import { PDFDocument } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FUEL_REQUEST_BODY } from "../lib/memoTemplate/fuelRequest.fixture";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  makeUser,
  missingId,
  rejection,
  signature,
} from "../test/db";
import { useCleanDatabase } from "../test/db";
import { brandingService } from "./branding.service";
import { documentsService } from "./documents.service";
import { memoPreviewService } from "./memoPreview.service";

/**
 * The memo drawn before it is submitted.
 *
 * This is not decoration. The preparer's signature is placed by dragging a
 * box onto a page, and a typed memo has no page until the server draws one -
 * so without this there is nothing for them to sign, and the feature does not
 * work at all.
 *
 * The rule these are written around: what comes back must be the same drawing
 * the submission will file. A preview that differed from the filed copy would
 * put every signature the preparer placed onto the wrong part of a document
 * that cannot be redrawn.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;

beforeEach(async () => {
  cast = await makeCast();
  brandingService.forget();
});

const input = (overrides: Record<string, unknown> = {}) => ({
  title: "Approval for Revision of Fuel Allowance",
  memoTo: "Sir BMD",
  memoFrom: "Human Resource Department",
  body: FUEL_REQUEST_BODY,
  chain: chainOf(cast.approver, cast.finalApprover),
  ...overrides,
});

describe("drawing a memo that has not been submitted", () => {
  it("returns a real PDF", async () => {
    const preview = await memoPreviewService.renderPreview(
      cast.preparer.id,
      input()
    );

    const bytes = Buffer.from(preview.pdfBase64, "base64");
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(
      preview.pageCount
    );
  });

  it("writes nothing down", async () => {
    await memoPreviewService.renderPreview(cast.preparer.id, input());

    // A preview is not an artefact. It has no reference number, no version
    // row and no file, and nothing about it may look like a submission.
    expect(await prisma.document.count()).toBe(0);
    expect(await prisma.documentVersion.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("draws a line for the preparer and for every approver", async () => {
    const preview = await memoPreviewService.renderPreview(
      cast.preparer.id,
      input()
    );

    // The preparer signs first, so they take the first column. A strip that
    // named only the approvers left them nowhere to sign.
    expect(preview.slots.map((slot) => slot.key)).toEqual([
      cast.preparer.id,
      cast.approver.id,
      cast.finalApprover.id,
    ]);
  });

  it("names one column per person, however the chain repeats them", async () => {
    // Submission refuses a chain naming its own preparer; a half-written
    // draft may well hold one, and two columns with one key would make the
    // slots ambiguous exactly where they are used.
    const preview = await memoPreviewService.renderPreview(
      cast.preparer.id,
      input({
        chain: chainOf(cast.preparer, cast.finalApprover),
      })
    );

    const keys = preview.slots.map((slot) => slot.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("draws the memo before any approver has been chosen", async () => {
    // Routing is the last step of the form, so the body is written long
    // before the chain exists. Refusing to draw until then would make the
    // preview useless for the part of the job it is for.
    const preview = await memoPreviewService.renderPreview(
      cast.preparer.id,
      input({ chain: [] })
    );

    expect(preview.pageCount).toBeGreaterThan(0);
    expect(preview.slots.map((slot) => slot.key)).toEqual([cast.preparer.id]);
  });

  it("draws a memo whose header fields are still empty", async () => {
    const preview = await memoPreviewService.renderPreview(
      cast.preparer.id,
      input({ title: "", memoTo: "", memoFrom: "" })
    );

    expect(preview.pageCount).toBeGreaterThan(0);
  });

  it("skips a step naming somebody who no longer exists", async () => {
    // Drafts are edited over days and people leave in between. Submission
    // refuses such a chain outright, which is the right way round - but a
    // preview that refused to draw would leave the preparer unable to see
    // what was wrong with it.
    const leaver = await makeUser({ firstName: "Leaver" });
    const chain = chainOf(leaver, cast.finalApprover);
    await prisma.user.delete({ where: { id: leaver.id } });

    const preview = await memoPreviewService.renderPreview(
      cast.preparer.id,
      input({ chain })
    );

    expect(preview.slots.map((slot) => slot.key)).toEqual([
      cast.preparer.id,
      cast.finalApprover.id,
    ]);
  });

  it("refuses a body the fonts cannot print, and says so", async () => {
    const error = await rejection(
      memoPreviewService.renderPreview(
        cast.preparer.id,
        input({
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
      )
    );

    // A 400: the request is what is wrong, and the sentence says how to fix
    // it. As a plain Error this reached the preparer as "Internal server
    // error", about the one problem the check exists to explain.
    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(/cannot print|empty boxes/i);
  });
});

describe("the preview and the filed copy are the same drawing", () => {
  it("puts the slots in the same place twice", async () => {
    const first = await memoPreviewService.renderPreview(
      cast.preparer.id,
      input()
    );
    const second = await memoPreviewService.renderPreview(
      cast.preparer.id,
      input()
    );

    expect(second.slots).toEqual(first.slots);
  });

  it("keeps the slots at the foot of the page however long the body is", async () => {
    /*
     * The strip sits at the foot of the last page, with nothing under it but
     * the margin, so a body that grows on the same page does not move the
     * lines. The sign step still draws a fresh preview: a body that grows
     * onto another page takes the strip with it, and the page is part of
     * where a signature goes.
     */
    const short = await memoPreviewService.renderPreview(
      cast.preparer.id,
      input({
        body: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Short." }] }],
        },
      })
    );

    const long = await memoPreviewService.renderPreview(
      cast.preparer.id,
      input()
    );

    expect(long.slots[0].page).toBe(short.slots[0].page);
    expect(long.slots[0].y).toBeCloseTo(short.slots[0].y, 5);
  });
});

/**
 * Redrawing a memo that already exists, for a preparer rewriting it.
 *
 * The reason this reads the document rather than believing the client: the
 * strip's geometry depends on how many people are on it, so a preview drawn
 * from a chain the client reassembled could put the ruled lines somewhere the
 * resubmission does not - and the preparer would have placed their signature
 * against a line that moves under them.
 */
describe("redrawing a memo that is already in flight", () => {
  const submitTyped = async () => {
    const { document } = await documentsService.createDocument(
      {
        title: "Approval for Revision of Fuel Allowance",
        memoType: "APPROVAL_REQUEST",
        memoTo: "Sir BMD",
        memoFrom: "Human Resource Department",
        body: FUEL_REQUEST_BODY,
        approvalChain: chainOf(cast.approver, cast.finalApprover),
        signature: signature(),
      },
      null,
      cast.preparer.id
    );
    return document;
  };

  it("prints the strip from the chain the document already has", async () => {
    const document = await submitTyped();

    const preview = await memoPreviewService.renderPreview(cast.preparer.id, {
      body: FUEL_REQUEST_BODY,
      documentId: document.id,
    });

    expect(preview.slots.map((slot) => slot.key)).toEqual([
      cast.preparer.id,
      cast.approver.id,
      cast.finalApprover.id,
    ]);
  });

  it("puts the lines where the resubmission will put them", async () => {
    const document = await submitTyped();

    const preview = await memoPreviewService.renderPreview(cast.preparer.id, {
      body: FUEL_REQUEST_BODY,
      documentId: document.id,
    });

    const filed = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId: document.id },
    });

    // The same drawing, down to the coordinates. This is the whole point of
    // reading the chain off the document.
    expect(preview.slots).toEqual(filed.signatureSlots);
  });

  it("takes the header off the document when the request does not carry one", async () => {
    /*
     * Byte for byte, with the clock held still.
     *
     * The renderer pins the PDF's own creation and modification dates to the
     * memo date, which is `new Date()`. Those live inside a Flate-compressed
     * object stream, so they cannot be normalised out of the bytes after the
     * fact - and a PDF date has second resolution, so two renders either side
     * of a second boundary differ and the comparison would pass or fail on
     * when the suite happened to run.
     *
     * With the clock stopped the only thing that can differ is the header,
     * which is the whole question. Nothing in this repository can read text
     * back out of a PDF, so the drawn bytes are the evidence.
     *
     * The memo is filed with the clock already stopped, and that is not
     * tidiness. A memo carries its own date; one filed before the clock was
     * held still is dated the day the suite ran, while the preview that
     * spells out its header has no date and falls back to the stopped one -
     * so the two print different days and the comparison fails on every day
     * but the one this was written on.
     */
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 23, 11, 30, 0));

    try {
      const document = await submitTyped();

      const fromDocument = await memoPreviewService.renderPreview(
        cast.preparer.id,
        { body: FUEL_REQUEST_BODY, documentId: document.id }
      );

      const spelledOut = await memoPreviewService.renderPreview(
        cast.preparer.id,
        {
          body: FUEL_REQUEST_BODY,
          title: "Approval for Revision of Fuel Allowance",
          memoTo: "Sir BMD",
          memoFrom: "Human Resource Department",
          chain: chainOf(cast.approver, cast.finalApprover),
        }
      );

      expect(fromDocument.pdfBase64).toBe(spelledOut.pdfBase64);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the request override the header it was asked to redraw", async () => {
    const document = await submitTyped();

    const preview = await memoPreviewService.renderPreview(cast.preparer.id, {
      body: FUEL_REQUEST_BODY,
      documentId: document.id,
      memoTo: "The Managing Director",
    });

    expect(preview.pageCount).toBeGreaterThan(0);
    expect(preview.slots).toHaveLength(3);
  });

  it("refuses anybody but the preparer", async () => {
    const document = await submitTyped();

    const error = await rejection(
      memoPreviewService.renderPreview(cast.approver.id, {
        body: FUEL_REQUEST_BODY,
        documentId: document.id,
      })
    );

    expect(error.statusCode).toBe(403);
  });

  it("refuses a document that does not exist", async () => {
    const error = await rejection(
      memoPreviewService.renderPreview(cast.preparer.id, {
        body: FUEL_REQUEST_BODY,
        documentId: missingId(),
      })
    );

    expect(error.statusCode).toBe(404);
  });

  it("writes nothing", async () => {
    const document = await submitTyped();
    const before = await prisma.documentVersion.count();

    await memoPreviewService.renderPreview(cast.preparer.id, {
      body: FUEL_REQUEST_BODY,
      documentId: document.id,
    });

    expect(await prisma.documentVersion.count()).toBe(before);
    expect(
      (await prisma.document.findUniqueOrThrow({ where: { id: document.id } }))
        .currentVersionNumber
    ).toBe(1);
  });
});
