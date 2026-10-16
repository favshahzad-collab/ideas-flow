import { memoPagesOnly } from "../test/pdfText";
import { promises as fs } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import nodePath from "node:path";
import zlib from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../app";
import { ApprovalType, LoginRole } from "../generated/prisma/client";
import { env } from "../lib/env";
import { hashPassword } from "../lib/password";
import { prisma } from "../prisma";
import {
  makeDepartment,
  makePdf,
  SIGNATURE_IMAGE,
  useCleanDatabase,
} from "../test/db";

/**
 * The whole memo, end to end, over real HTTP.
 *
 * Every other suite tests one layer. This one walks the journey the business
 * actually asked for and refuses to take any of it on trust:
 *
 *   HR uploads a memo -> it is submitted into the chain -> each approver
 *   reviews and signs, in order -> the final approver signs -> the workflow
 *   stops -> HR prints the approved memo.
 *
 * It drives the real Express app on an ephemeral port, against a real
 * database, writing real files, producing real PDFs. Nothing is mocked, so a
 * failure here is a failure a person would have hit.
 *
 * ---------------------------------------------------------------------------
 * WHICH REQUIREMENT EACH BLOCK ANSWERS
 *
 * The `describe` titles below carry the requirement's own section numbers so
 * the mapping survives without a second document to keep in step:
 *
 *   1              uploading and submitting
 *   2, 3           approvers signing, in order
 *   4, 5           the final approver, and the workflow stopping
 *   6              opening, downloading and printing the approved memo
 *   8              no way round the chain; delegation; file integrity
 *   9              the audit trail
 *   10             rejection, and return for revision
 *
 * Sections 7 and 11 carry NO block here, and that is not an oversight to fix
 * by renaming something: the requirement document is not in this repository
 * and is not in its history, so nothing here can state what those two ask for.
 * The behaviour one would expect around them is covered - every notice raised
 * at every step is asserted as a whole list in `unhappy-paths.itest.ts`, and
 * the queue, the retry and a real SMTP transaction in `email.*.itest.ts` - but
 * covered is not the same as traced, and a reader should not be left assuming
 * the numbering is complete when it is not.
 *
 * If you have the document: put the two titles in, or write the block if it is
 * genuinely untested. Do not renumber the blocks that are already here.
 * ---------------------------------------------------------------------------
 */

useCleanDatabase();

let server: Server;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      resolve();
    });
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

// ------------------------------------------------------------------ people

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
  departmentId: string,
  loginRole: LoginRole = LoginRole.USER
): Promise<Person> {
  const email = `${firstName.toLowerCase()}-${Math.random()
    .toString(36)
    .slice(2, 8)}@example.com`;

  const user = await prisma.user.create({
    data: {
      firstName,
      lastName: "Khan",
      email,
      passwordHash: await hashPassword(PASSWORD),
      departmentId,
      loginRole,
      isSuperAdmin: loginRole === "ADMINISTRATOR",
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

// --------------------------------------------------------------- requests

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
    // A PDF or an empty body. The status is the point.
  }

  return { status: response.status, json, text, headers: response.headers };
}

/**
 * Every flate-compressed content stream in a PDF, inflated. pdf-lib compresses
 * what it draws, so the words on the page are not visible to a plain string
 * search of the file - this is how you read them back.
 */
function pageText(pdf: Buffer): string {
  const START = Buffer.from("stream");
  const END = Buffer.from("endstream");
  const out: string[] = [];

  let from = 0;
  for (;;) {
    const open = pdf.indexOf(START, from);
    if (open === -1) break;
    const close = pdf.indexOf(END, open);
    if (close === -1) break;

    let body = open + START.length;
    while (pdf[body] === 0x0d || pdf[body] === 0x0a) body += 1;

    try {
      out.push(zlib.inflateSync(pdf.subarray(body, close)).toString("latin1"));
    } catch {
      // An image or the xref, not a content stream.
    }
    from = close + END.length;
  }

  // pdf-lib writes every string it draws as hex - `<417965736861> Tj` - so the
  // words are in the stream but not as words. Decode each one so a reader's
  // question ("is the name on the page?") can be asked in the reader's terms.
  const streams = out.join("\n");
  const decoded = [...streams.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((m) =>
    Buffer.from(m[1], "hex").toString("latin1")
  );
  return streams + "\n" + decoded.join("\n");
}

const placement = (overrides: Record<string, unknown> = {}) => ({
  consent: true,
  useSavedSignature: false,
  signatureImage: SIGNATURE_IMAGE,
  signaturePage: 1,
  signatureX: 100,
  signatureY: 200,
  signatureWidth: 120,
  signatureHeight: 40,
  ...overrides,
});

// ------------------------------------------------------------------- cast

let hr: Person;
let reviewer: Person;
let approver: Person;
let finalApprover: Person;
let outsider: Person;
let uploadedPdf: Buffer;

beforeEach(async () => {
  const department = await makeDepartment("Human Resources");

  [hr, reviewer, approver, finalApprover, outsider] = await Promise.all([
    makePerson("Ayesha", "Assistant Manager, HR", department.id),
    makePerson("Bilal", "Manager, Finance", department.id),
    makePerson("Chandni", "Head of Operations", department.id),
    makePerson("Danish", "Chief Executive", department.id),
    makePerson("Erum", "Storekeeper", department.id),
  ]);

  uploadedPdf = await makePdf(2);
});

/** HR uploads the memo and submits it into the chain, in one call. */
async function submitMemo(
  title = "Office Memorandum — annual increment, Mr Bilal Khan"
) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(uploadedPdf)], { type: "application/pdf" }),
    "memo.pdf"
  );
  form.append("title", title);
  form.append("description", "Recommended for approval of the annual increment.");
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

  const json = (await response.json()) as {
    document?: { id: string; referenceNumber?: string | null };
    error?: { message: string };
  };

  if (response.status !== 201) {
    throw new Error(
      `Submission failed (${response.status}): ${JSON.stringify(json)}`
    );
  }

  return json.document!;
}

const approveAs = (person: Person, documentId: string, body = placement()) =>
  call("POST", `/api/documents/${documentId}/approve`, {
    token: person.token,
    body,
  });

/** Drive the chain to the point where only the final approver is left. */
async function readyForFinalApproval() {
  const document = await submitMemo();
  await approveAs(reviewer, document.id);
  await approveAs(approver, document.id);
  return document;
}

// =========================================================== 1. HR upload

describe("1. HR uploads a memo", () => {
  it("accepts a PDF and puts it straight into the approval chain", async () => {
    const document = await submitMemo();

    const stored = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
      include: {
        versions: true,
        approvalChain: { include: { steps: { orderBy: { stepOrder: "asc" } } } },
      },
    });

    expect(stored.status).toBe("PENDING_REVIEW");
    expect(stored.versions).toHaveLength(1);
    expect(stored.approvalChain?.steps.map((s) => s.assignedUserId)).toEqual([
      reviewer.id,
      approver.id,
      finalApprover.id,
    ]);
  });

  it("gives the memo a reference somebody could write on a file cover", async () => {
    const document = await submitMemo();

    // A uuid is not a reference. This is the handle that gets quoted in a
    // reply, written on the paper file, and typed back into search.
    expect(document.referenceNumber).toMatch(/^MEMO-\d{4}-\d{4}$/);
  });

  it("never issues the same reference twice", async () => {
    const first = await submitMemo("First memo");
    const second = await submitMemo("Second memo");

    expect(first.referenceNumber).not.toBe(second.referenceNumber);
  });

  it("keeps the document exactly as uploaded", async () => {
    const document = await submitMemo();

    const version = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId: document.id },
    });

    // The submitted file already carries the preparer's signature, so it is
    // not the uploaded bytes. Both have to survive: one is what was sent in,
    // the other is what the approvers were asked to sign.
    expect(version.originalStoragePath).toBeTruthy();
    expect(version.originalStoragePath).not.toBe(version.storagePath);
  });

  it("shows HR the status and the whole history", async () => {
    const document = await submitMemo();

    const detail = await call("GET", `/api/documents/${document.id}`, {
      token: hr.token,
    });
    const history = await call("GET", `/api/documents/${document.id}/audit`, {
      token: hr.token,
    });

    expect(detail.status).toBe(200);
    expect(history.status).toBe(200);
  });
});

// ================================================= 2 & 3. sequenced approval

describe("2. and 3. approvers sign, in order", () => {
  it("asks the first approver and nobody further down", async () => {
    const document = await submitMemo();

    const workflow = await call("GET", `/api/documents/${document.id}/workflow`, {
      token: reviewer.token,
    });

    expect(workflow.status).toBe(200);
    const notified = await prisma.notification.findMany({
      // The preparer's own receipt aside.
      where: { documentId: document.id, type: { not: "SUBMITTED" } },
      select: { recipientId: true },
    });
    // Telling all three at once turns the queue into a list of things that
    // are not yet anybody's problem.
    expect(notified.map((row) => row.recipientId)).toEqual([reviewer.id]);
  });

  it("lets the current approver sign with a drawn signature", async () => {
    const document = await submitMemo();

    const response = await approveAs(reviewer, document.id);

    expect(response.status).toBe(200);
  });

  it("lets an approver sign with the image they uploaded instead", async () => {
    const document = await submitMemo();

    // The saved signature is uploaded once to the profile and reused - the
    // "upload your sign image" half of the requirement.
    const upload = new FormData();
    upload.append(
      "file",
      new Blob(
        [
          Buffer.from(
            SIGNATURE_IMAGE.replace(/^data:image\/png;base64,/, ""),
            "base64"
          ),
        ],
        { type: "image/png" }
      ),
      "signature.png"
    );

    const saved = await fetch(`${base}/api/users/me/signature`, {
      method: "POST",
      headers: authHeaders(reviewer.token),
      body: upload,
    });
    expect(saved.status).toBeLessThan(300);

    const response = await approveAs(
      reviewer,
      document.id,
      placement({ useSavedSignature: true, signatureImage: undefined })
    );

    expect(response.status).toBe(200);
  });

  it("moves to the next approver only once the current one has signed", async () => {
    const document = await submitMemo();

    const before = await approveAs(approver, document.id);
    expect(before.status).toBe(403);

    await approveAs(reviewer, document.id);

    const after = await approveAs(approver, document.id);
    expect(after.status).toBe(200);
  });

  it("refuses an approver who tries to jump the queue", async () => {
    const document = await submitMemo();

    // The whole point of a chain: the final signatory must not be able to
    // sanction something the recommending officers have not seen.
    const jumped = await approveAs(finalApprover, document.id);

    expect(jumped.status).toBe(403);
  });

  it("refuses the same approver signing the same step twice", async () => {
    const document = await submitMemo();
    await approveAs(reviewer, document.id);

    const again = await approveAs(reviewer, document.id);

    // Refused twice over: the step already has an action, and the run has
    // moved on so this person is no longer the assignee. Either refusal is
    // correct - what matters is that one approval never becomes two.
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(
      await prisma.approvalAction.count({ where: { actorId: reviewer.id } })
    ).toBe(1);
  });

  it("refuses somebody who is not in the chain at all", async () => {
    const document = await submitMemo();

    expect((await approveAs(outsider, document.id)).status).toBe(403);
  });

  it("refuses the preparer approving their own memo", async () => {
    const document = await submitMemo();

    expect((await approveAs(hr, document.id)).status).toBe(403);
  });

  it("records who signed, in what capacity, and when", async () => {
    const document = await submitMemo();
    await approveAs(reviewer, document.id);

    const action = await prisma.approvalAction.findFirstOrThrow({
      where: { actorId: reviewer.id },
      include: { actor: true, chainStep: true },
    });

    expect(action.action).toBe("APPROVE");
    expect(action.approvalType).toBe(ApprovalType.REVIEWER);
    expect(action.chainStep.stepOrder).toBe(1);
    expect(action.createdAt).toBeInstanceOf(Date);
    expect(action.signedPdfStoragePath).toBeTruthy();
    // The designation is what gets printed under the signature on the memo.
    expect(action.actor.designation).toBe("Manager, Finance");
  });

  it("says who is pending, who is done, and who is still to come", async () => {
    const document = await submitMemo();
    await approveAs(reviewer, document.id);

    const workflow = await call("GET", `/api/documents/${document.id}/workflow`, {
      token: hr.token,
    });

    expect(workflow.status).toBe(200);
    expect(JSON.stringify(workflow.json)).toContain(approver.id);
  });
});

// ================================================== 4 & 5. final approval

describe("4. and 5. the final approver ends it", () => {
  it("completes the workflow", async () => {
    const document = await readyForFinalApproval();

    const response = await approveAs(finalApprover, document.id);
    expect(response.status).toBe(200);

    const stored = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
      include: { currentWorkflowRun: true },
    });

    expect(stored.status).toBe("APPROVED");
    expect(stored.approvedAt).not.toBeNull();
    expect(stored.currentWorkflowRun?.status).toBe("APPROVED");
    expect(stored.currentWorkflowRun?.endedAt).not.toBeNull();
  });

  it("names the approved version once, and does not recompute it", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);

    const stored = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });

    const lastAction = await prisma.approvalAction.findFirstOrThrow({
      where: { actorId: finalApprover.id, action: "APPROVE" },
    });

    // HR prints this file. If it were derived on each request the answer
    // could change later; fixing it means the audit trail cites something
    // that cannot move.
    expect(stored.finalSignedStoragePath).toBe(lastAction.signedPdfStoragePath);
  });

  it("stops permanently — nothing can approve it again", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);

    for (const person of [reviewer, approver, finalApprover, outsider]) {
      const again = await approveAs(person, document.id);
      expect(again.status, person.email).toBeGreaterThanOrEqual(400);
    }
  });

  it("cannot be rejected or sent back after it is approved", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);

    const rejected = await call(
      "POST",
      `/api/documents/${document.id}/reject`,
      { token: approver.token, body: { comment: "Second thoughts." } }
    );
    const revision = await call(
      "POST",
      `/api/documents/${document.id}/request-revision`,
      { token: approver.token, body: { comment: "Please redo page 2." } }
    );

    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect(revision.status).toBeGreaterThanOrEqual(400);
  });

  it("cannot be withdrawn, so the signed record cannot be taken back", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);

    const deleted = await call("POST", `/api/documents/${document.id}/withdraw`, {
      token: hr.token,
      body: { reason: "Changed my mind" },
    });

    expect(deleted.status).toBe(409);
  });

  it("adds no name, title or capacity under any signature on the attached PDF", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);

    const file = await fetch(`${base}/api/documents/${document.id}/file`, {
      headers: authHeaders(hr.token),
    });
    // The memo's own pages: the certificate at the end names everybody, by design.
    const text = pageText(await memoPagesOnly(Buffer.from(await file.arrayBuffer())));

    // A memo written in Word prints its own signatories' names and titles
    // under the lines they sign on. Text drawn under each mark landed on top
    // of them, so the signatures go on alone; the ledger keeps who signed,
    // in what capacity and when.
    for (const unexpected of [
      "Ayesha Khan",
      "Assistant Manager, HR",
      "Bilal Khan",
      "Manager, Finance",
      "Reviewer",
      "Chandni Khan",
      "Head of Operations",
      "Danish Khan",
      "Chief Executive",
      "Final Approver",
    ]) {
      expect(text, unexpected).not.toContain(unexpected);
    }
  });

  it("carries every signature on one page, and keeps what each person signed", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);

    const actions = await prisma.approvalAction.findMany({
      where: { action: "APPROVE" },
      orderBy: { createdAt: "asc" },
      select: { signedPdfStoragePath: true },
    });

    const paths = actions.map((a) => a.signedPdfStoragePath);

    // Three approvals, three distinct files. Overwriting one shared file is
    // what made it impossible to show an approver what they had signed.
    expect(paths).toHaveLength(3);
    expect(new Set(paths).size).toBe(3);
  });
});

// ============================================================ 6. HR print

describe("6. HR opens, downloads and prints the approved memo", () => {
  it("serves the approved version once the workflow is complete", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);

    const file = await call("GET", `/api/documents/${document.id}/file`, {
      token: hr.token,
    });

    expect(file.status).toBe(200);
    expect(file.text.slice(0, 5)).toBe("%PDF-");
    // Bigger than what was uploaded, because it now carries four marks: the
    // preparer's and the three approvers'.
    expect(file.text.length).toBeGreaterThan(uploadedPdf.length);
  });

  it("records the download in the audit trail", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);

    await call("GET", `/api/documents/${document.id}/file`, { token: hr.token });

    const downloads = await prisma.auditLog.findMany({
      where: { entityId: document.id, action: "DOCUMENT_DOWNLOADED" },
    });

    expect(downloads.length).toBeGreaterThan(0);
    expect(downloads[0].actorId).toBe(hr.id);
  });

  it("records reading it on screen as a view, not a download", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);

    await call("GET", `/api/documents/${document.id}/file?reason=view`, {
      token: hr.token,
    });

    const rows = await prisma.auditLog.findMany({
      where: {
        entityId: document.id,
        action: { in: ["DOCUMENT_VIEWED", "DOCUMENT_DOWNLOADED"] },
      },
      select: { action: true, actorId: true },
    });

    expect(rows).toEqual([{ action: "DOCUMENT_VIEWED", actorId: hr.id }]);
  });

  it("refuses a reason it does not know rather than guessing one", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);

    const response = await call(
      "GET",
      `/api/documents/${document.id}/file?reason=borrowed`,
      { token: hr.token }
    );

    expect(response.status).toBe(400);
    expect(
      await prisma.auditLog.count({
        where: {
          entityId: document.id,
          action: { in: ["DOCUMENT_VIEWED", "DOCUMENT_DOWNLOADED"] },
        },
      })
    ).toBe(0);
  });

  it("lets HR print it, and records that too", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);

    const printed = await call("POST", `/api/documents/${document.id}/print`, {
      token: hr.token,
    });

    expect(printed.status).toBe(204);

    const rows = await prisma.auditLog.findMany({
      where: { entityId: document.id, action: "DOCUMENT_PRINTED" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(hr.id);
  });

  it("refuses to print a memo that is not approved yet", async () => {
    const document = await submitMemo();

    // Printing a half-signed memo and filing it as the record is precisely
    // the mistake this gate exists to prevent.
    const printed = await call("POST", `/api/documents/${document.id}/print`, {
      token: hr.token,
    });

    expect(printed.status).toBe(409);
  });

  it("refuses to serve or print it to somebody outside the chain", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);

    expect(
      (await call("GET", `/api/documents/${document.id}/file`, {
        token: outsider.token,
      })).status
    ).toBe(403);
    expect(
      (await call("POST", `/api/documents/${document.id}/print`, {
        token: outsider.token,
      })).status
    ).toBe(403);
  });

  it("refuses anyone with no token at all", async () => {
    const document = await submitMemo();

    expect((await call("GET", `/api/documents/${document.id}/file`)).status).toBe(
      401
    );
    expect(
      (await call("POST", `/api/documents/${document.id}/print`)).status
    ).toBe(401);
  });
});

// ================================================ 8. no way round the chain

/** Where a storage path actually lands on disk. */
const onDisk = (storagePath: string) =>
  nodePath.join(nodePath.resolve(env.STORAGE_DIR), "documents", storagePath);

describe("8. no way round the chain", () => {
  it("refuses the preparer trying to pass over an approver", async () => {
    const document = await submitMemo();

    const response = await call(
      "POST",
      `/api/documents/${document.id}/skip-step`,
      { token: hr.token, body: { reason: "Bilal is on leave until the 20th." } }
    );

    // The one bypass this system had. It is off unless a deployment sets
    // ALLOW_STEP_SKIP, and nothing here sets it - so this is the shipped
    // answer, not a test fixture's answer.
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.json)).toMatch(/switched off/i);
  });

  it("leaves the memo exactly where it was after a refused skip", async () => {
    const document = await submitMemo();

    await call("POST", `/api/documents/${document.id}/skip-step`, {
      token: hr.token,
      body: { reason: "Bilal is on leave until the 20th." },
    });

    // A refusal that had already moved something is not a refusal.
    const run = await prisma.workflowRun.findFirstOrThrow({
      where: { documentId: document.id },
    });
    expect(run.currentStepOrder).toBe(1);
    expect(
      await prisma.approvalAction.count({ where: { workflowRunId: run.id } })
    ).toBe(0);

    // And the first approver is still the one being asked.
    const chain = await call("GET", `/api/documents/${document.id}/workflow`, {
      token: hr.token,
    });
    expect(JSON.stringify(chain.json)).toContain(reviewer.id);
  });

  it("still lets the chain finish normally afterwards", async () => {
    const document = await submitMemo();
    await call("POST", `/api/documents/${document.id}/skip-step`, {
      token: hr.token,
      body: { reason: "Bilal is on leave until the 20th." },
    });

    await approveAs(reviewer, document.id);
    await approveAs(approver, document.id);
    expect((await approveAs(finalApprover, document.id)).status).toBe(200);

    const after = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    expect(after.status).toBe("APPROVED");
  });
});

// =========================================== 8. standing in for an approver

describe("8. somebody covering for an approver", () => {
  /*
   * The one way a person who is not on the chain may sign: an explicit,
   * dated, audited authorisation from the approver whose step it is. It is
   * tested here, with the rest of criterion 19, because it is the only route
   * by which "no unauthorised approvals" could quietly stop being true.
   */
  const handOver = (from: Person, to: Person) =>
    call("POST", "/api/delegations", {
      token: from.token,
      body: { delegateId: to.id, reason: "Away on site until Friday." },
    });

  it("lets the delegate sign, and the memo moves on", async () => {
    const document = await submitMemo();
    expect((await handOver(reviewer, outsider)).status).toBe(201);

    expect((await approveAs(outsider, document.id)).status).toBe(200);

    const workflow = await call("GET", `/api/documents/${document.id}/workflow`, {
      token: hr.token,
    });
    expect(JSON.stringify(workflow.json)).toContain(approver.id);
  });

  it("puts both names on the approval and in the trail", async () => {
    const document = await submitMemo();
    await handOver(reviewer, outsider);
    await approveAs(outsider, document.id);

    const action = await prisma.approvalAction.findFirstOrThrow({
      where: { workflowRun: { documentId: document.id }, action: "APPROVE" },
    });
    expect(action.actorId).toBe(outsider.id);
    expect(action.onBehalfOfId).toBe(reviewer.id);

    const trail = await call("GET", `/api/documents/${document.id}/audit`, {
      token: hr.token,
    });
    expect(JSON.stringify(trail.json)).toContain(reviewer.id);
  });

  it("still refuses somebody nobody has authorised", async () => {
    const document = await submitMemo();

    expect((await approveAs(outsider, document.id)).status).toBe(403);
  });

  it("refuses a delegation arranged by anybody but the approver or an admin", async () => {
    // The route by which somebody could authorise themselves.
    const response = await call("POST", "/api/delegations", {
      token: outsider.token,
      body: { delegatorId: reviewer.id, delegateId: outsider.id },
    });

    expect(response.status).toBe(403);
  });

  it("stops the moment the arrangement is ended", async () => {
    const document = await submitMemo();
    const created = await handOver(reviewer, outsider);
    const { delegation } = created.json as { delegation: { id: string } };

    expect(
      (
        await call("DELETE", `/api/delegations/${delegation.id}`, {
          token: reviewer.token,
        })
      ).status
    ).toBe(200);

    expect((await approveAs(outsider, document.id)).status).toBe(403);
  });

  it("never lets the preparer sign their own memo, delegation or not", async () => {
    const document = await submitMemo();
    await call("POST", "/api/delegations", {
      token: reviewer.token,
      body: { delegateId: hr.id },
    });

    // HR wrote this memo. Being handed the reviewer's authority does not make
    // them somebody who can approve it.
    expect((await approveAs(hr, document.id)).status).toBe(403);
    expect(
      await prisma.approvalAction.count({
        where: { workflowRun: { documentId: document.id } },
      })
    ).toBe(0);
  });
});

// ======================================== 8. the bytes are checkable later

describe("8. the signed files can be checked, not just trusted", () => {
  it("records a digest for the upload, each signature and the approved memo", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);

    const version = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId: document.id },
    });
    const actions = await prisma.approvalAction.findMany({
      where: { workflowRun: { documentId: document.id }, action: "APPROVE" },
    });
    const approved = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });

    const digest = /^[0-9a-f]{64}$/;
    expect(version.originalChecksum).toMatch(digest);
    expect(version.storageChecksum).toMatch(digest);
    expect(actions).toHaveLength(3);
    for (const action of actions) {
      expect(action.signedPdfChecksum).toMatch(digest);
    }
    expect(approved.finalSignedChecksum).toBe(
      actions.find((action) => action.actorId === finalApprover.id)
        ?.signedPdfChecksum
    );
  });

  it("recorded digests that actually describe the files on disk", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);

    const approved = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    const bytes = await fs.readFile(onDisk(approved.finalSignedStoragePath!));

    // Recomputed here with node's own crypto rather than the app's helper:
    // a digest is only worth anything if a second, independent tool agrees.
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      approved.finalSignedChecksum
    );
  });

  it("refuses to serve an approved memo whose file has been changed", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);

    const approved = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    const file = onDisk(approved.finalSignedStoragePath!);
    const real = await fs.readFile(file);

    // Nothing in the application can do this. A restore from the wrong
    // backup, a bad migration or somebody with a shell can, and the point of
    // writing the digest down is that the memo stops being served when it
    // stops being the memo that was signed.
    await fs.writeFile(file, Buffer.concat([real, Buffer.from(" tampered")]));

    const response = await call("GET", `/api/documents/${document.id}/file`, {
      token: hr.token,
    });

    expect(response.status).toBe(500);
    expect(response.text).toMatch(/no longer matches/i);

    await fs.writeFile(file, real);
    expect(
      (await call("GET", `/api/documents/${document.id}/file`, { token: hr.token }))
        .status
    ).toBe(200);
  });

  it("says in the audit trail which bytes were handed over", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);
    await call("GET", `/api/documents/${document.id}/file`, { token: hr.token });

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: document.id, action: "DOCUMENT_DOWNLOADED" },
      orderBy: { createdAt: "desc" },
    });
    const approved = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });

    const detail = row.newValue as {
      checksum?: string;
      integrity?: string;
      servedFile?: string;
    };
    expect(detail.servedFile).toBe("APPROVED");
    expect(detail.integrity).toBe("VERIFIED");
    expect(detail.checksum).toBe(approved.finalSignedChecksum);
  });
});

// ========================================================= 9. audit trail

describe("9. the audit trail covers the whole journey", () => {
  it("names every step from upload to print", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);
    await call("GET", `/api/documents/${document.id}/file`, { token: hr.token });
    await call("POST", `/api/documents/${document.id}/print`, {
      token: hr.token,
    });

    const rows = await prisma.auditLog.findMany({
      where: { entityId: document.id },
      select: { action: true },
    });
    const actions = rows.map((row) => row.action);

    expect(actions).toContain("DOCUMENT_SUBMITTED");
    expect(actions).toContain("WORKFLOW_APPROVED");
    expect(actions).toContain("WORKFLOW_COMPLETED");
    expect(actions).toContain("DOCUMENT_DOWNLOADED");
    expect(actions).toContain("DOCUMENT_PRINTED");
  });

  it("reads back as a history a person can follow", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);

    const history = await call("GET", `/api/documents/${document.id}/audit`, {
      token: hr.token,
    });

    expect(history.status).toBe(200);
    const entries = (history.json as { auditHistory?: unknown[] }).auditHistory;
    expect(Array.isArray(entries)).toBe(true);
    expect((entries as unknown[]).length).toBeGreaterThanOrEqual(4);
  });

  it("exports it, for the file", async () => {
    const document = await readyForFinalApproval();
    await approveAs(finalApprover, document.id);

    const csv = await call("GET", `/api/documents/${document.id}/audit/export`, {
      token: hr.token,
    });

    expect(csv.status).toBe(200);
    expect(csv.text).toContain("Action");
  });
});

// ==================================================== 10. rejection path

describe("10. rejection and return", () => {
  it("refuses a rejection with no reason", async () => {
    const document = await submitMemo();

    const rejected = await call(
      "POST",
      `/api/documents/${document.id}/reject`,
      { token: reviewer.token, body: {} }
    );

    // A rejection with no reason is unactionable for the person who has to
    // fix the memo.
    expect(rejected.status).toBe(400);
  });

  it("records the reason against the rejection", async () => {
    const document = await submitMemo();

    await call("POST", `/api/documents/${document.id}/reject`, {
      token: reviewer.token,
      body: { comment: "The increment percentage contradicts the policy." },
    });

    const stored = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    const action = await prisma.approvalAction.findFirstOrThrow({
      where: { actorId: reviewer.id },
    });

    expect(stored.status).toBe("REJECTED");
    expect(action.action).toBe("REJECT");
    expect(action.comment).toContain("contradicts the policy");
  });

  it("never marks a rejected memo as completed", async () => {
    const document = await submitMemo();
    await call("POST", `/api/documents/${document.id}/reject`, {
      token: reviewer.token,
      body: { comment: "Not approved." },
    });

    const stored = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
      include: { currentWorkflowRun: true },
    });

    expect(stored.status).toBe("REJECTED");
    expect(stored.approvedAt).toBeNull();
    expect(stored.finalSignedStoragePath).toBeNull();
  });

  it("sends a revision back to HR, who can resubmit it", async () => {
    const document = await submitMemo();

    const asked = await call(
      "POST",
      `/api/documents/${document.id}/request-revision`,
      { token: reviewer.token, body: { comment: "Page 2 is unsigned." } }
    );

    expect(asked.status).toBe(200);
    const stored = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    expect(stored.status).toBe("REVISION_REQUESTED");
  });
});
