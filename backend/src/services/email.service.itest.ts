import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  makeUser,
  signature,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { approvalService } from "./approval.service";
import { emailService } from "./email.service";
import * as mailer from "../lib/mailer";

/**
 * The outbox: what the system meant to tell people, and whether it managed to.
 *
 * The two properties worth holding are that a notice is never lost when the
 * mail server is unreachable - it is queued in the same transaction as the
 * inbox row, and retried - and that an unreachable mail server never takes an
 * approval down with it. Everything else here is about not delivering the
 * wrong thing: no duplicates from two dispatchers, nothing a day stale, and a
 * permanent refusal left alone with its reason on it.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;
let sent: { to: string; subject: string; text: string }[];
let sendMail: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  cast = await makeCast();
  sent = [];

  // A mail server that always accepts, unless a test says otherwise. The real
  // one is never touched: `sendMail` is the only door out of this module.
  vi.spyOn(mailer, "isMailConfigured").mockReturnValue(true);
  sendMail = vi.spyOn(mailer, "sendMail").mockImplementation(async (message) => {
    sent.push(message);
    return Promise.resolve();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const approveAs = (documentId: string, actorId: string) => {
  const { useSavedSignature: _saved, ...placement } = signature();
  return approvalService.approve(documentId, actorId, {
    ...placement,
    useSavedSignature: false,
  });
};

/*
 * Submitted, and the preparer's own receipt set aside: every test here is
 * about the one notice the approver is sent, and the receipt - which has its
 * own test in notify-and-escalate.itest.ts - would make each of them count
 * two. Deleted from the outbox and the inbox both, so neither is sent.
 */
const submit = async () => {
  const document = await submitDocument({
    preparerId: cast.preparer.id,
    approvalChain: chainOf(cast.reviewer, cast.approver, cast.finalApprover),
    title: "Annual increment - Mr Bilal Khan",
  });
  await prisma.emailMessage.deleteMany({ where: { recipientId: cast.preparer.id } });
  await prisma.notification.deleteMany({ where: { type: "SUBMITTED" } });
  return document;
};

const queued = () =>
  prisma.emailMessage.findMany({ orderBy: { createdAt: "asc" } });

describe("what gets queued", () => {
  it("queues a notice for the approver a memo has reached", async () => {
    await submit();

    const rows = await queued();

    expect(rows).toHaveLength(1);
    expect(rows[0].recipientId).toBe(cast.reviewer.id);
    expect(rows[0].status).toBe("PENDING");
  });

  it("addresses it to the person, and says which memo in the subject", async () => {
    const document = await submit();

    const [row] = await queued();
    const memo = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });

    const reviewer = await prisma.user.findUniqueOrThrow({
      where: { id: cast.reviewer.id },
    });
    expect(row.recipientEmail).toBe(reviewer.email);
    expect(row.subject).toContain("Approval needed");
    expect(row.subject).toContain(memo.referenceNumber as string);
    expect(row.body).toContain(`/documents/${document.id}`);
  });

  it("queues it with the inbox row, not instead of it", async () => {
    // Both or neither. A memo sitting in somebody's queue that nothing ever
    // told them about is the failure this whole feature exists to prevent.
    await submit();

    const [inbox, mail] = await Promise.all([
      prisma.notification.findMany(),
      queued(),
    ]);

    expect(inbox).toHaveLength(1);
    expect(mail).toHaveLength(1);
    expect(mail[0].documentId).toBe(inbox[0].documentId);
  });

  it("tells the preparer when their memo is approved", async () => {
    const document = await submit();
    await approveAs(document.id, cast.reviewer.id);
    await approveAs(document.id, cast.approver.id);
    await approveAs(document.id, cast.finalApprover.id);

    const rows = await queued();
    const toPreparer = rows.filter(
      (row) => row.recipientId === cast.preparer.id
    );

    expect(toPreparer.length).toBeGreaterThan(0);
    expect(toPreparer.at(-1)?.subject).toContain("Approved");
  });

  it("queues one for the delegate as well as the approver", async () => {
    const deputy = await makeUser({
      firstName: "Deputy",
      departmentId: cast.department.id,
    });
    await prisma.delegation.create({
      data: {
        delegatorId: cast.reviewer.id,
        delegateId: deputy.id,
        createdById: cast.reviewer.id,
      },
    });

    await submit();

    const recipients = (await queued()).map((row) => row.recipientId);
    expect(recipients).toContain(cast.reviewer.id);
    expect(recipients).toContain(deputy.id);
  });

  it("queues nothing extra for a person with no address on file", async () => {
    // Reachable: accounts are created by import, and the workflow must not
    // stop because one row has no email.
    await prisma.user.update({
      where: { id: cast.reviewer.id },
      data: { email: "" },
    });

    await expect(submit()).resolves.toBeTruthy();
    expect(await queued()).toHaveLength(0);
    expect(await prisma.notification.count()).toBe(1);
  });
});

describe("delivery", () => {
  it("sends what is queued and marks it sent", async () => {
    await submit();

    const result = await emailService.dispatchPending();

    expect(result.sent).toBe(1);
    expect(sent[0].subject).toContain("Approval needed");
    expect((await queued())[0].status).toBe("SENT");
    expect((await queued())[0].sentAt).toBeInstanceOf(Date);
  });

  it("records the delivery in the ledger", async () => {
    await submit();
    await emailService.dispatchPending();

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: "EMAIL_SENT" },
    });

    expect(row.entityType).toBe("EmailMessage");
  });

  it("sends nothing twice", async () => {
    await submit();

    await emailService.dispatchPending();
    await emailService.dispatchPending();

    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("leaves the queue alone when no mail server is configured", async () => {
    vi.mocked(mailer.isMailConfigured).mockReturnValue(false);
    await submit();

    const result = await emailService.dispatchPending();

    expect(result.sent).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
    // Still queued, not lost: it is the record of what the system meant to say.
    expect((await queued())[0].status).toBe("PENDING");
  });
});

describe("when the mail server refuses", () => {
  it("puts a temporary failure back on the queue with its reason", async () => {
    vi.mocked(mailer.sendMail).mockRejectedValueOnce(
      Object.assign(new Error("connect ECONNREFUSED"), { responseCode: 421 })
    );
    await submit();

    await emailService.dispatchPending();

    const [row] = await queued();
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("ECONNREFUSED");
  });

  it("delivers it on the next sweep", async () => {
    vi.mocked(mailer.sendMail).mockRejectedValueOnce(
      Object.assign(new Error("try later"), { responseCode: 421 })
    );
    await submit();

    await emailService.dispatchPending();
    const second = await emailService.dispatchPending();

    expect(second.sent).toBe(1);
    expect((await queued())[0].status).toBe("SENT");
  });

  it("gives up at once on an address it will never accept", async () => {
    // A 5xx is the server saying no, not saying not now. Retrying it ten
    // times tells nobody anything and delays everything behind it.
    vi.mocked(mailer.sendMail).mockRejectedValue(
      Object.assign(new Error("550 no such mailbox"), { responseCode: 550 })
    );
    await submit();

    const result = await emailService.dispatchPending();

    expect(result.failed).toBe(1);
    const [row] = await queued();
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("550");
  });

  it("stops retrying after ten attempts, and keeps the reason", async () => {
    vi.mocked(mailer.sendMail).mockRejectedValue(
      Object.assign(new Error("still down"), { responseCode: 421 })
    );
    await submit();

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await emailService.dispatchPending();
    }

    const [row] = await queued();
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(10);
    expect(row.lastError).toContain("still down");
  });

  it("never lets a failure reach the approval that caused it", async () => {
    vi.mocked(mailer.sendMail).mockRejectedValue(new Error("mail server down"));
    const document = await submit();

    // The memo advances whatever the mail server is doing: delivery happens
    // in the sweep, not in the request.
    await expect(approveAs(document.id, cast.reviewer.id)).resolves.toBeTruthy();
    await emailService.dispatchPending();

    const memo = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    expect(memo.status).toBe("PENDING_REVIEW");
    expect((await prisma.workflowRun.findFirstOrThrow({
      where: { documentId: document.id },
    })).currentStepOrder).toBe(2);
  });
});

describe("notices that are too old to send", () => {
  it("expires anything older than a day rather than delivering it late", async () => {
    // A mail server that comes back after two days must not post a backlog of
    // stale approval requests: by then they are confusion, not news.
    await submit();
    await prisma.emailMessage.updateMany({
      data: { createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000) },
    });

    const result = await emailService.dispatchPending();

    expect(result.expired).toBe(1);
    expect(result.sent).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
    expect((await queued())[0].status).toBe("EXPIRED");
  });

  it("leaves a notice from an hour ago alone", async () => {
    await submit();
    await prisma.emailMessage.updateMany({
      data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    expect((await emailService.dispatchPending()).sent).toBe(1);
  });
});

describe("a dispatcher that died mid-send", () => {
  it("reclaims the row once the claim goes stale", async () => {
    await submit();
    await prisma.emailMessage.updateMany({
      data: {
        status: "SENDING",
        claimedAt: new Date(Date.now() - 10 * 60 * 1000),
        attempts: 1,
      },
    });

    expect((await emailService.dispatchPending()).sent).toBe(1);
  });

  it("leaves a fresh claim to the process that made it", async () => {
    // The guard against two API processes both sending the same notice.
    await submit();
    await prisma.emailMessage.updateMany({
      data: { status: "SENDING", claimedAt: new Date(), attempts: 1 },
    });

    expect((await emailService.dispatchPending()).sent).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("the queue summary", () => {
  it("counts what is waiting, sent and failed", async () => {
    await submit();
    await emailService.dispatchPending();

    const summary = await emailService.queueSummary();

    expect(summary.configured).toBe(true);
    expect(summary.counts.SENT).toBe(1);
    expect(summary.counts.PENDING).toBe(0);
  });

  it("names the last failures, with the reason and who they were for", async () => {
    vi.mocked(mailer.sendMail).mockRejectedValue(
      Object.assign(new Error("550 no such mailbox"), { responseCode: 550 })
    );
    await submit();
    await emailService.dispatchPending();

    const summary = await emailService.queueSummary();

    expect(summary.counts.FAILED).toBe(1);
    expect(summary.recentFailures[0].lastError).toContain("550");
    expect(summary.recentFailures[0].recipientEmail).toContain("@");
  });
});
