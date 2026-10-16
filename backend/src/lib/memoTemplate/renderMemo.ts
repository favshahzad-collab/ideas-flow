/**
 * The memo template.
 *
 * Nothing about a particular organisation is written into this file. The
 * letterhead, the organisation's name and every signatory come in as data, so
 * a rebrand, a second company or a chain of six approvers is configuration
 * rather than a code change.
 */
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument } from "pdf-lib";

import {
  DEFAULT_FONT_FAMILY,
  allFontKeys,
  fontKey,
  readDefaultLogo,
  readFontBytes,
  type MemoFontFamily,
} from "./assets";
import { assertEmbeddableImage, bytesOfImageDataUri } from "../imageBytes";
import { assertRenderable } from "./coverage";
import {
  type Fonts,
  justifyLine,
  runsFromNodes,
  wrapRuns,
  type WrappedLine,
} from "./richText";
import { MUTED, RULE, Sheet, typographyFor } from "./sheet";
import { resolveGeometry } from "./geometry";
import { drawNotes } from "./notes";
import { drawTable } from "./table";
import {
  DEFAULT_TEXT_SIZE,
  type MemoBlockNode,
  type MemoBody,
  type MemoHeader,
  type MemoListNode,
  type MemoSignatory,
  type MemoSignatureSlot,
  type RenderMemoInput,
} from "./types";

type EmbeddedImage = Awaited<ReturnType<PDFDocument["embedPng"]>>;
/** Every picture in the body, embedded once, by the URI that carries it. */
type EmbeddedImages = Map<string, EmbeddedImage>;

/**
 * Pixels to points, at the 96 pixels an inch a screen assumes: the size a
 * picture is drawn at when nobody has sized it.
 */
const POINTS_PER_PIXEL = 0.75;

/**
 * The tallest a picture is drawn. A little under the text height, so that on
 * a continuation page - which gives its top to the reference line - the
 * picture still fits below it rather than running into the margin.
 */
const IMAGE_HEIGHT_ALLOWANCE = 48;

/**
 * Embed each picture before the body is drawn.
 *
 * Embedding is asynchronous and drawing is not, so this is done first, once
 * per distinct picture: the same photograph twice is one object in the file.
 * The bytes are walked before pdf-lib sees them, for the reason the logo's
 * are: the decoder runs on the thread that serves every request.
 */
async function embedImages(doc: PDFDocument, body: MemoBody): Promise<EmbeddedImages> {
  const images: EmbeddedImages = new Map();

  for (const node of body.content) {
    if (node.type !== "image" || images.has(node.attrs.src)) continue;

    const bytes = bytesOfImageDataUri(node.attrs.src);
    if (!bytes) {
      assertEmbeddableImage(Buffer.alloc(0), "A picture in the memo");
      continue;
    }
    const kind = assertEmbeddableImage(
      bytes,
      "A picture in the memo",
      "Take it out and add it again as a PNG or a JPEG."
    );
    images.set(
      node.attrs.src,
      kind === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
    );
  }

  return images;
}

// The body size, its leading and the heading sizes are the sheet's
// (`sheet.type`): the memo chooses them, see `typographyFor`.
const PARAGRAPH_GAP = 7;

const HEADING_SPACE_ABOVE = 11;
const HEADING_SPACE_BELOW = 5;

const LABEL_SIZE = 10;
const LOGO_WIDTH = 116;

/** "August 06, 2026", as the sample prints it. */
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function formatMemoDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${MONTHS[date.getUTCMonth()]} ${day}, ${date.getUTCFullYear()}`;
}

async function embedFonts(doc: PDFDocument, family: MemoFontFamily): Promise<Fonts> {
  const fonts = {} as Fonts;

  for (const key of allFontKeys()) {
    // Subset: a memo carries its fonts, and the full family is 320KB that
    // nobody needs on a two-page document.
    fonts[key] = await doc.embedFont(readFontBytes(key, family), { subset: true });
  }

  return fonts;
}

function drawLetterhead(
  sheet: Sheet,
  branding: RenderMemoInput["branding"],
  logo: Awaited<ReturnType<PDFDocument["embedPng"]>> | null
): void {
  const top = sheet.y;

  if (logo) {
    // scaleToFit rather than a fixed height, so a logo of different
    // proportions is not stretched. The same rule the signature stamping
    // learned the hard way.
    const fitted = logo.scaleToFit(LOGO_WIDTH, 46);
    sheet.page.drawImage(logo, {
      x: sheet.geometry.width - sheet.geometry.marginRight - fitted.width,
      y: sheet.toPdfY(top + fitted.height),
      width: fitted.width,
      height: fitted.height,
    });
    sheet.advance(fitted.height);
  } else {
    // No logo is a legitimate configuration, not an error: set the name.
    sheet.drawLineOfText(
      {
        fragments: [
          {
            text: branding.organisationName,
            key: fontKey("bold", "upright"),
            underline: false,
            x: 0,
            width: 0,
          },
        ],
        width: 0,
      },
      { size: 15 }
    );
    sheet.advance(20);
  }

  sheet.advance(12);
}

function drawHeaderBlock(sheet: Sheet, header: MemoHeader): void {
  const rows: [string, string][] = [
    ["To:", header.to],
    ["From:", header.from],
    ["Subject:", header.subject],
    ["Date:", formatMemoDate(header.date)],
  ];

  if (header.reference) rows.splice(3, 0, ["Ref:", header.reference]);

  const labelWidth = 52;
  const valueWidth = sheet.geometry.textWidth - labelWidth;

  sheet.rule({ fromTop: sheet.y, thickness: 1.2 });
  sheet.advance(7);

  for (const [label, value] of rows) {
    const lines = wrapRuns(
      [{ text: value, key: fontKey("bold", "upright"), underline: false }],
      LABEL_SIZE,
      valueWidth,
      sheet.fonts
    );

    const height = Math.max(1, lines.length) * (LABEL_SIZE * 1.35);
    sheet.ensure(height);

    const top = sheet.y;

    sheet.drawLineOfText(
      {
        fragments: [
          {
            text: label,
            key: fontKey("bold", "upright"),
            underline: false,
            x: 0,
            width: 0,
          },
        ],
        width: 0,
      },
      { size: LABEL_SIZE }
    );

    lines.forEach((line, index) => {
      sheet.y = top + index * (LABEL_SIZE * 1.35);
      sheet.drawLineOfText(line, { x: sheet.geometry.marginLeft + labelWidth, size: LABEL_SIZE });
    });

    sheet.y = top + height;
  }

  sheet.advance(5);
  sheet.rule({ fromTop: sheet.y, thickness: 1.2 });
  sheet.advance(14);
}

function drawParagraph(
  sheet: Sheet,
  lines: WrappedLine[],
  size: number,
  leading: number,
  indent = 0,
  justify = false
): void {
  lines.forEach((line, index) => {
    sheet.ensure(leading);

    // The closing line of a paragraph keeps its natural width. Justifying it
    // is what produces a last line of three words stretched across the page.
    const laidOut =
      justify && index < lines.length - 1
        ? justifyLine(line, sheet.geometry.textWidth - indent)
        : line;

    sheet.drawLineOfText(laidOut, { x: sheet.geometry.marginLeft + indent, size });
    sheet.advance(leading);
  });
}

function drawList(sheet: Sheet, node: MemoListNode): void {
  const BULLET_COLUMN = 16;

  node.content.forEach((item, index) => {
    const marker = node.type === "bulletList" ? "•" : `${index + 1}.`;

    const runs = item.content.flatMap((paragraph) =>
      runsFromNodes(paragraph.content)
    );
    const lines = wrapRuns(
      runs,
      sheet.type.body,
      sheet.geometry.textWidth - BULLET_COLUMN,
      sheet.fonts
    );

    sheet.ensure(sheet.type.leading);
    const top = sheet.y;

    sheet.drawLineOfText(
      {
        fragments: [
          {
            text: marker,
            key: fontKey("regular", "upright"),
            underline: false,
            x: 0,
            width: 0,
          },
        ],
        width: 0,
      },
      { size: sheet.type.body }
    );

    sheet.y = top;
    drawParagraph(sheet, lines, sheet.type.body, sheet.type.leading, BULLET_COLUMN);
    sheet.advance(2);
  });

  sheet.advance(PARAGRAPH_GAP - 2);
}

function drawBlock(sheet: Sheet, node: MemoBlockNode, images: EmbeddedImages): void {
  switch (node.type) {
    case "pageBreak":
      sheet.newPage();
      return;

    case "image": {
      const image = images.get(node.attrs.src);
      if (!image) return;

      const column = sheet.geometry.textWidth;
      // Its own size unless somebody sized it, and never wider than the column.
      let width = node.attrs.share
        ? column * node.attrs.share
        : Math.min(column, image.width * POINTS_PER_PIXEL);
      let height = (width * image.height) / image.width;

      // A picture taller than a page is scaled to fit one, never clipped: a
      // photograph cut in half on a document somebody signs is worse than a
      // smaller photograph.
      const tallest = sheet.geometry.textHeight - IMAGE_HEIGHT_ALLOWANCE;
      if (height > tallest) {
        width = (width * tallest) / height;
        height = tallest;
      }

      // Whole, or on the next page: a picture is not split.
      sheet.ensure(height);
      sheet.page.drawImage(image, {
        x: sheet.geometry.marginLeft,
        y: sheet.toPdfY(sheet.y + height),
        width,
        height,
      });
      sheet.advance(height + PARAGRAPH_GAP);
      return;
    }

    case "heading": {
      const size = sheet.type.heading[node.attrs.level];

      // A heading keeps company with what it introduces. Without this a
      // section title can be the last thing on a page and its first sentence
      // the first thing on the next, which reads as two unrelated fragments
      // on a document somebody is signing.
      sheet.ensure(
        HEADING_SPACE_ABOVE + size * 1.3 + HEADING_SPACE_BELOW + sheet.type.leading * 2
      );

      sheet.advance(HEADING_SPACE_ABOVE);

      // Headings are underlined in the sample - BACKGROUND:, Recommendation -
      // so the mark is applied here rather than expecting the author to.
      const runs = runsFromNodes(node.content, { weight: "bold" }).map(
        (run) => ({ ...run, underline: true })
      );

      const lines = wrapRuns(runs, size, sheet.geometry.textWidth, sheet.fonts);
      drawParagraph(sheet, lines, size, size * 1.3);
      sheet.advance(HEADING_SPACE_BELOW);
      return;
    }

    case "bulletList":
    case "orderedList":
      drawList(sheet, node);
      return;

    case "table":
      sheet.advance(3);
      drawTable(sheet, node);
      sheet.advance(PARAGRAPH_GAP + 3);
      return;

    case "paragraph": {
      const lines = wrapRuns(
        runsFromNodes(node.content),
        sheet.type.body,
        sheet.geometry.textWidth,
        sheet.fonts
      );

      // An empty paragraph is a deliberate blank line in the editor.
      if (lines.length === 0) {
        sheet.advance(sheet.type.leading);
        return;
      }

      drawParagraph(sheet, lines, sheet.type.body, sheet.type.leading, 0, true);
      sheet.advance(PARAGRAPH_GAP);
      return;
    }
  }
}

/**
 * The printed signature strip.
 *
 * One column per signatory, laid out across the text width - three, four or
 * six, taken from the approval chain rather than fixed. This is the ruled
 * line with a name beneath it that the paper form has always carried; the
 * signature image an approver applies later is stamped on top of it by
 * `pdfSignature.ts`, and is a separate thing.
 */

/**
 * Clear space kept above each ruled line for the signature that will be
 * stamped there.
 *
 * Without this the gap above the strip was whatever happened to be left on the
 * page - as little as 28pt - and a signature placed in it ran over the last
 * line of the memo.
 */
export const SIGNING_SPACE = 40;

/** Enough for the signing space and a little air between it and the text. */
const MIN_GAP_ABOVE_STRIP = SIGNING_SPACE + 8;

const STRIP_NAME_SIZE = 9.5;
const STRIP_TITLE_SIZE = 7.5;
const STRIP_GUTTER = 12;
/** From the rule down to the top of the name. */
const STRIP_NAME_OFFSET = 6;

function drawSignatories(
  sheet: Sheet,
  signatories: MemoSignatory[]
): MemoSignatureSlot[] {
  if (signatories.length === 0) return [];

  const column =
    (sheet.geometry.textWidth - STRIP_GUTTER * (signatories.length - 1)) / signatories.length;

  /*
   * Measured before anything is drawn, because where the strip goes depends
   * on how tall it is: every column's name, designation and office, wrapped
   * to the column, and the tallest of them is the strip.
   */
  const columns = signatories.map((signatory) => {
    const name = wrapRuns(
      [{ text: signatory.name, key: fontKey("bold", "upright"), underline: false }],
      STRIP_NAME_SIZE,
      column,
      sheet.fonts
    );
    /*
     * What this person does, then which office they did it for. Two separate
     * lines rather than one run-on: a designation can wrap on its own in a
     * six-column strip, and joining them with a comma would break in the
     * middle of whichever happened to be longer.
     */
    const details = [signatory.designation, signatory.department]
      .filter((text): text is string => Boolean(text))
      .flatMap((text) =>
        wrapRuns(
          [{ text, key: fontKey("regular", "upright"), underline: false }],
          STRIP_TITLE_SIZE,
          column,
          sheet.fonts
        )
      );
    const height =
      STRIP_NAME_OFFSET +
      name.length * STRIP_NAME_SIZE * 1.25 +
      details.length * STRIP_TITLE_SIZE * 1.3;
    return { signatory, name, details, height };
  });
  const stripHeight = Math.max(...columns.map((entry) => entry.height));

  /*
   * At the very foot of the last page, with nothing under it but the margin.
   *
   * A signature block belongs at the bottom of the sheet - it is where a paper
   * memo has it and where a reader looks for it. It used to sit under the last
   * sentence, pushed down fifty points at most, and the rest of the page lay
   * blank beneath the signatures. Now the last line of the strip ends where
   * the text area does. The gap above is reserved with the strip, so a page
   * without room for both turns first and the strip goes to the foot of the
   * next.
   */
  sheet.ensure(MIN_GAP_ABOVE_STRIP + stripHeight);
  const ruleTop = sheet.geometry.textHeight - stripHeight;
  sheet.y = ruleTop;

  const page = sheet.pages.length;
  const slots: MemoSignatureSlot[] = [];

  columns.forEach(({ signatory, name, details }, index) => {
    const x = sheet.geometry.marginLeft + index * (column + STRIP_GUTTER);
    // Inset so the rule reads as a signing line rather than a table border.
    const ruleWidth = Math.min(column, 150);
    const ruleX = x + (column - ruleWidth) / 2;

    sheet.rule({
      fromTop: ruleTop,
      x: ruleX,
      width: ruleWidth,
      thickness: 0.75,
      color: RULE,
    });

    /*
     * The space this line is waiting for. `sheet.y` is measured down from the
     * top of the text area; a slot is reported from the top of the page,
     * because that is the origin the viewer and `SignaturePlacement` use.
     */
    slots.push({
      ...(signatory.key === undefined ? {} : { key: signatory.key }),
      name: signatory.name,
      page,
      x: ruleX,
      y: sheet.geometry.marginTop + ruleTop - SIGNING_SPACE,
      width: ruleWidth,
      height: SIGNING_SPACE,
    });

    sheet.y = ruleTop + STRIP_NAME_OFFSET;
    for (const line of name) {
      sheet.drawLineOfText(line, {
        x: x + (column - line.width) / 2,
        size: STRIP_NAME_SIZE,
      });
      sheet.advance(STRIP_NAME_SIZE * 1.25);
    }

    for (const line of details) {
      sheet.drawLineOfText(line, {
        x: x + (column - line.width) / 2,
        size: STRIP_TITLE_SIZE,
        color: MUTED,
      });
      sheet.advance(STRIP_TITLE_SIZE * 1.3);
    }
  });

  sheet.y = ruleTop + stripHeight;
  return slots;
}

/**
 * The memo, and where its signatures go.
 *
 * `renderMemo` below returns only the bytes, which is all most callers want.
 * The submit path wants both: the slots are recorded against the version so
 * that months later, when an approver finally opens it, the page can offer
 * them the line with their own name under it rather than a blank canvas.
 */
export async function renderMemoDocument(
  input: RenderMemoInput
): Promise<{ bytes: Buffer; slots: MemoSignatureSlot[]; pageCount: number }> {
  // Before anything is drawn: a character with no glyph would be written as
  // an empty box, and this artefact is immutable, digested and sent into an
  // approval chain. Better to refuse than to seal a page of tofu.
  assertRenderable(input);

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  /*
   * Pinned to the memo's own date.
   *
   * pdf-lib stamps CreationDate and ModDate from the wall clock otherwise,
   * and two renders of one memo then differ in bytes - which would make the
   * SHA-256 recorded against the artefact depend on when it was built rather
   * than on what it contains. Proved by rendering twice 1.5s apart.
   */
  doc.setCreationDate(input.header.date);
  doc.setModificationDate(input.header.date);
  doc.setTitle(input.header.subject);
  doc.setProducer("Ideas Flow");
  doc.setCreator("Ideas Flow");

  // The family and the size are the memo's own, and default to what every
  // memo filed before they could be chosen was drawn in.
  const fonts = await embedFonts(doc, input.body.attrs?.font ?? DEFAULT_FONT_FAMILY);
  // Resolved once, here: every measurement below reads it off the sheet, so
  // a memo cannot be laid out against one page and drawn onto another.
  const sheet = new Sheet(
    doc,
    fonts,
    resolveGeometry(input.page),
    typographyFor(input.body.attrs?.size ?? DEFAULT_TEXT_SIZE)
  );

  const logoBytes =
    input.branding.logo === undefined
      ? readDefaultLogo()
      : input.branding.logo;
  /*
   * Same guard as a signature, for the same reason: pdf-lib decodes PNGs on
   * the thread that serves every request. An administrator uploads this one
   * rather than any signed-in account, so it is a smaller door - but it is
   * the same door, and a logo that stops being readable should stop the
   * render with a message rather than stop the process.
   */
  if (logoBytes) {
    assertEmbeddableImage(
      logoBytes,
      "The organisation logo",
      "Upload it again under Branding, as a PNG."
    );
  }
  const logo = logoBytes ? await doc.embedPng(logoBytes) : null;

  // Continuation pages carry the subject and the reference, not the logo.
  sheet.onContinuation((continued) => {
    const caption = input.header.reference
      ? `${input.header.reference} — ${input.header.subject}`
      : input.header.subject;

    const lines = wrapRuns(
      [{ text: caption, key: fontKey("regular", "upright"), underline: false }],
      8,
      sheet.geometry.textWidth,
      fonts
    );

    if (lines[0]) {
      continued.drawLineOfText(lines[0], { size: 8, color: MUTED });
    }
    continued.advance(13);
    continued.rule({ fromTop: continued.y, thickness: 0.5, color: MUTED });
    continued.advance(12);
  });

  const images = await embedImages(doc, input.body);

  drawLetterhead(sheet, input.branding, logo);
  drawHeaderBlock(sheet, input.header);

  for (const node of input.body.content) drawBlock(sheet, node, images);

  const slots = drawSignatories(sheet, input.signatories);

  /*
   * After the flow, and after the strip.
   *
   * A note is placed on a page, not inserted into the text, so it can only be
   * drawn once the pages it names exist - and it is drawn over everything
   * else because that is what putting a note on a page means.
   */
  drawNotes(sheet.pages, fonts, input.notes);

  sheet.finish();

  return {
    bytes: Buffer.from(await doc.save()),
    slots,
    // Counted here rather than parsed back out of the bytes: pdf-lib writes
    // object streams by default, so the page objects are compressed and a
    // reader scanning the file for them finds nothing at all.
    pageCount: sheet.pages.length,
  };
}

export async function renderMemo(input: RenderMemoInput): Promise<Buffer> {
  return (await renderMemoDocument(input)).bytes;
}
