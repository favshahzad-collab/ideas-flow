import { promises as fs } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "../lib/env";
import { prisma } from "../prisma";
import {
  chainOf,
  currentPosition,
  makeCast,
  makeUser,
  missingId,
  signature,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { approvalService } from "./approval.service";
import { auditService } from "./audit.service";
import { commentsService } from "./comments.service";
import { delegationsService } from "./delegations.service";
import { documentsService } from "./documents.service";
import { workflowService } from "./workflow.service";

/**
 * Handing one person's approvals to another while they are away.
 *
 * This is the only place in the product where somebody may act on a step that
 * is not theirs, which makes it the one feature that can quietly undo the
 * promise the whole workflow rests on: that a memo carries the approvals it
 * says it carries. So the tests here are mostly refusals - who may arrange it,
 * when it applies, when it stops - and the approvals it does allow are checked
 * for carrying both names, on the row and on the page.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;
let deputy: Awaited<ReturnType<typeof makeUser>>;
let administrator: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  cast = await makeCast();
  [deputy, administrator] = await Promise.all([
    makeUser({ firstName: "Deputy", departmentId: cast.department.id }),
    makeUser({
      firstName: "Admin",
      departmentId: cast.department.id,
      loginRole: "ADMINISTRATOR",
    }),
  ]);
});

const asUser = (user: { id: string }) => ({ id: user.id, isAdministrator: false });
const asAdmin = (user: { id: string }) => ({ id: user.id, isAdministrator: true });

const hoursFromNow = (hours: number) =>
  new Date(Date.now() + hours * 60 * 60 * 1000);

/** Hand `from`'s approvals to `to`, as `from` themselves, from now on. */
const handOver = (
  from: { id: string },
  to: { id: string },
  overrides: { startsAt?: Date; endsAt?: Date | null; reason?: string } = {}
) =>
  delegationsService.create(
    { delegateId: to.id, ...overrides },
    asUser(from)
  );

const approveAs = (documentId: string, actorId: string) => {
  const { useSavedSignature: _saved, ...placement } = signature();
  return approvalService.approve(documentId, actorId, {
    ...placement,
    useSavedSignature: false,
  });
};

const submit = () =>
  submitDocument({
    preparerId: cast.preparer.id,
    approvalChain: chainOf(cast.reviewer, cast.approver, cast.finalApprover),
    title: "Annual increment - Mr Bilal Khan",
  });

// ------------------------------------------------------------ arranging one

describe("arranging a delegation", () => {
  it("lets somebody hand over their own approvals", async () => {
    const delegation = await handOver(cast.reviewer, deputy, {
      reason: "Hajj leave until the 20th.",
    });

    expect(delegation.delegatorId).toBe(cast.reviewer.id);
    expect(delegation.delegateId).toBe(deputy.id);
    expect(delegation.isActive).toBe(true);
    expect(delegation.reason).toBe("Hajj leave until the 20th.");
  });

  it("lets an administrator arrange it for somebody else", async () => {
    const delegation = await delegationsService.create(
      { delegatorId: cast.reviewer.id, delegateId: deputy.id },
      asAdmin(administrator)
    );

    expect(delegation.delegatorId).toBe(cast.reviewer.id);
  });

  it("refuses anybody else arranging it for somebody else", async () => {
    // Otherwise the way to approve a memo you are not on is to give yourself
    // the authority of somebody who is.
    await expect(
      delegationsService.create(
        { delegatorId: cast.reviewer.id, delegateId: deputy.id },
        asUser(cast.preparer)
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses delegating to yourself", async () => {
    await expect(
      delegationsService.create(
        { delegateId: cast.reviewer.id },
        asUser(cast.reviewer)
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses a delegate who is no longer listed", async () => {
    await expect(
      delegationsService.create({ delegateId: missingId() }, asUser(cast.reviewer))
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses an end date that has already passed", async () => {
    await expect(
      handOver(cast.reviewer, deputy, { endsAt: hoursFromNow(-1) })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses an end before the start", async () => {
    await expect(
      handOver(cast.reviewer, deputy, {
        startsAt: hoursFromNow(48),
        endsAt: hoursFromNow(24),
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses a second delegation covering the same days", async () => {
    // One delegate at a time, or "who may sign for the reviewer on Tuesday"
    // has two answers and the audit trail cannot say which was used.
    await handOver(cast.reviewer, deputy);

    await expect(
      handOver(cast.reviewer, cast.bystander)
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows a later delegation that does not overlap", async () => {
    await handOver(cast.reviewer, deputy, { endsAt: hoursFromNow(24) });

    const second = await handOver(cast.reviewer, cast.bystander, {
      startsAt: hoursFromNow(48),
      endsAt: hoursFromNow(72),
    });

    expect(second.isActive).toBe(false);
  });

  it("refuses handing approvals to somebody who is away themselves", async () => {
    // The panel says a delegate cannot delegate onwards. The other half of
    // that rule is this one: somebody whose own approvals are already routed
    // away is not there to take anybody else's on.
    await handOver(deputy, cast.bystander);

    await expect(handOver(cast.reviewer, deputy)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("refuses somebody covering for another person from handing their own on", async () => {
    /*
     * The half of "no onward delegation" the panel states first, and the one
     * that actually strands a memo. The reviewer's steps are routed to the
     * deputy; if the deputy may then route their own approvals to a third
     * person, the reviewer's steps still go to the deputy - who is away - and
     * the third person has no authority over them and is never told. The memo
     * sits with two people who are both out of the office.
     */
    await handOver(cast.reviewer, deputy);

    await expect(handOver(deputy, cast.bystander)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("refuses a handover whose days the delegate is already away for later", async () => {
    // The delegate is here today and away from Thursday. Asking only whether
    // they are away *as it starts* lets the arrangement through, and it
    // strands the memo from Thursday on - the same harm, one day late.
    await handOver(deputy, cast.bystander, { startsAt: hoursFromNow(48) });

    await expect(handOver(cast.reviewer, deputy)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("allows it for days the two arrangements do not share", async () => {
    // The refusal is about overlap, not about the people. Once the cover ends
    // the deputy is back, and going away afterwards is nobody's business but
    // theirs.
    await handOver(cast.reviewer, deputy, { endsAt: hoursFromNow(24) });

    const own = await handOver(deputy, cast.bystander, {
      startsAt: hoursFromNow(48),
    });

    expect(own.delegatorId).toBe(deputy.id);
  });

  it("lets one person cover for several colleagues at once", async () => {
    // Nothing chains here: both sets of steps arrive at somebody who is in
    // the office. Covering the department over Eid is the ordinary case, and
    // the refusals above must not reach it.
    await handOver(cast.reviewer, deputy);

    const second = await handOver(cast.approver, deputy);

    expect(second.isActive).toBe(true);
  });

  it("records it in the ledger", async () => {
    const delegation = await handOver(cast.reviewer, deputy);

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: delegation.id, action: "DELEGATION_CREATED" },
    });

    expect(row.actorId).toBe(cast.reviewer.id);
    expect(row.newValue).toMatchObject({ delegateId: deputy.id });
  });
});

// -------------------------------------------------------------- ending one

describe("ending a delegation", () => {
  it("lets the person who gave it end it", async () => {
    const delegation = await handOver(cast.reviewer, deputy);

    const revoked = await delegationsService.revoke(
      delegation.id,
      asUser(cast.reviewer)
    );

    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.isActive).toBe(false);
  });

  it("lets an administrator end anybody's", async () => {
    const delegation = await handOver(cast.reviewer, deputy);

    await expect(
      delegationsService.revoke(delegation.id, asAdmin(administrator))
    ).resolves.toMatchObject({ isActive: false });
  });

  it("refuses anybody else, including the delegate", async () => {
    const delegation = await handOver(cast.reviewer, deputy);

    await expect(
      delegationsService.revoke(delegation.id, asUser(deputy))
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses to end one that has already ended", async () => {
    const delegation = await handOver(cast.reviewer, deputy);
    await delegationsService.revoke(delegation.id, asUser(cast.reviewer));

    await expect(
      delegationsService.revoke(delegation.id, asUser(cast.reviewer))
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("keeps the row, so what was possible between which dates survives", async () => {
    const delegation = await handOver(cast.reviewer, deputy);
    await delegationsService.revoke(delegation.id, asUser(cast.reviewer));

    const kept = await prisma.delegation.findUniqueOrThrow({
      where: { id: delegation.id },
    });

    expect(kept.delegateId).toBe(deputy.id);
    expect(kept.startsAt).toBeInstanceOf(Date);
    expect(kept.revokedById).toBe(cast.reviewer.id);
  });

  it("frees the person to arrange a new one", async () => {
    const first = await handOver(cast.reviewer, deputy);
    await delegationsService.revoke(first.id, asUser(cast.reviewer));

    await expect(
      handOver(cast.reviewer, cast.bystander)
    ).resolves.toMatchObject({ isActive: true });
  });
});

// ------------------------------------------------------------- signing under

describe("approving under a delegation", () => {
  it("lets the delegate act on the step, and moves the workflow on", async () => {
    const document = await submit();
    await handOver(cast.reviewer, deputy);

    await approveAs(document.id, deputy.id);

    const position = await currentPosition(document.id);
    expect(position.stepOrder).toBe(2);
    expect(position.assignedTo).toBe(cast.approver.id);
  });

  it("records both names on the approval", async () => {
    const document = await submit();
    await handOver(cast.reviewer, deputy);

    await approveAs(document.id, deputy.id);

    const action = await prisma.approvalAction.findFirstOrThrow({
      where: { workflowRun: { documentId: document.id }, action: "APPROVE" },
    });

    // Who actually signed, and whose approval it was. Either one alone is a
    // record somebody has to reconstruct from the delegation table later.
    expect(action.actorId).toBe(deputy.id);
    expect(action.onBehalfOfId).toBe(cast.reviewer.id);
  });

  it("says on the page who it was signed for", async () => {
    const document = await submit();
    await handOver(cast.reviewer, deputy);
    await approveAs(document.id, deputy.id);

    const action = await prisma.approvalAction.findFirstOrThrow({
      where: { workflowRun: { documentId: document.id }, action: "APPROVE" },
    });
    const bytes = await fs.readFile(
      path.join(
        path.resolve(env.STORAGE_DIR),
        "documents",
        action.signedPdfStoragePath as string
      )
    );

    expect(drawnText(bytes)).toContain(
      `Signed for ${cast.reviewer.firstName} ${cast.reviewer.lastName}`
    );
  });

  it("still lets the person sign for themselves while they are away", async () => {
    // Being away is a diary entry, not a lock. If they open the memo and sign
    // it, the approval is theirs and the delegation was simply not used.
    const document = await submit();
    await handOver(cast.reviewer, deputy);

    await approveAs(document.id, cast.reviewer.id);

    const action = await prisma.approvalAction.findFirstOrThrow({
      where: { workflowRun: { documentId: document.id }, action: "APPROVE" },
    });

    expect(action.actorId).toBe(cast.reviewer.id);
    expect(action.onBehalfOfId).toBeNull();
  });

  it("refuses the delegate before the delegation starts", async () => {
    const document = await submit();
    await handOver(cast.reviewer, deputy, { startsAt: hoursFromNow(24) });

    await expect(approveAs(document.id, deputy.id)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("refuses the delegate after it has ended", async () => {
    const document = await submit();
    const delegation = await handOver(cast.reviewer, deputy);

    // Wound back rather than waited out: the rule is about the dates on the
    // row, and a test that sleeps for a day is a test nobody runs.
    await prisma.delegation.update({
      where: { id: delegation.id },
      data: { startsAt: hoursFromNow(-48), endsAt: hoursFromNow(-24) },
    });

    await expect(approveAs(document.id, deputy.id)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("refuses the delegate the moment it is revoked", async () => {
    const document = await submit();
    const delegation = await handOver(cast.reviewer, deputy);
    await delegationsService.revoke(delegation.id, asUser(cast.reviewer));

    await expect(approveAs(document.id, deputy.id)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("leaves an approval already given under it standing", async () => {
    const document = await submit();
    const delegation = await handOver(cast.reviewer, deputy);
    await approveAs(document.id, deputy.id);

    await delegationsService.revoke(delegation.id, asUser(cast.reviewer));

    // It was authorised when it was given, and the memo has moved on. Undoing
    // it later would mean a signed page whose approval the system denies.
    const action = await prisma.approvalAction.findFirstOrThrow({
      where: { workflowRun: { documentId: document.id }, action: "APPROVE" },
    });
    expect(action.onBehalfOfId).toBe(cast.reviewer.id);
    expect((await currentPosition(document.id)).stepOrder).toBe(2);
  });

  it("refuses a delegate on a step that is not their delegator's", async () => {
    // Covering the reviewer does not make the final approver's step theirs.
    const document = await submit();
    await handOver(cast.finalApprover, deputy);

    await expect(approveAs(document.id, deputy.id)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("refuses the preparer even holding the approver's delegation", async () => {
    // The one route by which the author of a memo could have approved their
    // own memo. The preparer refusal is checked before the step is, so a
    // delegation cannot buy past it.
    const document = await submit();
    await handOver(cast.reviewer, cast.preparer);

    await expect(
      approveAs(document.id, cast.preparer.id)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("still refuses somebody with no delegation at all", async () => {
    const document = await submit();

    await expect(approveAs(document.id, deputy.id)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("lets the memo finish, with the delegated signature on it", async () => {
    const document = await submit();
    await handOver(cast.reviewer, deputy);

    await approveAs(document.id, deputy.id);
    await approveAs(document.id, cast.approver.id);
    await approveAs(document.id, cast.finalApprover.id);

    const finished = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    expect(finished.status).toBe("APPROVED");

    const signed = await fs.readFile(
      path.join(
        path.resolve(env.STORAGE_DIR),
        "documents",
        finished.finalSignedStoragePath as string
      )
    );
    const text = drawnText(signed);
    expect(text).toContain(`${deputy.firstName} ${deputy.lastName}`);
    expect(text).toContain(
      `Signed for ${cast.reviewer.firstName} ${cast.reviewer.lastName}`
    );
  });
});

// ---------------------------------------------------------------- seeing it

describe("a memo withdrawn while somebody is covering", () => {
  /**
   * The delegate is asked to approve it, and then it vanishes.
   *
   * Withdrawal already tells everybody named in the chain - that part works.
   * What it does not do is fan out to the person COVERING one of them, and a
   * delegate is precisely who is holding the memo at the moment it is
   * withdrawn. `notificationsService.approvalNeeded` exists to add them and is
   * used when the memo arrives; nothing added them when it left.
   *
   * The result is an inbox row in "Needs you" for a memo that no longer
   * exists, and no way to find out except opening it.
   */
  it("tells the delegate it has gone, not just the person they cover", async () => {
    const document = await submit();
    await handOver(cast.reviewer, deputy);

    // The memo is with the reviewer, and the deputy is covering that step.
    await documentsService.withdrawDocument(document.id, cast.preparer.id, "No longer needed");

    const told = await prisma.notification.findMany({
      where: { documentId: document.id, type: "DOCUMENT_DELETED" },
      select: { recipientId: true },
    });

    const names = new Map([
      [cast.reviewer.id, "reviewer"],
      [cast.approver.id, "approver"],
      [cast.finalApprover.id, "finalApprover"],
      [deputy.id, "deputy"],
      [cast.preparer.id, "preparer"],
    ]);

    expect(
      [...new Set(told.map((row) => names.get(row.recipientId) ?? "?"))].sort()
    ).toEqual(["approver", "deputy", "finalApprover", "reviewer"]);
  });

  it("does not tell the preparer, who is the one who withdrew it", async () => {
    const document = await submit();
    await handOver(cast.reviewer, deputy);

    await documentsService.withdrawDocument(document.id, cast.preparer.id, "No longer needed");

    const theirs = await prisma.notification.count({
      // Their receipt for submitting it aside.
      where: {
        documentId: document.id,
        recipientId: cast.preparer.id,
        type: { not: "SUBMITTED" },
      },
    });

    expect(theirs).toBe(0);
  });

  it("says who the delegate was covering, since they hold several people's work", async () => {
    const document = await submit();
    await handOver(cast.reviewer, deputy);

    await documentsService.withdrawDocument(document.id, cast.preparer.id, "No longer needed");

    const notice = await prisma.notification.findFirstOrThrow({
      where: { documentId: document.id, recipientId: deputy.id },
    });

    expect(notice.message).toContain(cast.reviewer.firstName);
  });
});

describe("what a delegate can see", () => {
  it("opens the document, the workflow and the thread", async () => {
    const document = await submit();
    await handOver(cast.reviewer, deputy);

    await expect(
      documentsService.getDocumentById(document.id, deputy.id)
    ).resolves.toMatchObject({ id: document.id });
    await expect(
      workflowService.getWorkflow(document.id, deputy.id)
    ).resolves.toBeTruthy();
    await expect(
      commentsService.getComments(document.id, deputy.id)
    ).resolves.toBeInstanceOf(Array);
    await expect(
      auditService.getDocumentAuditHistory(document.id, deputy.id)
    ).resolves.toBeInstanceOf(Array);
  });

  it("lists it among their documents", async () => {
    const document = await submit();
    await handOver(cast.reviewer, deputy);

    const { documents } = await documentsService.getDocuments(deputy.id);

    expect(documents.map((row) => row.id)).toContain(document.id);
  });

  it("shows them nothing before the run reaches the person they cover", async () => {
    // The delegation hands over the approver's authority, not more of it: a
    // memo sitting at step 1 is no more visible to the final approver's
    // delegate than it is to the final approver.
    const document = await submit();
    await handOver(cast.finalApprover, deputy);

    await expect(
      documentsService.getDocumentById(document.id, deputy.id)
    ).rejects.toMatchObject({ statusCode: 403 });
    const { documents } = await documentsService.getDocuments(deputy.id);
    expect(documents.map((row) => row.id)).not.toContain(document.id);
  });

  it("closes again when the delegation ends", async () => {
    const document = await submit();
    const delegation = await handOver(cast.reviewer, deputy);
    await delegationsService.revoke(delegation.id, asUser(cast.reviewer));

    await expect(
      documentsService.getDocumentById(document.id, deputy.id)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("does not open the delegator's own drafts", async () => {
    // A delegate covers approvals, not authorship. Standing in for a
    // colleague for a week does not open everything they have written.
    const ownDocument = await submitDocument({
      preparerId: cast.reviewer.id,
      approvalChain: chainOf(cast.approver, cast.finalApprover),
      title: "The reviewer's own paper",
    });
    await handOver(cast.reviewer, deputy);

    await expect(
      documentsService.getDocumentById(ownDocument.id, deputy.id)
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

// ------------------------------------------------------------ being told

/**
 * The ARRANGEMENT, as distinct from the memos that later flow through it.
 *
 * The suite below this one covers the memos: a document reaching a covered
 * step tells the approver and the delegate, and that has always worked. What
 * nothing covered - and nothing implemented - is being told that the
 * arrangement itself was made or ended.
 *
 * It matters most in the case the permission rule deliberately allows: an
 * ADMINISTRATOR may hand one person's approvals to another. In a system where
 * a signature carries authority, that is a transfer of authority, and until
 * now neither the person who lost it nor the person who gained it was told.
 * `DELEGATION_CREATED` went into the trail and no further.
 */
describe("arranging it, and ending it", () => {
  /** Every inbox row, as "who | type | title". */
  async function inboxes(): Promise<string[]> {
    const names = new Map([
      [cast.reviewer.id, "reviewer"],
      [deputy.id, "deputy"],
      [administrator.id, "administrator"],
    ]);

    const rows = await prisma.notification.findMany({
      select: { recipientId: true, type: true, title: true, createdAt: true },
    });

    return rows
      .map((row) => ({
        at: row.createdAt.getTime(),
        line: `${names.get(row.recipientId) ?? "?"} | ${row.type} | ${row.title}`,
      }))
      .sort((a, b) => a.at - b.at || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0))
      .map((row) => row.line);
  }

  it("tells the delegate they now hold somebody else's approvals", async () => {
    await handOver(cast.reviewer, deputy);

    expect(await inboxes()).toEqual([
      "deputy | DELEGATION_STARTED | You are covering approvals",
    ]);
  });

  it("tells BOTH when an administrator arranges it for somebody else", async () => {
    /*
     * The case the permission rule exists for, and the one that was silent.
     * Somebody else's approval authority moved, by a third party, and the two
     * people it concerns are exactly the two who were not told.
     */
    await delegationsService.create(
      { delegatorId: cast.reviewer.id, delegateId: deputy.id },
      asAdmin(administrator)
    );

    expect(await inboxes()).toEqual([
      "deputy | DELEGATION_STARTED | You are covering approvals",
      "reviewer | DELEGATION_STARTED | Your approvals were handed over",
    ]);
  });

  it("does not write to the administrator who arranged it", async () => {
    // They just did it. A notice to the actor is the noise that gets the
    // other two filtered.
    await delegationsService.create(
      { delegatorId: cast.reviewer.id, delegateId: deputy.id },
      asAdmin(administrator)
    );

    const theirs = await prisma.notification.count({
      where: { recipientId: administrator.id },
    });

    expect(theirs).toBe(0);
  });

  it("says who it is for, because a delegate may cover more than one person", async () => {
    await handOver(cast.reviewer, deputy);

    const notice = await prisma.notification.findFirstOrThrow({
      where: { recipientId: deputy.id },
    });

    expect(notice.message).toContain(cast.reviewer.firstName);
  });

  it("tells the delegate when it ends, since their authority just stopped", async () => {
    const delegation = await handOver(cast.reviewer, deputy);

    await delegationsService.revoke(delegation.id, asUser(cast.reviewer));

    expect(await inboxes()).toEqual([
      "deputy | DELEGATION_STARTED | You are covering approvals",
      "deputy | DELEGATION_ENDED | You are no longer covering approvals",
    ]);
  });

  it("tells the person covered too when an administrator ends it", async () => {
    const delegation = await delegationsService.create(
      { delegatorId: cast.reviewer.id, delegateId: deputy.id },
      asAdmin(administrator)
    );

    await delegationsService.revoke(delegation.id, asAdmin(administrator));

    expect(await inboxes()).toEqual([
      "deputy | DELEGATION_STARTED | You are covering approvals",
      "reviewer | DELEGATION_STARTED | Your approvals were handed over",
      "deputy | DELEGATION_ENDED | You are no longer covering approvals",
      "reviewer | DELEGATION_ENDED | Your approvals are back with you",
    ]);
  });

  it("raises nothing when the arrangement was refused", async () => {
    // An overlapping delegation is rejected. Notifying on a refusal hands
    // anybody who can reach the endpoint a way to send mail.
    await handOver(cast.reviewer, deputy);
    const before = await inboxes();

    await expect(handOver(cast.reviewer, deputy)).rejects.toThrow();

    expect(await inboxes()).toEqual(before);
  });
});

describe("being told about it", () => {
  it("notifies the delegate as well as the person covered", async () => {
    await handOver(cast.reviewer, deputy);
    const document = await submit();

    const inboxes = await prisma.notification.findMany({
      where: { documentId: document.id, type: "APPROVAL_NEEDED" },
      select: { recipientId: true, message: true },
    });

    expect(inboxes.map((row) => row.recipientId)).toContain(cast.reviewer.id);
    const delegateRow = inboxes.find((row) => row.recipientId === deputy.id);
    expect(delegateRow?.message).toContain(
      `covering for ${cast.reviewer.firstName} ${cast.reviewer.lastName}`
    );
  });

  it("notifies only the approver when nobody is covering", async () => {
    const document = await submit();

    const inboxes = await prisma.notification.findMany({
      where: { documentId: document.id, type: "APPROVAL_NEEDED" },
    });

    expect(inboxes).toHaveLength(1);
    expect(inboxes[0].recipientId).toBe(cast.reviewer.id);
  });

  it("tells the delegate when the memo reaches the step they cover", async () => {
    const document = await submit();
    await handOver(cast.approver, deputy);

    await approveAs(document.id, cast.reviewer.id);

    const delegateRows = await prisma.notification.findMany({
      where: { documentId: document.id, recipientId: deputy.id },
    });

    expect(delegateRows).toHaveLength(1);
  });
});

// --------------------------------------------------------------- listing it

describe("reading what is in force", () => {
  it("lists what somebody has given and what they hold", async () => {
    await handOver(cast.reviewer, deputy);

    const reviewer = await delegationsService.listForUser(cast.reviewer.id);
    const held = await delegationsService.listForUser(deputy.id);

    expect(reviewer.given).toHaveLength(1);
    expect(reviewer.given[0].delegate.id).toBe(deputy.id);
    expect(reviewer.held).toHaveLength(0);
    expect(held.held).toHaveLength(1);
    expect(held.held[0].delegator.id).toBe(cast.reviewer.id);
  });

  it("says which of them apply today", async () => {
    const current = await handOver(cast.reviewer, deputy, {
      endsAt: hoursFromNow(24),
    });
    const later = await handOver(cast.approver, deputy, {
      startsAt: hoursFromNow(48),
      endsAt: hoursFromNow(72),
    });

    const { held } = await delegationsService.listForUser(deputy.id);
    const byId = new Map(held.map((row) => [row.id, row.isActive]));

    expect(byId.get(current.id)).toBe(true);
    expect(byId.get(later.id)).toBe(false);
  });
});

/**
 * Every string drawn on a PDF, decoded.
 *
 * pdf-lib compresses its content streams and writes text as hex, so the words
 * on the page are not visible to a plain search of the file.
 */
function drawnText(pdf: Buffer): string {
  const streams: string[] = [];
  const START = Buffer.from("stream");
  const END = Buffer.from("endstream");

  let from = 0;
  for (;;) {
    const open = pdf.indexOf(START, from);
    if (open === -1) break;
    const close = pdf.indexOf(END, open);
    if (close === -1) break;

    // Past the newline that follows the `stream` keyword: inflate refuses a
    // stream that starts with it, and refuses it silently into the catch.
    let body = open + START.length;
    while (pdf[body] === 0x0d || pdf[body] === 0x0a) body += 1;

    try {
      streams.push(zlib.inflateSync(pdf.subarray(body, close)).toString("latin1"));
    } catch {
      // Not a compressed stream - an image, or the file's own metadata.
    }
    from = close + END.length;
  }

  const joined = streams.join("\n");

  return [...joined.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)]
    .map((match) => Buffer.from(match[1], "hex").toString("latin1"))
    .join("\n");
}
