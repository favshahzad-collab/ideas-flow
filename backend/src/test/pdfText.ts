import zlib from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { expect } from "vitest";

/**
 * Reading a signed PDF back out, rather than trusting what was asked for.
 *
 * Where a signature lands is the whole job, and nobody notices a misplaced
 * one until it is on a document somebody has already approved. These live
 * here rather than beside one suite because two now need them: the unit
 * tests over the renderer, and the integration test that submits a real memo
 * and checks the preparer's own name is on the page.
 */

/**
 * pdf-lib flate-compresses the content streams it writes, so getting at the
 * drawing operators means inflating every stream in the file and keeping the
 * ones that parse.
 */
export function contentStreams(pdf: Buffer): string[] {
  const START = Buffer.from("stream");
  const END = Buffer.from("endstream");
  const out: string[] = [];

  let from = 0;
  for (;;) {
    const open = pdf.indexOf(START, from);
    if (open === -1) break;
    const close = pdf.indexOf(END, open);
    if (close === -1) break;

    let body = open + START.length;
    while (pdf[body] === 0x0d || pdf[body] === 0x0a) body += 1;

    try {
      out.push(zlib.inflateSync(pdf.subarray(body, close)).toString("latin1"));
    } catch {
      // Not a flate stream - an embedded image, or the xref. Not our business.
    }
    from = close + END.length;
  }
  return out;
}

/**
 * The placement pdf-lib actually wrote: a translate matrix that moves the
 * origin, then a scale matrix carrying the drawn size.
 *
 *   q  1 0 0 1 <x> <y> cm  ...  <w> 0 0 <h> 0 0 cm  ...  /Image Do  Q
 */
export function drawnImage(pdf: Buffer) {
  const drawing = contentStreams(pdf).find((stream) => stream.includes(" Do"));
  expect(drawing, "no image was drawn into the pdf").toBeDefined();

  const draw = drawing!.indexOf(" Do");
  const block = drawing!.slice(drawing!.lastIndexOf("q", draw), draw);

  const N = "(-?\\d+(?:\\.\\d+)?)";
  const matrix = new RegExp([N, N, N, N, N, N, "cm"].join("\\s+"), "g");

  // Each `cm` concatenates onto the current transform: CTM' = M x CTM. Doing
  // the multiplication is the difference between reading the placement and
  // guessing which of four matrices carries it.
  let ctm = [1, 0, 0, 1, 0, 0];
  for (const found of block.matchAll(matrix)) {
    const [a, b, c, d, e, f] = found.slice(1).map(Number);
    const [A, B, C, D, E, F] = ctm;
    ctm = [
      a * A + b * C,
      a * B + b * D,
      c * A + d * C,
      c * B + d * D,
      e * A + f * C + E,
      e * B + f * D + F,
    ];
  }

  return { x: ctm[4], y: ctm[5], width: ctm[0], height: ctm[3] };
}

/**
 * Every line of text in the file, in the order it was drawn, with the baseline
 * it was drawn on.
 *
 * pdf-lib's standard fonts encode to WinAnsi - one byte a character, written
 * as a hex string - and set the position with a text matrix of its own per
 * line:
 *
 *   BT  ...  1 0 0 1 <x> <y> Tm  <417965736861> Tj  ...  ET
 */
export function drawnText(pdf: Buffer): { x: number; y: number; text: string }[] {
  const N = "(-?\\d+(?:\\.\\d+)?)";
  const line = new RegExp(
    `1 0 0 1 ${N} ${N} Tm\\s+<([0-9A-Fa-f]*)> Tj`,
    "g"
  );

  return contentStreams(pdf)
    .filter((stream) => stream.includes(" Tj"))
    .flatMap((stream) =>
      [...stream.matchAll(line)].map((found) => ({
        x: Number(found[1]),
        y: Number(found[2]),
        text: Buffer.from(found[3], "hex").toString("latin1"),
      }))
    );
}

/** Just the words, which is what most of these tests are about. */
export const linesOf = (pdf: Buffer) => drawnText(pdf).map((line) => line.text);

/**
 * The far end of the stroked segment `drawLine` writes - `<x> <y> l` followed
 * by the stroke - which is the rule closing the signature off.
 */
export function ruledLine(pdf: Buffer): { x: number; y: number } | undefined {
  const N = "(-?\\d+(?:\\.\\d+)?)";
  const stroke = new RegExp(`${N} ${N} l\\s+S`);

  const found = contentStreams(pdf)
    .map((stream) => stream.match(stroke))
    .find(Boolean);

  return found ? { x: Number(found[1]), y: Number(found[2]) } : undefined;
}

/**
 * Every text run drawn on one page, 1-based, with where it was drawn.
 *
 * pdf-lib writes one content stream per page, in page order, so the nth
 * stream carrying a text-showing operator is the nth page's. That is an
 * assumption about the writer rather than a guarantee of the format - it is
 * made here, once, so a test that cares which page something landed on says
 * so plainly instead of matching on coordinates that are identical from one
 * page to the next.
 *
 * The `text` is only readable for a standard font. The memo template embeds
 * its faces as subsets through fontkit, and a subset is addressed by glyph
 * index, so what comes back for a drawn memo is glyph ids rather than words.
 * That is why the tests over the template assert on *where* runs were drawn
 * and how many there are, and never on their spelling.
 */
export function drawnTextOnPage(
  pdf: Buffer,
  page: number
): { x: number; y: number; text: string }[] {
  const withText = contentStreams(pdf).filter((stream) =>
    stream.includes(" Tj")
  );
  const stream = withText[page - 1];

  if (stream === undefined) return [];

  const N = "(-?\\d+(?:\\.\\d+)?)";
  const line = new RegExp(`1 0 0 1 ${N} ${N} Tm\\s+<([0-9A-Fa-f]*)> Tj`, "g");

  return [...stream.matchAll(line)].map((found) => ({
    x: Number(found[1]),
    y: Number(found[2]),
    text: Buffer.from(found[3], "hex").toString("latin1"),
  }));
}

/**
 * The memo's own pages, without the signature certificate an approved file
 * ends with.
 *
 * Copied into a new document rather than removed in place: pdf-lib keeps an
 * orphaned page's content stream in the file it saves, and the text readers
 * above scan every stream, so a removed page would still be read.
 */
export async function memoPagesOnly(pdf: Buffer): Promise<Buffer> {
  const source = await PDFDocument.load(pdf);

  // Every certificate page opens with the title, continuation pages included.
  const title = Buffer.from("Signature certificate", "latin1").toString("hex").toUpperCase();
  const certificatePages = contentStreams(pdf).filter((stream) =>
    stream.toUpperCase().includes(`<${title}`)
  ).length;

  const keep = source.getPageCount() - certificatePages;
  const copy = await PDFDocument.create();
  const pages = await copy.copyPages(source, Array.from({ length: keep }, (_, i) => i));
  pages.forEach((page) => copy.addPage(page));
  return Buffer.from(await copy.save());
}
