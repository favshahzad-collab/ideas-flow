import { describe, expect, it } from "vitest";

import { FUEL_REQUEST, FUEL_REQUEST_BODY } from "./fuelRequest.fixture";
import { renderMemoDocument } from "./renderMemo";
import { PAGE_HEIGHT } from "./sheet";
import { drawnTextOnPage } from "../../test/pdfText";
import type { MemoBody, MemoNote } from "./types";

/**
 * Notes drawn onto the page.
 *
 * Read back out of the PDF rather than asserted against the drawing calls,
 * because what matters is that something was put on the page somebody files -
 * not that a function was called.
 *
 * Asserted by position rather than by spelling. The template embeds its faces
 * as fontkit subsets, which are addressed by glyph index, so the bytes in the
 * content stream are glyph ids and not words. Position is the stronger claim
 * anyway: a note is defined by where it sits.
 */

const note = (over: Partial<MemoNote> = {}): MemoNote => ({
  page: 1,
  x: 320,
  y: 300,
  width: 180,
  height: 60,
  text: "Checked against the register on 6 August.",
  ...over,
});

const draw = (notes: MemoNote[], body: MemoBody = FUEL_REQUEST_BODY) =>
  renderMemoDocument({ ...FUEL_REQUEST, body, notes });

/** The text runs that landed inside a note's box, on its page. */
function runsInside(pdf: Buffer, box: MemoNote) {
  const top = PAGE_HEIGHT - box.y;
  const bottom = PAGE_HEIGHT - box.y - box.height;

  return drawnTextOnPage(pdf, box.page).filter(
    (run) =>
      run.x >= box.x &&
      run.x <= box.x + box.width &&
      run.y <= top &&
      run.y >= bottom
  );
}

/**
 * The runs a note added, measured against the same memo without it.
 *
 * A note is placed over the prose, and the prose is still drawn underneath -
 * so counting what is inside the box counts the paragraph it was put on top
 * of as well. The difference between the two renderings is the note and
 * nothing else, because everything else on the page is laid out identically:
 * that is what "leaves the body and the strip where they were" establishes.
 */
function addedRuns(withNote: Buffer, without: Buffer, box: MemoNote) {
  const seen = new Map<string, number>();

  for (const run of runsInside(without, box)) {
    const key = `${run.x}|${run.y}|${run.text}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  return runsInside(withNote, box).filter((run) => {
    const key = `${run.x}|${run.y}|${run.text}`;
    const left = seen.get(key) ?? 0;
    if (left === 0) return true;
    seen.set(key, left - 1);
    return false;
  });
}

describe("a note on the page", () => {
  it("draws its text inside the box it was given", async () => {
    const box = note();
    const withNote = await draw([box]);
    const without = await draw([]);

    expect(addedRuns(withNote.bytes, without.bytes, box).length).toBeGreaterThan(
      0
    );
  });

  it("adds nothing there when the memo has no notes", async () => {
    // The control for every assertion here. Without it, a test counting runs
    // inside the box would be counting the memo's own prose underneath.
    const { bytes } = await draw([]);

    expect(addedRuns(bytes, bytes, note())).toEqual([]);
  });

  it("changes nothing about a memo that has none", async () => {
    // The path every memo filed before notes existed still takes, and the one
    // most memos take now. Byte-identical, which the memo's date being pinned
    // to its own day makes possible.
    const without = await draw([]);
    const undefinedNotes = await renderMemoDocument(FUEL_REQUEST);

    expect(without.bytes.equals(undefinedNotes.bytes)).toBe(true);
  });

  it("leaves the body and the strip where they were", async () => {
    // A note is drawn over the flow, not inserted into it. If it displaced
    // anything, adding one late would move the ruled lines under every
    // signature already placed against the preview.
    const withNote = await draw([note()]);
    const without = await draw([]);

    expect(withNote.slots).toEqual(without.slots);
    expect(withNote.pageCount).toBe(without.pageCount);
  });

  it("puts what was typed on the page, not a fixed box", async () => {
    // Position alone cannot tell two different notes apart. The bytes can.
    const one = await draw([note({ text: "Checked on 6 August." })]);
    const other = await draw([note({ text: "Not yet checked." })]);

    expect(one.bytes.equals(other.bytes)).toBe(false);
  });

  it("keeps a blank line somebody typed", async () => {
    const box = note({ text: "First line\n\nThird line", height: 80 });
    const withNote = await draw([box]);
    const without = await draw([]);

    const rows = addedRuns(withNote.bytes, without.bytes, box).map((run) =>
      Math.round(run.y)
    );
    const distinct = new Set(rows);

    // Two lines of text, and the gap between them is two line-heights rather
    // than one: the empty line took its turn instead of being dropped.
    expect(distinct.size).toBe(2);
    expect(Math.max(...rows) - Math.min(...rows)).toBeGreaterThan(20);
  });

  it("wraps text too wide for its box", async () => {
    const box = note({
      width: 90,
      height: 90,
      text: "A sentence considerably wider than the box it was given.",
    });
    const withNote = await draw([box]);
    const without = await draw([]);

    const rows = new Set(
      addedRuns(withNote.bytes, without.bytes, box).map((run) =>
        Math.round(run.y)
      )
    );

    expect(rows.size).toBeGreaterThan(1);
  });
});

describe("a note bigger than its box", () => {
  const overflowing = note({
    width: 120,
    height: 30,
    text: "One two three four five six seven eight nine ten eleven twelve thirteen",
  });

  it("stops at the bottom edge rather than running past it", async () => {
    const withNote = await draw([overflowing]);
    const without = await draw([]);

    // Everything the note added anywhere down that column, not only inside
    // its box - which is how running past the edge would show up.
    const column = { ...overflowing, y: 0, height: PAGE_HEIGHT };
    const added = addedRuns(withNote.bytes, without.bytes, column);
    const floor = PAGE_HEIGHT - overflowing.y - overflowing.height;

    expect(added.length).toBeGreaterThan(0);
    expect(added.filter((run) => run.y < floor)).toEqual([]);
  });

  it("marks that it was cut rather than stopping silently", async () => {
    // Somebody reading the filed memo cannot know a note was longer than its
    // box; somebody who wrote it assumes all of it is there. The mark is the
    // only honest answer when the alternative is dropping what they typed.
    const cut = await draw([overflowing]);
    const whole = await draw([note({ ...overflowing, text: "One two" })]);
    const without = await draw([]);

    const edge = (pdf: Buffer) =>
      addedRuns(pdf, without.bytes, overflowing).filter(
        (run) => run.x > overflowing.x + overflowing.width * 0.6
      );

    expect(edge(cut.bytes).length).toBeGreaterThan(edge(whole.bytes).length);
  });

  it("draws nothing at all for a box too small to hold a word", async () => {
    const box = note({ width: 8, height: 8 });
    const withNote = await draw([box]);
    const without = await draw([]);

    expect(addedRuns(withNote.bytes, without.bytes, box)).toEqual([]);
  });
});

describe("which page a note lands on", () => {
  const twoPages: MemoBody = {
    type: "doc",
    content: [
      ...FUEL_REQUEST_BODY.content,
      { type: "pageBreak" },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Continued overleaf." }],
      },
    ],
  };

  it("draws it on the page it names and not on the others", async () => {
    const box = note({ page: 2 });
    const withNote = await draw([box], twoPages);
    const without = await draw([], twoPages);

    expect(withNote.pageCount).toBeGreaterThan(1);
    expect(
      addedRuns(withNote.bytes, without.bytes, box).length
    ).toBeGreaterThan(0);
    expect(
      addedRuns(withNote.bytes, without.bytes, { ...box, page: 1 })
    ).toEqual([]);
  });

  it("draws one aimed past the end on the last page instead of losing it", async () => {
    // The memo is filed, immutable and hashed. Nothing afterwards could tell
    // anyone that something they typed never made it onto the page.
    const withNote = await draw([note({ page: 99 })], twoPages);
    const without = await draw([], twoPages);

    expect(
      addedRuns(
        withNote.bytes,
        without.bytes,
        note({ page: withNote.pageCount })
      ).length
    ).toBeGreaterThan(0);
  });
});
