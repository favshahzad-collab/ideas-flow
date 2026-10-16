import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { contentStreams, drawnTextOnPage } from "../../test/pdfText";
import { solidPngDataUrl } from "../../test/png";
import { findUndrawableCharacters } from "./coverage";
import { MARGIN_BOTTOM, MARGIN_TOP, MARGIN_X, PAGE_HEIGHT, TEXT_WIDTH } from "./sheet";
import { FUEL_REQUEST, FUEL_REQUEST_BODY } from "./fuelRequest.fixture";
import {
  SIGNING_SPACE,
  formatMemoDate,
  renderMemo,
  renderMemoDocument,
} from "./renderMemo";
import type { MemoBody, RenderMemoInput } from "./types";

const AUGUST = new Date(Date.UTC(2026, 7, 6));

function memo(overrides: Partial<RenderMemoInput> = {}): RenderMemoInput {
  return { ...FUEL_REQUEST, ...overrides };
}

function paragraphs(count: number): MemoBody {
  return {
    type: "doc",
    content: Array.from({ length: count }, (_, index) => ({
      type: "paragraph" as const,
      content: [
        {
          type: "text" as const,
          text: `Paragraph ${index + 1}. ${"The quick brown fox jumps over the lazy dog. ".repeat(4)}`,
        },
      ],
    })),
  };
}

describe("rendering the reference memo", () => {
  it("produces a one-page A4 PDF", async () => {
    const pdf = await renderMemo(FUEL_REQUEST);
    const parsed = await PDFDocument.load(pdf);

    expect(parsed.getPageCount()).toBe(1);

    const { width, height } = parsed.getPage(0).getSize();
    expect(width).toBeCloseTo(595.28, 1);
    expect(height).toBeCloseTo(841.89, 1);
  });

  it("carries the memo's own subject and date, not the clock", async () => {
    /*
     * `updateMetadata: false` is required to read this honestly.
     *
     * pdf-lib calls `updateInfoDict()` from the PDFDocument constructor, and
     * that overwrites ModDate with `new Date()` - so a plain
     * `PDFDocument.load()` reports the moment of the load rather than what
     * the file says, and an assertion written against it is measuring the
     * test's own clock.
     */
    const parsed = await PDFDocument.load(await renderMemo(FUEL_REQUEST), {
      updateMetadata: false,
    });

    expect(parsed.getTitle()).toBe(FUEL_REQUEST.header.subject);
    expect(parsed.getCreationDate()?.getTime()).toBe(AUGUST.getTime());
    expect(parsed.getModificationDate()?.getTime()).toBe(AUGUST.getTime());
  });

  it("is read back with a fresh ModDate when metadata is not suppressed", async () => {
    // Pinned deliberately: this is pdf-lib's behaviour, it is why the
    // assertion above passes `updateMetadata: false`, and it is why
    // `pdfSignature.ts` - which loads a document to stamp it - produces a
    // file whose ModDate is the moment of stamping. Nothing depends on that
    // being stable, because each artefact is digested as it is written.
    const loaded = await PDFDocument.load(await renderMemo(FUEL_REQUEST));

    expect(loaded.getCreationDate()?.getTime()).toBe(AUGUST.getTime());
    expect(loaded.getModificationDate()?.getTime()).toBeGreaterThan(
      AUGUST.getTime()
    );
  });

  it("prints the date the way the memo does", () => {
    expect(formatMemoDate(AUGUST)).toBe("August 06, 2026");
    expect(formatMemoDate(new Date(Date.UTC(2026, 11, 25)))).toBe(
      "December 25, 2026"
    );
  });
});

/**
 * The digest of this file is stored on the version row and the API checks
 * bytes against it before serving. If a render is not reproducible, that
 * digest describes the minute it was built rather than the memo.
 */
describe("the same memo renders to the same bytes", () => {
  it("is byte-identical across renders separated in time", async () => {
    const first = await renderMemo(FUEL_REQUEST);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await renderMemo(FUEL_REQUEST);

    expect(Buffer.compare(first, second)).toBe(0);
  });

  it("changes when the memo changes", async () => {
    const first = await renderMemo(FUEL_REQUEST);
    const second = await renderMemo(
      memo({ header: { ...FUEL_REQUEST.header, to: "Sir ABC" } })
    );

    expect(Buffer.compare(first, second)).not.toBe(0);
  });
});

describe("the signature strip follows the chain", () => {
  it.each([1, 2, 3, 4, 6])("lays out %i signatories", async (count) => {
    const signatories = Array.from({ length: count }, (_, index) => ({
      name: `Approver ${index + 1}`,
      designation: `Director of Thing ${index + 1}`,
    }));

    const pdf = await renderMemo(memo({ signatories }));
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(0);
  });

  it("renders a memo with no signatories at all", async () => {
    // A chain is validated elsewhere; the renderer must not be the thing
    // that throws on an empty strip.
    const pdf = await renderMemo(memo({ signatories: [] }));
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("accepts a signatory with no designation", async () => {
    const pdf = await renderMemo(
      memo({ signatories: [{ name: "Chairman" }] })
    );
    expect(pdf.length).toBeGreaterThan(1000);
  });

  /*
   * The office each signatory signs for.
   *
   * Asserted by drawing rather than by the data going in: the strip carrying
   * a department and the strip PRINTING one are different claims, and it is
   * the printed page somebody reads.
   */
  it("prints the office under the designation", async () => {
    const one = { name: "Inayat Hussain", designation: "Security Executive" };

    const without = await renderMemo(memo({ signatories: [one] }));
    const withOffice = await renderMemo(
      memo({
        signatories: [{ ...one, department: "Security & Loss Prevention" }],
      })
    );

    const before = drawnTextOnPage(without, 1);
    const after = drawnTextOnPage(withOffice, 1);

    // Strictly more drawn on the page, and nothing that was there reflowed:
    // the office is a new line below. The strip ends at the foot of the
    // page, so a taller strip rises as one piece - the body stays where it
    // was and every line of the strip moves up by the same amount.
    expect(after.length).toBeGreaterThan(before.length);
    const lifts = new Set<number>();
    for (const [at, run] of before.entries()) {
      expect(after[at].x).toBeCloseTo(run.x, 2);
      const lift = Number((after[at].y - run.y).toFixed(2));
      if (lift !== 0) lifts.add(lift);
    }
    expect(lifts.size).toBe(1);
    expect([...lifts][0]).toBeGreaterThan(0);
  });

  it("draws nothing extra for a signatory with no office", async () => {
    // Byte-identical, so every memo filed before this existed is unaffected.
    const one = { name: "Chairman", designation: "Chairman" };

    const absent = await renderMemo(memo({ signatories: [one] }));
    const explicitlyNull = await renderMemo(
      memo({ signatories: [{ ...one, department: null }] })
    );

    expect(explicitlyNull.equals(absent)).toBe(true);
  });

  it("still fits six columns with three lines each", async () => {
    const six = Array.from({ length: 6 }, (_, index) => ({
      name: `Approver ${index + 1}`,
      designation: `Director of Thing ${index + 1}`,
      department: `Department of Thing ${index + 1}`,
    }));

    const pdf = await renderMemo(memo({ signatories: six }));
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(0);
  });
});

describe("running onto more pages", () => {
  it("paginates a long body", async () => {
    const pdf = await renderMemo(memo({ body: paragraphs(40) }));
    const parsed = await PDFDocument.load(pdf);

    expect(parsed.getPageCount()).toBeGreaterThan(1);
  });

  it("starts a new page where the body asks for one", async () => {
    const before = await PDFDocument.load(
      await renderMemo(
        memo({
          body: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "One" }] },
              { type: "paragraph", content: [{ type: "text", text: "Two" }] },
            ],
          },
        })
      )
    );

    const after = await PDFDocument.load(
      await renderMemo(
        memo({
          body: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "One" }] },
              { type: "pageBreak" },
              { type: "paragraph", content: [{ type: "text", text: "Two" }] },
            ],
          },
        })
      )
    );

    expect(before.getPageCount()).toBe(1);
    expect(after.getPageCount()).toBe(2);
  });

  it("keeps a table with many rows inside the page", async () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({
      type: "tableRow" as const,
      content: [
        { type: "tableCell" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: String(index) }] }] },
        { type: "tableCell" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: `Employee ${index}` }] }] },
      ],
    }));

    const pdf = await renderMemo(
      memo({
        body: {
          type: "doc",
          content: [
            {
              type: "table",
              content: [
                {
                  type: "tableRow",
                  content: [
                    { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "ID" }] }] },
                    { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Name" }] }] },
                  ],
                },
                ...rows,
              ],
            },
          ],
        },
      })
    );

    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(1);
  });
});

/**
 * The reason this check exists: pdf-lib measures Urdu happily and then draws
 * empty boxes, and the result would be digested, sealed and signed.
 */
describe("refusing what it cannot draw", () => {
  it("passes the reference memo", () => {
    expect(findUndrawableCharacters(FUEL_REQUEST)).toEqual([]);
  });

  it("names the characters it cannot print", async () => {
    const bad = memo({
      body: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Salary الس revision" }],
          },
        ],
      },
    });

    expect(findUndrawableCharacters(bad).length).toBeGreaterThan(0);
    await expect(renderMemo(bad)).rejects.toThrow(
      /cannot print|empty boxes/i
    );
  });

  it("checks the header and the signatories too, not only the body", () => {
    expect(
      findUndrawableCharacters(
        memo({ header: { ...FUEL_REQUEST.header, to: "中文" } })
      )
    ).not.toEqual([]);

    expect(
      findUndrawableCharacters(
        memo({ signatories: [{ name: "الس" }] })
      )
    ).not.toEqual([]);
  });

  it("does not object to tabs and newlines", () => {
    expect(
      findUndrawableCharacters(
        memo({
          body: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "a\tb\nc" }] },
            ],
          },
        })
      )
    ).toEqual([]);
  });
});

describe("the body the editor can produce", () => {
  it("renders every node type in one document", async () => {
    const pdf = await renderMemo(
      memo({
        body: {
          type: "doc",
          content: [
            { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Level one" }] },
            { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Level two" }] },
            {
              type: "paragraph",
              content: [
                { type: "text", text: "plain " },
                { type: "text", text: "bold ", marks: [{ type: "bold" }] },
                { type: "text", text: "italic ", marks: [{ type: "italic" }] },
                { type: "text", text: "underlined", marks: [{ type: "underline" }] },
              ],
            },
            {
              type: "bulletList",
              content: [
                { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] },
                { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }] },
              ],
            },
            {
              type: "orderedList",
              content: [
                { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "step one" }] }] },
              ],
            },
            ...FUEL_REQUEST_BODY.content.filter((node) => node.type === "table"),
            { type: "pageBreak" },
            { type: "paragraph", content: [{ type: "text", text: "after the break" }] },
          ],
        },
      })
    );

    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(2);
  });

  it("survives an empty body", async () => {
    const pdf = await renderMemo(memo({ body: { type: "doc", content: [] } }));
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });

  it("does not break a word that fits the column", async () => {
    // The employee id 1644 was printed as "16" above "44" because every
    // column was scaled down by the same factor, including one with no room
    // to give. Rendering must not split a token that the column can hold.
    const pdf = await renderMemo(FUEL_REQUEST);
    expect(pdf.length).toBeGreaterThan(1000);
  });
});

describe("branding is data, not code", () => {
  it("renders without a logo", async () => {
    const pdf = await renderMemo(
      memo({ branding: { organisationName: "Another Company Ltd", logo: null } })
    );
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("accepts a different organisation name", async () => {
    const pdf = await renderMemo(
      memo({ branding: { organisationName: "Second Org", logo: null } })
    );
    expect(pdf.length).toBeGreaterThan(1000);
  });
});

/**
 * The slots are how the printed strip and the stamping path are joined up.
 *
 * Without them the memo prints ruled lines that nobody signs, while the
 * signatures land somewhere in the body - so every approver's name appears
 * on the page twice, once signed and once not. These tests are about the
 * arithmetic that makes the two agree.
 */
describe("where the signatures go", () => {
  const three = [
    { key: "a", name: "Shazia Khan", designation: "Chief Operating Officer" },
    { key: "b", name: "Rizwan Mushtaq", designation: "Director - HR" },
    { key: "c", name: "Maryam Ali", designation: "Director - Audit" },
  ];

  it("reports one slot per signatory, in the printed order", async () => {
    const { slots } = await renderMemoDocument(memo({ signatories: three }));

    expect(slots.map((slot) => slot.key)).toEqual(["a", "b", "c"]);
    expect(slots.map((slot) => slot.name)).toEqual([
      "Shazia Khan",
      "Rizwan Mushtaq",
      "Maryam Ali",
    ]);
  });

  it("puts them left to right without overlapping", async () => {
    const { slots } = await renderMemoDocument(memo({ signatories: three }));

    for (const [index, slot] of slots.entries()) {
      if (index === 0) continue;
      const left = slots[index - 1];
      expect(slot.x).toBeGreaterThan(left.x + left.width);
      // Every column is on one line, so they share a top edge.
      expect(slot.y).toBeCloseTo(left.y, 5);
    }
  });

  it("keeps every slot inside the page", async () => {
    const { slots } = await renderMemoDocument(memo({ signatories: three }));

    for (const slot of slots) {
      expect(slot.x).toBeGreaterThanOrEqual(0);
      expect(slot.y).toBeGreaterThanOrEqual(0);
      expect(slot.x + slot.width).toBeLessThanOrEqual(595.28);
      expect(slot.y + slot.height).toBeLessThanOrEqual(841.89);
      expect(slot.width).toBeGreaterThan(0);
      expect(slot.height).toBe(SIGNING_SPACE);
    }
  });

  it("reports the page the strip actually landed on", async () => {
    // A memo long enough to push the strip onto a second page. A slot that
    // still claimed page 1 would place every signature in the middle of the
    // body text.
    const { slots, pageCount } = await renderMemoDocument(
      memo({ body: paragraphs(30), signatories: three })
    );

    expect(pageCount).toBeGreaterThan(1);
    for (const slot of slots) expect(slot.page).toBe(pageCount);
  });

  it("gives no slots to a memo with no signatories", async () => {
    const { slots } = await renderMemoDocument(memo({ signatories: [] }));
    expect(slots).toEqual([]);
  });

  it("leaves the signing space clear of the page number", async () => {
    /*
     * The strip used to reserve only its own height and then advance into
     * whatever was left, so on a page with just enough room it was pushed
     * down and its last 28 points were drawn into the bottom margin - where
     * the page number is written.
     *
     * Sized so the strip is the thing that decides whether a new page starts.
     */
    for (const count of [11, 12, 13, 14]) {
      const { slots, pageCount } = await renderMemoDocument(
        memo({ body: paragraphs(count), signatories: three })
      );

      for (const slot of slots) {
        // MARGIN_BOTTOM is 57.6, and the page number sits 28pt into it.
        expect(slot.y + slot.height).toBeLessThanOrEqual(841.89 - 57.6);
        expect(slot.page).toBe(pageCount);
      }
    }
  });

  it("is the same page twice for the same memo", async () => {
    // The preparer places their signature against a preview and the
    // submission draws the memo again. Two drawings that disagreed by a few
    // points would put the signature off its line on a document that cannot
    // be redrawn.
    const first = await renderMemoDocument(memo({ signatories: three }));
    const second = await renderMemoDocument(memo({ signatories: three }));

    expect(second.slots).toEqual(first.slots);
    expect(second.bytes.equals(first.bytes)).toBe(true);
  });
});

describe("pictures in the body", () => {
  const picture = (src: string, attrs: Record<string, unknown> = {}): MemoBody["content"][number] =>
    ({ type: "image", attrs: { src, ...attrs } });

  const line = (text: string): MemoBody["content"][number] => ({
    type: "paragraph",
    content: [{ type: "text", text }],
  });

  /**
   * Without the logo, so the only picture in the file is the memo's, and
   * without signatories, so the page count is the body's alone.
   */
  const withPictures = (...content: MemoBody["content"]): RenderMemoInput =>
    memo({
      branding: { ...FUEL_REQUEST.branding, logo: null },
      signatories: [],
      body: { type: "doc", content },
    });

  /**
   * Every picture drawn, in order, as pdf-lib placed it: the same matrix
   * arithmetic `drawnImage` does, for each `Do` rather than the first.
   */
  function drawnImages(pdf: Buffer): { x: number; y: number; width: number; height: number }[] {
    const N = "(-?\\d+(?:\\.\\d+)?)";
    const matrix = new RegExp([N, N, N, N, N, N, "cm"].join("\\s+"), "g");
    const placed: { x: number; y: number; width: number; height: number }[] = [];

    // Each image `Do`, not the first ` Do` in the file: with the memo's fonts
    // embedded, those three bytes turn up inside a font program too.
    const imageDraw = new RegExp("/Image[^ ]* Do", "g");
    for (const stream of contentStreams(pdf)) {
      for (const found of stream.matchAll(imageDraw)) {
        const draw = found.index;
        const block = stream.slice(stream.lastIndexOf("q", draw), draw);
        let ctm = [1, 0, 0, 1, 0, 0];
        for (const found of block.matchAll(matrix)) {
          const [a, b, c, d, e, f] = found.slice(1).map(Number);
          const [A, B, C, D, E, F] = ctm;
          ctm = [
            a * A + b * C,
            a * B + b * D,
            c * A + d * C,
            c * B + d * D,
            e * A + f * C + E,
            e * B + f * D + F,
          ];
        }
        placed.push({ x: ctm[4], y: ctm[5], width: ctm[0], height: ctm[3] });
      }
    }
    return placed;
  }

  it("draws a picture at its own size, at 96 pixels an inch", async () => {
    const pdf = await renderMemo(withPictures(line("The printer:"), picture(solidPngDataUrl(400, 300))));

    const [drawn] = drawnImages(pdf);
    expect(drawn).toBeDefined();
    expect(drawn.width).toBeCloseTo(300, 1);
    expect(drawn.height).toBeCloseTo(225, 1);
    expect(drawn.x).toBeCloseTo(MARGIN_X, 1);
  });

  it("never draws a picture wider than the text column, and keeps its proportions", async () => {
    const pdf = await renderMemo(withPictures(picture(solidPngDataUrl(2000, 1000))));

    const [drawn] = drawnImages(pdf);
    expect(drawn.width).toBeCloseTo(TEXT_WIDTH, 1);
    expect(drawn.height).toBeCloseTo(TEXT_WIDTH / 2, 1);
  });

  it("draws a picture at the share of the column it was given", async () => {
    const pdf = await renderMemo(withPictures(picture(solidPngDataUrl(400, 400), { share: 0.5 })));

    const [drawn] = drawnImages(pdf);
    expect(drawn.width).toBeCloseTo(TEXT_WIDTH / 2, 1);
    expect(drawn.height).toBeCloseTo(TEXT_WIDTH / 2, 1);
  });

  it("keeps a picture whole, on the next page if it does not fit, and never taller than a page", async () => {
    const tall = picture(solidPngDataUrl(600, 3000));
    const pdf = await renderMemo(withPictures(line("Above."), tall, line("Below.")));
    const parsed = await PDFDocument.load(pdf);

    expect(parsed.getPageCount()).toBe(2);
    const [drawn] = drawnImages(pdf);
    // Inside the page: its bottom edge is above the bottom margin.
    expect(drawn.y).toBeGreaterThanOrEqual(MARGIN_BOTTOM - 1);
    expect(drawn.height).toBeLessThanOrEqual(PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM);
    expect(drawn.width / drawn.height).toBeCloseTo(600 / 3000, 3);
  });

  it("embeds the same picture once however many times it is drawn", async () => {
    const src = solidPngDataUrl(50, 50);
    const pdf = await renderMemo(withPictures(picture(src), line("and again"), picture(src)));

    expect(drawnImages(pdf)).toHaveLength(2);
    expect(pdf.toString("latin1").match(/\/Subtype \/Image/g)).toHaveLength(1);
  });

  it("refuses bytes that only claim to be a picture, before the decoder sees them", async () => {
    const fake = `data:image/png;base64,${Buffer.from("not a picture").toString("base64")}`;

    await expect(renderMemo(withPictures(picture(fake)))).rejects.toThrow(
      /A picture in the memo is not a PNG or a JPEG/
    );
  });
});

describe("the strip at the foot of the page", () => {
  /*
   * A signature block belongs at the bottom of the last sheet with nothing
   * under it but the margin. It used to sit under the last sentence, pushed
   * down by fifty points at most, and the rest of the page lay blank
   * beneath the signatures.
   */
  const slotsFor = async (body: MemoBody) =>
    (await renderMemoDocument(memo({ body }))).slots;

  /**
   * The lowest baseline drawn in the text area of a page: the last line of
   * the strip. The page number, on a memo of more than one page, sits in the
   * margin below and is left out.
   */
  const lowestInTextArea = (pdf: Buffer, page: number) =>
    Math.min(
      ...drawnTextOnPage(pdf, page)
        .map((line) => line.y)
        .filter((y) => y > MARGIN_BOTTOM - 4)
    );

  it("sits at the foot whatever the length of the body above it", async () => {
    const [short] = await slotsFor(paragraphs(1));
    const [longer] = await slotsFor(paragraphs(5));

    expect(short.page).toBe(1);
    expect(longer.page).toBe(1);
    expect(short.y).toBe(longer.y);
  });

  it("ends at the bottom margin, with nothing under it but the margin", async () => {
    const pdf = await renderMemo(memo({ body: paragraphs(1) }));

    // The last line's baseline sits a descender above the margin: its
    // glyphs end where the text area does.
    const lowest = lowestInTextArea(pdf, 1);
    expect(lowest).toBeGreaterThan(MARGIN_BOTTOM);
    expect(lowest).toBeLessThan(MARGIN_BOTTOM + 6);
  });

  it("turns the page when the body reaches it, and sits at the foot of that page", async () => {
    const rendered = await renderMemoDocument(memo({ body: paragraphs(30) }));
    const [slot] = rendered.slots;

    expect(rendered.pageCount).toBeGreaterThan(1);
    expect(slot.page).toBe(rendered.pageCount);
    const lowest = lowestInTextArea(rendered.bytes, rendered.pageCount);
    expect(lowest).toBeGreaterThan(MARGIN_BOTTOM);
    expect(lowest).toBeLessThan(MARGIN_BOTTOM + 6);
  });

  it("keeps the signing space clear above the rule", async () => {
    const [slot] = await slotsFor(paragraphs(1));

    expect(slot.height).toBe(SIGNING_SPACE);
    // Above the rule, not below it: the slot ends where the line is.
    expect(slot.y + slot.height).toBeLessThan(PAGE_HEIGHT - MARGIN_BOTTOM);
  });
});

describe("the face and the size the memo is set in", () => {
  const set = (attrs: MemoBody["attrs"], body: MemoBody = paragraphs(3)): RenderMemoInput =>
    memo({ body: { ...body, attrs } });

  /**
   * The font dictionaries sit inside pdf-lib's object streams, compressed,
   * so the face a memo is set in is read from the inflated streams and not
   * from the raw bytes.
   */
  const facesIn = (pdf: Buffer): string => contentStreams(pdf).join("\n");

  it("draws Plus Jakarta Sans unless told otherwise", async () => {
    const faces = facesIn(await renderMemo(memo()));

    expect(faces).toMatch(/PlusJakartaSans/);
    expect(faces).not.toMatch(/Liberation/);
  });

  it("sets the whole memo in the serif face when asked, and in the sans face", async () => {
    const serif = facesIn(await renderMemo(set({ font: "serif" })));
    expect(serif).toMatch(/LiberationSerif/);
    expect(serif).not.toMatch(/PlusJakartaSans/);

    const sans = facesIn(await renderMemo(set({ font: "sans" })));
    expect(sans).toMatch(/LiberationSans/);
  });

  it("needs more pages at twelve points than at nine, for the same words", async () => {
    const body = paragraphs(12);
    const small = (await renderMemoDocument(set({ size: 9 }, body))).pageCount;
    const large = (await renderMemoDocument(set({ size: 12 }, body))).pageCount;

    expect(large).toBeGreaterThan(small);
  });

  it("checks the characters against the face the memo is set in", () => {
    const urdu: MemoBody = {
      type: "doc",
      attrs: { font: "serif" },
      content: [{ type: "paragraph", content: [{ type: "text", text: "السلام" }] }],
    };

    expect(findUndrawableCharacters(memo({ body: urdu }))).not.toHaveLength(0);
  });
});
