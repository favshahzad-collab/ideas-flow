import { describe, expect, it } from "vitest";

import { FUEL_REQUEST } from "./fuelRequest.fixture";
import { renderMemoDocument } from "./renderMemo";
import { MARGIN_BOTTOM, MARGIN_TOP, PAGE_HEIGHT, TEXT_WIDTH } from "./sheet";
import { drawnTextOnPage } from "../../test/pdfText";
import type { MemoBody, MemoTableCellNode, MemoTableNode } from "./types";

/**
 * A table somebody has sized, merged and shaped.
 *
 * Asserted geometrically and by difference, for the reason the notes tests
 * give: the template embeds its faces as fontkit subsets, so the bytes in the
 * content stream are glyph ids rather than words. Position is the stronger
 * claim here anyway - a column width *is* a position, and the failure this
 * guards against is a figure printed under the wrong heading.
 *
 * Nothing here asserts that a drawing call was made. Every check reads the
 * finished PDF, because what is filed is the PDF.
 */

const cell = (text: string, colspan?: number): MemoTableCellNode => ({
  type: "tableCell",
  ...(colspan ? { attrs: { colspan } } : {}),
  ...(text ? { content: [{ type: "paragraph", content: [{ type: "text", text }] }] } : {}),
});

const head = (text: string): MemoTableCellNode => ({
  type: "tableHeader",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/** Short single words, so nothing wraps and a width change only moves text. */
function table(over: Partial<MemoTableNode> = {}): MemoTableNode {
  return {
    type: "table",
    content: [
      { type: "tableRow", content: [head("A"), head("B"), head("C")] },
      { type: "tableRow", content: [cell("D"), cell("E"), cell("F")] },
    ],
    ...over,
  };
}

const draw = (node: MemoTableNode) => {
  const body: MemoBody = { type: "doc", content: [node] };
  return renderMemoDocument({ ...FUEL_REQUEST, body });
};

/**
 * How far every run moved between two renderings, in draw order.
 *
 * The two documents differ only in the table's measurements, so everything
 * else on the page - the letterhead, the header block, the signature strip -
 * is laid out identically and reports a shift of zero. What is left is the
 * table, and the numbers are the ones the widths predict.
 */
function shifts(before: Buffer, after: Buffer, axis: "x" | "y" = "x") {
  const one = drawnTextOnPage(before, 1);
  const two = drawnTextOnPage(after, 1);

  expect(two).toHaveLength(one.length);
  return one.map((run, at) => Number((two[at][axis] - run[axis]).toFixed(2)));
}

/** The shifts that are not zero, which is the part a test is ever about. */
const moved = (values: number[]) => values.filter((value) => value !== 0);

describe("columns somebody has sized", () => {
  it("puts each column where the widths say, not where the content asks", async () => {
    const wide = await draw(table({ attrs: { widths: [0.6, 0.2, 0.2] } }));
    const narrow = await draw(table({ attrs: { widths: [0.2, 0.2, 0.6] } }));

    /*
     * Text is centred in its cell, so a cell's centre is what moves. With
     * the first column cut from 60% to 20% the three centres travel 20%,
     * 40% and 20% of the text column to the left - once for the header row
     * and again for the row under it.
     */
    const expected = [-0.2, -0.4, -0.2].map((share) =>
      Number((share * TEXT_WIDTH).toFixed(2))
    );

    expect(moved(shifts(wide.bytes, narrow.bytes))).toEqual([
      ...expected,
      ...expected,
    ]);
  });

  it("sizes a table nobody has touched from its content, as it always did", async () => {
    // The path every table filed before widths existed still takes, and the
    // one most still take. Byte-identical, not merely similar.
    const plain = await draw(table());
    const empty = await draw(table({ attrs: {} }));

    expect(plain.bytes.equals(empty.bytes)).toBe(true);
  });

  it("ignores widths that no longer describe the table", async () => {
    /*
     * Two widths for three columns means a column was added after they were
     * set. There is no way to know which column the missing width belonged
     * to, and a guess puts figures under the wrong heading - so the table is
     * sized from its content instead. The schema refuses this outright; this
     * is the renderer refusing to invent an answer if one ever reaches it.
     */
    const stale = await draw(table({ attrs: { widths: [0.5, 0.5] } }));
    const plain = await draw(table());

    expect(stale.bytes.equals(plain.bytes)).toBe(true);
  });

  it("will not squeeze a column down to nothing", async () => {
    // A hand-written request can ask for a column 0.2% of the page wide. It
    // would print as a vertical line with one letter per row beside it.
    const sliver = await draw(table({ attrs: { widths: [0.002, 0.499, 0.499] } }));
    const floored = await draw(table({ attrs: { widths: [0.4, 0.3, 0.3] } }));

    // The first column is pulled back up off zero, so its text does not sit
    // at the very left edge of the text column.
    const first = drawnTextOnPage(sliver.bytes, 1);
    const left = Math.min(...first.map((run) => run.x));

    expect(left).toBeGreaterThan(0);
    expect(sliver.bytes.equals(floored.bytes)).toBe(false);
  });
});

describe("cells merged across columns", () => {
  const spanning = table({
    content: [
      { type: "tableRow", content: [head("A"), head("B"), head("C")] },
      { type: "tableRow", content: [cell("D", 3)] },
    ],
  });

  const separate = table({
    content: [
      { type: "tableRow", content: [head("A"), head("B"), head("C")] },
      // The other two draw no text at all, so the two documents have the
      // same runs in the same order and only the merged one has moved.
      { type: "tableRow", content: [cell("D"), cell(""), cell("")] },
    ],
  });

  it("draws a merged cell across the columns it covers", async () => {
    const merged = await draw(spanning);
    const split = await draw(separate);

    // One column's centre is a sixth of the way across; three columns' is
    // halfway. The difference is a third of the text column.
    const expected = Number((TEXT_WIDTH / 3).toFixed(2));

    expect(moved(shifts(split.bytes, merged.bytes))).toEqual([expected]);
  });

  it("changes nothing for a cell that covers one column", async () => {
    // `colspan: 1` is what every cell has always meant. If it drew even a
    // point differently, every table filed before merging existed would
    // start rendering differently too.
    const explicit = table({
      content: [
        { type: "tableRow", content: [head("A"), head("B"), head("C")] },
        { type: "tableRow", content: [cell("D", 1), cell("E", 1), cell("F", 1)] },
      ],
    });

    const plain = await draw(table());
    const spelled = await draw(explicit);

    expect(plain.bytes.equals(spelled.bytes)).toBe(true);
  });

  it("does not let a merged cell dictate the width of one column", async () => {
    /*
     * A heading written across the whole table asks for a great deal of
     * width. Charging the whole of it to the first column would make that
     * column enormous and crush the two beside it, so the demand is shared
     * across the columns the cell actually covers.
     */
    const line = "A considerably longer line of text";

    const across = await draw(
      table({
        content: [
          { type: "tableRow", content: [head("A"), head("B"), head("C")] },
          { type: "tableRow", content: [cell(line, 3)] },
        ],
      })
    );

    const stacked = await draw(
      table({
        content: [
          { type: "tableRow", content: [head("A"), head("B"), head("C")] },
          { type: "tableRow", content: [cell(line), cell(""), cell("")] },
        ],
      })
    );

    /*
     * Drawn in order: the three headings, then the cell holding the line.
     * With the line in column one alone that column takes nearly two thirds
     * of the table; shared across three it leaves them even, so every
     * heading sits further left - and the cell itself, now centred across
     * the whole table rather than over column one, sits further right.
     *
     * Were the demand charged to column one either way, the two tables would
     * be identical and nothing would have moved at all.
     */
    const [first, second, third, ...rest] = moved(
      shifts(stacked.bytes, across.bytes)
    );

    expect(Math.max(first, second, third)).toBeLessThan(0);

    // Every word of the line - each drawn as its own run, with the spaces
    // between them - travels the other way.
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((shift) => shift > 0)).toBe(true);
  });
});

describe("a row somebody has made taller", () => {
  /** One line of 8.5pt text plus the cell padding, which is what a row is. */
  const NATURAL = 8.5 * 1.25 + 4 * 2;

  const withHeight = (height: number) =>
    table({
      content: [
        { type: "tableRow", content: [head("A"), head("B"), head("C")] },
        {
          type: "tableRow",
          attrs: { height },
          content: [cell("D"), cell("E"), cell("F")],
        },
      ],
    });

  it("gives it the height it asked for", async () => {
    const tall = await draw(withHeight(60));
    const plain = await draw(table());

    const extra = 60 - NATURAL;
    const down = moved(shifts(plain.bytes, tall.bytes, "y"));

    const half = Number((-extra / 2).toFixed(2));
    const whole = Number((-extra).toFixed(2));

    // The row's own text is centred in the taller box, so it drops by half
    // the height that was added. Nothing else on this memo moves: the only
    // thing below the table is the signature strip, and that is anchored to
    // the foot of the page whatever is above it. pdf-lib measures from the
    // foot of the page, so down is negative.
    expect(down).toEqual([half, half, half]);
    expect(whole).toBeLessThan(half);
  });

  it("still grows for content that needs more room", async () => {
    /*
     * The height is a floor, never a ceiling. A cell clipped to fit a height
     * somebody dragged would lose a figure off a document being signed, and
     * nothing downstream could tell anyone it had happened.
     */
    // Long enough in every column that each one wraps to two lines, so the
    // row genuinely needs more than the 20 points it is being offered.
    const long = (word: string) =>
      cell(`${word} one two three four five six seven eight nine ten`);

    const cells = [long("First"), long("Second"), long("Third")];
    const headings = { type: "tableRow" as const, content: [head("A"), head("B"), head("C")] };

    const asked = await draw(
      table({
        content: [
          headings,
          { type: "tableRow", attrs: { height: 20 }, content: cells },
        ],
      })
    );

    const free = await draw(
      table({ content: [headings, { type: "tableRow", content: cells }] })
    );

    expect(asked.bytes.equals(free.bytes)).toBe(true);
  });

  it("refuses to be taller than a page has room for", async () => {
    // A row told to be 5,000 points tall could never be drawn whole, however
    // many pages were started for it. Clamped, rather than drawn off the
    // bottom edge of one.
    const page = PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;

    const absurd = await draw(withHeight(5_000));
    const clamped = await draw(withHeight(page));

    expect(absurd.bytes.equals(clamped.bytes)).toBe(true);
  });

  it("leaves a row nobody sized alone", async () => {
    const plain = await draw(table());
    const zero = await draw(withHeight(0));

    expect(plain.bytes.equals(zero.bytes)).toBe(true);
  });
});
