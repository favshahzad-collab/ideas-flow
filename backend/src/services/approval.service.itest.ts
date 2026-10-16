import { memoPagesOnly } from "../test/pdfText";
import { promises as fs } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "../lib/env";
import { storageService } from "../lib/storage";
import { prisma } from "../prisma";
import { approveDocumentSchema } from "../schemas/approval.schema";
import { allowStepSkipInThisSuite } from "../test/stepSkip";
import {
  chainOf,
  currentPosition,
  makeCast,
  makeUser,
  signature,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { approvalService } from "./approval.service";
import { usersService } from "./users.service";

/**
 * The workflow rules. Every action here is one transaction that writes an
 * approval action, moves or ends the run, changes the document's status,
 * writes an audit row and fans out notifications - and burns a signature into
 * a PDF outside the transaction, before it opens.
 *
 * What makes these worth running against a real database is that most of the
 * rules are about *refusal*: who may act, when, and how often. A mock would
 * happily agree that the wrong person was refused while the query that
 * decides it had drifted.
 */

useCleanDatabase();

type Cast = Awaited<ReturnType<typeof makeCast>>;

let cast: Cast;
let documentId: string;

/** A three-step chain sitting on step 1, submitted by the preparer. */
beforeEach(async () => {
  cast = await makeCast();
  const document = await submitDocument({
    preparerId: cast.preparer.id,
    approvalChain: chainOf(cast.reviewer, cast.approver, cast.finalApprover),
    title: "Warehouse lease extension",
  });
  documentId = document.id;
});

const approvalInput = () => {
  const { useSavedSignature: _saved, ...placement } = signature();
  return { ...placement, useSavedSignature: false } as Parameters<
    typeof approvalService.approve
  >[2];
};

const storedFile = async () => {
  const version = await prisma.documentVersion.findFirstOrThrow({
    where: { documentId },
    orderBy: { versionNumber: "desc" },
  });
  return path.join(
    path.resolve(env.STORAGE_DIR),
    "documents",
    version.storagePath
  );
};

const storedBytes = async () => fs.readFile(await storedFile());

/** The bytes one approver actually signed, as named by their own action row. */
const signedBytesFor = async (actorId: string) => {
  const action = await prisma.approvalAction.findFirstOrThrow({
    where: { actorId, action: "APPROVE" },
    orderBy: { createdAt: "desc" },
  });
  return fs.readFile(
    path.join(
      path.resolve(env.STORAGE_DIR),
      "documents",
      action.signedPdfStoragePath as string
    )
  );
};

/** The file fixed as the approved version when the last approver signed. */
const finalSignedBytes = async () => {
  const document = await prisma.document.findUniqueOrThrow({
    where: { id: documentId },
  });
  return fs.readFile(
    path.join(
      path.resolve(env.STORAGE_DIR),
      "documents",
      document.finalSignedStoragePath as string
    )
  );
};

/** Put something on disk under the path the workflow will go looking for. */
const replaceStoredBytes = async (bytes: Buffer) =>
  fs.writeFile(await storedFile(), bytes);

/** Walk the chain forward by approving as whoever it is currently waiting on. */
const approveAs = (actorId: string) =>
  approvalService.approve(documentId, actorId, approvalInput());

/** Approve with one part of the signature request replaced. */
const approveWith = (actorId: string, overrides: Record<string, unknown>) =>
  approvalService.approve(documentId, actorId, {
    ...approvalInput(),
    ...overrides,
  });

/** The page every fixture document is built on, from `makePdf`. */
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;

/**
 * The lines of text in a PDF, with the baseline each was drawn on.
 *
 * pdf-lib flate-compresses its content streams and writes standard-font text
 * as WinAnsi hex, so getting the words back means inflating every stream and
 * decoding the show-text operands. The twin of this lives in
 * `src/lib/pdfSignature.test.ts`, which is where the drawing itself is pinned
 * down; here it answers a different question - what ended up in the file the
 * workflow filed.
 */
function drawnText(pdf: Buffer): { y: number; text: string }[] {
  const START = Buffer.from("stream");
  const END = Buffer.from("endstream");
  const N = "(-?\\d+(?:\\.\\d+)?)";
  const line = new RegExp(`1 0 0 1 ${N} ${N} Tm\\s+<([0-9A-Fa-f]*)> Tj`, "g");
  const found: { y: number; text: string }[] = [];

  let from = 0;
  for (;;) {
    const open = pdf.indexOf(START, from);
    if (open === -1) break;
    const close = pdf.indexOf(END, open);
    if (close === -1) break;

    let body = open + START.length;
    while (pdf[body] === 0x0d || pdf[body] === 0x0a) body += 1;

    try {
      const stream = zlib
        .inflateSync(pdf.subarray(body, close))
        .toString("latin1");

      for (const match of stream.matchAll(line)) {
        found.push({
          y: Number(match[2]),
          text: Buffer.from(match[3], "hex").toString("latin1"),
        });
      }
    } catch {
      // Not a flate stream - an embedded image, or the xref.
    }
    from = close + END.length;
  }

  return found;
}

const signedTextFor = async (actorId: string) =>
  drawnText(await signedBytesFor(actorId));

describe("approve", () => {
  it("hands the document to the next step", async () => {
    const response = await approveAs(cast.reviewer.id);

    expect(await currentPosition(documentId)).toEqual({
      status: "PENDING_REVIEW",
      runStatus: "IN_PROGRESS",
      stepOrder: 2,
      assignedTo: cast.approver.id,
    });

    expect(response).toMatchObject({
      documentStatus: "PENDING_REVIEW",
      workflowStatus: "IN_PROGRESS",
      currentStepOrder: 2,
    });
    expect(response.action.action).toBe("APPROVE");
  });

  it("records the action against the step that was acted on", async () => {
    await approveAs(cast.reviewer.id);

    const action = await prisma.approvalAction.findFirstOrThrow({
      include: { chainStep: true },
    });

    expect(action.actorId).toBe(cast.reviewer.id);
    expect(action.action).toBe("APPROVE");
    expect(action.chainStep.stepOrder).toBe(1);
    expect(action.chainStep.assignedUserId).toBe(cast.reviewer.id);
  });

  it("adds each signature to the one before, cumulatively", async () => {
    const asSubmitted = await storedBytes();

    await approveAs(cast.reviewer.id);
    const afterFirst = await signedBytesFor(cast.reviewer.id);

    await approveAs(cast.approver.id);
    const afterSecond = await signedBytesFor(cast.approver.id);

    // The second approver signs what the first one left, not the original, so
    // the finished page carries every mark. The signed document IS the record
    // - there is no separate certificate to lose.
    expect(afterFirst.length).toBeGreaterThan(asSubmitted.length);
    expect(afterSecond.length).toBeGreaterThan(afterFirst.length);
    expect(afterSecond.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("never writes over the document as it was submitted", async () => {
    // This is what makes an approval evidenceable. Signing used to overwrite
    // the version's own file, so the memo as submitted was destroyed by the
    // first signature and every earlier approver's stored path then named a
    // file that later approvals had rewritten.
    const asSubmitted = await storedBytes();

    await approveAs(cast.reviewer.id);
    await approveAs(cast.approver.id);

    expect(await storedBytes()).toEqual(asSubmitted);
  });

  it("keeps the exact bytes each approver signed, separately", async () => {
    await approveAs(cast.reviewer.id);
    await approveAs(cast.approver.id);

    const reviewerSaw = await signedBytesFor(cast.reviewer.id);
    const approverSaw = await signedBytesFor(cast.approver.id);

    // An approver asked "what did you sign?" a year later has an answer, and
    // it is not the same answer as the person after them.
    expect(reviewerSaw).not.toEqual(approverSaw);
    expect(reviewerSaw.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("keeps the document exactly as uploaded, before the preparer signed it", async () => {
    const version = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId },
      orderBy: { versionNumber: "desc" },
    });

    expect(version.originalStoragePath).toBeTruthy();

    const original = await fs.readFile(
      path.join(
        path.resolve(env.STORAGE_DIR),
        "documents",
        version.originalStoragePath as string
      )
    );

    // Smaller than the submitted file, because the submitted one already
    // carries the preparer's signature.
    expect(original.subarray(0, 5).toString()).toBe("%PDF-");
    expect(original.length).toBeLessThan((await storedBytes()).length);
  });

  it("fixes the approved version when the last approver signs", async () => {
    await approveAs(cast.reviewer.id);
    await approveAs(cast.approver.id);
    await approveAs(cast.finalApprover.id);

    const finalBytes = await finalSignedBytes();

    // Named once, at final approval, and never recomputed - so HR prints the
    // same bytes every time, and the trail cites a file that cannot move.
    expect(finalBytes).toEqual(await signedBytesFor(cast.finalApprover.id));
    expect(finalBytes.length).toBeGreaterThan((await storedBytes()).length);
  });

  it("completes the workflow when the final approver signs", async () => {
    await approveAs(cast.reviewer.id);
    await approveAs(cast.approver.id);
    const response = await approveAs(cast.finalApprover.id);

    const document = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      include: { currentWorkflowRun: true },
    });

    expect(document.status).toBe("APPROVED");
    expect(document.approvedAt).not.toBeNull();
    expect(document.currentWorkflowRun?.status).toBe("APPROVED");
    expect(document.currentWorkflowRun?.endedAt).not.toBeNull();

    expect(response).toMatchObject({
      documentStatus: "APPROVED",
      workflowStatus: "APPROVED",
    });
  });

  describe("what the preparer's inbox says", () => {
    const subjectsTo = async (userId: string) =>
      (
        await prisma.emailMessage.findMany({
          where: { recipientId: userId, documentId },
          orderBy: { createdAt: "asc" },
          select: { subject: true },
        })
      )
        .map((row) => row.subject)
        // The receipt for submitting is not news about approval.
        .filter((subject) => !subject.startsWith("Submitted"));

    it("does not call a memo approved while two approvers still hold it", async () => {
      await approveAs(cast.reviewer.id);

      expect(await subjectsTo(cast.preparer.id)).toEqual([
        expect.stringMatching(/^Approval progress: /),
      ]);
    });

    it("says it plainly, and only once, when the memo is finished", async () => {
      await approveAs(cast.reviewer.id);
      await approveAs(cast.approver.id);
      await approveAs(cast.finalApprover.id);

      const subjects = await subjectsTo(cast.preparer.id);

      expect(subjects).toEqual([
        expect.stringMatching(/^Approval progress: /),
        expect.stringMatching(/^Approval progress: /),
        expect.stringMatching(/^Approved: /),
      ]);

      // The point of the distinction: a mail client threads by subject, so
      // three identical ones collapse into a single conversation and the
      // notice that the memo is actually done is the one nobody opens.
      expect(new Set(subjects).size).toBe(2);
    });
  });

  it("writes an audit row naming who approved and where the run went", async () => {
    await approveAs(cast.reviewer.id);

    const audit = await prisma.auditLog.findMany({
      where: { entityId: documentId },
      orderBy: { createdAt: "asc" },
    });

    const approval = audit.find((row) => row.action === "WORKFLOW_APPROVED");
    expect(approval?.actorId).toBe(cast.reviewer.id);
    expect(approval?.newValue).toMatchObject({ stepOrder: 1, nextStepOrder: 2 });
  });

  it("marks the whole workflow completed in the audit trail", async () => {
    await approveAs(cast.reviewer.id);
    await approveAs(cast.approver.id);
    await approveAs(cast.finalApprover.id);

    const audit = await prisma.auditLog.findMany({
      where: { entityId: documentId },
    });

    expect(audit.map((row) => row.action)).toContain("WORKFLOW_COMPLETED");
  });

  describe("using a saved signature", () => {
    const PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    const savedSignature = () => {
      const { signatureImage: _drawn, ...placement } = signature();
      return { ...placement, useSavedSignature: true } as Parameters<
        typeof approvalService.approve
      >[2];
    };

    it("stamps the one on file instead of a drawn image", async () => {
      await usersService.uploadSignature(cast.reviewer.id, {
        buffer: PNG,
        mimetype: "image/png",
      } as unknown as Express.Multer.File);
      const before = await storedBytes();

      await approvalService.approve(
        documentId,
        cast.reviewer.id,
        savedSignature(),
      );

      expect((await signedBytesFor(cast.reviewer.id)).length).toBeGreaterThan(
        before.length,
      );
      expect(await currentPosition(documentId)).toMatchObject({ stepOrder: 2 });
    });

    it("refuses when the approver has not saved one", async () => {
      await expect(
        approvalService.approve(documentId, cast.reviewer.id, savedSignature()),
      ).rejects.toMatchObject({
        statusCode: 404,
        message: "No saved signature found",
      });
    });

    it("leaves the run alone when the signature is missing", async () => {
      // The stamp happens before the transaction opens, so a failure here has
      // to leave nothing behind at all.
      await approvalService
        .approve(documentId, cast.reviewer.id, savedSignature())
        .catch(() => null);

      expect(await currentPosition(documentId)).toMatchObject({
        stepOrder: 1,
        assignedTo: cast.reviewer.id,
      });
      expect(await prisma.approvalAction.count()).toBe(0);
    });
  });

  describe("what the signature says on the page", () => {
    /*
     * An attached PDF is a memo written in Word, and it prints its own
     * signatories' names and titles under the lines they sign on. A block
     * drawn under the mark landed on top of those printed names, so on an
     * uploaded document the signature goes on alone: the page names the
     * signatory, and the ledger keeps who signed, in what capacity and when.
     */
    it("puts the signature on alone, with no name, post or capacity under it", async () => {
      await prisma.user.update({
        where: { id: cast.reviewer.id },
        data: { designation: "Manager, Internal Audit" },
      });

      await approveAs(cast.reviewer.id);

      const lines = (await signedTextFor(cast.reviewer.id)).map((line) => line.text);

      expect(lines).not.toContain(
        `${cast.reviewer.firstName} ${cast.reviewer.lastName}`
      );
      expect(lines.some((line) => line.includes("Manager, Internal Audit"))).toBe(false);
      expect(lines.some((line) => line.includes(cast.department.name))).toBe(false);
      expect(lines).not.toContain("Reviewer");
    });

    it("still records who signed and when in the ledger", async () => {
      await approveAs(cast.reviewer.id);

      const action = await prisma.approvalAction.findFirstOrThrow();

      // The page no longer says it, so the row is where it is said.
      expect(action.actorId).toBe(cast.reviewer.id);
      expect(action.approvalType).toBe("REVIEWER");
      expect(action.createdAt).toBeInstanceOf(Date);
    });

    it("adds no text anywhere by the time the chain is done", async () => {
      await approveAs(cast.reviewer.id);
      await approveAs(cast.approver.id);
      await approveAs(cast.finalApprover.id);

      // The memo's own pages: the certificate at the end names everybody, by design.
      const lines = drawnText(await memoPagesOnly(await finalSignedBytes())).map((line) => line.text);

      for (const person of [cast.reviewer, cast.approver, cast.finalApprover]) {
        expect(lines).not.toContain(`${person.firstName} ${person.lastName}`);
      }
      expect(lines).not.toContain("Reviewer");
      expect(lines).not.toContain("Approver");
      expect(lines).not.toContain("Final Approver");
    });
  });

  describe("where the signature lands", () => {
    it("pulls a box hanging over the edge back onto the page", async () => {
      // Placed near the corner, so the box runs past it. Refusing an overhang
      // would fail signatures people placed exactly where they meant to - at
      // the edge, the viewer's float conversion routinely lands a point or so
      // over - so the box is fitted instead.
      await approveWith(cast.reviewer.id, {
        signatureX: PAGE_WIDTH - 5,
        signatureY: PAGE_HEIGHT - 5,
      });

      // The row is the record of where the mark is, so it holds the fitted
      // box and not the requested one: anyone checking the ledger against the
      // PDF, which is what the ledger is for, has to find the signature where
      // the row says it is.
      //
      // Nothing hangs below the mark on an uploaded document, so the box is
      // pulled back by the image alone.
      const action = await prisma.approvalAction.findFirstOrThrow();
      expect(action.signatureX).toBe(PAGE_WIDTH - 120);
      expect(action.signatureY).toBe(PAGE_HEIGHT - 40);
    });

    it("fits a box larger than the page to the page", async () => {
      await approveWith(cast.reviewer.id, {
        signatureWidth: 2000,
        signatureHeight: 2000,
      });

      // With no block beneath it on an uploaded document, the image may take
      // the whole page.
      const action = await prisma.approvalAction.findFirstOrThrow();
      expect(action.signatureWidth).toBe(PAGE_WIDTH);
      expect(action.signatureHeight).toBe(PAGE_HEIGHT);
      expect(action.signatureX).toBe(0);
      expect(action.signatureY).toBe(0);
    });

    it("refuses a placement that misses the page entirely", async () => {
      // The signed bytes overwrite the stored version in place, so drawing
      // off-page would leave a document that reads as approved with no
      // signature on it anywhere, and no earlier rendering to go back to.
      const before = await storedBytes();

      await expect(
        approveWith(cast.reviewer.id, { signatureX: 99999 })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("outside the page"),
      });

      expect(await storedBytes()).toEqual(before);
      expect(await prisma.approvalAction.count()).toBe(0);
      expect(await currentPosition(documentId)).toMatchObject({ stepOrder: 1 });
    });

    it("refuses a placement that misses the page downwards too", async () => {
      // The same refusal, on the other axis. With only the horizontal case
      // covered, half the check can be deleted and every test still passes -
      // and a signature dropped below the page is exactly as invisible as one
      // dropped beside it.
      const before = await storedBytes();

      await expect(
        approveWith(cast.reviewer.id, { signatureY: 99999 })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("outside the page"),
      });

      expect(await storedBytes()).toEqual(before);
      expect(await prisma.approvalAction.count()).toBe(0);
      expect(await currentPosition(documentId)).toMatchObject({ stepOrder: 1 });
    });

    it("refuses a page the document does not have", async () => {
      const before = await storedBytes();

      await expect(
        approveWith(cast.reviewer.id, { signaturePage: 5 })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("page number"),
      });

      expect(await storedBytes()).toEqual(before);
    });
  });

  describe("when the stored pdf cannot be read", () => {
    it("asks for a resubmit rather than reporting a server fault", async () => {
      // Whatever left the stored version unreadable - a half-written
      // overwrite, the wrong bytes at the path - surfaces here, at the moment
      // somebody legitimate is trying to approve. 500 gives them nothing to
      // act on; naming the resubmit tells them who has to fix it.
      await replaceStoredBytes(Buffer.from("not a pdf any more"));

      await expect(approveAs(cast.reviewer.id)).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("resubmit"),
      });

      expect(await prisma.approvalAction.count()).toBe(0);
      expect(await currentPosition(documentId)).toMatchObject({ stepOrder: 1 });
    });
  });

  describe("when the signature image cannot be read", () => {
    /** Valid base64, but not an image - a truncated canvas export looks like this. */
    const NOT_AN_IMAGE = "AAAAAAAAAAAA";

    it("tells the approver rather than reporting a server fault", async () => {
      // This is a legitimate action by the right person: answering 500 sends
      // them to support when redrawing the signature is what would fix it.
      const before = await storedBytes();

      await expect(
        approveWith(cast.reviewer.id, { signatureImage: NOT_AN_IMAGE })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("not a PNG or a JPEG"),
      });

      expect(await storedBytes()).toEqual(before);
      expect(await prisma.approvalAction.count()).toBe(0);
    });

    it("says the same when the unreadable bytes came from a saved signature", async () => {
      /*
       * The saved-signature path never sees the schema - the bytes come from
       * storage - so the refusal has to be raised here or it is a 500.
       *
       * Written straight into storage rather than through `uploadSignature`,
       * which now refuses these bytes itself. That guard is the right place
       * for anything arriving today; this one is for what is already on disk
       * from before it existed.
       */
      await storageService.uploadSignature(
        `${cast.reviewer.id}.png`,
        Buffer.from("not an image, whatever the extension says"),
        "image/png"
      );
      await prisma.user.update({
        where: { id: cast.reviewer.id },
        data: { signatureStoragePath: `${cast.reviewer.id}.png` },
      });

      const { signatureImage: _drawn, ...placement } = signature();

      await expect(
        approvalService.approve(documentId, cast.reviewer.id, {
          ...placement,
          useSavedSignature: true,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("not a PNG or a JPEG"),
      });
    });
  });

  describe("who may act", () => {
    it("refuses the preparer their own document", async () => {
      // The preparer already signed it on submission. Letting them approve it
      // as well would make a one-person chain possible by accident.
      await expect(approveAs(cast.preparer.id)).rejects.toMatchObject({
        statusCode: 403,
        message: expect.stringContaining("preparer cannot approve"),
      });
    });

    it("refuses an approver further down the chain", async () => {
      // In the chain, but the workflow is on step 1. Approving out of order
      // would skip the reviewer without anyone recording that it happened.
      await expect(approveAs(cast.finalApprover.id)).rejects.toMatchObject({
        statusCode: 403,
        message: expect.stringContaining("assigned user for the current step"),
      });
    });

    it("refuses someone who is not in the chain at all", async () => {
      await expect(approveAs(cast.bystander.id)).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it("refuses a user who has nothing to do with the document", async () => {
      const stranger = await makeUser();

      await expect(approveAs(stranger.id)).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it("leaves the workflow exactly where it was after a refusal", async () => {
      await approveAs(cast.finalApprover.id).catch(() => null);

      expect(await currentPosition(documentId)).toMatchObject({
        stepOrder: 1,
        assignedTo: cast.reviewer.id,
      });
      expect(await prisma.approvalAction.count()).toBe(0);
    });
  });

  describe("when it is too late to act", () => {
    it("refuses a second approval of the same step", async () => {
      await approveAs(cast.reviewer.id);

      // The run has moved on, so the reviewer is no longer the current step -
      // this is caught as "not your step" before the idempotency guard.
      await expect(approveAs(cast.reviewer.id)).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it("refuses any action once the document is approved", async () => {
      await approveAs(cast.reviewer.id);
      await approveAs(cast.approver.id);
      await approveAs(cast.finalApprover.id);

      await expect(approveAs(cast.finalApprover.id)).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("not pending review"),
      });
    });

    it("refuses any action once the document is rejected", async () => {
      await approvalService.reject(documentId, cast.reviewer.id, {
        comment: "The lease term is wrong.",
      });

      await expect(approveAs(cast.reviewer.id)).rejects.toMatchObject({
        statusCode: 400,
      });
    });
  });
});

describe("reject", () => {
  const reject = (actorId: string, comment = "The figures do not add up.") =>
    approvalService.reject(documentId, actorId, { comment });

  it("ends the workflow there and then", async () => {
    const response = await reject(cast.reviewer.id);

    const document = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      include: { currentWorkflowRun: true },
    });

    expect(document.status).toBe("REJECTED");
    expect(document.rejectedAt).not.toBeNull();
    expect(document.currentWorkflowRun?.status).toBe("REJECTED");
    expect(document.currentWorkflowRun?.endedAt).not.toBeNull();

    expect(response).toMatchObject({
      documentStatus: "REJECTED",
      workflowStatus: "REJECTED",
    });
  });

  it("can be rejected at any step, not only the first", async () => {
    await approveAs(cast.reviewer.id);

    await reject(cast.approver.id);

    expect(await currentPosition(documentId)).toMatchObject({
      status: "REJECTED",
      runStatus: "REJECTED",
    });
  });

  it("puts the reason in the document's comment thread", async () => {
    // A rejection the preparer cannot read the reason for is not something
    // they can act on.
    await reject(cast.reviewer.id, "Board approval is missing.");

    const comments = await prisma.documentComment.findMany({
      where: { documentId },
    });

    expect(comments).toHaveLength(1);
    expect(comments[0].comment).toContain("Board approval is missing.");
    expect(comments[0].authorId).toBe(cast.reviewer.id);
  });

  it("tells the preparer and everyone else who has already seen it", async () => {
    await approveAs(cast.reviewer.id);
    await prisma.notification.deleteMany();

    await reject(cast.approver.id);

    const recipients = new Set(
      (await prisma.notification.findMany()).map((row) => row.recipientId)
    );

    expect(recipients).toContain(cast.preparer.id);
    expect(recipients).toContain(cast.reviewer.id);
    // Not the person who rejected it: they know (fit-gap decision 2).
    expect(recipients).not.toContain(cast.approver.id);
    // Step 3 was never reached, so this is news about a document they have
    // never been shown.
    expect(recipients).not.toContain(cast.finalApprover.id);
  });

  it("refuses the preparer", async () => {
    await expect(reject(cast.preparer.id)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("refuses anyone but the current step", async () => {
    await expect(reject(cast.approver.id)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe("requestRevision", () => {
  const requestRevision = (actorId: string, comment = "Attach the survey.") =>
    approvalService.requestRevision(documentId, actorId, { comment });

  it("sends the document back to the preparer and ends the run", async () => {
    await requestRevision(cast.reviewer.id);

    const document = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      include: { currentWorkflowRun: true },
    });

    expect(document.status).toBe("REVISION_REQUESTED");
    expect(document.currentWorkflowRun?.status).toBe("SUPERSEDED");
    expect(document.currentWorkflowRun?.endedAt).not.toBeNull();
  });

  it("reports the run status it actually wrote", async () => {
    // This said IN_PROGRESS while writing SUPERSEDED, so a client that
    // believed the response showed the document as still in flight.
    const response = await requestRevision(cast.reviewer.id);

    expect(response).toMatchObject({
      documentStatus: "REVISION_REQUESTED",
      workflowStatus: "SUPERSEDED",
    });
  });

  it("remembers which action asked for the revision", async () => {
    await requestRevision(cast.reviewer.id);

    const document = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
    });
    const action = await prisma.approvalAction.findFirstOrThrow();

    expect(document.revisionRequestedByActionId).toBe(action.id);
    expect(action.action).toBe("REQUEST_REVISION");
  });

  it("puts the request in the comment thread and notifies the preparer", async () => {
    await prisma.notification.deleteMany();

    await requestRevision(cast.reviewer.id, "Page 2 is unsigned.");

    const comments = await prisma.documentComment.findMany();
    expect(comments[0].comment).toContain("Page 2 is unsigned.");

    const notified = await prisma.notification.findMany();
    expect(notified.map((row) => row.recipientId)).toContain(cast.preparer.id);
  });

  it("refuses anyone but the current step", async () => {
    await expect(requestRevision(cast.finalApprover.id)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(requestRevision(cast.preparer.id)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe("skipWorkflowStep", () => {
  // Off by default in every deployment; these tests describe what it does
  // where an organisation has deliberately switched it on.
  allowStepSkipInThisSuite();

  const skip = (actorId: string, reason = "On leave until next month.") =>
    approvalService.skipWorkflowStep(documentId, actorId, { reason });

  it("moves past the step and records that it was skipped", async () => {
    await skip(cast.preparer.id);

    expect(await currentPosition(documentId)).toMatchObject({
      status: "PENDING_REVIEW",
      runStatus: "IN_PROGRESS",
      stepOrder: 2,
      assignedTo: cast.approver.id,
    });

    const action = await prisma.approvalAction.findFirstOrThrow();
    expect(action.action).toBe("SKIP");
    expect(action.actorId).toBe(cast.preparer.id);
  });

  it("names the person who was skipped, in the thread", async () => {
    // "Step 1 was skipped" is not a reviewable record; who was skipped, and
    // why, is.
    await skip(cast.preparer.id, "On leave until next month.");

    const comments = await prisma.documentComment.findMany();
    expect(comments[0].comment).toContain(cast.reviewer.firstName);
    expect(comments[0].comment).toContain("On leave until next month.");
  });

  it("is the preparer's decision alone", async () => {
    await expect(skip(cast.reviewer.id)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(skip(cast.bystander.id)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("refuses to skip the final approval", async () => {
    await skip(cast.preparer.id);
    await skip(cast.preparer.id);

    // Now sitting on the final approver. Skipping that would approve the
    // document without anyone approving it.
    await expect(skip(cast.preparer.id)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("final approval step"),
    });
  });

  it("can skip the step after one that was approved", async () => {
    // Named for what it checks. The service also guards against skipping a
    // step that already carries an action, but that guard is unreachable
    // through the public flow: acting on a step advances the run past it, so
    // the current step never has one.
    await approveAs(cast.reviewer.id);
    await skip(cast.preparer.id);

    const actions = await prisma.approvalAction.findMany({
      include: { chainStep: true },
      orderBy: { createdAt: "asc" },
    });

    expect(actions.map((a) => [a.chainStep.stepOrder, a.action])).toEqual([
      [1, "APPROVE"],
      [2, "SKIP"],
    ]);
  });

  it("refuses once the document is no longer pending review", async () => {
    await approvalService.reject(documentId, cast.reviewer.id, {
      comment: "No.",
    });

    await expect(skip(cast.preparer.id)).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

/*
 * The request shape, checked here rather than in a unit file because it is one
 * half of the same rule: the schema keeps nonsense off the page, and the
 * service above fits what survives to the real page box. Neither is any use
 * without the other.
 */
describe("the approve request shape", () => {
  const parseApproval = (overrides: Record<string, unknown> = {}) =>
    approveDocumentSchema.safeParse({
      params: { id: documentId },
      body: { ...signature(), ...overrides },
    });

  const refusal = (result: ReturnType<typeof parseApproval>) =>
    result.success ? "" : result.error.issues.map((i) => i.message).join(". ");

  it("accepts the box sizes the viewer really produces", () => {
    // The client's own MIN/MAX styling constants are not the contract: a
    // cropped initial legitimately comes out a few points wide and a
    // full-width ink stroke on A4 comes out around 595. Bounding the server
    // by those constants would refuse both.
    expect(parseApproval({ signatureWidth: 12, signatureHeight: 6 }).success).toBe(true);
    expect(parseApproval({ signatureWidth: 595, signatureHeight: 200 }).success).toBe(true);
  });

  it("accepts a JPEG, not only the canvas's PNG", () => {
    // PNG and JPEG are both embeddable, and the saved-signature upload route
    // takes both. A header check that only recognised PNG would refuse an
    // image the rest of the signing path handles perfectly well.
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(20),
    ]).toString("base64");

    expect(
      parseApproval({ signatureImage: `data:image/jpeg;base64,${jpeg}` }).success
    ).toBe(true);
  });

  it("refuses base64 that is not a PNG or JPEG", () => {
    // Valid base64, no image in it - a truncated canvas export. It used to
    // travel into pdf-lib and come back to the approver as a 500.
    expect(refusal(parseApproval({ signatureImage: "AAAAAAAAAAAA" }))).toContain(
      "PNG or JPEG"
    );
  });

  it("refuses an image far larger than a drawn signature", () => {
    // Every approval re-embeds the image and rewrites the stored PDF, so an
    // unbounded one grows the document once per approver in the chain.
    const huge = `data:image/png;base64,iVBORw0KGgo${"A".repeat(2 * 1024 * 1024)}`;

    expect(refusal(parseApproval({ signatureImage: huge }))).toContain("too large");
  });

  it("refuses a coordinate that is off the page before any page is loaded", () => {
    expect(refusal(parseApproval({ signatureX: -10 }))).toContain("on the page");
    expect(refusal(parseApproval({ signatureHeight: 5000 }))).toContain("too large");
  });

  it("refuses a document id that is not a uuid", () => {
    // Straight into a uuid column otherwise, which answers 500 for what is a
    // stale link or a mistyped one.
    const result = approveDocumentSchema.safeParse({
      params: { id: "not-a-uuid" },
      body: signature(),
    });

    expect(refusal(result)).toContain("Invalid document id");
  });
});

describe("two people deciding the same step at the same moment", () => {
  /**
   * Everything else in this file is sequential, and so was every rehearsal
   * this system had. A real Monday morning is not.
   *
   * `approve` reads the run, then spends several hundred milliseconds
   * fetching, stamping and storing a PDF, and only then opens its
   * transaction. Requests fired into that window all pass validation on the
   * same state. Before the run was claimed inside the transaction, five
   * clicks on one button produced three approval rows, three audit entries
   * and three "approval needed" emails to the next approver - for one
   * decision. The workflow itself survived only by accident, because
   * `currentStepOrder + 1` is computed from the stale read, so the writers
   * all set the same value instead of advancing three steps.
   *
   * These are timing tests, which normally means flaky ones. They are not,
   * in the direction that matters: the assertion is that exactly one of N
   * concurrent calls succeeds, and that holds whether or not the calls
   * actually overlap. A run where they happen not to overlap passes for the
   * ordinary reason. A run where they do overlap is the one that used to
   * fail.
   *
   * Not all of them bite equally, and it is worth knowing which. Approving
   * writes its signed artefact to a path named after the step, and the store
   * refuses to overwrite one that exists - an accidental guard that turns
   * some of these races into a file conflict before they reach the database.
   * It is not a guard anybody designed and it does not hold under HTTP, where
   * five clicks got three approvals past it. The sharpest test here is the
   * approval racing a rejection: rejecting writes no artefact, so there is
   * nothing to collide, and before the run was claimed both landed every
   * time.
   */

  const settle = async <T>(promises: Promise<T>[]) => {
    const outcomes = await Promise.allSettled(promises);
    return {
      won: outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      lost: outcomes.filter((outcome) => outcome.status === "rejected"),
    };
  };

  const actionsOnCurrentStep = async () => {
    const run = await prisma.workflowRun.findFirstOrThrow({
      where: { documentId },
    });
    return prisma.approvalAction.count({ where: { workflowRunId: run.id } });
  };

  it("records one approval when the button is clicked five times", async () => {
    const { won, lost } = await settle(
      Array.from({ length: 5 }, () => approveAs(cast.reviewer.id))
    );

    expect(won).toBe(1);
    expect(await actionsOnCurrentStep()).toBe(1);
    // Everybody who lost has to be told something a person can act on, not a
    // constraint violation escaping from the driver.
    for (const failure of lost) {
      expect((failure.reason as { statusCode?: number }).statusCode).toBeGreaterThanOrEqual(400);
      expect((failure.reason as { statusCode?: number }).statusCode).toBeLessThan(500);
    }
  });

  it("advances the run exactly one step, not five", async () => {
    await settle(Array.from({ length: 5 }, () => approveAs(cast.reviewer.id)));

    const run = await prisma.workflowRun.findFirstOrThrow({ where: { documentId } });
    expect(run.currentStepOrder).toBe(2);
    expect(run.status).toBe("IN_PROGRESS");
  });

  it("notifies the next approver once, not once per click", async () => {
    // The reason this is worth a test of its own: the duplicates that reach a
    // person are the ones they complain about, and they are sent from inside
    // the transaction that was being run five times.
    await settle(Array.from({ length: 5 }, () => approveAs(cast.reviewer.id)));

    const waiting = await prisma.notification.count({
      where: { recipientId: cast.approver.id, documentId, type: "APPROVAL_NEEDED" },
    });
    expect(waiting).toBe(1);
  });

  it("writes one audit row for one decision", async () => {
    await settle(Array.from({ length: 5 }, () => approveAs(cast.reviewer.id)));

    const written = await prisma.auditLog.count({
      where: { entityId: documentId, action: "WORKFLOW_APPROVED" },
    });
    expect(written).toBe(1);
  });

  it("leaves the winner's signed file where its action row says it is", async () => {
    /*
     * The first version of the claim broke this, which is worth keeping a test
     * for rather than a memory of. Every attempt at a step used to compute the
     * same artefact path, and a losing attempt cleans up after itself by
     * deleting that path - so the loser deleted the file the winner had just
     * committed a row against. The approval survived with an evidence path
     * pointing at nothing, and the next approver could not open the document
     * they were being asked to countersign.
     */
    await settle(Array.from({ length: 5 }, () => approveAs(cast.reviewer.id)));

    const action = await prisma.approvalAction.findFirstOrThrow({
      where: { workflowRun: { documentId }, action: "APPROVE" },
    });
    const onDisk = path.join(
      path.resolve(env.STORAGE_DIR),
      "documents",
      action.signedPdfStoragePath as string
    );

    await expect(fs.access(onDisk)).resolves.toBeUndefined();

    // And it has to be openable, not merely present: the next approver signs
    // on top of these bytes.
    const bytes = await fs.readFile(onDisk);
    expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("lets the next approver sign on top of a contested approval", async () => {
    // The end of the same story, from the only place it actually showed up:
    // twenty-five memos went through this workflow and the one that had been
    // double-clicked was the one that could not be finished.
    await settle(Array.from({ length: 5 }, () => approveAs(cast.reviewer.id)));

    await expect(approveAs(cast.approver.id)).resolves.toBeDefined();
  });

  it("lets an approval and a rejection race, and only one of them lands", async () => {
    /*
     * The worst of these, because the two disagree. Both used to pass
     * validation on the same state and both used to commit, leaving the memo
     * with an approval and a rejection on one step and a fate decided by
     * whichever transaction committed second.
     */
    const { won } = await settle([
      approveAs(cast.reviewer.id),
      approvalService.reject(documentId, cast.reviewer.id, { comment: "No." }),
    ]);

    expect(won).toBe(1);

    const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    // Only step one has been acted on, so every action on this run is an
    // action on the step the two were racing for.
    const actions = await prisma.approvalAction.findMany({
      where: { workflowRun: { documentId } },
    });
    expect(actions).toHaveLength(1);

    // Whichever won, the document and the single action have to agree.
    const decided = actions[0].action;
    expect(document.status).toBe(decided === "REJECT" ? "REJECTED" : "PENDING_REVIEW");
  });
});
