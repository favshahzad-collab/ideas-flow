/**
 * Notes written onto the page rather than into the text.
 *
 * The body of a memo is a flowing document: paragraphs, headings, lists and
 * tables, laid out one after another and broken across pages by whatever
 * happens to fit. A note is the other kind of thing - a box somebody put in a
 * particular place, next to the paragraph it is about, the way a person
 * writing on paper would.
 *
 * So notes are not body content and are deliberately not in `MemoBody`. They
 * are drawn after the flow has been laid out, at coordinates of their own,
 * onto a page they name. Nothing about them moves when the text above them
 * grows, which is the whole point: a note placed beside the third paragraph
 * is a note about the third paragraph, and a flow that reflowed it somewhere
 * else would be silently changing what somebody wrote.
 *
 * Coordinates are in PDF points measured from the top-left of the page, the
 * same space `MemoSignatureSlot` and `SignaturePlacement` use, so the viewer
 * that places a signature box and the one that places a note agree without
 * either of them converting.
 */
import { rgb, type PDFPage } from "pdf-lib";

import { fontKey } from "./assets";
import { measure, wrapRuns, type Fonts } from "./richText";
import type { MemoNote } from "./types";

/** Body size inside a note. Smaller than the memo's prose, as a note is. */
const NOTE_SIZE = 8.5;
const LINE_HEIGHT = NOTE_SIZE * 1.3;
const PAD_X = 5;
const PAD_Y = 4;
const BORDER = 0.75;

/** The note's own ink: readable, and plainly not part of the printed prose. */
const NOTE_INK = rgb(0.13, 0.15, 0.16);
const NOTE_EDGE = rgb(0.55, 0.58, 0.6);
const NOTE_FILL = rgb(0.98, 0.97, 0.9);

/**
 * How many lines of this note's text fit in the box it was given.
 *
 * A note whose text outgrew its box is clipped rather than spilled: it was
 * placed somewhere deliberately, and text running out of the bottom of it
 * would cross whatever it was placed beside. The editor shows the same box at
 * the same size, so what is cut here is what was visibly cut there.
 */
function linesThatFit(height: number): number {
  return Math.max(0, Math.floor((height - PAD_Y * 2) / LINE_HEIGHT));
}

/**
 * Draw one note onto one page.
 *
 * Exported for the test; `drawNotes` is what the renderer calls.
 */
export function drawNote(page: PDFPage, fonts: Fonts, note: MemoNote): void {
  /*
   * The page's own size, not the default one.
   *
   * A note is placed in page coordinates, so clamping it against a constant
   * would put a note on a Letter page using A4's height - off the sheet at
   * the bottom, or clipped short of the right edge. The page in hand knows.
   */
  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();

  const width = Math.min(note.width, pageWidth - note.x);
  const height = Math.min(note.height, pageHeight - note.y);

  if (width <= PAD_X * 2 || height <= PAD_Y * 2) return;

  // pdf-lib measures from the bottom-left; the note is given from the top.
  const bottom = pageHeight - note.y - height;

  page.drawRectangle({
    x: note.x,
    y: bottom,
    width,
    height,
    color: NOTE_FILL,
    borderColor: NOTE_EDGE,
    borderWidth: BORDER,
  });

  const runs = note.text
    .split(/\r?\n/)
    .map((line) => [
      { text: line, key: fontKey("regular", "upright"), underline: false },
    ]);

  const room = linesThatFit(height);
  const lines: ReturnType<typeof wrapRuns> = [];

  for (const run of runs) {
    // An empty line in the middle of a note is a blank line somebody typed,
    // so it takes a line rather than being dropped.
    if (!run[0].text) {
      lines.push({ fragments: [], width: 0 });
      continue;
    }
    lines.push(...wrapRuns(run, NOTE_SIZE, width - PAD_X * 2, fonts));
    if (lines.length >= room) break;
  }

  const shown = lines.slice(0, room);

  shown.forEach((line, index) => {
    const baseline =
      pageHeight -
      note.y -
      PAD_Y -
      index * LINE_HEIGHT -
      NOTE_SIZE * 0.8;

    for (const fragment of line.fragments) {
      page.drawText(fragment.text, {
        x: note.x + PAD_X + fragment.x,
        y: baseline,
        size: NOTE_SIZE,
        font: fonts[fragment.key],
        color: NOTE_INK,
      });
    }
  });

  /*
   * An ellipsis where text was cut, rather than a box that simply stops.
   *
   * Somebody reading the filed memo has no way of knowing a note was longer
   * than its box; somebody who wrote it has every reason to assume all of it
   * is there. A mark is the only honest answer when the alternative is
   * silently dropping what they wrote.
   */
  if (lines.length > room && room > 0) {
    const mark = "…";
    const markWidth = measure(
      fonts,
      { text: mark, key: fontKey("regular", "upright") },
      NOTE_SIZE
    );

    page.drawText(mark, {
      x: note.x + width - PAD_X - markWidth,
      y:
        pageHeight -
        note.y -
        PAD_Y -
        (room - 1) * LINE_HEIGHT -
        NOTE_SIZE * 0.8,
      size: NOTE_SIZE,
      font: fonts[fontKey("regular", "upright")],
      color: NOTE_INK,
    });
  }
}

/**
 * Draw every note onto the page it names.
 *
 * A note naming a page the memo does not have is drawn on the last one rather
 * than dropped. Losing it would be worse: the memo is filed, immutable and
 * hashed, and nothing afterwards could tell anyone that something they typed
 * never made it onto the page.
 */
export function drawNotes(
  pages: PDFPage[],
  fonts: Fonts,
  notes: MemoNote[] | undefined
): void {
  if (!notes?.length || !pages.length) return;

  for (const note of notes) {
    const index = Math.min(Math.max(1, note.page), pages.length) - 1;
    drawNote(pages[index], fonts, note);
  }
}
