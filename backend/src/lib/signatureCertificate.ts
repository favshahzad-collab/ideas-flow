import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";

/**
 * The signature certificate: a last page on every approved memo that says,
 * in words, who signed it, when, from where, and how they proved it was them.
 *
 * The approved PDF is what HR prints, files and hands to an auditor years
 * later, by which time nobody may be able to log in and look anything up.
 * Signatures on the page are images; this page is what turns them into a
 * record the paper can carry by itself.
 *
 * It is added once, in the same step that produces the approved file, and
 * before that file is fingerprinted - so the fingerprint the ledger records is
 * the fingerprint of the file people download, certificate included. The page
 * cannot print its own file's fingerprint (adding it would change it), so it
 * prints the fingerprint of the memo as submitted and says where the approved
 * file's is kept.
 */

/** How each way of confirming identity reads on the certificate. */
const IDENTITY_LABEL = {
  PASSWORD: "Password",
  AUTHENTICATOR: "Authenticator app code",
  MICROSOFT: "Microsoft sign-in, entered again",
} as const;

export type CertificateSigner = {
  name: string;
  designation?: string | null;
  /** "Preparer", "Reviewer", "Approver", "Final Approver". */
  role: string;
  signedAt: Date;
  ipAddress?: string | null;
  /** How the mark was made, where it was recorded. */
  method?: "SAVED_SIGNATURE" | "DRAWN" | null;
  /** When they confirmed it was them; null where that was not recorded. */
  identityConfirmedAt?: Date | null;
  /** How they confirmed it; null for a signature recorded before this was kept. */
  identityConfirmedBy?: "PASSWORD" | "AUTHENTICATOR" | "MICROSOFT" | null;
  agreedToStatement?: boolean;
  /** The person whose step this was, when somebody signed under a delegation. */
  onBehalfOf?: string | null;
};

export type CertificateSkippedStep = {
  role: string;
  assignee: string;
  skippedBy: string;
  at: Date;
  reason?: string | null;
};

export type CertificateData = {
  title: string;
  referenceNumber?: string | null;
  documentId: string;
  versionNumber: number;
  submittedAt?: Date | null;
  /** SHA-256 of the memo as submitted, before any approver signed it. */
  submittedChecksum?: string | null;
  approvedAt: Date;
  signers: CertificateSigner[];
  skipped?: CertificateSkippedStep[];
  /** IANA zone the times are shown in; UTC is printed beside each one. */
  timeZone: string;
  /** Whose digital seal the file is about to carry, when it will carry one. */
  sealedBy?: string | null;
};

export const CERTIFICATE_TITLE = "Signature certificate";

const MARGIN = 56;
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.38, 0.38, 0.38);
const RULE = rgb(0.8, 0.8, 0.8);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `01 Oct 2026, 11:44:03 (Asia/Karachi) · 06:44:03 UTC` - never ambiguous. */
export function formatCertificateTime(date: Date, timeZone: string): string {
  // Numbers from the zone, the month's name from a fixed list: the runtime's
  // own short names vary between versions ("Sep" or "Sept"), and the same
  // memo must not print differently depending on which server approved it.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      day: "2-digit",
      month: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  ) as Record<string, string>;
  const local = `${parts.day} ${MONTHS[Number(parts.month) - 1]} ${parts.year}, ${parts.hour}:${parts.minute}:${parts.second}`;
  const utc = date.toISOString().slice(11, 19);
  return timeZone === "UTC" ? `${local} UTC` : `${local} (${timeZone}) · ${utc} UTC`;
}

/** Whether a zone name is one this runtime can format in. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const METHOD_LABEL = { SAVED_SIGNATURE: "Saved signature", DRAWN: "Drawn at signing" } as const;

/**
 * Text Helvetica can spell. pdf-lib's standard fonts encode WinAnsi and throw
 * on anything outside it; a name with one unusual letter must not stop a memo
 * being approved.
 */
function spellable(font: PDFFont, text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  try {
    font.widthOfTextAtSize(clean, 10);
    return clean;
  } catch {
    return Array.from(clean)
      .map((ch) => {
        try {
          font.widthOfTextAtSize(ch, 10);
          return ch;
        } catch {
          return "?";
        }
      })
      .join("");
  }
}

/** Break a line into pieces that fit the width, at spaces where it can. */
function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    // A single word wider than the line - a fingerprint - is cut by character.
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > width) {
      let cut = rest.length;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut -= 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

/** Append the certificate to an approved PDF and return the new bytes. */
export async function appendSignatureCertificate(
  pdfBuffer: Buffer,
  data: CertificateData
): Promise<Buffer> {
  const pdf = await PDFDocument.load(pdfBuffer);
  const [regular, bold, mono] = await Promise.all([
    pdf.embedFont(StandardFonts.Helvetica),
    pdf.embedFont(StandardFonts.HelveticaBold),
    pdf.embedFont(StandardFonts.Courier),
  ]);

  // The memo's own page size, so the certificate prints on the same paper.
  const first = pdf.getPages()[0];
  const { width, height } = first ? first.getSize() : { width: 595, height: 842 };
  const textWidth = width - MARGIN * 2;

  let page: PDFPage = pdf.addPage([width, height]);
  let y = height - MARGIN;
  let pageNumber = 1;

  const newPage = () => {
    page = pdf.addPage([width, height]);
    pageNumber += 1;
    y = height - MARGIN;
    write(`${CERTIFICATE_TITLE} (continued, page ${pageNumber})`, { font: bold, size: 11 });
    y -= 6;
  };
  const room = (needed: number) => {
    if (y - needed < MARGIN) newPage();
  };
  function write(
    text: string,
    { font = regular, size = 9.5, color = INK, indent = 0, gap = 3.5 }: {
      font?: PDFFont; size?: number; color?: typeof INK; indent?: number; gap?: number;
    } = {}
  ) {
    for (const line of wrap(font, spellable(font, text), size, textWidth - indent)) {
      room(size + gap);
      y -= size;
      page.drawText(line, { x: MARGIN + indent, y, size, font, color });
      y -= gap;
    }
  }
  const field = (label: string, value: string, font: PDFFont = regular) => {
    write(`${label}: ${value}`, { font, indent: 12 });
  };
  const rule = () => {
    room(10);
    y -= 4;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: width - MARGIN, y }, thickness: 0.5, color: RULE });
    y -= 8;
  };
  const time = (date: Date) => formatCertificateTime(date, data.timeZone);

  write(CERTIFICATE_TITLE, { font: bold, size: 16, gap: 6 });
  write(
    "Added by Ideas Flow when this memo was fully approved. It is part of the approved file and records who signed it, when, and how each signer proved who they were.",
    { color: MUTED, size: 9 }
  );
  rule();

  write("The memo", { font: bold, size: 11, gap: 5 });
  field("Subject", data.title);
  if (data.referenceNumber) field("Reference", data.referenceNumber);
  field("Document ID", data.documentId);
  field("Version", String(data.versionNumber));
  if (data.submittedAt) field("Submitted", time(data.submittedAt));
  field("Fully approved", time(data.approvedAt));
  if (data.submittedChecksum) {
    write("Fingerprint of the memo as submitted (SHA-256):", { indent: 12 });
    write(data.submittedChecksum, { font: mono, size: 8.5, indent: 24 });
  }
  rule();

  write("Signatures, in the order they were made", { font: bold, size: 11, gap: 5 });
  data.signers.forEach((signer, index) => {
    room(70);
    write(`${index + 1}. ${signer.name}`, { font: bold, size: 10.5, gap: 2 });
    write([signer.designation, signer.role].filter(Boolean).join(" · "), { color: MUTED, indent: 12 });
    if (signer.onBehalfOf) field("Signed for", signer.onBehalfOf);
    field("Signed", time(signer.signedAt));
    field("IP address", signer.ipAddress || "Not recorded");
    field("Signature", signer.method ? METHOD_LABEL[signer.method] : "Not recorded");
    field(
      "Identity confirmed",
      signer.identityConfirmedAt
        ? signer.identityConfirmedBy
          ? `${IDENTITY_LABEL[signer.identityConfirmedBy]}, ${time(signer.identityConfirmedAt)}`
          : // Recorded before the method was kept: the time is known, the
            // method is not, and the page must not guess one.
            `Confirmed ${time(signer.identityConfirmedAt)} (method not recorded)`
        : "Not recorded (signed before this check was introduced)"
    );
    field(
      "Agreed that this is their signature",
      signer.agreedToStatement ? "Yes" : "Not recorded (signed before this check was introduced)"
    );
    y -= 4;
  });

  if (data.skipped?.length) {
    rule();
    write("Steps passed over", { font: bold, size: 11, gap: 5 });
    for (const step of data.skipped) {
      write(
        `${step.role} (${step.assignee}): skipped by ${step.skippedBy}, ${time(step.at)}${step.reason ? `. Reason: ${step.reason}` : ""}`,
        { indent: 12 }
      );
    }
  }

  rule();
  if (data.sealedBy) {
    write(
      `This file carries the digital seal of ${data.sealedBy}. Your PDF reader checks it when the file opens: it shows who sealed the file and warns if anything in it has changed since.`,
      { size: 8.5 }
    );
  }
  write(
    "To check this file has not been changed since it was approved, compare its SHA-256 fingerprint with the one recorded in the Ideas Flow audit ledger for this memo. The fingerprint of this file cannot be printed on it, because printing it would change it.",
    { color: MUTED, size: 8.5 }
  );

  return Buffer.from(await pdf.save());
}
