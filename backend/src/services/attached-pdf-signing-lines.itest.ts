import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeEach, describe, expect, it } from "vitest";
import { placementForSlot } from "../lib/memoSignatureSlots";
import { storageService } from "../lib/storage";
import { prisma } from "../prisma";
import { chainOf, makeCast, rejection, signature, useCleanDatabase } from "../test/db";
import { linesOf, memoPagesOnly } from "../test/pdfText";
import { approvalService } from "./approval.service";
import { documentsService } from "./documents.service";

/**
 * An attached PDF's signing lines, found above its printed names.
 *
 * The memo is written in Word and prints each signatory's name under a ruled
 * line at its foot. The portal now finds those names when the PDF is attached
 * and records a line above each, exactly as a typed memo's strip does - so a
 * signature goes on its own person's line wherever it was dropped, and nobody
 * can put theirs on somebody else's.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;

beforeEach(async () => {
  cast = await makeCast();
});

/** A memo with a signature strip naming whoever is passed, in columns. */
async function wordMemo(names: string[]): Promise<Express.Multer.File> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([595, 842]);
  page.drawText("Office memorandum", { x: 60, y: 780, size: 14, font });
  names.forEach((name, index) => {
    const x = 40 + index * 135;
    page.drawLine({ start: { x, y: 130 }, end: { x: x + 120, y: 130 } });
    page.drawText(name, { x: x + 10, y: 115, size: 9, font });
  });
  const buffer = Buffer.from(await pdf.save());
  return {
    fieldname: "file",
    originalname: "memo.pdf",
    encoding: "7bit",
    mimetype: "application/pdf",
    size: buffer.length,
    buffer,
    stream: undefined as never,
    destination: "",
    filename: "memo.pdf",
    path: "",
  };
}

const named = (person: { firstName: string; lastName: string }) => `${person.firstName} ${person.lastName}`;

async function submitWith(names: string[], chain = chainOf(cast.reviewer, cast.approver, cast.finalApprover)) {
  const { document } = await documentsService.createDocument(
    { title: "Leave policy", approvalChain: chain, signature: signature() },
    await wordMemo(names),
    cast.preparer.id
  );
  return document;
}

const slotsOf = async (documentId: string) =>
  (
    await prisma.documentVersion.findFirstOrThrow({
      where: { documentId },
      orderBy: { versionNumber: "desc" },
    })
  ).signatureSlots as { key: string; page: number; x: number; y: number; width: number; height: number; detected?: boolean }[] | null;

describe("finding the lines when a PDF is attached", () => {
  it("records a line above each signatory's printed name, preparer included", async () => {
    const document = await submitWith([cast.preparer, cast.reviewer, cast.approver, cast.finalApprover].map(named));
    const slots = await slotsOf(document.id);

    expect(slots?.map((slot) => slot.key).sort()).toEqual(
      [cast.preparer.id, cast.reviewer.id, cast.approver.id, cast.finalApprover.id].sort()
    );
    expect(slots?.every((slot) => slot.detected === true)).toBe(true);
  });

  it("records nothing for a PDF that prints none of their names", async () => {
    const document = await submitWith(["Somebody Else", "Another Person"]);
    expect(await slotsOf(document.id)).toBeNull();
  });

  it("puts the preparer's own signature on their line, wherever it was dropped", async () => {
    const document = await submitWith([cast.preparer, cast.reviewer, cast.approver, cast.finalApprover].map(named));
    const mine = (await slotsOf(document.id))!.find((slot) => slot.key === cast.preparer.id)!;
    const submitted = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: document.id, action: "DOCUMENT_SUBMITTED" },
    });
    expect((submitted.newValue as { signaturePage?: number }).signaturePage).toBe(mine.page);
  });

  it("refuses a preparer's signature dropped on an approver's name", async () => {
    const memo = await wordMemo([cast.preparer, cast.reviewer, cast.approver, cast.finalApprover].map(named));
    // Where the reviewer's line lands: second column, just above the name.
    const onReviewer = { signatureX: 190, signatureY: 680, signatureWidth: 110, signatureHeight: 36 };

    const error = await rejection(
      documentsService.createDocument(
        { title: "Leave policy", approvalChain: chainOf(cast.reviewer, cast.approver, cast.finalApprover), signature: signature(onReviewer) },
        memo,
        cast.preparer.id
      )
    );
    expect(error).toMatchObject({ statusCode: 403 });
  });
});

describe("approving on an attached PDF with lines", () => {
  const everybody = () => [cast.preparer, cast.reviewer, cast.approver, cast.finalApprover].map(named);

  it("offers the approver their own line", async () => {
    const document = await submitWith(everybody());
    const detail = await documentsService.getDocumentById(document.id, cast.reviewer.id);
    const mine = (await slotsOf(document.id))!.find((slot) => slot.key === cast.reviewer.id)!;
    expect(detail.mySignatureSlot).toMatchObject({ page: mine.page, x: mine.x, y: mine.y });
  });

  it("puts the signature on their line even when it was sent somewhere else", async () => {
    const document = await submitWith(everybody());
    await approvalService.approve(document.id, cast.reviewer.id, signature());

    const action = await prisma.approvalAction.findFirstOrThrow({ where: { actorId: cast.reviewer.id } });
    const mine = (await slotsOf(document.id))!.find((slot) => slot.key === cast.reviewer.id)!;
    expect({
      signaturePage: action.signaturePage,
      signatureX: action.signatureX,
      signatureY: action.signatureY,
      signatureWidth: action.signatureWidth,
      signatureHeight: action.signatureHeight,
    }).toEqual(placementForSlot(mine as never));
  });

  it("refuses a signature placed on somebody else's name", async () => {
    const document = await submitWith(everybody());
    const theirs = (await slotsOf(document.id))!.find((slot) => slot.key === cast.finalApprover.id)!;

    const error = await rejection(
      approvalService.approve(
        document.id,
        cast.reviewer.id,
        signature({ signatureX: theirs.x + 5, signatureY: theirs.y + 2, signatureWidth: 100, signatureHeight: 30 })
      )
    );
    expect(error).toMatchObject({ statusCode: 403 });
    expect(await prisma.approvalAction.count()).toBe(0);
  });

  it("still adds no name or title under any signature", async () => {
    const document = await submitWith(everybody());
    const original = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: document.id } });
    const before = linesOf(await storageService.downloadDocument(original.originalStoragePath!));

    for (const person of [cast.reviewer, cast.approver, cast.finalApprover]) {
      await approvalService.approve(document.id, person.id, signature());
    }
    const approved = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    const after = linesOf(await memoPagesOnly(await storageService.downloadDocument(approved.finalSignedStoragePath!)));
    expect(after).toEqual(before);
  });

  it("leaves somebody whose name is not printed to place it themselves", async () => {
    // The final approver's name is missing from this strip.
    const document = await submitWith([cast.preparer, cast.reviewer, cast.approver].map(named));
    await approvalService.approve(document.id, cast.reviewer.id, signature());
    await approvalService.approve(document.id, cast.approver.id, signature());
    const free = { signatureX: 300, signatureY: 300, signatureWidth: 110, signatureHeight: 36 };
    await approvalService.approve(document.id, cast.finalApprover.id, signature(free));

    const action = await prisma.approvalAction.findFirstOrThrow({ where: { actorId: cast.finalApprover.id } });
    expect({ x: action.signatureX, y: action.signatureY }).toEqual({ x: 300, y: 300 });
  });
});
