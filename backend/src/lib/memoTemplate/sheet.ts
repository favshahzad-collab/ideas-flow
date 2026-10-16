/**
 * The page, the cursor, and the arithmetic for running off the bottom of one.
 *
 * pdf-lib measures from the bottom-left corner. Everything above this layer
 * thinks in "distance down from the top of the text area", which is how the
 * document reads and how a page break is reasoned about, so the conversion
 * happens here and exactly once.
 */
import { type PDFDocument, type PDFPage, rgb } from "pdf-lib";

import type { Fonts, WrappedLine } from "./richText";
import { fontKey } from "./assets";
import { DEFAULT_GEOMETRY, type PageGeometry } from "./geometry";

/*
 * The default page, by its old names.
 *
 * These were the only page this renderer could draw. They are kept because
 * they are still the truth about the DEFAULT page, and a test that wants to
 * say "43.2 from the left" should not have to resolve geometry to do it.
 *
 * Drawing code must NOT use them: it takes the page it is drawing on from
 * `sheet.geometry`, which is the one the memo was actually filed with. Using
 * these in a renderer is the bug where a memo set to Letter is drawn as if it
 * were A4 and only the second page shows it.
 */
/** A4, in points. */
export const PAGE_WIDTH = DEFAULT_GEOMETRY.width;
export const PAGE_HEIGHT = DEFAULT_GEOMETRY.height;

/** From the sample: ~0.6in left and right, ~0.8in top. */
export const MARGIN_X = DEFAULT_GEOMETRY.marginLeft;
export const MARGIN_TOP = DEFAULT_GEOMETRY.marginTop;
/** Room for the page number, plus the same breathing space as the top. */
export const MARGIN_BOTTOM = DEFAULT_GEOMETRY.marginBottom;

export const TEXT_WIDTH = DEFAULT_GEOMETRY.textWidth;

export const INK = rgb(0.08, 0.09, 0.09);
export const MUTED = rgb(0.38, 0.4, 0.4);
export const RULE = rgb(0.1, 0.1, 0.1);
export const TABLE_HEADER_FILL = rgb(0.93, 0.94, 0.93);

/**
 * Every size the body is set in, from the one the memo asks for.
 *
 * The body size is the memo's; the rest follow it in the proportions the
 * template always had - a heading a point above the body, a sub-heading half
 * a point, table text at 85% - so a memo set at twelve points is the same
 * memo, larger, and not a different design.
 */
export type Typography = {
  body: number;
  leading: number;
  heading: { 1: number; 2: number };
  table: number;
  tableLeading: number;
};

export function typographyFor(size: number = 10): Typography {
  const table = size * 0.85;
  return {
    body: size,
    leading: size * 1.42,
    heading: { 1: size + 1, 2: size + 0.5 },
    table,
    tableLeading: table * 1.25,
  };
}

/** Ten points: what every memo was set at before the size could be chosen. */
export const DEFAULT_TYPOGRAPHY: Typography = typographyFor(10);

export class Sheet {
  readonly pages: PDFPage[] = [];
  private current!: PDFPage;

  /** Distance from the top of the text area to the next thing drawn. */
  private cursor = 0;

  /**
   * Drawn at the top of every page after the first. The letterhead belongs on
   * page one only; a continuation page needs the reference, not the logo.
   */
  private continuation: ((sheet: Sheet) => void) | null = null;

  /**
   * The page this memo is drawn on.
   *
   * Passed in rather than read from a setting, so re-rendering a memo filed
   * last year uses last year's page. Defaulted so every existing caller, and
   * every test written before page setup existed, keeps the page it had.
   */
  readonly geometry: PageGeometry;

  /**
   * The sizes the memo is set at. Resolved once from the body's own setting,
   * and read off the sheet by everything that draws text, so a memo cannot
   * be measured at one size and drawn at another.
   */
  readonly type: Typography;

  constructor(
    readonly doc: PDFDocument,
    readonly fonts: Fonts,
    geometry: PageGeometry = DEFAULT_GEOMETRY,
    type: Typography = DEFAULT_TYPOGRAPHY
  ) {
    this.geometry = geometry;
    this.type = type;
    this.newPage();
  }

  get page(): PDFPage {
    return this.current;
  }

  get y(): number {
    return this.cursor;
  }

  set y(value: number) {
    this.cursor = value;
  }

  /** Vertical room left on this page. */
  get remaining(): number {
    return this.geometry.textHeight - this.cursor;
  }

  onContinuation(draw: (sheet: Sheet) => void): void {
    this.continuation = draw;
  }

  newPage(): void {
    this.current = this.doc.addPage([this.geometry.width, this.geometry.height]);
    this.pages.push(this.current);
    this.cursor = 0;

    if (this.pages.length > 1 && this.continuation) this.continuation(this);
  }

  /**
   * Make room for something `height` tall, starting a page if it will not fit.
   * Returns true when a page was started, which a table uses to know it must
   * redraw its header row.
   */
  ensure(height: number): boolean {
    if (height <= this.remaining) return false;
    this.newPage();
    return true;
  }

  advance(by: number): void {
    this.cursor += by;
  }

  /** Convert a top-down offset into pdf-lib's bottom-up coordinate. */
  toPdfY(offsetFromTop: number): number {
    return this.geometry.height - this.geometry.marginTop - offsetFromTop;
  }

  drawLineOfText(
    line: WrappedLine,
    options: { x?: number; size: number; color?: ReturnType<typeof rgb> }
  ): void {
    const left = options.x ?? this.geometry.marginLeft;
    // `cursor` addresses the top of the line; text is drawn from its
    // baseline, which sits one ascent below.
    const baseline = this.toPdfY(this.cursor + options.size * 0.8);

    for (const fragment of line.fragments) {
      const font = this.fonts[fragment.key];

      this.current.drawText(fragment.text, {
        x: left + fragment.x,
        y: baseline,
        size: options.size,
        font,
        color: options.color ?? INK,
      });

      if (fragment.underline) {
        const drop = options.size * 0.12;
        this.current.drawLine({
          start: { x: left + fragment.x, y: baseline - drop },
          end: { x: left + fragment.x + fragment.width, y: baseline - drop },
          thickness: Math.max(0.5, options.size * 0.055),
          color: options.color ?? INK,
        });
      }
    }
  }

  rule(options: {
    fromTop: number;
    x?: number;
    width?: number;
    thickness?: number;
    color?: ReturnType<typeof rgb>;
  }): void {
    const x = options.x ?? this.geometry.marginLeft;
    const y = this.toPdfY(options.fromTop);

    this.current.drawLine({
      start: { x, y },
      end: { x: x + (options.width ?? this.geometry.textWidth), y },
      thickness: options.thickness ?? 1,
      color: options.color ?? RULE,
    });
  }

  /**
   * Page numbers, written once every page exists.
   *
   * Deliberately last: "Page 2 of 5" cannot be drawn while the document is
   * still growing, and a memo that runs to five pages is exactly the one
   * where somebody needs to know a page is missing.
   */
  finish(): void {
    if (this.pages.length < 2) return;

    const font = this.fonts[fontKey("regular", "upright")];
    const size = 8;

    this.pages.forEach((page, index) => {
      const label = `Page ${index + 1} of ${this.pages.length}`;
      const width = font.widthOfTextAtSize(label, size);

      page.drawText(label, {
        x: (this.geometry.width - width) / 2,
        // Inside the bottom margin, but never off the sheet: a narrow bottom
        // margin would otherwise push the page number to a negative y, where
        // it is simply not drawn and a five-page memo loses its numbering.
        y: Math.max(12, this.geometry.marginBottom - 28),
        size,
        font,
        color: MUTED,
      });
    });
  }
}
