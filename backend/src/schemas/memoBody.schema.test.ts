import { randomBytes } from "node:crypto";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";

import { FUEL_REQUEST_BODY } from "../lib/memoTemplate/fuelRequest.fixture";
import { solidPngDataUrl } from "../test/png";
import {
  MEMO_BODY_LIMITS,
  memoBodyIsEmpty,
  memoBodySchema,
} from "./memoBody.schema";

const paragraph = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const doc = (...content: unknown[]) => ({ type: "doc", content });

describe("the body a memo is allowed to have", () => {
  it("accepts the reference memo", () => {
    expect(memoBodySchema.safeParse(FUEL_REQUEST_BODY).success).toBe(true);
  });

  it("accepts every node the template can draw", () => {
    const result = memoBodySchema.safeParse(
      doc(
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "One" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Two" }] },
        paragraph("prose"),
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [paragraph("a")] }],
        },
        {
          type: "orderedList",
          content: [{ type: "listItem", content: [paragraph("b")] }],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [{ type: "tableHeader", content: [paragraph("H")] }],
            },
            {
              type: "tableRow",
              content: [{ type: "tableCell", content: [paragraph("c")] }],
            },
          ],
        },
        { type: "pageBreak" }
      )
    );

    expect(result.success).toBe(true);
  });

  it("accepts an empty document", () => {
    expect(memoBodySchema.safeParse(doc()).success).toBe(true);
  });
});

/**
 * The rule the brief is explicit about: an unknown node is refused, not
 * quietly dropped. A body that saves cleanly and renders without the section
 * somebody typed is the worse outcome.
 */
describe("refusing what the template cannot draw", () => {
  it.each([
    ["image", { type: "image", attrs: { src: "data:image/png;base64,AAA" } }],
    ["codeBlock", { type: "codeBlock", content: [{ type: "text", text: "x" }] }],
    ["blockquote", { type: "blockquote", content: [paragraph("quoted")] }],
    ["horizontalRule", { type: "horizontalRule" }],
    ["iframe", { type: "iframe", attrs: { src: "https://example.com" } }],
  ])("rejects a %s node", (_label, node) => {
    expect(memoBodySchema.safeParse(doc(node)).success).toBe(false);
  });

  it("rejects a node carrying keys it should not have", () => {
    // A paragraph with an `attrs` is a paragraph from a different editor
    // build. Accepting the parts we recognise is how a document ends up
    // meaning something other than what was written.
    expect(
      memoBodySchema.safeParse(
        doc({ ...paragraph("text"), attrs: { style: "color:red" } })
      ).success
    ).toBe(false);
  });

  it("rejects a mark the template has no font for", () => {
    expect(
      memoBodySchema.safeParse(
        doc({
          type: "paragraph",
          content: [
            { type: "text", text: "x", marks: [{ type: "strike" }] },
          ],
        })
      ).success
    ).toBe(false);
  });

  it("rejects a heading level the template does not draw", () => {
    expect(
      memoBodySchema.safeParse(
        doc({
          type: "heading",
          attrs: { level: 4 },
          content: [{ type: "text", text: "deep" }],
        })
      ).success
    ).toBe(false);
  });

  it("rejects a document that is not a document", () => {
    expect(memoBodySchema.safeParse({ type: "paragraph" }).success).toBe(false);
    expect(memoBodySchema.safeParse(null).success).toBe(false);
    expect(memoBodySchema.safeParse("<p>hello</p>").success).toBe(false);
  });

  it("says what is allowed when it refuses", () => {
    const result = memoBodySchema.safeParse(doc({ type: "video" }));

    expect(result.success).toBe(false);
    if (!result.success) {
      const message = JSON.stringify(result.error.issues);
      expect(message).toMatch(/paragraph|heading|table/i);
    }
  });
});

describe("a table has to line up with its own headers", () => {
  it("rejects rows of different widths", () => {
    const result = memoBodySchema.safeParse(
      doc({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [paragraph("A")] },
              { type: "tableHeader", content: [paragraph("B")] },
            ],
          },
          {
            type: "tableRow",
            content: [{ type: "tableCell", content: [paragraph("only one")] }],
          },
        ],
      })
    );

    expect(result.success).toBe(false);
  });

  it("accepts a table whose rows match", () => {
    const row = (kind: "tableHeader" | "tableCell") => ({
      type: "tableRow",
      content: [
        { type: kind, content: [paragraph("A")] },
        { type: kind, content: [paragraph("B")] },
      ],
    });

    expect(
      memoBodySchema.safeParse(
        doc({ type: "table", content: [row("tableHeader"), row("tableCell")] })
      ).success
    ).toBe(true);
  });
});

describe("a table somebody has sized and merged", () => {
  const cell = (text: string, attrs?: { colspan: number }) => ({
    type: "tableCell",
    ...(attrs ? { attrs } : {}),
    content: [paragraph(text)],
  });

  const rows = (...content: unknown[][]) =>
    content.map((cells) => ({ type: "tableRow", content: cells }));

  const table = (over: Record<string, unknown> = {}) => ({
    type: "table",
    content: rows([cell("A"), cell("B"), cell("C")]),
    ...over,
  });

  it("accepts column widths for every column", () => {
    expect(
      memoBodySchema.safeParse(
        doc(table({ attrs: { widths: [0.5, 0.25, 0.25] } }))
      ).success
    ).toBe(true);
  });

  it("refuses widths that no longer describe the table", () => {
    /*
     * Two widths for three columns means a column was added after the widths
     * were set. There is no way to know which column the missing width
     * belonged to, and a guess puts figures under the wrong heading on a
     * document somebody signs - so the submission is refused while it can
     * still be corrected, rather than drawn on a guess.
     */
    const result = memoBodySchema.safeParse(
      doc(table({ attrs: { widths: [0.5, 0.5] } }))
    );

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/3 columns/);
  });

  it("refuses a column with no width at all", () => {
    expect(
      memoBodySchema.safeParse(doc(table({ attrs: { widths: [0.5, 0.5, 0] } })))
        .success
    ).toBe(false);
  });

  it("counts a merged cell as the columns it covers", () => {
    // Three headings over one cell spanning three is not a ragged table; it
    // is the commonest shape a details table has.
    expect(
      memoBodySchema.safeParse(
        doc({
          type: "table",
          content: rows(
            [cell("A"), cell("B"), cell("C")],
            [cell("Total", { colspan: 3 })]
          ),
        })
      ).success
    ).toBe(true);
  });

  it("still refuses a row that covers fewer columns than the rest", () => {
    const result = memoBodySchema.safeParse(
      doc({
        type: "table",
        content: rows(
          [cell("A"), cell("B"), cell("C")],
          [cell("Total", { colspan: 2 })]
        ),
      })
    );

    expect(result.success).toBe(false);
  });

  it("refuses a cell that covers less than one column", () => {
    expect(
      memoBodySchema.safeParse(
        doc({ type: "table", content: rows([cell("A", { colspan: 0 })]) })
      ).success
    ).toBe(false);
  });

  it("accepts a row height and refuses one taller than a page", () => {
    const withHeight = (height: number) =>
      doc({
        type: "table",
        content: [
          { type: "tableRow", attrs: { height }, content: [cell("A")] },
        ],
      });

    expect(memoBodySchema.safeParse(withHeight(48)).success).toBe(true);
    expect(
      memoBodySchema.safeParse(withHeight(MEMO_BODY_LIMITS.rowHeight + 1))
        .success
    ).toBe(false);
  });

  it("refuses anything else hidden in a table's attributes", () => {
    // `.strict()` throughout, for the reason the file opens with: a node
    // carrying keys we do not recognise came from somewhere else, and taking
    // the parts we understand is how a document ends up meaning something
    // other than what was written.
    expect(
      memoBodySchema.safeParse(
        doc(table({ attrs: { widths: [0.4, 0.3, 0.3], rowspan: 2 } }))
      ).success
    ).toBe(false);
  });
});

describe("bounds", () => {
  it("refuses a body past the character limit", () => {
    const huge = "x".repeat(MEMO_BODY_LIMITS.textNodeChars);
    const blocks = Array.from(
      { length: Math.ceil(MEMO_BODY_LIMITS.totalChars / huge.length) + 2 },
      () => paragraph(huge)
    );

    const result = memoBodySchema.safeParse(doc(...blocks));
    expect(result.success).toBe(false);
  });

  it("refuses a single run longer than the limit", () => {
    expect(
      memoBodySchema.safeParse(
        doc(paragraph("x".repeat(MEMO_BODY_LIMITS.textNodeChars + 1)))
      ).success
    ).toBe(false);
  });

  it("refuses more blocks than the limit", () => {
    const blocks = Array.from({ length: MEMO_BODY_LIMITS.blocks + 1 }, () =>
      paragraph("x")
    );
    expect(memoBodySchema.safeParse(doc(...blocks)).success).toBe(false);
  });

  it("refuses a table wider than the limit", () => {
    expect(
      memoBodySchema.safeParse(
        doc({
          type: "table",
          content: [
            {
              type: "tableRow",
              content: Array.from(
                { length: MEMO_BODY_LIMITS.tableColumns + 1 },
                () => ({ type: "tableCell", content: [paragraph("x")] })
              ),
            },
          ],
        })
      ).success
    ).toBe(false);
  });
});

describe("knowing an empty memo when it sees one", () => {
  it("counts a document with no blocks as empty", () => {
    expect(memoBodyIsEmpty({ type: "doc", content: [] })).toBe(true);
  });

  it("counts blank paragraphs as empty", () => {
    const parsed = memoBodySchema.parse(doc(paragraph(""), paragraph("")));
    expect(memoBodyIsEmpty(parsed)).toBe(true);
  });

  it("counts text inside a table as not empty", () => {
    const parsed = memoBodySchema.parse(
      doc({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [{ type: "tableCell", content: [paragraph("1644")] }],
          },
        ],
      })
    );

    expect(memoBodyIsEmpty(parsed)).toBe(false);
  });

  it("counts the reference memo as not empty", () => {
    expect(memoBodyIsEmpty(memoBodySchema.parse(FUEL_REQUEST_BODY))).toBe(false);
  });
});

describe("pictures", () => {
  const picture = (src: string, attrs: Record<string, unknown> = {}) => ({
    type: "image",
    attrs: { src, ...attrs },
  });

  /** A PNG whose pixels do not compress, so it weighs what it is asked to. */
  const noisyPngDataUrl = (pixelBytes: number): string => {
    const width = 200;
    const rows = Math.ceil(pixelBytes / (1 + width * 3));
    const chunk = (type: string, body: Buffer) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(body.length);
      const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(zlib.crc32(typed));
      return Buffer.concat([length, typed, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(rows, 4);
    header[8] = 8;
    header[9] = 2;
    const pixels = Buffer.concat(
      Array.from({ length: rows }, () => Buffer.concat([Buffer.alloc(1), randomBytes(width * 3)]))
    );
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", zlib.deflateSync(pixels)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    return `data:image/png;base64,${bytes.toString("base64")}`;
  };

  const firstMessage = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
    result.error?.issues[0]?.message ?? "";

  it("accepts a picture carried in the body, with a description and a size", () => {
    const result = memoBodySchema.safeParse(
      doc(
        paragraph("The damaged printer:"),
        picture(solidPngDataUrl(800, 600), { alt: "The printer, tray broken", share: 0.5 })
      )
    );

    expect(result.success).toBe(true);
  });

  it("refuses a picture that is not carried in the body", () => {
    const result = memoBodySchema.safeParse(doc(picture("https://example.com/printer.png")));

    expect(result.success).toBe(false);
    expect(firstMessage(result)).toContain("carried in the memo itself");
  });

  it("refuses a picture larger than the limit, saying how large it is", () => {
    const result = memoBodySchema.safeParse(
      doc(picture(noisyPngDataUrl(MEMO_BODY_LIMITS.imageBytes + 2_000)))
    );

    expect(result.success).toBe(false);
    expect(firstMessage(result)).toMatch(/is \d+ KB; a memo picture can be 391 KB/);
    expect(firstMessage(result)).toContain("Attach it as a supporting document instead.");
  });

  it("refuses bytes that only claim to be a picture, before anything decodes them", () => {
    const result = memoBodySchema.safeParse(
      doc(picture(`data:image/png;base64,${Buffer.from("not a picture at all").toString("base64")}`))
    );

    expect(result.success).toBe(false);
    expect(firstMessage(result)).toContain("A picture in the memo is not a PNG or a JPEG.");
  });

  it("refuses a picture narrower than a fifth of the column, or wider than it", () => {
    const src = solidPngDataUrl(10, 10);

    expect(memoBodySchema.safeParse(doc(picture(src, { share: 0.1 }))).success).toBe(false);
    expect(memoBodySchema.safeParse(doc(picture(src, { share: 1.5 }))).success).toBe(false);
    expect(memoBodySchema.safeParse(doc(picture(src, { share: 0.2 }))).success).toBe(true);
    expect(memoBodySchema.safeParse(doc(picture(src, { share: 1 }))).success).toBe(true);
  });

  it("refuses more pictures than a memo can carry", () => {
    const src = solidPngDataUrl(10, 10);
    const result = memoBodySchema.safeParse(
      doc(...Array.from({ length: MEMO_BODY_LIMITS.images + 1 }, () => picture(src)))
    );

    expect(result.success).toBe(false);
    expect(firstMessage(result)).toContain(`This memo has ${MEMO_BODY_LIMITS.images + 1} pictures`);
  });

  it("refuses pictures that together weigh more than a memo may carry", () => {
    const each = noisyPngDataUrl(MEMO_BODY_LIMITS.imageBytes - 20_000);
    const count = Math.ceil(MEMO_BODY_LIMITS.imageTotalBytes / (MEMO_BODY_LIMITS.imageBytes - 20_000)) + 1;
    const result = memoBodySchema.safeParse(
      doc(...Array.from({ length: count }, () => picture(each)))
    );

    expect(result.success).toBe(false);
    expect(firstMessage(result)).toContain("together");
  });

  it("refuses anything else hidden in a picture's attributes", () => {
    const result = memoBodySchema.safeParse(
      doc(picture(solidPngDataUrl(10, 10), { href: "https://example.com" }))
    );

    expect(result.success).toBe(false);
  });

  it("says pictures are allowed when it refuses something else", () => {
    const result = memoBodySchema.safeParse(doc({ type: "video", attrs: {} }));

    expect(result.success).toBe(false);
    expect(firstMessage(result)).toContain("tables, pictures and page breaks");
  });

  it("counts a memo of a picture alone as empty, because a memo has to say something", () => {
    const parsed = memoBodySchema.parse(doc(picture(solidPngDataUrl(10, 10))));

    expect(memoBodyIsEmpty(parsed)).toBe(true);
  });
});

describe("how the memo is set", () => {
  const set = (attrs: unknown) => ({ type: "doc", attrs, content: [paragraph("x")] });

  it("accepts a face and a size for the whole memo, and keeps them", () => {
    const result = memoBodySchema.safeParse(set({ font: "serif", size: 12 }));

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.attrs).toEqual({ font: "serif", size: 12 });
  });

  it("accepts a memo that says nothing about it", () => {
    expect(memoBodySchema.safeParse(set({})).success).toBe(true);
    expect(memoBodySchema.safeParse(doc(paragraph("x"))).success).toBe(true);
  });

  it("refuses a face it has no fonts for, and a size off the scale", () => {
    const face = memoBodySchema.safeParse(set({ font: "comic" }));
    expect(face.success).toBe(false);
    if (!face.success) {
      expect(face.error.issues[0]?.message).toContain("Plus Jakarta Sans, Liberation Serif or Liberation Sans");
    }

    const size = memoBodySchema.safeParse(set({ size: 13 }));
    expect(size.success).toBe(false);
    if (!size.success) expect(size.error.issues[0]?.message).toContain("9, 10, 11 or 12 points");
  });

  it("refuses anything else in the setting", () => {
    expect(memoBodySchema.safeParse(set({ colour: "red" })).success).toBe(false);
  });
});
