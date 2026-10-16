/**
 * The page itself: how big it is and how much of it the memo may write on.
 *
 * This was four constants in `sheet.ts` - A4 at 0.6in sides - and there was no
 * way to change them. An organisation whose memo standard is Letter, or whose
 * paper form leaves a wider gutter for a punch hole, could not produce its own
 * document at all.
 *
 * Two things follow from making it settable, and both are the reason this is a
 * value rather than a lookup:
 *
 *  - A memo is a write-once artefact and the audit trail cites its checksum.
 *    If the renderer read a live setting, widening the margin next year would
 *    silently re-draw every memo already signed and the reprint would no
 *    longer match the hash it is filed under. So a filed version records the
 *    geometry it was drawn with, and re-rendering an old memo passes that
 *    recorded value back in rather than asking what the setting says today.
 *  - The default is exactly what the constants were, so a deployment that
 *    never touches the setting draws byte-identical documents.
 */

/** The papers an organisation can choose between, in points. */
export const PAPER = {
  A4: { width: 595.28, height: 841.89 },
  LETTER: { width: 612, height: 792 },
} as const;

export type PaperName = keyof typeof PAPER;

export function isPaperName(value: unknown): value is PaperName {
  return typeof value === "string" && value in PAPER;
}

export const PAPER_NAMES = Object.keys(PAPER) as PaperName[];

/**
 * What an administrator chooses. Margins are in points, because that is what
 * the renderer draws in; the admin screen shows them in millimetres or inches
 * and converts, so nobody types 43.2 on purpose.
 */
export type PageSetup = {
  paper: PaperName;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
};

/**
 * Today's values, unchanged.
 *
 * A4 with ~0.6in left and right and ~0.8in top, taken from the paper form this
 * template was drawn from. Every memo filed before page setup existed was
 * drawn with these, so they are also what a version with no recorded geometry
 * is re-rendered with.
 */
export const DEFAULT_PAGE_SETUP: PageSetup = {
  paper: "A4",
  marginLeft: 43.2,
  marginRight: 43.2,
  marginTop: 57.6,
  marginBottom: 57.6,
};

/**
 * Bounds.
 *
 * A margin of zero is a document no printer can reproduce, and a margin wide
 * enough to close the text column is one the renderer cannot lay a table out
 * in. Both ends are refused by the schema with a sentence the administrator
 * can act on; these are the defensive floor, applied again at render time so
 * a value that somehow reached the database cannot crash a memo.
 */
export const MIN_MARGIN = 18; // 0.25in
export const MAX_MARGIN = 216; // 3in
export const MIN_TEXT_WIDTH = 200;
export const MIN_TEXT_HEIGHT = 200;

/** A page setup with the arithmetic already done. */
export type PageGeometry = PageSetup & {
  width: number;
  height: number;
  /** The writable column: what a table spans and a paragraph wraps inside. */
  textWidth: number;
  /** The writable column's height, which is what a page break measures. */
  textHeight: number;
};

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

/**
 * Turn a setup into geometry, surviving anything.
 *
 * Margins are clamped individually first, then together: a pair that still
 * leaves no room to write falls back to the default for that axis rather than
 * producing a column of negative width, which would draw a memo inside out.
 */
export function resolveGeometry(setup?: Partial<PageSetup> | null): PageGeometry {
  const paper = isPaperName(setup?.paper) ? setup.paper : DEFAULT_PAGE_SETUP.paper;
  const { width, height } = PAPER[paper];

  let marginLeft = clamp(setup?.marginLeft ?? DEFAULT_PAGE_SETUP.marginLeft, MIN_MARGIN, MAX_MARGIN);
  let marginRight = clamp(setup?.marginRight ?? DEFAULT_PAGE_SETUP.marginRight, MIN_MARGIN, MAX_MARGIN);
  let marginTop = clamp(setup?.marginTop ?? DEFAULT_PAGE_SETUP.marginTop, MIN_MARGIN, MAX_MARGIN);
  let marginBottom = clamp(setup?.marginBottom ?? DEFAULT_PAGE_SETUP.marginBottom, MIN_MARGIN, MAX_MARGIN);

  if (width - marginLeft - marginRight < MIN_TEXT_WIDTH) {
    marginLeft = DEFAULT_PAGE_SETUP.marginLeft;
    marginRight = DEFAULT_PAGE_SETUP.marginRight;
  }

  if (height - marginTop - marginBottom < MIN_TEXT_HEIGHT) {
    marginTop = DEFAULT_PAGE_SETUP.marginTop;
    marginBottom = DEFAULT_PAGE_SETUP.marginBottom;
  }

  return {
    paper,
    marginLeft,
    marginRight,
    marginTop,
    marginBottom,
    width,
    height,
    textWidth: width - marginLeft - marginRight,
    textHeight: height - marginTop - marginBottom,
  };
}

/** The geometry every memo filed before this existed was drawn with. */
export const DEFAULT_GEOMETRY = resolveGeometry(DEFAULT_PAGE_SETUP);

/**
 * Is this the default? Used to decide whether a filed version needs to record
 * anything at all - there is no point storing a copy of the constant on every
 * version, and a null reads unambiguously as "drawn the way it always was".
 */
export function isDefaultSetup(setup: PageSetup): boolean {
  return (
    setup.paper === DEFAULT_PAGE_SETUP.paper &&
    setup.marginLeft === DEFAULT_PAGE_SETUP.marginLeft &&
    setup.marginRight === DEFAULT_PAGE_SETUP.marginRight &&
    setup.marginTop === DEFAULT_PAGE_SETUP.marginTop &&
    setup.marginBottom === DEFAULT_PAGE_SETUP.marginBottom
  );
}

/** Points per millimetre and per inch, for the admin screen's conversions. */
export const PT_PER_MM = 72 / 25.4;
export const PT_PER_INCH = 72;
