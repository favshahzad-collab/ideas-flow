import { beforeEach, describe, expect, it } from "vitest";

import { storageService } from "../lib/storage";
import { prisma } from "../prisma";
import { chainOf, makeCast, signature, useCleanDatabase } from "../test/db";
import { brandingService } from "./branding.service";
import { documentsService } from "./documents.service";
import { memoPreviewService } from "./memoPreview.service";

/**
 * A table somebody sized, merged and made room in, carried the whole way.
 *
 * Every piece of this is tested on its own - the operations against a table,
 * the reader and writer against the DOM, the schema against a body, the
 * renderer against the drawn page. What none of them can see is the join: a
 * measurement that survives the editor and the validator and is then dropped
 * on the way to the PDF is a memo that files looking nothing like the one
 * somebody approved, on an artefact that cannot be redrawn.
 *
 * So this submits a real memo and reads the filed bytes back.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;

beforeEach(async () => {
  cast = await makeCast();
  brandingService.forget();
});

const paragraph = (text: string) => ({
  type: "paragraph" as const,
  content: [{ type: "text" as const, text }],
});

const cell = (text: string, colspan?: number) => ({
  type: "tableCell" as const,
  ...(colspan ? { attrs: { colspan } } : {}),
  content: [paragraph(text)],
});

const head = (text: string) => ({
  type: "tableHeader" as const,
  content: [paragraph(text)],
});

/** The details table off the sample memo, shaped as somebody would shape it. */
function body(shape: {
  widths?: number[];
  height?: number;
  merged?: boolean;
}) {
  const last = shape.merged
    ? [cell("Approved by the department", 3)]
    : [cell("Approved"), cell("by the"), cell("department")];

  return {
    type: "doc" as const,
    content: [
      {
        type: "table" as const,
        ...(shape.widths ? { attrs: { widths: shape.widths } } : {}),
        content: [
          {
            type: "tableRow" as const,
            content: [head("AX ID"), head("Employee Name"), head("Allowance")],
          },
          {
            type: "tableRow" as const,
            ...(shape.height ? { attrs: { height: shape.height } } : {}),
            content: [
              cell("1644"),
              cell("Inayat Hussain"),
              cell("75 Litres/Month"),
            ],
          },
          { type: "tableRow" as const, content: last },
        ],
      },
    ],
  };
}

const file = async (over: Record<string, unknown>) => {
  const { document } = await documentsService.createDocument(
    {
      title: "Approval for Revision of Fuel Allowance",
      memoType: "APPROVAL_REQUEST",
      memoTo: "Sir BMD",
      memoFrom: "Human Resource Department",
      approvalChain: chainOf(cast.approver, cast.finalApprover),
      signature: signature(),
      ...over,
    },
    null,
    cast.preparer.id
  );

  const version = await prisma.documentVersion.findFirstOrThrow({
    where: { documentId: document.id },
  });

  return {
    document,
    version,
    bytes: await storageService.downloadDocument(version.originalStoragePath!),
  };
};

describe("filing a memo whose table has been shaped", () => {
  it("keeps the measurements on the version it stores", async () => {
    const shaped = body({ widths: [0.2, 0.5, 0.3], height: 40, merged: true });
    const { version } = await file({ body: shaped });

    // Stored as written, not as the renderer happened to resolve it: a
    // returned memo is reopened from this, and a preparer correcting a
    // sentence must not find their columns back where they started.
    expect(version.bodyJson).toEqual(shaped);
  });

  it("draws a page that is not the one it would have drawn unshaped", async () => {
    /*
     * The join this file exists for. Everything upstream can be right and
     * the widths still be dropped between the validator and the renderer,
     * and the only place that shows is the bytes that get digested.
     */
    const shaped = await file({ body: body({ widths: [0.2, 0.5, 0.3] }) });
    const plain = await file({ body: body({}) });

    expect(shaped.bytes.equals(plain.bytes)).toBe(false);
  });

  it("draws a merged cell and a row height into the page too", async () => {
    const merged = await file({ body: body({ merged: true }) });
    const separate = await file({ body: body({}) });
    const tall = await file({ body: body({ height: 60 }) });

    expect(merged.bytes.equals(separate.bytes)).toBe(false);
    expect(tall.bytes.equals(separate.bytes)).toBe(false);
  });

  it("leaves a table nobody shaped drawn exactly as it always was", async () => {
    // Most memos. If this ever stops holding, every table filed before any
    // of this existed starts rendering differently from the day it was
    // signed - on documents whose whole point is that they cannot change.
    const one = await file({ body: body({}) });
    const other = await file({ body: body({}) });

    expect(one.bytes.equals(other.bytes)).toBe(true);
  });

  it("shows the preparer the same page the submission will file", async () => {
    /*
     * The preview is what a signature is placed against. If it sized the
     * columns differently from the submission, the signature would be
     * positioned on a drawing that never gets filed.
     */
    const shaped = body({ widths: [0.2, 0.5, 0.3], height: 40, merged: true });

    const preview = await memoPreviewService.renderPreview(cast.preparer.id, {
      title: "Approval for Revision of Fuel Allowance",
      memoType: "APPROVAL_REQUEST",
      memoTo: "Sir BMD",
      memoFrom: "Human Resource Department",
      body: shaped,
      chain: chainOf(cast.approver, cast.finalApprover).map(step => ({
        userId: step.userId,
      })),
    });

    const filed = await file({ body: shaped });

    expect(Buffer.from(preview.pdfBase64, "base64").equals(filed.bytes)).toBe(
      true
    );
  });
});
