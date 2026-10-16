import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import { AppError, errors } from "./errors";
import { assertEmbeddableImage } from "./imageBytes";

export type SignaturePlacement = {
  signaturePage: number;
  signatureX: number;
  signatureY: number;
  signatureWidth: number;
  signatureHeight: number;
};

/** The capacity somebody signed in, as the approval chain records it. */
export type SignoffCapacity = "REVIEWER" | "APPROVER" | "FINAL_APPROVER";

/**
 * Who signed, in what capacity, and when.
 *
 * The filed PDF is the record: it is what HR prints, what an auditor is shown
 * and what somebody reads back years later, by which time the workflow rows
 * behind it may mean nothing to them. An image on its own identifies nobody -
 * a signature is a squiggle - so the page has to carry the answer in words.
 *
 * Everything but the name is optional because the columns behind them are:
 * `designation` arrived after the accounts did, and the preparer's signature
 * is applied without a capacity or an approval time to quote.
 */
export type SignoffDetails = {
  name: string;
  designation?: string | null;
  department?: string | null;
  capacity?: SignoffCapacity | null;
  signedAt?: Date | null;
  /**
   * The person whose step this was, when somebody signed it under a
   * delegation. The mark and the name are the delegate's - they are who
   * signed - and this line says whose approval it was, because a page that
   * shows one name where the chain names another is a page nobody can
   * reconcile years later.
   */
  onBehalfOf?: string | null;
  /**
   * The page already prints this person's name and title, on a ruled line
   * directly under where the signature is going.
   *
   * True on a memo typed in the portal, whose template draws a signature
   * strip from the approval chain, and on an attached PDF, which is a memo
   * written in Word with its signatories already printed on it - except for
   * a delegate, whose mark sits over somebody else's name. Drawing the
   * block there puts the same name twice within a few points of itself, over
   * the top of the printed one. Nothing is drawn under the mark but a
   * delegate's "Signed for" line: the page names the signatory, and the
   * capacity and the date are the ledger's.
   */
  onOwnLine?: boolean;
  /**
   * The document is a memo typed in the portal, whether or not this
   * signature sits on its own printed line - a delegate's does not. On such
   * a memo no capacity and no date are drawn under any signature; the name,
   * the post and whose approval it was still are, where the strip does not
   * already print them.
   */
  onTypedMemo?: boolean;
};

/** What each capacity is called in front of a reader, rather than in the enum. */
export const CAPACITY_LABEL: Record<SignoffCapacity, string> = {
  REVIEWER: "Reviewer",
  APPROVER: "Approver",
  FINAL_APPROVER: "Final Approver",
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * `06 Sep 2026`.
 *
 * A date on a memo is read by a person, and the two shorthands a machine would
 * reach for both cost them something: an ISO timestamp cannot be taken in at a
 * glance, and `06/09/2026` is two different days depending on who is holding
 * the page. Spelling the month removes the ambiguity for good.
 */
export function formatSignoffDate(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const day = String(date.getDate()).padStart(2, "0");
  return `${day} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/* The sign-off block's layout, in points. Sizes are small on purpose: the
 * block sits inside whatever space the signer left themselves on somebody
 * else's page, and has to read as an annotation rather than as body text. */
const RULE_OFFSET = 5;
/**
 * The same gap, for a signature sitting on a line the page already printed.
 *
 * `RULE_OFFSET` is the air above a rule this block draws for itself. On a
 * printed line there is no rule to leave room for, and spending five points
 * on one pushed the date down across the line it was supposed to sit above.
 */
const OWN_LINE_OFFSET = 1;
const RULE_THICKNESS = 0.75;
const NAME_SIZE = 9;
const DETAIL_SIZE = 7.5;
const LINE_GAP = 3.5;
/** Room under the last baseline for the tail of a g, y or p. */
const DESCENDER_TAIL = 2;

type SignoffLine = { text: string; size: number; bold: boolean };

/**
 * One line's worth of text, whatever was stored.
 *
 * A newline inside a name or a department would make pdf-lib draw two lines
 * where the height calculation below counted one, and the extra line lands on
 * the memo text underneath.
 */
function oneLine(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The block's lines, top to bottom, with the empty ones left out entirely.
 *
 * Somebody with no designation gets no designation line rather than a blank
 * one: a gap in the middle of a sign-off block reads as a field the system
 * failed to fill in, and it pushes the rest of the block down onto the text.
 */
function signoffLines(signoff?: SignoffDetails | null): SignoffLine[] {
  const name = oneLine(signoff?.name);

  if (!signoff || !name) {
    return [];
  }

  const lines: SignoffLine[] = [];

  // On a printed line, the name and the role are already set below it - the
  // strip drew them from the approval chain when the memo was generated.
  if (!signoff.onOwnLine) {
    lines.push({ text: name, size: NAME_SIZE, bold: true });

    const role = [oneLine(signoff.designation), oneLine(signoff.department)]
      .filter(Boolean)
      .join(", ");
    if (role) {
      lines.push({ text: role, size: DETAIL_SIZE, bold: false });
    }
  }

  /*
   * The capacity, on an uploaded document only; the date, never.
   *
   * No signature carries a date on the page: the audit ledger records when
   * each person signed, and a date under the mark read as the system's tag
   * on a signed document. On a memo written in the portal the capacity goes
   * too - the strip already names every signatory. The services sign an
   * uploaded PDF on its own printed lines (`onOwnLine`), so in practice this
   * line is only drawn for a caller that says neither.
   */
  if (!signoff.onOwnLine && !signoff.onTypedMemo && signoff.capacity) {
    lines.push({ text: CAPACITY_LABEL[signoff.capacity], size: DETAIL_SIZE, bold: false });
  }

  // Only ever present under a delegation, so an ordinary signature keeps the
  // block it always had.
  const onBehalfOf = oneLine(signoff.onBehalfOf);
  if (onBehalfOf) {
    lines.push({
      text: `Signed for ${onBehalfOf}`,
      size: DETAIL_SIZE,
      bold: false,
    });
  }

  return lines;
}

/**
 * How far below the signature image the block reaches, in points.
 *
 * Exported because the caller places the image before this file ever sees it:
 * a signature dropped near the foot of a page is legal on its own and only
 * overflows once the block is under it, so whoever fits the box to the page
 * has to reserve this much or the names are drawn into the margin and off the
 * bottom edge - burned into an approved document that cannot be redrawn.
 */
export function signoffBlockHeight(signoff?: SignoffDetails | null): number {
  const lines = signoffLines(signoff);

  if (lines.length === 0) {
    return 0;
  }

  // No rule of its own on a printed line: the strip drew one, which is what
  // the signature is being placed above.
  const ruleSpace = signoff?.onOwnLine
    ? OWN_LINE_OFFSET
    : RULE_OFFSET + RULE_THICKNESS;

  return (
    lines.reduce((total, line) => total + LINE_GAP + line.size, ruleSpace) +
    DESCENDER_TAIL
  );
}

/**
 * The text, with anything Helvetica cannot spell replaced.
 *
 * pdf-lib's standard fonts encode WinAnsi and throw on a code point outside
 * it. Raised from here that arrives as a failed approval reported as a broken
 * signature image, which sends the approver off to redraw a signature that was
 * never the problem. A name that keeps its Latin letters and loses one
 * accent is a poor result; refusing to sign the document is a worse one.
 */
function encodable(font: PDFFont, text: string): string {
  const spellable = (candidate: string): boolean => {
    try {
      font.widthOfTextAtSize(candidate, NAME_SIZE);
      return true;
    } catch {
      return false;
    }
  };

  if (spellable(text)) {
    return text;
  }

  return Array.from(text)
    .map((character) => (spellable(character) ? character : "?"))
    .join("");
}

/**
 * Trim a line to the room left between it and the right edge of the page.
 *
 * A long designation is ordinary - "Deputy Manager, Procurement and Contracts"
 * - and a signature placed to the right of centre leaves it nowhere to go. Text
 * that runs past the edge is not clipped by a viewer, it is simply gone, and
 * the block silently stops saying what it was there to say.
 */
function fitToWidth(
  font: PDFFont,
  text: string,
  size: number,
  maxWidth: number
): string {
  if (maxWidth <= 0) {
    return "";
  }

  if (font.widthOfTextAtSize(text, size) <= maxWidth) {
    return text;
  }

  let kept = text;
  while (kept && font.widthOfTextAtSize(`${kept}...`, size) > maxWidth) {
    kept = kept.slice(0, -1);
  }

  return kept ? `${kept}...` : "";
}

/**
 * Draw the sign-off block under the signature, in the order a person reads a
 * signed page: the mark, a rule closing it off, then the name, the post held,
 * and the capacity and date the signature was given in.
 */
async function drawSignoffBlock(
  pdfDoc: PDFDocument,
  page: PDFPage,
  placement: SignaturePlacement,
  imageBottom: number,
  lines: SignoffLine[],
  onOwnLine = false
): Promise<void> {
  const [regular, bold] = await Promise.all([
    pdfDoc.embedFont(StandardFonts.Helvetica),
    pdfDoc.embedFont(StandardFonts.HelveticaBold),
  ]);

  const { width: pageWidth } = page.getSize();
  const available = Math.max(pageWidth - placement.signatureX, 0);

  const drawable = lines.map((line) => {
    const font = line.bold ? bold : regular;
    const text = fitToWidth(
      font,
      encodable(font, line.text),
      line.size,
      available
    );
    return { ...line, font, text };
  });

  // The rule runs the width of whatever it is closing off - the mark or the
  // longest line under it - so a narrow initial does not end up with a stub of
  // a rule over a name three times its length.
  const ruleWidth = Math.min(
    Math.max(
      placement.signatureWidth,
      ...drawable.map((line) => line.font.widthOfTextAtSize(line.text, line.size))
    ),
    available
  );

  let y = imageBottom - (onOwnLine ? OWN_LINE_OFFSET : RULE_OFFSET);

  if (!onOwnLine) {
    page.drawLine({
      start: { x: placement.signatureX, y },
      end: { x: placement.signatureX + ruleWidth, y },
      thickness: RULE_THICKNESS,
      color: rgb(0.45, 0.45, 0.45),
    });

    y -= RULE_THICKNESS;
  }

  for (const line of drawable) {
    if (!line.text) {
      continue;
    }

    // Every line is drawn at its own y rather than with pdf-lib's leading, so
    // the positions on the page are the ones `signoffBlockHeight` promised.
    y -= LINE_GAP + line.size;

    page.drawText(line.text, {
      x: placement.signatureX,
      y,
      size: line.size,
      font: line.font,
      color: line.bold ? rgb(0, 0, 0) : rgb(0.25, 0.25, 0.25),
    });
  }
}

export function decodeSignatureImage(signatureImage: string): Buffer {
  const base64 = signatureImage.replace(/^data:image\/\w+;base64,/, "");
  return Buffer.from(base64, "base64");
}

/**
 * Hand pdf-lib a standalone copy of the image bytes.
 *
 * Its JPEG embedder reads `bytes.buffer` without applying `byteOffset`, and
 * Node hands out small Buffers as views into a shared 8 KB pool - so a JPEG
 * signature under ~4 KB arrives at offset 8, pdf-lib reads the pool's first
 * two bytes instead of the image's, and rejects a perfectly good file with
 * "SOI not found in JPEG". A copy costs one allocation of a few kilobytes and
 * removes the whole class of bug.
 */
function standaloneBytes(bytes: Buffer): Uint8Array {
  return new Uint8Array(bytes);
}

export async function embedSignatureInPdf(
  pdfBuffer: Buffer,
  signatureBuffer: Buffer,
  input: SignaturePlacement,
  signoff?: SignoffDetails | null
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pages = pdfDoc.getPages();

  if (input.signaturePage < 1 || input.signaturePage > pages.length) {
    throw errors.badRequest("Invalid signature page number.");
  }

  const page = pages[input.signaturePage - 1];
  const { height: pageHeight } = page.getSize();

  /*
   * Checked before any decoder sees it.
   *
   * pdf-lib decodes in pure JavaScript on the thread that serves every other
   * request, and malformed bytes do not make it fail fast - they make it work
   * for a very long time. The old try/embedPng/catch/embedJpg handed the same
   * bad bytes to both decoders in turn; this reads the headers first, refuses
   * anything that does not add up, and then calls the one decoder that
   * matches.
   */
  const kind = assertEmbeddableImage(
    signatureBuffer,
    "The signature image",
    "Draw a new signature, or re-upload your saved one."
  );
  const imageBytes = standaloneBytes(signatureBuffer);

  const image =
    kind === "png"
      ? await pdfDoc.embedPng(imageBytes)
      : await pdfDoc.embedJpg(imageBytes);

  // Frontend coordinates are top-left origin; pdf-lib uses bottom-left origin.
  const pdfY = pageHeight - input.signatureY - input.signatureHeight;

  /*
   * The box is the frame the signature is fitted into, not a shape to pour it
   * into.
   *
   * The signing editor draws the preview with `object-contain` - scaled to fit
   * inside the box, proportions kept, letterboxed where the two disagree.
   * Passing a width and a height to `drawImage` fills the box instead, so any
   * signature whose shape was not the box's arrived on the memo stretched:
   * previewed correctly, filed wrong, and the first chance anybody had of
   * seeing it was the signed PDF.
   *
   * A drawn signature is cropped to its own ink and the box is built from that
   * crop, so for the pen the two already agree and this changes nothing. It is
   * an uploaded or saved signature that this is about: those are dropped into
   * a 150 x 50 default box whatever shape the file is, and the fitting the
   * frontend does can be undone server-side anyway - a signature wider than
   * the page has its width pulled in on its own, which leaves the box a shape
   * the image never was.
   *
   * The leftover is centred on both axes, which is what `object-contain` does
   * and therefore what the person placing it saw.
   */
  const fitted = image.scaleToFit(input.signatureWidth, input.signatureHeight);

  page.drawImage(image, {
    x: input.signatureX + (input.signatureWidth - fitted.width) / 2,
    y: pdfY + (input.signatureHeight - fitted.height) / 2,
    width: fitted.width,
    height: fitted.height,
  });

  const lines = signoffLines(signoff);
  if (lines.length > 0) {
    await drawSignoffBlock(
      pdfDoc,
      page,
      input,
      pdfY,
      lines,
      signoff?.onOwnLine ?? false
    );
  }

  const signedPdfBytes = await pdfDoc.save();
  return Buffer.from(signedPdfBytes);
}

/**
 * What to say when the document itself cannot be opened.
 *
 * The same failure, but not the same sentence. An approver is holding
 * somebody else's file and can only ask for it again; a preparer is holding
 * the one they just chose and can go and fix it.
 */
export interface FitPlacementMessages {
  unreadablePdf: string;
}

/**
 * Fit the signature box to the page it is about to be burned into.
 *
 * The signed bytes become the stored version, so a box drawn off the page
 * leaves a document that reads as signed with no visible signature anywhere
 * on it - and what it replaced is gone. The browser already keeps the box
 * inside the page; nothing on the server insisted on it, so a replayed call
 * with `signatureX: 99999` was answered 200.
 *
 * A fraction of a point over the edge is not misuse - it falls out of the
 * float conversion the viewer does - so an overhanging box is pulled back
 * onto the page rather than refused. Only a box that shares no area with the
 * page at all is refused, because there is no honest place to put it.
 *
 * The mark is taller than the image: the sign-off block naming the signer
 * hangs below it, so the space to fit is both together. Fitting the image
 * alone leaves the names in the bottom margin and off the edge of a signature
 * placed at the foot of a page.
 *
 * Lives here rather than on one service because every signature this product
 * burns in goes through it. It was written for approvals and reached from
 * nowhere else, so the preparer's own signature - the first mark on the memo,
 * and the one every approver then signs around - was placed by no rule at
 * all: their name, title and date were drawn below the bottom edge and lost.
 */
export async function fitPlacementToPage(
  pdfBuffer: Buffer,
  input: SignaturePlacement,
  signoff: SignoffDetails | null | undefined,
  messages: FitPlacementMessages
): Promise<SignaturePlacement> {
  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBuffer);
  } catch {
    throw errors.badRequest(messages.unreadablePdf);
  }

  const pages = pdfDoc.getPages();

  // Same refusal embedSignatureInPdf would give, raised before the image is
  // touched so the page number is not reported as an image problem.
  if (input.signaturePage < 1 || input.signaturePage > pages.length) {
    throw errors.badRequest("Invalid signature page number.");
  }

  const { width: pageWidth, height: pageHeight } =
    pages[input.signaturePage - 1].getSize();

  const missesThePage =
    input.signatureX >= pageWidth ||
    input.signatureY >= pageHeight ||
    input.signatureX + input.signatureWidth <= 0 ||
    input.signatureY + input.signatureHeight <= 0;

  if (missesThePage) {
    throw errors.badRequest(
      "The signature was placed outside the page. Move it onto the page and sign again."
    );
  }

  // The image and the block under it move as one: the block is drawn from the
  // foot of the image downwards, so the space to fit is both together.
  const blockHeight = signoffBlockHeight(signoff);
  const markHeight = Math.min(input.signatureHeight + blockHeight, pageHeight);

  const signatureWidth = Math.min(input.signatureWidth, pageWidth);
  const signatureHeight = Math.max(markHeight - blockHeight, 0);

  return {
    signaturePage: input.signaturePage,
    signatureX: Math.min(
      Math.max(input.signatureX, 0),
      pageWidth - signatureWidth
    ),
    signatureY: Math.min(
      Math.max(input.signatureY, 0),
      pageHeight - markHeight
    ),
    signatureWidth,
    signatureHeight,
  };
}

/**
 * Burn the signature in, and answer for a bad image in words.
 *
 * pdf-lib tries PNG then JPEG and throws out of the second attempt when the
 * bytes are neither. That is a plain Error, so it reaches the signer as 500
 * "Internal server error" in the middle of legitimate work. It can also
 * arrive from the saved-signature path, where the bytes came from storage
 * rather than from this request - hence a message that covers both.
 *
 * Shared for the same reason as the fitting above: the preparer submitting a
 * memo got the raw "SOI not found in JPEG" and a 500, with their upload,
 * their chain and their signature to enter again.
 */
export async function stampSignature(
  pdfBuffer: Buffer,
  signatureBuffer: Buffer,
  placement: SignaturePlacement,
  signoff?: SignoffDetails | null
): Promise<Buffer> {
  try {
    return await embedSignatureInPdf(
      pdfBuffer,
      signatureBuffer,
      placement,
      signoff
    );
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw errors.badRequest(
      "Signature image could not be read as a PNG or JPEG. Draw a new signature, or re-upload your saved one."
    );
  }
}
