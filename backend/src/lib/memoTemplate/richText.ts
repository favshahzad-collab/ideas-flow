/**
 * Turning styled text into lines that fit.
 *
 * pdf-lib draws a string at a point; it does not wrap, and it has no notion
 * of a run of bold inside a sentence. Both are needed here - the sample memo
 * bolds a name mid-paragraph and then keeps going - so the wrapping works on
 * runs rather than on a string, and a line can carry several fonts.
 */
import type { PDFFont } from "pdf-lib";

import {
  type FontKey,
  type FontStyle,
  type FontWeight,
  fontKey,
} from "./assets";
import type { MemoMark, MemoTextNode } from "./types";

export type Fonts = Record<FontKey, PDFFont>;

/** A stretch of text that shares one font and one underline state. */
export type StyledRun = {
  text: string;
  key: FontKey;
  underline: boolean;
};

/** A run placed on a line, with its offset from the line's left edge. */
export type Fragment = StyledRun & {
  x: number;
  width: number;
};

export type WrappedLine = {
  fragments: Fragment[];
  width: number;
};

/**
 * Editor marks to a font.
 *
 * Underline is not a font: the family has no underlined face, and faking one
 * by picking a different weight would silently change the emphasis. It is
 * drawn as a rule under the fragment instead, which is also what a word
 * processor does.
 */
export function runsFromNodes(
  nodes: MemoTextNode[] | undefined,
  base: { weight: FontWeight; style?: FontStyle } = { weight: "regular" }
): StyledRun[] {
  if (!nodes?.length) return [];

  return nodes
    .filter((node) => node.text.length > 0)
    .map((node) => {
      const marks = new Set<MemoMark>(
        (node.marks ?? []).map((mark) => mark.type)
      );

      // A heading is already semibold; bold inside one must not drop it back.
      const weight: FontWeight = marks.has("bold")
        ? base.weight === "regular"
          ? "bold"
          : base.weight
        : base.weight;

      const style: FontStyle = marks.has("italic")
        ? "italic"
        : (base.style ?? "upright");

      return {
        text: node.text,
        key: fontKey(weight, style),
        underline: marks.has("underline"),
      };
    });
}

export function measure(
  fonts: Fonts,
  run: Pick<StyledRun, "text" | "key">,
  size: number
): number {
  return fonts[run.key].widthOfTextAtSize(run.text, size);
}

/**
 * Split into the smallest pieces a line break may fall between: words, and
 * the whitespace separating them. Whitespace is kept as its own token so a
 * line that ends at a space does not silently lose it from the next line's
 * measurement.
 */
function tokenise(run: StyledRun): StyledRun[] {
  const pieces = run.text.split(/(\s+)/).filter((piece) => piece.length > 0);
  return pieces.map((text) => ({ ...run, text }));
}

export function wrapRuns(
  runs: StyledRun[],
  size: number,
  maxWidth: number,
  fonts: Fonts
): WrappedLine[] {
  const tokens = runs.flatMap(tokenise);
  const lines: WrappedLine[] = [];

  let fragments: Fragment[] = [];
  let x = 0;

  const flush = () => {
    // Trailing whitespace is dropped rather than drawn: it would widen the
    // line for no visible reason, which matters when a line is centred.
    while (fragments.length > 0 && /^\s+$/.test(fragments[fragments.length - 1].text)) {
      fragments.pop();
    }
    if (fragments.length > 0) {
      const last = fragments[fragments.length - 1];
      lines.push({ fragments, width: last.x + last.width });
    }
    fragments = [];
    x = 0;
  };

  for (const token of tokens) {
    const width = measure(fonts, token, size);
    const isSpace = /^\s+$/.test(token.text);

    // A space that would overflow just ends the line.
    if (isSpace && x + width > maxWidth) {
      flush();
      continue;
    }

    // Never open a line with a space.
    if (isSpace && fragments.length === 0) continue;

    if (x + width <= maxWidth || fragments.length === 0) {
      // A single token longer than the whole line - a URL, a run of digits,
      // a pasted identifier - cannot be placed by word. Break it by
      // character so it stays inside the column rather than running off the
      // page, which is what a silently overflowing cell looks like.
      if (width > maxWidth && fragments.length === 0) {
        for (const piece of breakToken(token, size, maxWidth, fonts)) {
          lines.push({
            fragments: [{ ...piece.run, x: 0, width: piece.width }],
            width: piece.width,
          });
        }
        continue;
      }

      fragments.push({ ...token, x, width });
      x += width;
      continue;
    }

    flush();
    if (!isSpace) {
      fragments.push({ ...token, x: 0, width });
      x = width;
    }
  }

  flush();
  return lines;
}

function breakToken(
  token: StyledRun,
  size: number,
  maxWidth: number,
  fonts: Fonts
): { run: StyledRun; width: number }[] {
  const out: { run: StyledRun; width: number }[] = [];
  let current = "";

  for (const char of Array.from(token.text)) {
    const next = current + char;
    if (measure(fonts, { text: next, key: token.key }, size) > maxWidth && current) {
      out.push({
        run: { ...token, text: current },
        width: measure(fonts, { text: current, key: token.key }, size),
      });
      current = char;
    } else {
      current = next;
    }
  }

  if (current) {
    out.push({
      run: { ...token, text: current },
      width: measure(fonts, { text: current, key: token.key }, size),
    });
  }

  return out;
}

/** Plain text of a set of nodes, for the coverage check and for measurement. */
export function plainText(nodes: MemoTextNode[] | undefined): string {
  return (nodes ?? []).map((node) => node.text).join("");
}

/**
 * Spread a line out to the full measure, as the sample memo is set.
 *
 * Only the spaces grow - the words keep their own widths, so nothing is
 * stretched or letter-spaced. A line with a lot of slack is left alone
 * instead: forcing four words across the measure opens rivers of white down
 * the paragraph, which reads far worse than a ragged edge.
 */
const MAX_GAP_STRETCH = 3.2;

export function justifyLine(line: WrappedLine, target: number): WrappedLine {
  const gaps = line.fragments.filter((fragment) =>
    /^\s+$/.test(fragment.text)
  ).length;

  if (gaps === 0 || line.width >= target) return line;

  const extra = (target - line.width) / gaps;
  if (extra > MAX_GAP_STRETCH) return line;

  let shift = 0;

  const fragments = line.fragments.map((fragment) => {
    const moved = { ...fragment, x: fragment.x + shift };

    if (/^\s+$/.test(fragment.text)) {
      shift += extra;
      return { ...moved, width: fragment.width + extra };
    }

    return moved;
  });

  return { fragments, width: target };
}
