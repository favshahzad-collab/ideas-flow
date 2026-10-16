/**
 * The fonts and the logo, read from disk once.
 *
 * From disk, never from the network. The deployment may be intranet-only with
 * no route out, and a renderer that fetches a font at render time is a memo
 * that fails to submit the day the proxy changes. The frontend pulls the same
 * family from Google Fonts because a browser can; the server cannot assume it.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * `assets/` sits beside `src/`, not inside it, so `tsc` neither compiles nor
 * copies it.
 *
 * Found by walking up from this file rather than by counting directories,
 * because the count is not the same in both layouts: this module lives at
 * `src/lib/memoTemplate` under tsx and at `dist/src/lib/memoTemplate` once
 * built, so any fixed number of `..` is right in one and wrong in the other.
 * Walking up is right in both, and in a test runner too.
 */
function findAssetDir(): string {
  let dir = __dirname;

  for (let hops = 0; hops < 8; hops++) {
    const candidate = path.join(dir, "assets");
    if (fs.existsSync(path.join(candidate, "fonts"))) return candidate;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `Could not find the memo template's assets/ directory above ${__dirname}. ` +
      `It holds the fonts and the letterhead and is part of the deployment, ` +
      `not something the build generates.`
  );
}

const ASSET_DIR = findAssetDir();

export const FONT_DIR = path.join(ASSET_DIR, "fonts");
export const BRAND_DIR = path.join(ASSET_DIR, "brand");

export type FontWeight = "regular" | "semibold" | "bold";
export type FontStyle = "upright" | "italic";
export type FontKey = `${FontWeight}:${FontStyle}`;

/**
 * The families a memo may be set in.
 *
 * Plus Jakarta Sans is the letterhead's own and the default. The two
 * Liberation families (SIL Open Font Licence, `LIBERATION-LICENSE` beside
 * them) are metrically the Times New Roman and Arial an office has always
 * typed memos in, for the memo that has to look like the paper it replaces.
 * A family is chosen for a whole memo, never a run: the template draws one
 * document, not a ransom note.
 */
export const MEMO_FONT_FAMILIES = ["jakarta", "serif", "sans"] as const;
export type MemoFontFamily = (typeof MEMO_FONT_FAMILIES)[number];
export const DEFAULT_FONT_FAMILY: MemoFontFamily = "jakarta";

const FONT_FILES: Record<MemoFontFamily, Record<FontKey, string>> = {
  jakarta: {
    "regular:upright": "PlusJakartaSans-Regular.ttf",
    "regular:italic": "PlusJakartaSans-Italic.ttf",
    "semibold:upright": "PlusJakartaSans-SemiBold.ttf",
    "semibold:italic": "PlusJakartaSans-BoldItalic.ttf",
    "bold:upright": "PlusJakartaSans-Bold.ttf",
    "bold:italic": "PlusJakartaSans-BoldItalic.ttf",
  },
  serif: {
    "regular:upright": "LiberationSerif-Regular.ttf",
    "regular:italic": "LiberationSerif-Italic.ttf",
    "semibold:upright": "LiberationSerif-Bold.ttf",
    "semibold:italic": "LiberationSerif-BoldItalic.ttf",
    "bold:upright": "LiberationSerif-Bold.ttf",
    "bold:italic": "LiberationSerif-BoldItalic.ttf",
  },
  sans: {
    "regular:upright": "LiberationSans-Regular.ttf",
    "regular:italic": "LiberationSans-Italic.ttf",
    "semibold:upright": "LiberationSans-Bold.ttf",
    "semibold:italic": "LiberationSans-BoldItalic.ttf",
    "bold:upright": "LiberationSans-Bold.ttf",
    "bold:italic": "LiberationSans-BoldItalic.ttf",
  },
};

export function fontKey(weight: FontWeight, style: FontStyle): FontKey {
  return `${weight}:${style}`;
}

const cache = new Map<string, Buffer>();

function readCached(file: string): Buffer {
  const hit = cache.get(file);
  if (hit) return hit;

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    throw new Error(
      `Memo template asset is missing: ${file}. The fonts and letterhead are ` +
        `part of the deployment, not generated - check that assets/ shipped ` +
        `alongside dist/.`
    );
  }

  cache.set(file, bytes);
  return bytes;
}

export function readFontBytes(
  key: FontKey,
  family: MemoFontFamily = DEFAULT_FONT_FAMILY
): Buffer {
  return readCached(path.join(FONT_DIR, FONT_FILES[family][key]));
}

export function allFontKeys(): FontKey[] {
  return Object.keys(FONT_FILES[DEFAULT_FONT_FAMILY]) as FontKey[];
}

/** The default letterhead. A caller may pass its own instead. */
export function readDefaultLogo(): Buffer {
  return readCached(path.join(BRAND_DIR, "ideas-logo.png"));
}

/**
 * Which code points the family can actually draw.
 *
 * This exists because measuring a string is not the same as being able to
 * render it. `widthOfTextAtSize` happily returns a number for Urdu, and the
 * page then shows a row of identical empty boxes - Plus Jakarta Sans has no
 * Arabic script. Tofu in a memo is worse than a refusal: the artefact is
 * immutable, its digest is recorded, and it goes into an approval chain
 * looking like a document rather than like a failure.
 *
 * Read straight out of the font's `cmap` table rather than trusting the
 * shaper, so the answer is about glyphs that exist.
 */
export function supportedCodePoints(
  key: FontKey,
  family: MemoFontFamily = DEFAULT_FONT_FAMILY
): Set<number> {
  const cacheKey = `${family}/${key}`;
  const cached = codePointCache.get(cacheKey);
  if (cached) return cached;

  const points = readCmap(readFontBytes(key, family));
  codePointCache.set(cacheKey, points);
  return points;
}

const codePointCache = new Map<string, Set<number>>();

/**
 * A deliberately small TrueType `cmap` reader: enough to answer "is there a
 * glyph for this code point", and nothing else.
 *
 * Formats 4 (BMP) and 12 (full range) are the two that matter; a font whose
 * Unicode subtable is neither is treated as covering nothing, which fails
 * loudly rather than passing everything.
 */
function readCmap(font: Buffer): Set<number> {
  const points = new Set<number>();
  const tableCount = font.readUInt16BE(4);

  let cmapOffset = 0;
  for (let i = 0; i < tableCount; i++) {
    const record = 12 + i * 16;
    if (font.toString("latin1", record, record + 4) === "cmap") {
      cmapOffset = font.readUInt32BE(record + 8);
      break;
    }
  }
  if (cmapOffset === 0) return points;

  // Prefer a full-repertoire subtable, then a BMP one.
  const subtableCount = font.readUInt16BE(cmapOffset + 2);
  let best = 0;
  let bestScore = -1;

  for (let i = 0; i < subtableCount; i++) {
    const record = cmapOffset + 4 + i * 8;
    const platform = font.readUInt16BE(record);
    const encoding = font.readUInt16BE(record + 2);
    const offset = cmapOffset + font.readUInt32BE(record + 4);

    // 4 = Windows UCS-4, 3 = Windows BMP, 2 = Unicode any.
    const score =
      platform === 3 && encoding === 10
        ? 4
        : platform === 3 && encoding === 1
          ? 3
          : platform === 0
            ? 2
            : 0;

    if (score > bestScore) {
      bestScore = score;
      best = offset;
    }
  }
  if (bestScore <= 0) return points;

  const format = font.readUInt16BE(best);

  if (format === 4) {
    const segCountX2 = font.readUInt16BE(best + 6);
    const segCount = segCountX2 / 2;
    const endBase = best + 14;
    const startBase = endBase + segCountX2 + 2;

    for (let s = 0; s < segCount; s++) {
      const end = font.readUInt16BE(endBase + s * 2);
      const start = font.readUInt16BE(startBase + s * 2);
      if (start === 0xffff) continue;
      // The trailing 0xFFFF segment is a terminator, not coverage.
      for (let cp = start; cp <= end && cp !== 0xffff; cp++) points.add(cp);
    }
    return points;
  }

  if (format === 12) {
    const groups = font.readUInt32BE(best + 12);
    for (let g = 0; g < groups; g++) {
      const record = best + 16 + g * 12;
      const start = font.readUInt32BE(record);
      const end = font.readUInt32BE(record + 4);
      for (let cp = start; cp <= end; cp++) points.add(cp);
    }
  }

  return points;
}
