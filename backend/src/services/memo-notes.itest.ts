import { describe, expect, it } from "vitest";

import { prisma } from "../prisma";
import { storageService } from "../lib/storage";
import {
  chainOf,
  makeCast,
  makeUpload,
  signature,
  useCleanDatabase,
} from "../test/db";
import { drawnTextOnPage } from "../test/pdfText";
import { documentsService } from "./documents.service";
import { FUEL_REQUEST_BODY } from "../lib/memoTemplate/fuelRequest.fixture";

/**
 * A note placed on the page, from submission to filed artefact.
 *
 * The renderer's own tests prove a note is drawn where it was put. These prove
 * the rest of the journey: that what a preparer placed reaches the PDF that is
 * stored and hashed, that the row records it, and that a revision cannot
 * quietly change what v1 said.
 */

useCleanDatabase();

const NOTE = {
  page: 1,
  x: 320,
  y: 300,
  width: 180,
  height: 60,
  text: "Checked against the register on 6 August.",
};

const typed = (cast: Awaited<ReturnType<typeof makeCast>>, over: Record<string, unknown> = {}) => ({
  title: "Approval for Revision of Fuel Allowance",
  memoType: "APPROVAL_REQUEST",
  memoTo: "Sir BMD",
  memoFrom: "Human Resource Department",
  body: FUEL_REQUEST_BODY,
  approvalChain: chainOf(cast.approver, cast.finalApprover),
  signature: signature(),
  ...over,
});

/** Text runs inside a note's box, on its page, from the stored artefact. */
async function runsInNote(documentId: string) {
  const version = await prisma.documentVersion.findFirstOrThrow({
    where: { documentId },
  });
  const bytes = await storageService.downloadDocument(version.storagePath);

  const A4_HEIGHT = 841.89;
  const top = A4_HEIGHT - NOTE.y;
  const bottom = A4_HEIGHT - NOTE.y - NOTE.height;

  return drawnTextOnPage(bytes, NOTE.page).filter(
    (run) =>
      run.x >= NOTE.x &&
      run.x <= NOTE.x + NOTE.width &&
      run.y <= top &&
      run.y >= bottom
  );
}

describe("a memo submitted with a note on it", () => {
  it("files a PDF carrying the note", async () => {
    const cast = await makeCast();

    const { document } = await documentsService.createDocument(
      typed(cast, { notes: [NOTE] }),
      null,
      cast.preparer.id
    );
    const withNote = await runsInNote(document.id);

    const plain = await documentsService.createDocument(
      typed(cast, { title: "The same memo, no note" }),
      null,
      cast.preparer.id
    );
    const without = await runsInNote(plain.document.id);

    expect(withNote.length).toBeGreaterThan(without.length);
  });

  it("records what was placed, beside where the signatures go", async () => {
    // The artefact is immutable and hashed. What was drawn on it has to be
    // answerable later without redrawing the memo as it would look today.
    const cast = await makeCast();
    const { document } = await documentsService.createDocument(
      typed(cast, { notes: [NOTE] }),
      null,
      cast.preparer.id
    );

    const version = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId: document.id },
    });

    expect(version.pageNotesJson).toEqual([NOTE]);
  });

  it("records nothing for a memo with no notes", async () => {
    const cast = await makeCast();
    const { document } = await documentsService.createDocument(
      typed(cast),
      null,
      cast.preparer.id
    );

    const version = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId: document.id },
    });

    expect(version.pageNotesJson).toBeNull();
  });

  it("files nothing for a box nobody wrote in", async () => {
    // An empty box is one somebody placed and thought better of. It must not
    // become an empty rectangle printed on a document forever.
    const cast = await makeCast();
    const { document } = await documentsService.createDocument(
      typed(cast, { notes: [{ ...NOTE, text: "   " }] }),
      null,
      cast.preparer.id
    );

    const version = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId: document.id },
    });

    expect(version.pageNotesJson).toBeNull();
  });

  it("leaves the uploaded path alone", async () => {
    // An uploaded memo brings its own PDF. Nothing is drawn onto it here, and
    // nothing about notes may change that.
    const cast = await makeCast();
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

    expect(version.pageNotesJson).toBeNull();
    expect(version.bodyJson).toBeNull();
  });
});
