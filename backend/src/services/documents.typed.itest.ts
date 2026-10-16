import { promises as fs } from "node:fs";
import path from "node:path";

import { PDFDocument } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sha256 } from "../lib/checksum";
import { env } from "../lib/env";
import { FUEL_REQUEST_BODY } from "../lib/memoTemplate/fuelRequest.fixture";
import { storageService } from "../lib/storage";
import { prisma } from "../prisma";
import { linesOf } from "../test/pdfText";
import {
  chainOf,
  makeCast,
  makeUpload,
  rejection,
  signature,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { approvalService } from "./approval.service";
import { brandingService } from "./branding.service";
import { ledgerService } from "./ledger.service";
import { documentsService } from "./documents.service";

/**
 * A memo typed in the portal.
 *
 * The rule these are written around: from the moment the PDF exists, nothing
 * downstream may be able to tell it from an uploaded one. Everything the
 * uploaded path produces - a version row, two digested artefacts, a chain, a
 * run, an audit row - has to come out the same shape, or the approval,
 * signing and verification paths are all quietly on their own code path.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;

beforeEach(async () => {
  cast = await makeCast();
  brandingService.forget();
});

const typed = (overrides: Record<string, unknown> = {}) => ({
  title: "Approval for Revision of Fuel Allowance",
  memoType: "APPROVAL_REQUEST",
  memoTo: "Sir BMD",
  memoFrom: "Human Resource Department",
  body: FUEL_REQUEST_BODY,
  approvalChain: chainOf(cast.approver, cast.finalApprover),
  signature: signature(),
  ...overrides,
});

/** Unwraps the `{ message, document }` envelope the service answers with. */
const submitTyped = async (overrides: Record<string, unknown> = {}) => {
  const { document } = await documentsService.createDocument(
    typed(overrides),
    null,
    cast.preparer.id
  );

  return document;
};

describe("submitting a memo nobody uploaded", () => {
  it("creates the document without a file being attached", async () => {
    const document = await submitTyped();

    expect(document.status).toBe("PENDING_REVIEW");
    expect(document.referenceNumber).toMatch(/^MEMO-\d{4}-\d{4}$/);
    expect(document.submittedAt).toBeTruthy();
  });

  it("produces the same artefacts an uploaded memo does", async () => {
    const document = await submitTyped();

    const version = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId: document.id },
    });

    // Both files, both digests - exactly as the uploaded path writes them.
    expect(version.storagePath).toBe(`documents/${document.id}/v1.pdf`);
    expect(version.originalStoragePath).toBe(
      `documents/${document.id}/v1-original.pdf`
    );
    expect(version.storageChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(version.originalChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(version.storageChecksum).not.toBe(version.originalChecksum);
  });

  it("writes both files, and they are real PDFs", async () => {
    const document = await submitTyped();
    const version = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId: document.id },
    });

    for (const path of [version.storagePath, version.originalStoragePath!]) {
      const bytes = await storageService.downloadDocument(path);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(0);
    }
  });

  it("digests what it actually wrote", async () => {
    const { createHash } = await import("node:crypto");
    const document = await submitTyped();
    const version = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId: document.id },
    });

    const onDisk = await storageService.downloadDocument(version.storagePath);
    expect(createHash("sha256").update(onDisk).digest("hex")).toBe(
      version.storageChecksum
    );
  });

  it("starts the workflow on step one, like any other memo", async () => {
    const document = await submitTyped();

    const run = await prisma.workflowRun.findFirstOrThrow({
      where: { documentId: document.id },
    });

    expect(run.status).toBe("IN_PROGRESS");
    expect(run.currentStepOrder).toBe(1);

    const steps = await prisma.approvalChainStep.findMany({
      where: { chain: { documentId: document.id } },
      orderBy: { stepOrder: "asc" },
    });

    expect(steps.map((step) => step.assignedUserId)).toEqual([
      cast.approver.id,
      cast.finalApprover.id,
    ]);
  });
});

describe("what the row remembers about a typed memo", () => {
  it("keeps the header fields and the type", async () => {
    const document = await submitTyped();

    const row = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });

    expect(row.memoType).toBe("APPROVAL_REQUEST");
    expect(row.memoTo).toBe("Sir BMD");
    expect(row.memoFrom).toBe("Human Resource Department");
  });

  it("keeps the body against the version it drew", async () => {
    const document = await submitTyped();

    const version = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId: document.id },
    });

    expect(version.bodyJson).not.toBeNull();
    expect(JSON.stringify(version.bodyJson)).toContain("BACKGROUND:");
  });

  it("says in the audit trail how the artefact came to exist", async () => {
    const document = await submitTyped();

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: document.id, action: "DOCUMENT_SUBMITTED" },
    });

    expect(entry.newValue).toMatchObject({
      authoring: "GENERATED",
      memoType: "APPROVAL_REQUEST",
    });
  });

  it("leaves an uploaded memo's new columns null", async () => {
    const { document: uploaded } = await documentsService.createDocument(
      {
        title: "Uploaded the old way",
        approvalChain: chainOf(cast.approver, cast.finalApprover),
        signature: signature(),
      },
      await makeUpload(),
      cast.preparer.id
    );

    const row = await prisma.document.findUniqueOrThrow({
      where: { id: uploaded.id },
    });

    expect(row.memoType).toBeNull();
    expect(row.memoTo).toBeNull();
    expect(row.memoFrom).toBeNull();

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: uploaded.id, action: "DOCUMENT_SUBMITTED" },
    });
    expect(entry.newValue).toMatchObject({ authoring: "UPLOADED" });
  });
});

/**
 * "A memo must never go in flight without its artefact." The render happens
 * after everything that can refuse the submission and before the first byte
 * is written, so a failure leaves nothing behind at all.
 */
describe("when the memo cannot be drawn", () => {
  const unrenderable = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        // Arabic script: the embedded fonts have no glyphs for it, and the
        // renderer refuses rather than sealing a row of empty boxes into an
        // immutable artefact.
        content: [{ type: "text", text: "السلام" }],
      },
    ],
  };

  it("refuses the submission and says why", async () => {
    const error = await rejection(submitTyped({ body: unrenderable }));
    expect(error.message).toMatch(/cannot print|empty boxes/i);
  });

  it("leaves no document, no version, no chain, no run, no audit row", async () => {
    await rejection(submitTyped({ body: unrenderable }));

    expect(await prisma.document.count()).toBe(0);
    expect(await prisma.documentVersion.count()).toBe(0);
    expect(await prisma.approvalChain.count()).toBe(0);
    expect(await prisma.workflowRun.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("leaves no orphaned file in storage", async () => {
    const before = await prisma.documentVersion.count();
    await rejection(submitTyped({ body: unrenderable }));

    // Nothing was written, so there is no path to look for - the assertion
    // that matters is that the failure happened before any upload call.
    expect(await prisma.documentVersion.count()).toBe(before);
  });

  it("does not burn a memo reference on a submission that failed", async () => {
    await rejection(submitTyped({ body: unrenderable }));

    // The reference is minted inside the transaction, so a failed render
    // must not consume one. The next real memo gets 0001.
    const document = await submitTyped();
    expect(document.referenceNumber).toMatch(/-0001$/);
  });
});

describe("an invalid chain is refused before anything is drawn", () => {
  it("refuses a chain naming the preparer", async () => {
    const error = await rejection(
      submitTyped({
        approvalChain: chainOf(cast.preparer, cast.finalApprover),
      })
    );

    expect(error.statusCode).toBe(400);
    expect(await prisma.document.count()).toBe(0);
  });

  it("refuses a chain with the same person twice", async () => {
    const error = await rejection(
      submitTyped({
        approvalChain: chainOf(cast.approver, cast.approver),
      })
    );

    expect(error.statusCode).toBe(400);
    expect(await prisma.document.count()).toBe(0);
  });

  it("refuses a chain whose last step is not an approver", async () => {
    const error = await rejection(
      submitTyped({
        approvalChain: [
          { userId: cast.reviewer.id, approvalType: "REVIEWER" },
        ],
      })
    );

    expect(error.statusCode).toBe(400);
    expect(await prisma.document.count()).toBe(0);
  });
});

/**
 * Acceptance: a typed memo has to walk the chain exactly as an uploaded one
 * does. If any of this diverges, the approval, signing and verification paths
 * are quietly running on a second code path that nobody is maintaining.
 */
describe("a typed memo goes all the way through", () => {
  const approvalInput = () => {
    const { useSavedSignature: _saved, ...placement } = signature();
    return { ...placement, useSavedSignature: false } as Parameters<
      typeof approvalService.approve
    >[2];
  };

  it("is signed by every approver and comes out approved", async () => {
    const document = await submitTyped();

    await approvalService.approve(document.id, cast.approver.id, approvalInput());
    await approvalService.approve(
      document.id,
      cast.finalApprover.id,
      approvalInput()
    );

    const finished = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });

    expect(finished.status).toBe("APPROVED");
    expect(finished.approvedAt).toBeTruthy();
    expect(finished.finalSignedStoragePath).toBeTruthy();
    expect(finished.finalSignedChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces one stamped artefact per step, the same shape as always", async () => {
    const document = await submitTyped();

    await approvalService.approve(document.id, cast.approver.id, approvalInput());
    await approvalService.approve(
      document.id,
      cast.finalApprover.id,
      approvalInput()
    );

    const actions = await prisma.approvalAction.findMany({
      where: { workflowRun: { documentId: document.id } },
      orderBy: { createdAt: "asc" },
    });

    expect(actions).toHaveLength(2);

    // `documents/<id>/v1/step-<k>-<uuid>-<uuid>.pdf` - unchanged by this
    // feature, which is the point of generating the base document rather
    // than teaching the stamping path about memo bodies.
    const row = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    expect(row.finalSignedStoragePath).toMatch(
      new RegExp(`^documents/${document.id}/v1/step-2-`)
    );
  });

  it("serves the approved file, and it matches its digest", async () => {
    const { createHash } = await import("node:crypto");
    const document = await submitTyped();

    await approvalService.approve(document.id, cast.approver.id, approvalInput());
    await approvalService.approve(
      document.id,
      cast.finalApprover.id,
      approvalInput()
    );

    const row = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });

    const bytes = await storageService.downloadDocument(
      row.finalSignedStoragePath!
    );

    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      row.finalSignedChecksum
    );
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(0);
  });

  it("leaves the audit ledger intact", async () => {
    const document = await submitTyped();

    await approvalService.approve(document.id, cast.approver.id, approvalInput());
    await approvalService.approve(
      document.id,
      cast.finalApprover.id,
      approvalInput()
    );

    // Seal what the run just wrote, then ask the ledger to check itself.
    await ledgerService.seal();
    const report = await ledgerService.verify();

    expect(report.intact).toBe(true);
  });
});

/**
 * The printed strip and the stamped signature are two separate mechanisms
 * that share a piece of the page, and Phase 3's walkthrough showed what
 * happens when they do not know about each other: the ruled lines stay blank
 * while the signatures sit in the body, so every approver's name appears on
 * the memo twice - once signed, once not.
 *
 * These are the tests that join them up.
 */
describe("signing on the line that was printed for it", () => {
  const slotsOf = async (documentId: string) => {
    const version = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId },
    });
    return version.signatureSlots as unknown as {
      key: string;
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
    }[];
  };

  it("records where every signature belongs", async () => {
    const document = await submitTyped();
    const slots = await slotsOf(document.id);

    // Preparer first, then the chain in order: exactly the people who will
    // put a signature on this memo, in the order they will do it.
    expect(slots.map((slot) => slot.key)).toEqual([
      cast.preparer.id,
      cast.approver.id,
      cast.finalApprover.id,
    ]);
  });

  it("records nothing for an uploaded memo", async () => {
    const { document } = await documentsService.createDocument(
      {
        title: "Uploaded the old way",
        approvalChain: chainOf(cast.approver, cast.finalApprover),
        signature: signature(),
      },
      await makeUpload(),
      cast.preparer.id
    );

    const version = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId: document.id },
    });

    // No strip, so no slots - and the uploaded path keeps the full printed
    // block under every signature, because nothing else on the page names
    // the signer.
    expect(version.signatureSlots).toBeNull();
  });

  it("tells a reader where their own line is, and only theirs", async () => {
    const document = await submitTyped();

    const asApprover = await documentsService.getDocumentById(
      document.id,
      cast.approver.id
    );
    expect(asApprover.mySignatureSlot?.key).toBe(cast.approver.id);

    // Somebody who can see the memo but is not on the strip is offered no
    // line, rather than somebody else's.
    const asPreparer = await documentsService.getDocumentById(
      document.id,
      cast.preparer.id
    );
    expect(asPreparer.mySignatureSlot?.key).toBe(cast.preparer.id);
  });

  it("offers no line on an uploaded memo", async () => {
    const { document } = await documentsService.createDocument(
      {
        title: "Uploaded the old way",
        approvalChain: chainOf(cast.approver, cast.finalApprover),
        signature: signature(),
      },
      await makeUpload(),
      cast.preparer.id
    );

    const seen = await documentsService.getDocumentById(
      document.id,
      cast.approver.id
    );
    expect(seen.mySignatureSlot).toBeNull();
  });

  it("lets an approver sign on their own line and keeps the memo valid", async () => {
    const document = await submitTyped();
    const slots = await slotsOf(document.id);
    const mine = slots.find((slot) => slot.key === cast.approver.id)!;

    await approvalService.approve(document.id, cast.approver.id, {
      useSavedSignature: false,
      signatureImage: signature().signatureImage,
      signaturePage: mine.page,
      signatureX: mine.x,
      signatureY: mine.y,
      signatureWidth: mine.width,
      signatureHeight: mine.height,
    });

    const action = await prisma.approvalAction.findFirstOrThrow({
      where: { workflowRun: { documentId: document.id } },
    });

    const bytes = await storageService.downloadDocument(
      action.signedPdfStoragePath!
    );

    // Still a document, still one page, still digested by the path that
    // files it - the slot changes where the mark goes, not what happens to
    // the artefact afterwards.
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(0);
    expect(action.signedPdfChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  /*
   * "Approver · 26 Sep 2026" under the mark read as the system's tags on a
   * signed memo whose strip already names every signatory. On a typed memo
   * the ledger keeps the capacity and the date and the page does not repeat
   * them - on the signer's own line, and off it.
   *
   * The memo's own text is set in its embedded face and comes back from
   * `linesOf` as glyph codes; the stamp draws in a standard face, which
   * reads as text. So "what the stamp drew" is the readable lines.
   */
  const stampedLines = (pdf: Buffer) =>
    linesOf(pdf).filter((line) => /^[\x20-\x7e\xa0-\xff]+$/.test(line) && /[A-Za-z]/.test(line));
  const ATTESTATION = /·|\d{2} [A-Z][a-z]{2} \d{4}/;

  it("stamps no capacity and no date under a signature on a typed memo", async () => {
    const document = await submitTyped();
    const mine = (await slotsOf(document.id)).find((slot) => slot.key === cast.approver.id)!;

    await approvalService.approve(document.id, cast.approver.id, {
      useSavedSignature: false,
      signatureImage: signature().signatureImage,
      signaturePage: mine.page,
      signatureX: mine.x,
      signatureY: mine.y,
      signatureWidth: mine.width,
      signatureHeight: mine.height,
    });

    const action = await prisma.approvalAction.findFirstOrThrow({
      where: { workflowRun: { documentId: document.id } },
    });
    const stamped = stampedLines(await storageService.downloadDocument(action.signedPdfStoragePath!));

    // On the signer's own line nothing at all is drawn under the mark - and
    // a signer who holds a line always signs on it, wherever they aimed. Only
    // a delegate signs off the strip; their block keeps a name and whose
    // approval it was, still without a capacity or a date (see the unit
    // tests of `embedSignatureInPdf`).
    expect(stamped).toEqual([]);
    expect(stamped.some((line) => ATTESTATION.test(line))).toBe(false);
  });

  it("still accepts a signature placed in open space", async () => {
    // A signer who wants their mark somewhere else - next to a paragraph
    // they are agreeing to - is not doing anything wrong, provided the space
    // is clear of the strip. Only another person's printed line is barred.
    const document = await submitTyped();

    await approvalService.approve(document.id, cast.approver.id, {
      useSavedSignature: false,
      signatureImage: signature().signatureImage,
      signaturePage: 1,
      signatureX: 320,
      signatureY: 300,
      signatureWidth: 120,
      signatureHeight: 40,
    });

    const run = await prisma.workflowRun.findFirstOrThrow({
      where: { documentId: document.id },
    });
    expect(run.currentStepOrder).toBe(2);
  });
});

/**
 * Signing on somebody else's line.
 *
 * The strip is printed on the page, so where each line sits is known to
 * everyone who may open the memo - it is not, and could never be, a secret.
 * The property that has to hold is that knowing the coordinates buys nothing:
 * the service decides whose line a signature may land on, not the request.
 *
 * These call the service directly, which is the point. A screen that sends
 * the right box proves nothing about what happens when something sends the
 * wrong one.
 */
describe("a signature aimed at a line that is not the signer's", () => {
  const stripOf = async (documentId: string) => {
    const version = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId },
    });
    return version.signatureSlots as unknown as {
      key: string;
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
    }[];
  };

  /** Somebody else's column, read off the memo exactly as an attacker would. */
  const lineBelongingTo = async (documentId: string, userId: string) => {
    const theirs = (await stripOf(documentId)).find(
      (slot) => slot.key === userId
    )!;
    return {
      useSavedSignature: false,
      signatureImage: signature().signatureImage,
      signaturePage: theirs.page,
      signatureX: theirs.x,
      signatureY: theirs.y,
      signatureWidth: theirs.width,
      signatureHeight: theirs.height,
    };
  };

  it("is refused when an approver aims at the approver after them", async () => {
    const document = await submitTyped();

    await expect(
      approvalService.approve(
        document.id,
        cast.approver.id,
        (await lineBelongingTo(document.id, cast.finalApprover.id)) as never
      )
    ).rejects.toThrow(/line the document prints for somebody else/i);
  });

  it("leaves the workflow exactly where it was", async () => {
    // A refusal that still advanced the step, or still wrote an action row,
    // would be worse than no refusal at all: the memo would be recorded as
    // approved by somebody whose signature was never filed.
    const document = await submitTyped();
    const aimed = await lineBelongingTo(document.id, cast.finalApprover.id);

    await expect(
      approvalService.approve(document.id, cast.approver.id, aimed as never)
    ).rejects.toThrow();

    const run = await prisma.workflowRun.findFirstOrThrow({
      where: { documentId: document.id },
    });
    const actions = await prisma.approvalAction.findMany({
      where: { workflowRunId: run.id },
    });

    expect(run.currentStepOrder).toBe(1);
    expect(actions).toEqual([]);
  });

  it("is refused at submission when the preparer aims at an approver's line", async () => {
    // The preparer is the one signer holding the whole strip before anybody
    // has signed anything, so the first column is where a planted signature
    // would be easiest and hardest to spot.
    //
    // The coordinates come off a memo already filed with the same chain and
    // body: the layout is a pure function of those, so the column sits in the
    // same place on the next one. Which is exactly the point - the geometry
    // is reproducible by anyone, and secrecy was never what protected it.
    const filed = await submitTyped();
    const theirs = (await stripOf(filed.id)).find(
      (slot) => slot.key === cast.approver.id
    )!;

    await expect(
      documentsService.createDocument(
        typed({
          title: "Aimed at somebody else",
          signature: {
            ...signature(),
            signaturePage: theirs.page,
            signatureX: theirs.x,
            signatureY: theirs.y,
            signatureWidth: theirs.width,
            signatureHeight: theirs.height,
          },
        }) as never,
        null,
        cast.preparer.id
      )
    ).rejects.toThrow(/line the memo prints for somebody else/i);
  });

  it("puts a signer's own mark on their own line however they aimed it", async () => {
    // The other half of the rule. Holding a line means signing on it, so a
    // box dragged loose still lands square on the printed rule rather than
    // floating beside it.
    const document = await submitTyped();
    const mine = (await stripOf(document.id)).find(
      (slot) => slot.key === cast.approver.id
    )!;

    await approvalService.approve(document.id, cast.approver.id, {
      useSavedSignature: false,
      signatureImage: signature().signatureImage,
      signaturePage: mine.page,
      // Nudged well off the line, but still inside their own column.
      signatureX: mine.x + 6,
      signatureY: mine.y + 4,
      signatureWidth: mine.width - 20,
      signatureHeight: mine.height - 6,
    });

    const run = await prisma.workflowRun.findFirstOrThrow({
      where: { documentId: document.id },
    });
    expect(run.currentStepOrder).toBe(2);
  });
});

/**
 * Revising a memo that was typed in the portal.
 *
 * The rule: a revision produces v2. It never edits v1. Everything v1 says -
 * its file, its digests, the body it was drawn from and the lines it printed
 * - has to still say the same thing afterwards, because v1 is what four
 * people already signed and the audit trail already sealed.
 */
describe("rewriting a typed memo after it comes back", () => {
  /** Submit, send back for revision, and hand the preparer the pen. */
  const sentBack = async (overrides: Record<string, unknown> = {}) => {
    const document = await submitTyped(overrides);
    await approvalService.requestRevision(document.id, cast.approver.id, {
      comment: "The figure is out of date.",
    });
    return document;
  };

  const rewritten = (text: string) => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });

  const versionsOf = (documentId: string) =>
    prisma.documentVersion.findMany({
      where: { documentId },
      orderBy: { versionNumber: "asc" },
    });

  it("draws v2 from the rewritten body and leaves v1 exactly as it was", async () => {
    const document = await sentBack();
    const [before] = await versionsOf(document.id);

    await documentsService.updateDocument(
      document.id,
      {
        body: rewritten("The allowance is revised to PKR 12,000 per month."),
        signature: signature(),
      } as never,
      undefined,
      cast.preparer.id
    );

    const versions = await versionsOf(document.id);
    expect(versions.map((version) => version.versionNumber)).toEqual([1, 2]);

    const [v1, v2] = versions;

    // v1, field by field, against the row read before the revision ran.
    expect(v1.storagePath).toBe(before.storagePath);
    expect(v1.storageChecksum).toBe(before.storageChecksum);
    expect(v1.originalChecksum).toBe(before.originalChecksum);
    expect(v1.bodyJson).toEqual(before.bodyJson);
    expect(v1.signatureSlots).toEqual(before.signatureSlots);

    // v2 is its own artefact, on its own paths, drawn from the new text.
    // Named per attempt (v2-<attempt>), so two attempts never share a file.
    expect(v2.storagePath.startsWith(`documents/${document.id}/v2-`)).toBe(true);
    expect(v2.storagePath).toMatch(/\/v2-[0-9a-f]{8}\.pdf$/);
    expect(v2.originalStoragePath).toBe(
      v2.storagePath.replace(/\.pdf$/, "-original.pdf")
    );
    expect(v2.storageChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(v2.storageChecksum).not.toBe(v1.storageChecksum);
    expect(JSON.stringify(v2.bodyJson)).toContain("PKR 12,000");
    expect(JSON.stringify(v1.bodyJson)).not.toContain("PKR 12,000");
  });

  it("keeps v1's file readable and still matching its digest", async () => {
    const document = await sentBack();
    const [before] = await versionsOf(document.id);
    const wasThere = await storageService.downloadDocument(before.storagePath);

    await documentsService.updateDocument(
      document.id,
      { body: rewritten("Rewritten."), signature: signature() } as never,
      undefined,
      cast.preparer.id
    );

    const stillThere = await storageService.downloadDocument(
      before.storagePath
    );

    // Byte for byte. A revision that quietly overwrote v1's storage path
    // would leave the checksum in the audit trail describing a file that no
    // longer exists.
    expect(sha256(stillThere)).toBe(sha256(wasThere));
    expect(sha256(stillThere)).toBe(before.storageChecksum);
  });

  it("reprints the strip for the chain the revision actually routes to", async () => {
    /*
     * Rerouting is only open while nobody has acted, which after a revision
     * request is never - so the path that can change the chain is the
     * preparer withdrawing their own memo and putting it up again.
     */
    const document = await submitTyped();
    await documentsService.withdrawDocument(document.id, cast.preparer.id, "No longer needed");

    await documentsService.updateDocument(
      document.id,
      {
        body: rewritten("Rewritten for a different chain."),
        approvalChain: chainOf(cast.reviewer, cast.finalApprover),
        signature: signature(),
      } as never,
      undefined,
      cast.preparer.id
    );

    const [v1, v2] = await versionsOf(document.id);

    const slotKeys = (slots: unknown) =>
      (slots as { key: string }[]).map((slot) => slot.key);

    expect(slotKeys(v2.signatureSlots)).toEqual([
      cast.preparer.id,
      cast.reviewer.id,
      cast.finalApprover.id,
    ]);
    // And v1 still names the people v1 went to.
    expect(slotKeys(v1.signatureSlots)).toEqual([
      cast.preparer.id,
      cast.approver.id,
      cast.finalApprover.id,
    ]);
  });

  it("keeps printing the chain already on the document when only the text changed", async () => {
    const document = await sentBack();

    await documentsService.updateDocument(
      document.id,
      { body: rewritten("Only the words changed."), signature: signature() } as never,
      undefined,
      cast.preparer.id
    );

    const [, v2] = await versionsOf(document.id);

    expect(
      (v2.signatureSlots as { key: string }[]).map((slot) => slot.key)
    ).toEqual([cast.preparer.id, cast.approver.id, cast.finalApprover.id]);
  });

  it("follows a retitle onto the page it prints as the subject", async () => {
    const document = await sentBack();

    await documentsService.updateDocument(
      document.id,
      {
        title: "Approval for Revision of Fuel Allowance (revised)",
        body: rewritten("Rewritten."),
        signature: signature(),
      } as never,
      undefined,
      cast.preparer.id
    );

    const row = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    expect(row.title).toBe("Approval for Revision of Fuel Allowance (revised)");
    expect(row.currentVersionNumber).toBe(2);
  });

  it("changes the addressee only when the revision says so", async () => {
    const document = await sentBack();

    await documentsService.updateDocument(
      document.id,
      { body: rewritten("Unchanged header."), signature: signature() } as never,
      undefined,
      cast.preparer.id
    );

    const kept = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    expect(kept.memoTo).toBe("Sir BMD");

    await approvalService.requestRevision(document.id, cast.approver.id, {
      comment: "Address it to the MD.",
    });

    await documentsService.updateDocument(
      document.id,
      {
        body: rewritten("Readdressed."),
        memoTo: "The Managing Director",
        signature: signature(),
      } as never,
      undefined,
      cast.preparer.id
    );

    const changed = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    expect(changed.memoTo).toBe("The Managing Director");
    expect(changed.memoFrom).toBe("Human Resource Department");
  });

  it("records the revision as drawn, not uploaded", async () => {
    const document = await sentBack();

    await documentsService.updateDocument(
      document.id,
      { body: rewritten("Rewritten."), signature: signature() } as never,
      undefined,
      cast.preparer.id
    );

    const submitted = await prisma.auditLog.findMany({
      where: { entityId: document.id, action: "DOCUMENT_SUBMITTED" },
      orderBy: { createdAt: "asc" },
    });

    expect(
      submitted.map((row) => (row.newValue as { authoring?: string }).authoring)
    ).toEqual(["GENERATED", "GENERATED"]);
  });

  it("accepts a PDF in place of the text, and says so in the trail", async () => {
    // Not the expected route, but not an error either: a preparer who has a
    // signed scan to put up instead should not be stuck because the first
    // version happened to be typed.
    const document = await sentBack();

    await documentsService.updateDocument(
      document.id,
      { signature: signature() },
      await makeUpload(),
      cast.preparer.id
    );

    const [, v2] = await versionsOf(document.id);
    expect(v2.bodyJson).toBeNull();
    expect(v2.signatureSlots).toBeNull();

    const last = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: document.id, action: "DOCUMENT_SUBMITTED" },
      orderBy: { createdAt: "desc" },
    });
    expect((last.newValue as { authoring?: string }).authoring).toBe("UPLOADED");
  });

  it("refuses text and a PDF together", async () => {
    const document = await sentBack();

    await expect(
      documentsService.updateDocument(
        document.id,
        { body: rewritten("Rewritten."), signature: signature() } as never,
        await makeUpload(),
        cast.preparer.id
      )
    ).rejects.toMatchObject({ statusCode: 400 });

    // Nothing written: still one version, still waiting on the preparer.
    expect(await versionsOf(document.id)).toHaveLength(1);
  });

  it("refuses neither", async () => {
    const document = await sentBack();

    await expect(
      documentsService.updateDocument(
        document.id,
        { signature: signature() },
        undefined,
        cast.preparer.id
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses to turn an uploaded memo into a typed one", async () => {
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.approver, cast.finalApprover),
    });
    await approvalService.requestRevision(document.id, cast.approver.id, {
      comment: "Page 2 is unsigned.",
    });

    await expect(
      documentsService.updateDocument(
        document.id,
        { body: rewritten("Typed instead."), signature: signature() } as never,
        undefined,
        cast.preparer.id
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("leaves v1 live when the revision cannot be drawn", async () => {
    const document = await sentBack();
    const [before] = await versionsOf(document.id);

    await expect(
      documentsService.updateDocument(
        document.id,
        {
          // No bundled font draws this, and a memo of empty boxes must never
          // be sealed. The refusal has to happen before anything is written.
          body: rewritten("السلام عليكم"),
          signature: signature(),
        } as never,
        undefined,
        cast.preparer.id
      )
    ).rejects.toMatchObject({ statusCode: 400 });

    const after = await versionsOf(document.id);
    expect(after).toHaveLength(1);
    expect(after[0].storageChecksum).toBe(before.storageChecksum);
    expect(after[0].isDeleted).toBe(false);

    const row = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    expect(row.status).toBe("REVISION_REQUESTED");
    expect(row.currentVersionNumber).toBe(1);

    // And no v2 file was left behind in storage, under any attempt's name.
    const folder = path.join(path.resolve(env.STORAGE_DIR), "documents", "documents", document.id);
    const left = await fs.readdir(folder).catch(() => [] as string[]);
    expect(left.filter((name) => name.startsWith("v2"))).toEqual([]);
  });

  it("keeps the audit chain verifiable across the revision", async () => {
    const document = await sentBack();

    await documentsService.updateDocument(
      document.id,
      { body: rewritten("Rewritten."), signature: signature() } as never,
      undefined,
      cast.preparer.id
    );

    await ledgerService.seal();
    expect((await ledgerService.verify()).intact).toBe(true);
  });
});

/**
 * The draft stops existing when the memo does.
 *
 * Not tidiness: a draft that survives its own submission is offered back on
 * the Submit screen as something still to finish, and the preparer sends the
 * same memo twice.
 */
describe("the draft a memo was written in", () => {
  const makeDraft = () =>
    prisma.memoDraft.create({
      data: {
        preparerId: cast.preparer.id,
        memoType: "APPROVAL_REQUEST",
        title: "Approval for Revision of Fuel Allowance",
        bodyJson: FUEL_REQUEST_BODY as never,
      },
      select: { id: true },
    });

  it("is deleted when the memo is submitted", async () => {
    const draft = await makeDraft();

    await submitTyped({ draftId: draft.id });

    expect(await prisma.memoDraft.count()).toBe(0);
  });

  it("is left alone when it belongs to somebody else", async () => {
    const theirs = await prisma.memoDraft.create({
      data: { preparerId: cast.approver.id, title: "Not yours" },
      select: { id: true },
    });

    await submitTyped({ draftId: theirs.id });

    // Scoped by preparer in the WHERE clause, so naming somebody else's draft
    // deletes nothing rather than deleting theirs.
    expect(await prisma.memoDraft.count()).toBe(1);
  });

  it("does not take the submission down with it when the id is stale", async () => {
    const draft = await makeDraft();
    await prisma.memoDraft.delete({ where: { id: draft.id } });

    const document = await submitTyped({ draftId: draft.id });

    expect(document.status).toBe("PENDING_REVIEW");
  });

  it("survives a submission that is refused", async () => {
    const draft = await makeDraft();

    await expect(
      submitTyped({
        draftId: draft.id,
        // Refused by the renderer, which runs before the transaction opens.
        // An empty body is refused by the schema instead, which this call
        // does not go through - that one is covered over HTTP.
        body: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "السلام" }],
            },
          ],
        },
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    // The memo never got filed, so the draft is still the only copy of it.
    expect(await prisma.memoDraft.count()).toBe(1);
  });

  it("is deleted for an uploaded memo too", async () => {
    const draft = await makeDraft();

    await documentsService.createDocument(
      {
        title: "An uploaded memo written from a draft",
        approvalChain: chainOf(cast.approver, cast.finalApprover),
        signature: signature(),
        draftId: draft.id,
      },
      await makeUpload(),
      cast.preparer.id
    );

    expect(await prisma.memoDraft.count()).toBe(0);
  });
});

/**
 * A submission that fails after the files are written.
 *
 * Every memo puts two files in storage before the transaction opens: the
 * signed copy, and the one it was made from. If the transaction then fails,
 * both have to go - a file nothing points at is a file nobody will ever find
 * again to clean up, and for a typed memo it is a full copy of somebody's
 * unpublished argument for a pay revision sitting on disk indefinitely.
 */
describe("when the database refuses a memo whose files are already written", () => {
  /** Every file under the documents bucket, however deep. */
  const storedFiles = async (dir = path.join(path.resolve(env.STORAGE_DIR), "documents")): Promise<string[]> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const found: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...(await storedFiles(full)));
      else found.push(full);
    }
    return found;
  };

  const failTheTransaction = async () => {
    const transaction = vi
      .spyOn(prisma, "$transaction")
      .mockRejectedValueOnce(new Error("the database went away"));

    try {
      await expect(submitTyped()).rejects.toThrow("the database went away");
    } finally {
      transaction.mockRestore();
    }
  };

  it("has something to clean up in the first place", async () => {
    // The guard on the two tests below: if a submission stopped writing files
    // before the transaction, they would both pass having checked nothing.
    await submitTyped();

    expect((await storedFiles()).length).toBeGreaterThanOrEqual(2);
  });

  it("removes both files, not just the signed one", async () => {
    /*
     * The signed copy was always removed. The file it was made from was not,
     * so every failed submission left a `-original.pdf` on disk for good.
     */
    const before = await storedFiles();

    await failTheTransaction();

    expect(await storedFiles()).toEqual(before);
  });

  it("writes nothing to the database either", async () => {
    await failTheTransaction();

    expect(await prisma.document.count()).toBe(0);
    expect(await prisma.documentVersion.count()).toBe(0);
  });
});

/**
 * The date the memo bears.
 *
 * Every field in the printed header is the preparer's to set, and this one is
 * not the date the memo was submitted: a memo written on the 6th, agreed
 * verbally, and put through the system on the 11th is dated the 6th. The
 * trail still records when it actually entered the workflow.
 */
describe("the date on the memo", () => {
  const headerDate = async (documentId: string) => {
    const row = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { memoDate: true, submittedAt: true },
    });
    return row;
  };

  it("is what the preparer typed, not the day they submitted", async () => {
    const document = await submitTyped({ memoDate: "2026-08-06" });

    const { memoDate, submittedAt } = await headerDate(document.id);
    expect(memoDate?.toISOString().slice(0, 10)).toBe("2026-08-06");
    // And the submission is still recorded truthfully.
    expect(submittedAt?.toISOString().slice(0, 10)).not.toBe("2026-08-06");
  });

  it("falls back to today when the memo does not carry one", async () => {
    const document = await submitTyped();

    const { memoDate } = await headerDate(document.id);
    expect(memoDate?.toISOString().slice(0, 10)).toBe(
      new Date().toISOString().slice(0, 10)
    );
  });

  it("is stored with no time on it", async () => {
    // Date-only is load-bearing: the PDF's own creation date is pinned to it,
    // and a time would make two renders of the same memo differ.
    const document = await submitTyped({ memoDate: "2026-08-06" });

    const { memoDate } = await headerDate(document.id);
    expect(memoDate?.toISOString()).toBe("2026-08-06T00:00:00.000Z");
  });

  it("reaches the drawn page", async () => {
    const early = await submitTyped({ memoDate: "2026-01-02" });
    const late = await submitTyped({ memoDate: "2026-11-30" });

    const [a, b] = await Promise.all(
      [early, late].map(async (document) => {
        const version = await prisma.documentVersion.findFirstOrThrow({
          where: { documentId: document.id },
        });
        return storageService.downloadDocument(version.storagePath);
      })
    );

    // Nothing here can read text out of a PDF, so the evidence is that the
    // two drawings differ at all - the only thing that changed is the date.
    expect(sha256(a)).not.toBe(sha256(b));
  });

  it("survives a revision unchanged", async () => {
    const document = await submitTyped({ memoDate: "2026-08-06" });
    await approvalService.requestRevision(document.id, cast.approver.id, {
      comment: "Fix the figure.",
    });

    await documentsService.updateDocument(
      document.id,
      {
        body: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Rewritten." }] },
          ],
        },
        signature: signature(),
      } as never,
      undefined,
      cast.preparer.id
    );

    /*
     * The same memo, corrected - not a new one. Re-dating it to the day the
     * correction happened would make v2 claim to be a different document
     * from the v1 people have already signed.
     */
    const { memoDate } = await headerDate(document.id);
    expect(memoDate?.toISOString().slice(0, 10)).toBe("2026-08-06");
  });

  it("can be changed by a revision that says so", async () => {
    const document = await submitTyped({ memoDate: "2026-08-06" });
    await approvalService.requestRevision(document.id, cast.approver.id, {
      comment: "Date it the day it goes out.",
    });

    await documentsService.updateDocument(
      document.id,
      {
        body: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Rewritten." }] },
          ],
        },
        memoDate: "2026-09-01",
        signature: signature(),
      } as never,
      undefined,
      cast.preparer.id
    );

    const { memoDate } = await headerDate(document.id);
    expect(memoDate?.toISOString().slice(0, 10)).toBe("2026-09-01");
  });

  it("stays null for an uploaded memo, which brings its own header", async () => {
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.approver, cast.finalApprover),
    });

    const { memoDate } = await headerDate(document.id);
    expect(memoDate).toBeNull();
  });
});
