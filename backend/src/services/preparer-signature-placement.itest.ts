import { describe, expect, it } from "vitest";
import { storageService } from "../lib/storage";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  makeUpload,
  signature,
  useCleanDatabase,
} from "../test/db";
import { drawnImage, drawnText, linesOf, memoPagesOnly } from "../test/pdfText";
import { approvalService } from "./approval.service";
import { documentsService } from "./documents.service";

/**
 * Where the preparer's own signature ends up on the memo they filed.
 *
 * Every signature this product burns in is fitted to the page first: pulled
 * back from an edge it overhangs, refused if it misses the page entirely, and
 * moved up far enough that the block naming the signer fits underneath. That
 * rule was written for approvals and reached from nowhere else, so the
 * preparer's mark - the first one on the memo, and the one every approver
 * then signs around - was placed by no rule at all.
 *
 * A preparer who dropped their signature near the foot of a page got their
 * name, title and date drawn below y=0: off the bottom edge, absent from the
 * document, and unrecoverable once the file is in the chain.
 *
 * An attached PDF now carries no block at all - it prints its own
 * signatories' names and titles, and a block drawn under the mark landed on
 * top of them - so what is left to pin here is the image itself: on the
 * page, and exactly where it was put.
 *
 * The page is 595 x 842 throughout, which is what `makeUpload` builds.
 */

useCleanDatabase();

const PAGE_HEIGHT = 842;
const PAGE_WIDTH = 595;
const SIGNATURE_HEIGHT = 40;

/** A preparer with enough on their profile to fill the block. */
async function makePreparer() {
  const cast = await makeCast();
  await prisma.user.update({
    where: { id: cast.preparer.id },
    data: { designation: "HR Manager" },
  });
  return cast;
}

const submitWith = async (
  preparerId: string,
  reviewer: { id: string },
  overrides: Record<string, unknown>
) =>
  documentsService.createDocument(
    {
      title: "Annual leave policy",
      approvalChain: chainOf(reviewer),
      signature: signature({
        signatureWidth: 120,
        signatureHeight: SIGNATURE_HEIGHT,
        ...overrides,
      }),
    },
    await makeUpload(),
    preparerId
  );

/** The memo as it was filed, which is what the first approver opens. */
async function filedPdf(documentId: string): Promise<Buffer> {
  const version = await prisma.documentVersion.findFirstOrThrow({
    where: { documentId },
    orderBy: { versionNumber: "desc" },
  });
  return storageService.downloadDocument(version.storagePath);
}

/** Flush against the bottom edge, which is where the editor let them drop it. */
const AT_THE_FOOT = {
  signatureX: 60,
  signatureY: PAGE_HEIGHT - SIGNATURE_HEIGHT,
};

describe("a signature dropped at the foot of the page", () => {
  it("adds no name or title under the preparer's mark on an attached PDF", async () => {
    const cast = await makePreparer();

    const { document } = await submitWith(
      cast.preparer.id,
      cast.reviewer,
      AT_THE_FOOT
    );

    // The PDF prints its own signatories; the portal adds nothing to it.
    expect(drawnText(await filedPdf(document.id))).toEqual([]);
  });

  it("leaves a signature at the very foot exactly where it was put", async () => {
    const cast = await makePreparer();

    const { document } = await submitWith(
      cast.preparer.id,
      cast.reviewer,
      AT_THE_FOOT
    );

    // With nothing hanging below it there is nothing to make room for, so
    // the mark is not lifted: its foot sits on the bottom edge it was put on.
    expect(drawnImage(await filedPdf(document.id)).y).toBeCloseTo(0, 5);
  });

  it("leaves a signature that already fits exactly where it was put", async () => {
    // The ordinary case, pinned: fitting must not move a placement that had
    // room for its block all along.
    const cast = await makePreparer();

    const { document } = await submitWith(cast.preparer.id, cast.reviewer, {
      signatureX: 60,
      signatureY: 300,
    });

    expect(drawnImage(await filedPdf(document.id))).toMatchObject({
      x: 60,
      y: PAGE_HEIGHT - 300 - SIGNATURE_HEIGHT,
      width: 120,
      height: SIGNATURE_HEIGHT,
    });
  });

  it("does the same on a resubmission after a revision request", async () => {
    // The other caller of the same stamping path. A memo that comes back for
    // revision is signed again, and was losing the block the same way.
    const cast = await makePreparer();
    const { document } = await submitWith(cast.preparer.id, cast.reviewer, {
      signatureX: 60,
      signatureY: 300,
    });

    await approvalService.requestRevision(document.id, cast.reviewer.id, {
      comment: "Please correct the leave entitlement table.",
    });

    await documentsService.updateDocument(
      document.id,
      {
        // No chain change - the reviewer has already acted, and resubmission
        // keeps the chain it was returned from.
        signature: signature({
          signatureWidth: 120,
          signatureHeight: SIGNATURE_HEIGHT,
          ...AT_THE_FOOT,
        }),
      },
      await makeUpload(),
      cast.preparer.id
    );

    for (const line of drawnText(await filedPdf(document.id))) {
      expect(line.y).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("a signature that cannot be placed at all", () => {
  it("is refused in words, not filed with nothing visible on it", async () => {
    /*
     * The submission schema accepts a negative offset on the stated grounds
     * that "clamping is the renderer's job". This is the renderer, and it was
     * not doing it - so a replayed or hand-made call put the signature into
     * nowhere and the memo entered the chain reading as signed with no mark
     * anywhere on it.
     */
    const cast = await makePreparer();

    await expect(
      submitWith(cast.preparer.id, cast.reviewer, {
        signatureX: PAGE_WIDTH + 500,
        signatureY: 100,
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message:
        "The signature was placed outside the page. Move it onto the page and sign again.",
    });
  });

  it("pulls a box that only overhangs back onto the page", async () => {
    // A fraction over the edge falls out of the viewer's float conversion and
    // is not misuse. Refusing it would fail a submission that draws fine.
    const cast = await makePreparer();

    const { document } = await submitWith(cast.preparer.id, cast.reviewer, {
      signatureX: PAGE_WIDTH - 10,
      signatureY: 300,
    });

    expect(drawnImage(await filedPdf(document.id)).x).toBe(PAGE_WIDTH - 120);
  });

  it("answers for an unreadable signature image instead of failing at 500", async () => {
    /*
     * This used to be pdf-lib's plain "SOI not found in JPEG", which reached
     * the preparer as a 500 with their upload, their chain and their
     * signature to enter again. The bytes are now refused before any decoder
     * sees them, and the message says both what is wrong and what to do.
     */
    const cast = await makePreparer();

    await expect(
      submitWith(cast.preparer.id, cast.reviewer, {
        signatureImage: "data:image/png;base64,bm90IGFuIGltYWdl",
        signatureY: 300,
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message:
        "The signature image is not a PNG or a JPEG. Draw a new signature, or re-upload your saved one.",
    });
  });
});

describe("what an approver then signs", () => {
  it("adds no text under either signature on an attached PDF", async () => {
    // The document approvers open is the one the preparer signed, and each
    // signature after it is put on alone as well.
    const cast = await makePreparer();

    const { document } = await submitWith(
      cast.preparer.id,
      cast.reviewer,
      AT_THE_FOOT
    );

    const { useSavedSignature: _saved, ...placement } = signature({
      signatureY: 400,
    });
    await approvalService.approve(document.id, cast.reviewer.id, {
      ...placement,
      useSavedSignature: false,
    });

    const finalPdf = await filedPdf(document.id);
    const signed = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
      select: { finalSignedStoragePath: true },
    });

    const pdf = signed.finalSignedStoragePath
      ? await storageService.downloadDocument(signed.finalSignedStoragePath)
      : finalPdf;

    // The memo's own pages: the certificate at the end names everybody, by design.
    expect(linesOf(await memoPagesOnly(pdf))).toEqual([]);
  });
});
