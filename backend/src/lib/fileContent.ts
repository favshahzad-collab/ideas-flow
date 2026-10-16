import { PDFDocument } from "pdf-lib";
import { errors } from "./errors";

/**
 * Is this file what it says it is?
 *
 * The upload filter decides on `mimetype`, and `mimetype` is whatever the
 * browser - or anybody with curl - wrote in the multipart header. So a file
 * called "increment.pdf" labelled application/pdf could be anything at all,
 * and it was filed, shown to every approver and kept for good. This reads the
 * bytes instead, before anything is written.
 *
 * It checks the signature at the front of the file (the "magic bytes"), which
 * is what separates a PDF from a renamed executable, and that the name agrees
 * with the type, because the name is what somebody downloads it as and opens.
 * It is not a virus scan; `virusScan.ts` is.
 */

type Signature = { at: number; bytes: number[] };

const PDF: Signature[] = [{ at: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }]; // %PDF-
const PNG: Signature[] = [
  { at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];
const JPEG: Signature[] = [{ at: 0, bytes: [0xff, 0xd8, 0xff] }];
/** .docx and .xlsx are ZIP archives. */
const ZIP: Signature[] = [{ at: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }];
/** .doc and .xls are OLE compound files. */
const OLE: Signature[] = [
  { at: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];

type Kind = {
  /** What to call it when refusing. */
  noun: string;
  extensions: string[];
  /** null for text, which has no signature: it is checked for binary instead. */
  signatures: Signature[] | null;
};

const KINDS: Record<string, Kind> = {
  "application/pdf": { noun: "a PDF", extensions: [".pdf"], signatures: PDF },
  "image/png": { noun: "a PNG image", extensions: [".png"], signatures: PNG },
  "image/jpeg": {
    noun: "a JPEG image",
    extensions: [".jpg", ".jpeg"],
    signatures: JPEG,
  },
  "application/msword": {
    noun: "a Word document",
    extensions: [".doc"],
    signatures: OLE,
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    noun: "a Word document",
    extensions: [".docx"],
    signatures: ZIP,
  },
  "application/vnd.ms-excel": {
    noun: "an Excel workbook",
    extensions: [".xls"],
    signatures: OLE,
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    noun: "an Excel workbook",
    extensions: [".xlsx"],
    signatures: ZIP,
  },
  "text/plain": { noun: "a text file", extensions: [".txt"], signatures: null },
  "text/csv": { noun: "a CSV file", extensions: [".csv"], signatures: null },
};

function startsWith(bytes: Buffer, signature: Signature): boolean {
  if (bytes.length < signature.at + signature.bytes.length) return false;
  return signature.bytes.every((byte, index) => bytes[signature.at + index] === byte);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/**
 * Text has no signature to check, so the test is the other way round: a text
 * file has no NUL bytes in it, and every binary format does. Not a check that
 * it is UTF-8 - a CSV saved from Excel is often Windows-1252, and that is
 * still a CSV.
 */
function looksLikeText(bytes: Buffer): boolean {
  return !bytes.includes(0x00);
}

/**
 * Refuses a supporting file whose bytes or name disagree with its type.
 * The type has already been through the upload filter's allow list.
 */
export function assertSupportingFileContent(file: Express.Multer.File): void {
  const name = file.originalname;
  const kind = KINDS[file.mimetype];

  if (!kind) {
    throw errors.badRequest(`"${name}" is not a type of file that can be attached.`);
  }

  if (file.buffer.length === 0) {
    throw errors.badRequest(`"${name}" is empty.`);
  }

  if (!kind.extensions.includes(extensionOf(name))) {
    throw errors.badRequest(
      `"${name}" was sent as ${kind.noun}, but its name does not end in ` +
        `${kind.extensions.join(" or ")}. Rename it, or attach the right file.`
    );
  }

  const matches = kind.signatures
    ? kind.signatures.some((signature) => startsWith(file.buffer, signature))
    : looksLikeText(file.buffer);

  if (!matches) {
    throw errors.badRequest(
      `"${name}" is not ${kind.noun}, whatever its name says. ` +
        "Open it to check it is the right file, save it again, and attach that."
    );
  }
}

/**
 * The PDF header may sit a little way in - the specification allows leading
 * bytes, and some scanners write them - but not further than this.
 */
const PDF_HEADER_WINDOW = 1024;

/**
 * Refuses a memo PDF that approvers would not be able to sign.
 *
 * Checking the header is not enough for this one. Every approver's signature
 * is drawn onto this file, and until now the first time anybody opened it
 * properly was at the first approval - so a damaged or password-protected
 * PDF went round the whole chain's inboxes and then failed in the hands of
 * someone who could do nothing about it. It is opened here, once, while the
 * person who can fix it is still looking at the form.
 */
export async function assertSignablePdf(file: Express.Multer.File): Promise<void> {
  const bytes = file.buffer;

  if (bytes.length === 0) {
    throw errors.badRequest("The memo file is empty.");
  }

  const header = bytes.subarray(0, PDF_HEADER_WINDOW);
  if (header.indexOf("%PDF-", 0, "latin1") === -1) {
    throw errors.badRequest(
      "The memo file is not a PDF, whatever its name says. Save or export it " +
        "as a PDF and upload that."
    );
  }

  /*
   * Opened with `ignoreEncryption` and then asked, rather than left to throw:
   * pdf-lib is compiled to ES5, where `instanceof` on its EncryptedPDFError
   * is always false, so a catch that tested for it would have called every
   * password-protected memo "damaged".
   */
  const damaged = () =>
    errors.badRequest(
      "The memo PDF is damaged and could not be opened. Save or export it " +
        "again and upload the new copy."
    );

  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
  } catch {
    throw damaged();
  }

  if (pdf.isEncrypted) {
    throw errors.badRequest(
      "The memo PDF is password-protected or encrypted, so approvers' " +
        "signatures cannot be added to it. Save a copy without the " +
        "password and upload that."
    );
  }

  // The page tree is read lazily, so a file with no usable catalog loads and
  // only fails here.
  let pages: number;
  try {
    pages = pdf.getPageCount();
  } catch {
    throw damaged();
  }

  if (pages === 0) {
    throw errors.badRequest("The memo PDF has no pages.");
  }
}
