/**
 * Tables: bordered cells, a shaded header row, and that header row drawn
 * again at the top of every page the table runs onto.
 *
 * The repeat is the point. The sample memo's Employee Details table is eight
 * columns of figures; split across a page without its header the second half
 * is a grid of numbers nobody can read, on a document someone is being asked
 * to approve.
 */
import {
  type Fonts,
  type WrappedLine,
  wrapRuns,
  runsFromNodes,
  measure,
} from "./richText";
import {
  INK,
  Sheet,
  TABLE_HEADER_FILL,
} from "./sheet";
import type { MemoTableCellNode, MemoTableNode, MemoTableRowNode } from "./types";
import type { Typography } from "./sheet";
import { fontKey } from "./assets";

const CELL_PAD_X = 4;
const CELL_PAD_Y = 4;
const BORDER = 0.75;
const MIN_COLUMN = 26;

/**
 * The tallest a row may be *asked* to be.
 *
 * A row told to be taller than the page has room for could never be drawn
 * whole, however many pages were started for it, so the request is clamped
 * rather than honoured off the bottom edge. Content that genuinely needs
 * more is a different matter and still gets it.
 */
function maxRowHeight(sheet: Sheet): number {
  return sheet.geometry.textHeight;
}

// The table's text size and leading are the sheet's (`sheet.type.table`,
// `sheet.type.tableLeading`): 85% of the body, whatever the body is set at.

function cellIsHeader(cell: MemoTableCellNode): boolean {
  return cell.type === "tableHeader";
}

/** How many columns a cell covers. */
function spanOf(cell: MemoTableCellNode): number {
  return Math.max(1, Math.floor(cell.attrs?.colspan ?? 1));
}

/** How many columns a row covers, which is not how many cells it holds. */
function rowSpan(row: MemoTableRowNode): number {
  return row.content.reduce((total, cell) => total + spanOf(cell), 0);
}

function cellRuns(cell: MemoTableCellNode) {
  // A cell holds paragraphs; joined with a space because a cell that wraps
  // reads as one value, not as separate blocks.
  return (cell.content ?? []).flatMap((paragraph, index) => {
    const runs = runsFromNodes(paragraph.content, {
      weight: cellIsHeader(cell) ? "bold" : "regular",
    });
    return index === 0
      ? runs
      : [{ text: " ", key: fontKey("regular", "upright"), underline: false }, ...runs];
  });
}

/**
 * The widest thing in a cell that cannot be broken: its longest word.
 *
 * A column narrower than this does not wrap, it *splits a word* - and on the
 * sample memo that meant the employee id `1644` was printed as "16" above
 * "44". A broken number on an HR memo is not a cosmetic problem; it is the
 * wrong value on a document somebody signs.
 */
function widestToken(cell: MemoTableCellNode, fonts: Fonts, size: number): number {
  let widest = 0;

  for (const run of cellRuns(cell)) {
    for (const word of run.text.split(/\s+/)) {
      if (!word) continue;
      widest = Math.max(widest, measure(fonts, { text: word, key: run.key }, size));
    }
  }

  return widest;
}

/**
 * Column widths from the content.
 *
 * Two numbers per column: what it would like (its longest line) and what it
 * cannot go below (its longest single word). When the table is wider than the
 * page - which an eight-column table always is - the difference between those
 * is the only part that may be taken away.
 *
 * Scaling every column by the same factor instead, which is the obvious
 * approach and was the first one here, takes 29% from "AX ID" as readily as
 * from "Security & Loss Prevention". The wide column has room to give; the
 * narrow one does not, and starts splitting words.
 */
function autoWidths(
  table: MemoTableNode,
  fonts: Fonts,
  count: number,
  textWidth: number,
  size: number
): number[] {
  const natural = new Array<number>(count).fill(MIN_COLUMN);
  const floors = new Array<number>(count).fill(MIN_COLUMN);

  for (const row of table.content) {
    let column = 0;

    for (const cell of row.content) {
      const span = Math.min(spanOf(cell), count - column);
      if (span <= 0) break;

      const line =
        cellRuns(cell).reduce((sum, run) => sum + measure(fonts, run, size), 0) +
        CELL_PAD_X * 2;

      /*
       * A cell covering several columns says nothing about any one of them,
       * so what it asks for is shared out across the columns it covers.
       * Charging the whole demand to the first would make that column as
       * wide as a heading written across the entire table.
       */
      const share = line / span;
      const floor = (widestToken(cell, fonts, size) + CELL_PAD_X * 2) / span;

      for (let at = column; at < column + span; at += 1) {
        natural[at] = Math.max(natural[at], share);
        floors[at] = Math.max(floors[at], floor);
      }

      column += span;
    }
  }

  const wanted = natural.reduce((sum, width) => sum + width, 0);

  // Comfortably inside the page: give every column its full width and share
  // what is left over, so the table still spans the text column.
  if (wanted <= textWidth) {
    const spare = (textWidth - wanted) / count;
    return natural.map((width) => width + spare);
  }

  const slack = natural.map((width, index) =>
    Math.max(0, width - floors[index])
  );
  const totalSlack = slack.reduce((sum, value) => sum + value, 0);
  const deficit = wanted - textWidth;

  // Not even the floors fit - more columns than the page can carry. Nothing
  // can save this one, so shrink everything evenly and let it wrap hard,
  // rather than silently running off the page edge.
  if (totalSlack < deficit) {
    const floorTotal = floors.reduce((sum, width) => sum + width, 0);
    const scale = textWidth / floorTotal;
    return floors.map((width) => width * scale);
  }

  return natural.map(
    (width, index) => width - (deficit * slack[index]) / totalSlack
  );
}

/**
 * The widths somebody set, in points across the text column.
 *
 * A stale array is ignored rather than stretched to fit: a length that no
 * longer matches the table means a column was added or taken away since the
 * widths were set, and guessing which one would put the figures under the
 * wrong headings. The submission schema refuses that case outright, so this
 * is the belt to its braces.
 */
function setWidths(
  table: MemoTableNode,
  count: number,
  textWidth: number
): number[] | null {
  const fractions = table.attrs?.widths;
  if (!fractions || fractions.length !== count) return null;

  const total = fractions.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return null;

  const widths = fractions.map((value) => (value / total) * textWidth);
  const owed = widths.reduce(
    (sum, width) => sum + Math.max(0, MIN_COLUMN - width),
    0
  );

  if (owed === 0) return widths;

  /*
   * A column too narrow to hold a character is widened at the expense of
   * the ones with room to give. The editor stops a drag well short of this;
   * a hand-written request does not, and a zero-width column would print as
   * a vertical line with figures stacked one letter per row beside it.
   */
  const spare = widths.reduce(
    (sum, width) => sum + Math.max(0, width - MIN_COLUMN),
    0
  );

  // More columns than the page can carry even at their narrowest. Nothing
  // can save this one, so share the page out evenly rather than pretending.
  if (spare < owed) return new Array<number>(count).fill(textWidth / count);

  const take = owed / spare;
  return widths.map((width) =>
    width < MIN_COLUMN ? MIN_COLUMN : width - (width - MIN_COLUMN) * take
  );
}

function columnWidths(
  table: MemoTableNode,
  fonts: Fonts,
  textWidth: number,
  size: number
): number[] {
  const count = Math.max(1, ...table.content.map(rowSpan));
  return (
    setWidths(table, count, textWidth) ??
    autoWidths(table, fonts, count, textWidth, size)
  );
}

/** One cell, with the box it was given rather than the column it started in. */
type PreparedCell = {
  lines: WrappedLine[];
  /** Offset from the left of the text column. */
  x: number;
  width: number;
};

type PreparedRow = {
  row: MemoTableRowNode;
  cells: PreparedCell[];
  height: number;
};

function prepareRow(
  row: MemoTableRowNode,
  widths: number[],
  fonts: Fonts,
  maxRowHeight: number,
  type: Typography
): PreparedRow {
  const cells: PreparedCell[] = [];

  let column = 0;
  let x = 0;

  for (const cell of row.content) {
    const span = Math.max(1, Math.min(spanOf(cell), widths.length - column));

    let width = 0;
    for (let at = column; at < column + span && at < widths.length; at += 1) {
      width += widths[at];
    }
    if (width <= 0) width = MIN_COLUMN;

    cells.push({
      x,
      width,
      lines: wrapRuns(cellRuns(cell), type.table, width - CELL_PAD_X * 2, fonts),
    });

    column += span;
    x += width;
  }

  const tallest = Math.max(1, ...cells.map((cell) => cell.lines.length));
  const fromContent = tallest * type.tableLeading + CELL_PAD_Y * 2;

  // An asked-for height is a floor, so a row made roomier stays roomy and a
  // row whose content outgrows it still grows instead of clipping a figure.
  const asked = Math.min(row.attrs?.height ?? 0, maxRowHeight);

  return { row, cells, height: Math.max(fromContent, asked) };
}

function drawRow(sheet: Sheet, prepared: PreparedRow): void {
  const top = sheet.y;
  const isHeader = prepared.row.content.some(cellIsHeader);

  for (const { x, width, lines } of prepared.cells) {
    const left = sheet.geometry.marginLeft + x;

    if (isHeader) {
      sheet.page.drawRectangle({
        x: left,
        y: sheet.toPdfY(top + prepared.height),
        width,
        height: prepared.height,
        color: TABLE_HEADER_FILL,
      });
    }

    sheet.page.drawRectangle({
      x: left,
      y: sheet.toPdfY(top + prepared.height),
      width,
      height: prepared.height,
      borderWidth: BORDER,
      borderColor: INK,
    });

    // Centred, as the sample's table is - the figures read as a grid rather
    // than as ragged prose.
    const block = lines.length * sheet.type.tableLeading;
    let cursor = top + (prepared.height - block) / 2;

    for (const line of lines) {
      const saved = sheet.y;
      sheet.y = cursor;
      sheet.drawLineOfText(line, {
        x: left + (width - line.width) / 2,
        size: sheet.type.table,
      });
      sheet.y = saved;
      cursor += sheet.type.tableLeading;
    }
  }

  sheet.advance(prepared.height);
}

export function drawTable(sheet: Sheet, table: MemoTableNode): void {
  if (table.content.length === 0) return;

  const widths = columnWidths(table, sheet.fonts, sheet.geometry.textWidth, sheet.type.table);
  const tallest = maxRowHeight(sheet);
  const rows = table.content.map((row) =>
    prepareRow(row, widths, sheet.fonts, tallest, sheet.type)
  );

  const header = rows[0].row.content.some(cellIsHeader) ? rows[0] : null;

  for (const [index, prepared] of rows.entries()) {
    // Keep a header row with at least one body row: a header stranded alone
    // at the foot of a page is a page break in the worst possible place.
    const needed =
      header && index === 0
        ? prepared.height + (rows[1]?.height ?? 0)
        : prepared.height;

    if (sheet.ensure(needed) && header && index > 0) {
      drawRow(sheet, header);
    }

    drawRow(sheet, prepared);
  }
}
