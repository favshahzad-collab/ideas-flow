import type { MemoSignatureSlot } from "./memoTemplate";

/**
 * Where each signatory signs on a memo that was attached as a PDF.
 *
 * A memo typed in the portal draws its own signature strip, so it knows where
 * every line is. An attached PDF was written in Word, and it prints its
 * signatories' names and titles under the lines they sign on - but the
 * application could not see them, so every signer had to drag their signature
 * into place by hand, and nothing stopped one from landing on somebody else's
 * name. This reads the PDF's text, finds each signatory's printed name, and
 * returns a signing line above it: the same slots a typed memo carries, so
 * everything that already works for those - starting on your own line, the
 * "Sign here" mark, refusing a signature on someone else's line - works here.
 *
 * Deliberately cautious, because a wrong line is worse than none:
 *
 *   - a name matches only text that is exactly that name on its own - a
 *     mention inside a sentence never does;
 *   - where it is printed more than once, the last occurrence wins (last
 *     page, lowest on it): signature blocks sit at the foot, and a "From:"
 *     line at the top must not take the signature;
 *   - two signatories with the same name get no line at all;
 *   - a scanned PDF has no text to read, and gets no lines.
 *
 * Anybody without a line places their signature by hand, as before.
 */

export type Signatory = { key: string; name: string };

/** Marks a slot found in an attached PDF, as opposed to one a typed memo drew. */
export type DetectedSignatureSlot = MemoSignatureSlot & { detected: true };

type Segment = {
  page: number;
  pageWidth: number;
  pageHeight: number;
  text: string;
  x0: number;
  x1: number;
  /** Baseline, in PDF units from the bottom of the page. */
  baseline: number;
  fontSize: number;
};

const SLOT_HEIGHT = 40;
const SLOT_MIN_WIDTH = 140;
/** Air between the bottom of the signature box and the top of the name. */
const GAP_ABOVE_NAME = 3;

const normalise = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s.,;:()[\]-]+|[\s.,;:()[\]-]+$/g, "")
    .trim();

type TextItem = { str: string; transform: number[]; width: number; height: number };

/** The page's text joined into runs: same baseline, close together. */
function segmentsOf(items: TextItem[], page: number, pageWidth: number, pageHeight: number): Segment[] {
  const runs = items
    // pdfjs fills the gap between two runs on a line with a single space
    // item as wide as the gap. Taken as text, it glues neighbouring columns
    // of a signature strip into one "name"; the gaps are measured instead.
    .filter((item) => item.str.trim().length > 0)
    .map((item) => ({
      str: item.str,
      x: item.transform[4] ?? 0,
      y: item.transform[5] ?? 0,
      width: item.width,
      size: Math.max(Math.abs(item.transform[3] ?? 0), item.height, 1),
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const segments: Segment[] = [];
  for (const run of runs) {
    const last = segments.at(-1);
    const sameLine = last && Math.abs(last.baseline - run.y) <= Math.max(1.5, run.size * 0.2);
    const gap = last ? run.x - last.x1 : Infinity;
    // Words in one name sit a space apart; columns of a signature strip sit
    // far further apart than that, and must stay separate segments.
    if (last && sameLine && gap <= Math.max(last.fontSize, run.size) * 1.2 && gap > -run.size) {
      const needsSpace = gap > run.size * 0.15 && !last.text.endsWith(" ") && !run.str.startsWith(" ");
      last.text += (needsSpace ? " " : "") + run.str;
      last.x1 = Math.max(last.x1, run.x + run.width);
      last.fontSize = Math.max(last.fontSize, run.size);
      continue;
    }
    segments.push({
      page,
      pageWidth,
      pageHeight,
      text: run.str,
      x0: run.x,
      x1: run.x + run.width,
      baseline: run.y,
      fontSize: run.size,
    });
  }
  return segments;
}

/** Every text segment in the PDF, page by page. Empty for a scanned PDF. */
async function readSegments(pdf: Buffer): Promise<Segment[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(pdf),
    // Text only: no fonts loaded for drawing.
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const document = await task.promise;

  try {
    const segments: Segment[] = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const [, , width, height] = page.view;
      const content = await page.getTextContent();
      const items: TextItem[] = [];
      for (const item of content.items) {
        if ("str" in item) items.push(item);
      }
      segments.push(...segmentsOf(items, number, width ?? 595, height ?? 842));
    }
    return segments;
  } finally {
    await task.destroy();
  }
}

/** A signing box resting just above a printed name, in top-left page units. */
function slotAbove(segment: Segment, signatory: Signatory): DetectedSignatureSlot {
  const nameWidth = segment.x1 - segment.x0;
  const width = Math.min(Math.max(SLOT_MIN_WIDTH, nameWidth + 20), segment.pageWidth);
  const centre = (segment.x0 + segment.x1) / 2;
  const x = Math.min(Math.max(centre - width / 2, 0), segment.pageWidth - width);
  // The top of the name, measured from the top of the page.
  const nameTop = segment.pageHeight - (segment.baseline + segment.fontSize * 0.8);
  const y = Math.max(nameTop - GAP_ABOVE_NAME - SLOT_HEIGHT, 0);
  return {
    key: signatory.key,
    name: signatory.name,
    page: segment.page,
    x,
    y,
    width,
    height: SLOT_HEIGHT,
    detected: true,
  };
}

const overlaps = (a: MemoSignatureSlot, b: MemoSignatureSlot) =>
  a.page === b.page && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Narrower than this, a line is not somewhere a signature can go. */
const SLOT_NARROWEST = 60;
/** Clear space kept between two neighbouring lines. */
const SLOT_SPACING = 4;

/**
 * Neighbouring columns of a tight signature strip: give each the space up to
 * the midpoint between the two names, rather than lose both. Two lines that
 * still collide - stacked rows, or names nearly on top of each other - are a
 * layout this cannot read with confidence, and go back to being placed by hand.
 */
function separate(slots: DetectedSignatureSlot[]): DetectedSignatureSlot[] {
  const kept = slots.map((slot) => ({ ...slot }));
  for (let i = 0; i < kept.length; i += 1) {
    for (let j = i + 1; j < kept.length; j += 1) {
      const [a, b] = [kept[i], kept[j]].sort((left, right) => left.x - right.x);
      // Only neighbours on one row are split; stacked lines are left to clash.
      if (!overlaps(a, b) || Math.abs(a.y - b.y) > 1) continue;
      const middle = (a.x + a.width / 2 + (b.x + b.width / 2)) / 2;
      const aRight = middle - SLOT_SPACING / 2;
      const bLeft = middle + SLOT_SPACING / 2;
      a.width = Math.min(a.width, aRight - a.x);
      b.width = b.x + b.width - Math.max(b.x, bLeft);
      b.x = Math.max(b.x, bLeft);
    }
  }
  const usable = kept.filter((slot) => slot.width >= SLOT_NARROWEST);
  return usable.filter((slot) => !usable.some((other) => other !== slot && overlaps(other, slot)));
}

/**
 * The signing lines found for these signatories, or null when none was found
 * - so an attached PDF with nothing recognisable stays exactly as it was.
 * Never throws: a PDF this cannot read simply gets no lines.
 */
export async function findSignatoryLines(
  pdf: Buffer,
  signatories: Signatory[]
): Promise<DetectedSignatureSlot[] | null> {
  let segments: Segment[];
  try {
    segments = await readSegments(pdf);
  } catch {
    return null;
  }
  if (segments.length === 0) return null;

  const byName = new Map<string, Signatory[]>();
  for (const signatory of signatories) {
    const name = normalise(signatory.name);
    if (!name) continue;
    byName.set(name, [...(byName.get(name) ?? []), signatory]);
  }

  const slots: DetectedSignatureSlot[] = [];
  for (const [name, people] of byName) {
    // Two people of one name: whichever line is theirs cannot be told apart.
    if (people.length !== 1) continue;
    const matches = segments.filter((segment) => normalise(segment.text) === name);
    // Reading order is page, then top to bottom: the last is the foot of the
    // last page it appears on.
    const chosen = matches.sort((a, b) => a.page - b.page || b.baseline - a.baseline).at(-1);
    if (!chosen) continue;
    slots.push(slotAbove(chosen, people[0]));
  }

  const separated = separate(slots);
  return separated.length > 0 ? separated : null;
}
