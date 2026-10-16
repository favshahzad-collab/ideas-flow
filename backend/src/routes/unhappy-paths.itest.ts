import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../app";
import { ApprovalType } from "../generated/prisma/client";
import { hashPassword } from "../lib/password";
import { prisma } from "../prisma";
import {
  makeDepartment,
  makePdf,
  SIGNATURE_IMAGE,
  useCleanDatabase,
} from "../test/db";
import { allowStepSkipInThisSuite } from "../test/stepSkip";

/**
 * What a memo that does NOT sail through puts in people's inboxes.
 *
 * Every other suite asserts one row at a time, and they all passed while a
 * comment on a memo told nobody at all. That defect was not a wrong row - it
 * was a MISSING one, and a test that looks up the row it expects can never see
 * a row that was never written. Two earlier defects hid the same way round:
 * four identical subject lines, each of which was individually correct.
 *
 * So this file asserts the WHOLE list. Every notice a run produced, in order,
 * against the list a person should have received - which means a notice that
 * stops being sent fails here, and so does one that starts being sent twice.
 *
 * The happy path had been through a real run and been read by somebody. These
 * had not: on the live database `audit_logs` holds no row for a rejection, a
 * revision request, a comment or a delegation, so every line below describes
 * behaviour that had never reached a mailbox anyone opened.
 */

useCleanDatabase();

let server: Server;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

const PASSWORD = "correct horse battery staple";

type Person = { id: string; email: string; token: string };

/*
 * Each person's "confirm it's you", made through the real endpoint with their
 * password when they sign in, and sent with every request they make - as the
 * app does once somebody has confirmed. Signing is refused without one; the
 * refusal itself is pinned in `signing-confirmation.itest.ts`.
 */
const stepUps = new Map<string, string>();
const authHeaders = (token: string): Record<string, string> => {
  const stepUp = stepUps.get(token);
  return {
    authorization: `Bearer ${token}`,
    ...(stepUp ? { "x-step-up": stepUp } : {}),
  };
};

async function makePerson(
  firstName: string,
  designation: string,
  departmentId: string
): Promise<Person> {
  const email = `${firstName.toLowerCase()}@example.com`;

  const user = await prisma.user.create({
    data: {
      firstName,
      lastName: "Khan",
      email,
      passwordHash: await hashPassword(PASSWORD),
      departmentId,
      designation,
    },
  });

  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = (await response.json()) as { accessToken?: string };

  if (!body.accessToken) {
    throw new Error(`Could not sign in as ${email}: ${response.status}`);
  }

  const confirmation = await fetch(`${base}/api/auth/step-up`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${body.accessToken}`,
    },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const { stepUpToken } = (await confirmation.json()) as { stepUpToken?: string };
  if (stepUpToken) stepUps.set(body.accessToken, stepUpToken);

  return { id: user.id, email, token: body.accessToken };
}

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {}
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.token ? authHeaders(options.token) : {}),
      ...(options.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });

  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    /* a PDF or an empty body */
  }

  return { status: response.status, json, text };
}

const placement = () => ({
  consent: true,
  useSavedSignature: false,
  signatureImage: SIGNATURE_IMAGE,
  signaturePage: 1,
  signatureX: 100,
  signatureY: 200,
  signatureWidth: 120,
  signatureHeight: 40,
});

let hr: Person;
let reviewer: Person;
let approver: Person;
let finalApprover: Person;
let stand: Person;
let pdf: Buffer;

beforeEach(async () => {
  const department = await makeDepartment("Human Resources");

  [hr, reviewer, approver, finalApprover, stand] = await Promise.all([
    makePerson("Ayesha", "Assistant Manager, HR", department.id),
    makePerson("Bilal", "Manager, Finance", department.id),
    makePerson("Chandni", "Head of Operations", department.id),
    makePerson("Danish", "Chief Executive", department.id),
    makePerson("Erum", "Deputy Head of Operations", department.id),
  ]);

  pdf = await makePdf(2);
});

async function submitMemo(title: string) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
    "memo.pdf"
  );
  form.append("title", title);
  form.append("description", "Recommended for approval.");
  form.append(
    "approvalChain",
    JSON.stringify([
      { userId: reviewer.id, approvalType: ApprovalType.REVIEWER },
      { userId: approver.id, approvalType: ApprovalType.APPROVER },
      { userId: finalApprover.id, approvalType: ApprovalType.FINAL_APPROVER },
    ])
  );
  form.append("signature", JSON.stringify(placement()));

  const response = await fetch(`${base}/api/documents`, {
    method: "POST",
    headers: authHeaders(hr.token),
    body: form,
  });

  const json = (await response.json()) as { document?: { id: string } };

  if (response.status !== 201) {
    throw new Error(`Submission failed: ${response.status}`);
  }

  return json.document!;
}

/**
 * Every notice raised so far as `who | what kind`, oldest first.
 *
 * The reference and title are cut off deliberately. What this file is about is
 * WHO was told and WHAT KIND of thing they were told; leaving the memo title
 * in would make every line unique and hide exactly the repeat that is worth
 * catching.
 */
async function notices(): Promise<string[]> {
  const messages = await prisma.emailMessage.findMany({
    /*
     * The preparer's receipt for submitting is left out: these tests are
     * about who is told of what happens to a memo afterwards, and the
     * receipt - pinned in notify-and-escalate.itest.ts - would be a line in
     * every one of them.
     */
    where: { NOT: { subject: { startsWith: "Submitted:" } } },
    select: { recipientEmail: true, subject: true, createdAt: true },
  });

  return messages
    .map((message) => ({
      at: message.createdAt.getTime(),
      line: `${message.recipientEmail.split("@")[0]} | ${message.subject.split(":")[0]}`,
    }))
    /*
     * By time, then by the line itself - and the tiebreaker is not cosmetic.
     * `created_at` defaults to `now()`, which in Postgres is the TRANSACTION's
     * start time, so every notice raised by one event carries exactly the same
     * timestamp and their order among themselves is undefined. Ordering in SQL
     * left that to whatever the planner returned.
     *
     * Between events the order is real and worth asserting; within one it is
     * not, so the text settles it. Compared with `<` rather than
     * `localeCompare`, which would hand the answer back to a locale in the
     * same way `ORDER BY fileName` handed it to a collation - that one passed
     * here and failed in CI.
     */
    .sort((a, b) => a.at - b.at || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0))
    .map((message) => message.line);
}

/** The audit trail as `who did what`, oldest first. */
async function trail(): Promise<string[]> {
  /*
   * By WRITE order, not by `seq`. `seq` is assigned by the sealer, which has
   * not run here, so every row in this database has the same (null) value for
   * it and the order was whatever the heap happened to return - which passed
   * about four runs in five and failed the fifth, on the one assertion that
   * cares about two rows written inside a single transaction.
   */
  const rows = await prisma.auditLog.findMany({
    // What was done to the memo. The cast signing in over HTTP is recorded
    // too, and is not part of the story these tests tell.
    where: { action: { not: "SIGN_IN_SUCCEEDED" } },
    orderBy: { writeSeq: "asc" },
    select: { action: true, actorId: true },
  });

  const names = new Map(
    (await prisma.user.findMany({ select: { id: true, firstName: true } })).map(
      (user) => [user.id, user.firstName]
    )
  );

  return rows.map(
    (row) =>
      `${row.actorId ? (names.get(row.actorId) ?? "?") : "system"} ${row.action}`
  );
}

describe("a memo whose approver was passed over", () => {
  // Off in every deployment unless an organisation switches it on. These
  // describe what it does where one has.
  allowStepSkipInThisSuite();

  it("does not tell the person it passed over that their approval is needed", async () => {
    /*
     * The skipped reviewer IS told - that part was never missing. What they
     * were told was "Approval needed", because the notice reused
     * APPROVAL_NEEDED for want of a type that meant what had happened.
     *
     * Three things followed from the one wrong word. The mail arrived headed
     * "Approval needed" at somebody whose approval had just been bypassed.
     * The inbox maps that type to the `action` category, so it sat in "Needs
     * you" - the group the codebase deliberately keeps clear of anything that
     * is not a task. And the row offered a button reading "Open to sign", on
     * a memo they can no longer sign.
     *
     * Exactly the shape of the resubmission defect: a subject line that was
     * individually plausible and described the wrong event.
     */
    const memo = await submitMemo("Annual increment - Mr Bilal Khan");

    const skipped = await call("POST", `/api/documents/${memo.id}/skip-step`, {
      token: hr.token,
      body: { reason: "On leave until next month." },
    });
    expect(skipped.status).toBe(200);

    expect(await notices()).toEqual([
      // Submitted: the first approver is asked.
      "bilal | Approval needed",
      // Passed over: told what happened to them, not asked for something.
      "bilal | Skipped",
      // The step really did move, so this one IS an approval request.
      "chandni | Approval needed",
    ]);
  });

  it("files it as news for the skipped person, not as work", async () => {
    const memo = await submitMemo("Annual increment - Mr Bilal Khan");

    await call("POST", `/api/documents/${memo.id}/skip-step`, {
      token: hr.token,
      body: { reason: "On leave until next month." },
    });

    const theirs = await prisma.notification.findMany({
      where: { recipientId: reviewer.id },
      orderBy: { createdAt: "asc" },
      select: { type: true },
    });

    // Asked first, then told they were passed over. The second must not be
    // the same type as the first.
    expect(theirs.map((row) => row.type)).toEqual([
      "APPROVAL_NEEDED",
      "STEP_SKIPPED",
    ]);
  });
});

describe("a memo sent back for revision", () => {
  it("tells exactly the right people, exactly once each", async () => {
    const memo = await submitMemo("Annual increment — Mr Bilal Khan");

    // The reviewer has a question before signing.
    const commented = await call("POST", `/api/documents/${memo.id}/comments`, {
      token: reviewer.token,
      body: { comment: "The grade on page 2 does not match the scale." },
    });
    expect(commented.status).toBe(201);

    const sentBack = await call(
      "POST",
      `/api/documents/${memo.id}/request-revision`,
      {
        token: reviewer.token,
        body: { comment: "Correct the grade on page 2 and resubmit." },
      }
    );
    expect(sentBack.status).toBe(200);

    expect(await notices()).toEqual([
      // Submitted: the first approver is asked.
      "bilal | Approval needed",
      /*
       * The comment, and this line is why the file exists. It was absent, and
       * nothing anywhere noticed, because the thread renders as a
       * conversation - avatars, names, timestamps - whether or not a single
       * person is told about it.
       */
      "ayesha | New comment",
      // Sent back: the preparer, who is the only one who can act on it.
      "ayesha | Revision requested",
    ]);
  });

  it("does not tell approvers the memo never reached", async () => {
    /*
     * Chandni and Danish are further down the chain and have never seen this
     * memo. A notice about a question on it would be the first they hear of
     * its existence, which is not a notification - it is somebody else's work
     * in progress arriving uninvited.
     */
    const memo = await submitMemo("Annual increment — Mr Bilal Khan");

    await call("POST", `/api/documents/${memo.id}/comments`, {
      token: reviewer.token,
      body: { comment: "The grade on page 2 does not match the scale." },
    });

    const told = (await notices()).map((line) => line.split(" | ")[0]);

    expect(told).not.toContain("chandni");
    expect(told).not.toContain("danish");
  });
});

describe("a memo rejected by somebody covering for an approver", () => {
  const cover = (endsAt: string | null) =>
    call("POST", "/api/delegations", {
      token: approver.token,
      body: {
        delegateId: stand.id,
        startsAt: new Date().toISOString().slice(0, 10),
        endsAt,
        reason: "Away on site",
      },
    });

  it("tells the chain behind it, and the person being covered for", async () => {
    const memo = await submitMemo("Overtime claim — October");

    const delegation = await cover(
      new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10)
    );
    expect(delegation.status).toBe(201);

    await call("POST", `/api/documents/${memo.id}/approve`, {
      token: reviewer.token,
      body: placement(),
    });

    const rejected = await call("POST", `/api/documents/${memo.id}/reject`, {
      token: stand.token,
      body: { comment: "The claim exceeds the approved overtime budget." },
    });
    expect(rejected.status).toBe(200);

    expect(await notices()).toEqual([
      "bilal | Approval needed",
      /*
       * Erum is told she is covering, at the moment the arrangement is made
       * rather than when the first memo arrives. Chandni is not: she made it
       * herself. Nothing was sent here at all until delegation raised its own
       * notices - the arrangement was silent while every memo passing through
       * it was not, which is what kept the silence out of sight.
       */
      "erum | Approvals handed over",
      // The preparer hears it moved on, in words that do not say "Approved":
      // two approvers still had to sign.
      "ayesha | Approval progress",
      /*
       * Both the approver and the person covering for them. Chandni is away,
       * which is why she delegated - but the step is still hers, and a
       * delegation that quietly took her off the list would be a way to move
       * a memo past somebody without their knowledge.
       */
      "chandni | Approval needed",
      "erum | Approval needed",
      // Rejected: the preparer, whoever had already signed, and the approver
      // whose step it was. Not Danish - it never reached him.
      "ayesha | Rejected",
      "bilal | Rejected",
      "chandni | Rejected",
    ]);
  });

  it("names the stand-in in the trail, not the person they covered for", async () => {
    // The trail has to say who actually pressed it. "Chandni rejected this"
    // over an action Erum took is the one thing an audit trail cannot say.
    const memo = await submitMemo("Overtime claim — October");

    await cover(null);
    await call("POST", `/api/documents/${memo.id}/approve`, {
      token: reviewer.token,
      body: placement(),
    });
    await call("POST", `/api/documents/${memo.id}/reject`, {
      token: stand.token,
      body: { comment: "Over budget." },
    });

    expect(await trail()).toEqual([
      "Ayesha DOCUMENT_SUBMITTED",
      // Each signature is its own entry, right after what it was part of.
      "Ayesha DOCUMENT_SIGNED",
      "Chandni DELEGATION_CREATED",
      "Bilal WORKFLOW_APPROVED",
      "Bilal DOCUMENT_SIGNED",
      "Erum WORKFLOW_REJECTED",
    ]);
  });
});

describe("a memo corrected and sent round again", () => {
  it("does not send the reviewer a second mail that looks like the first", async () => {
    /*
     * The defect this describes. A reviewer who sends a memo back gets it
     * again once it is corrected - and the subject line was character for
     * character the one they already read: "Approval needed: MEMO-2026-0001
     * - Annual increment". Nothing in the inbox said whether this was the
     * memo they had already looked at or the corrected one they asked for.
     *
     * The body always said "Revised document". Nobody reads the body to
     * decide whether to open the mail.
     */
    const memo = await submitWithSupporting("Annual increment — Mr Bilal Khan");

    await call("POST", `/api/documents/${memo.id}/request-revision`, {
      token: reviewer.token,
      body: { comment: "Correct the grade on page 2 and resubmit." },
    });

    const again = await resubmit(memo.id);
    expect(again.status).toBe(200);

    expect(await notices()).toEqual([
      "bilal | Approval needed",
      "ayesha | Revision requested",
      // Not "Approval needed" a second time.
      "bilal | Resubmitted",
    ]);
  });

  it("asks the first approver again, and nobody who was never asked", async () => {
    // The chain starts over. Chandni and Danish are no more involved than
    // they were the first time round.
    const memo = await submitWithSupporting("Annual increment — Mr Bilal Khan");

    await call("POST", `/api/documents/${memo.id}/request-revision`, {
      token: reviewer.token,
      body: { comment: "Correct the grade." },
    });
    await resubmit(memo.id);

    const told = (await notices()).map((line) => line.split(" | ")[0]);

    expect(told.filter((who) => who === "bilal")).toHaveLength(2);
    expect(told).not.toContain("chandni");
    expect(told).not.toContain("danish");
  });

  it("records the new version and the fresh submission, in that order", async () => {
    const memo = await submitWithSupporting("Annual increment — Mr Bilal Khan");

    await call("POST", `/api/documents/${memo.id}/request-revision`, {
      token: reviewer.token,
      body: { comment: "Correct the grade." },
    });
    await resubmit(memo.id);

    expect(await trail()).toEqual([
      "Ayesha DOCUMENT_SUBMITTED",
      "Ayesha DOCUMENT_SIGNED",
      "Bilal WORKFLOW_REVISION_REQUESTED",
      // The file first, then the submission that acted on it. A records
      // system whose trail says "submitted" before "here is what was
      // submitted" cannot be read back in order.
      "Ayesha DOCUMENT_VERSION_UPLOADED",
      "Ayesha DOCUMENT_SUBMITTED",
      "Ayesha DOCUMENT_SIGNED",
    ]);
  });

  it("keeps the superseded version rather than overwriting it", async () => {
    /*
     * Somebody requested a revision against specific bytes, and the reason is
     * written against them. A records system that deletes the paper it acted
     * on cannot show what was acted on.
     */
    const memo = await submitWithSupporting("Annual increment — Mr Bilal Khan");

    await call("POST", `/api/documents/${memo.id}/request-revision`, {
      token: reviewer.token,
      body: { comment: "Correct the grade." },
    });
    await resubmit(memo.id);

    const versions = await prisma.documentVersion.findMany({
      where: { documentId: memo.id },
      orderBy: { versionNumber: "asc" },
      select: { versionNumber: true, storagePath: true },
    });

    expect(versions).toHaveLength(2);
    expect(versions[0].storagePath).not.toBe(versions[1].storagePath);
  });
});

/** The memo, plus a file attached to it. */
async function submitWithSupporting(title: string) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
    "memo.pdf"
  );
  form.append(
    "supportingFiles",
    new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
    "salary-scale.pdf"
  );
  form.append("title", title);
  form.append("description", "Recommended for approval.");
  form.append(
    "approvalChain",
    JSON.stringify([
      { userId: reviewer.id, approvalType: ApprovalType.REVIEWER },
      { userId: approver.id, approvalType: ApprovalType.APPROVER },
      { userId: finalApprover.id, approvalType: ApprovalType.FINAL_APPROVER },
    ])
  );
  form.append("signature", JSON.stringify(placement()));

  const response = await fetch(`${base}/api/documents`, {
    method: "POST",
    headers: authHeaders(hr.token),
    body: form,
  });

  const json = (await response.json()) as { document?: { id: string } };
  if (response.status !== 201) {
    throw new Error(`Submission failed: ${response.status}`);
  }
  return json.document!;
}

/** HR corrects the memo and sends it round again. */
async function resubmit(documentId: string) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
    "memo-v2.pdf"
  );
  form.append("signature", JSON.stringify(placement()));

  const response = await fetch(`${base}/api/documents/${documentId}`, {
    method: "PATCH",
    headers: authHeaders(hr.token),
    body: form,
  });

  return { status: response.status, text: await response.text() };
}

describe("the attachments on a memo that was sent back", () => {
  /**
   * Whether the bytes are still on disk. `isDeleted` hides a row from every
   * reader; this asks the separate question of whether the file it names
   * still exists, which is what decides if the record can be produced later.
   */
  const bytesOf = async (storagePath: string) => {
    const { promises: fs } = await import("node:fs");
    const nodePath = await import("node:path");

    try {
      await fs.access(
        nodePath.join(process.env.STORAGE_DIR ?? "", "documents", storagePath)
      );
      return "present";
    } catch {
      return "gone";
    }
  };

  /**
   * Corrected, with a new attachment - and, where `remove` names them, the
   * old ones taken off. Taking one off is a choice now (fit-gap decision 8):
   * adding a file no longer replaces the others.
   */
  async function resubmitWithNewAttachment(documentId: string, remove: string[] = []) {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
      "memo-v2.pdf"
    );
    form.append(
      "supportingFiles",
      new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
      "salary-scale-v2.pdf"
    );
    if (remove.length > 0) form.append("removeSupportingIds", JSON.stringify(remove));
    form.append("signature", JSON.stringify(placement()));

    return fetch(`${base}/api/documents/${documentId}`, {
      method: "PATCH",
      headers: authHeaders(hr.token),
      body: form,
    });
  }

  async function sendBackAndCorrect() {
    const memo = await submitWithSupporting("Annual increment — Mr Bilal Khan");

    await call("POST", `/api/documents/${memo.id}/request-revision`, {
      token: reviewer.token,
      body: { comment: "Correct the grade." },
    });

    const original = await prisma.supportingDocument.findFirstOrThrow({
      where: { documentId: memo.id },
    });
    const response = await resubmitWithNewAttachment(memo.id, [original.id]);
    expect(response.status).toBe(200);

    /*
     * Deliberately unordered. Ordering by `fileName` in SQL puts the answer in
     * the hands of the database's collation, and this pair is exactly the case
     * where collations disagree: "salary-scale-v2.pdf" sorts BEFORE
     * "salary-scale.pdf" by byte, because "-" is 0x2D and "." is 0x2E, and
     * AFTER it under a locale that ignores punctuation at the primary level
     * and compares "salaryscalepdf" with "salaryscalev2pdf". It passed on a
     * local container and failed in CI. Every assertion below reads this by
     * name instead.
     */
    return prisma.supportingDocument.findMany({
      where: { documentId: memo.id },
      select: {
        fileName: true,
        storagePath: true,
        isDeleted: true,
        addedInVersion: true,
        removedInVersion: true,
      },
    });
  }

  it("keeps the earlier file when one is added and none is taken off", async () => {
    const memo = await submitWithSupporting("Annual increment — Mr Bilal Khan");
    await call("POST", `/api/documents/${memo.id}/request-revision`, {
      token: reviewer.token,
      body: { comment: "Attach the scale for next year too." },
    });

    expect((await resubmitWithNewAttachment(memo.id)).status).toBe(200);

    const rows = await prisma.supportingDocument.findMany({
      where: { documentId: memo.id },
      select: { fileName: true, isDeleted: true, addedInVersion: true },
    });
    expect(Object.fromEntries(rows.map((row) => [row.fileName, [row.isDeleted, row.addedInVersion]]))).toEqual({
      "salary-scale.pdf": [false, 1],
      "salary-scale-v2.pdf": [false, 2],
    });
  });

  it("records which versions carried a file taken off", async () => {
    const rows = await sendBackAndCorrect();
    const old = rows.find((row) => row.fileName === "salary-scale.pdf");

    expect([old?.addedInVersion, old?.removedInVersion]).toEqual([1, 2]);
  });

  it("refuses to take off a file the memo does not carry", async () => {
    const memo = await submitWithSupporting("Annual increment — Mr Bilal Khan");
    await call("POST", `/api/documents/${memo.id}/request-revision`, {
      token: reviewer.token,
      body: { comment: "Correct the grade." },
    });

    const response = await resubmitWithNewAttachment(memo.id, [
      "00000000-0000-4000-8000-0000000000aa",
    ]);

    expect(response.status).toBe(400);
  });

  it("keeps the file the memo was returned over", async () => {
    /*
     * The bytes used to be deleted from storage while the row naming them
     * survived. That held the memo and its attachments to opposite standards:
     * the superseded version of the memo itself is kept on the grounds that a
     * records system cannot show what was acted on if it destroys the paper
     * it acted on - and an approver who returned this memo may have done so
     * precisely because of what was in the attachment.
     */
    const rows = await sendBackAndCorrect();
    const old = rows.find((row) => row.fileName === "salary-scale.pdf");

    expect(old?.isDeleted).toBe(true);
    expect(await bytesOf(old!.storagePath)).toBe("present");
  });

  it("takes it out of view all the same", async () => {
    // Kept is not the same as shown. `isDeleted` is what every reader filters
    // on, so marking the row is the whole of the job.
    const rows = await sendBackAndCorrect();

    // By name rather than by position: what this asserts is which file is
    // hidden, and the order they come back in is the database's business.
    expect(Object.fromEntries(rows.map((row) => [row.fileName, row.isDeleted]))).toEqual({
      "salary-scale-v2.pdf": false,
      "salary-scale.pdf": true,
    });
  });

  it("holds the superseded memo to the same standard it always did", async () => {
    // The contrast that made the old behaviour wrong. Both now survive.
    const memo = await submitWithSupporting("Annual increment — Mr Bilal Khan");

    await call("POST", `/api/documents/${memo.id}/request-revision`, {
      token: reviewer.token,
      body: { comment: "Correct the grade." },
    });
    await resubmitWithNewAttachment(memo.id);

    const versions = await prisma.documentVersion.findMany({
      where: { documentId: memo.id },
      orderBy: { versionNumber: "asc" },
      select: { storagePath: true },
    });

    expect(versions).toHaveLength(2);
    for (const version of versions) {
      expect(await bytesOf(version.storagePath)).toBe("present");
    }
  });
});
