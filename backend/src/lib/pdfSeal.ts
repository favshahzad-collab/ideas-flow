import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import signpdf from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import forge from "node-forge";
import { logger } from "./logger";
import { subjectField } from "./sealCertificate";

/**
 * The organisation's digital seal on every approved memo.
 *
 * Everything else about a signature here - the images, the certificate page,
 * the ledger - is evidence the system keeps about the file. This is evidence
 * the file carries itself: a cryptographic signature over its bytes, made with
 * the organisation's certificate, that any PDF reader checks on opening.
 * Adobe Reader then shows who sealed it and whether the document has changed
 * since; change one byte and the seal shows as broken.
 *
 * Applied once, to the approved file, after the signature certificate is
 * added and before the file is fingerprinted - so the ledger's fingerprint is
 * of the sealed file people download.
 *
 * The certificate is a PKCS#12 file named by `SEAL_P12_PATH`, unlocked by
 * `SEAL_P12_PASSWORD`. A self-made one (`npm run seal:create-certificate`)
 * works today; Adobe shows its signer as unknown until each PC trusts it. A
 * certificate bought from a trusted authority is a drop-in replacement: point
 * the same two settings at it. With neither set, approvals carry no seal and
 * say so once at start-up - the memo is still approved.
 */

export type SealIdentity = {
  /** The PKCS#12 file: the certificate and its private key. */
  p12: Buffer;
  passphrase: string;
  /** Who the seal says signed: the certificate's own name. */
  signerName: string;
};

/** What the reader is told about the seal, alongside the certificate. */
export type SealDetails = {
  reason: string;
  location: string;
  contactInfo: string;
};

/*
 * Large enough for a 4096-bit key, its chain and the attributes, as hex. A
 * placeholder too small for the signature fails the seal outright, so the
 * margin is deliberate; unused space is padded with zeros.
 */
const SIGNATURE_LENGTH = 16_384;

/** The name inside a certificate, for the reader and for start-up logging. */
export function certificateName(p12: Buffer, passphrase: string): string {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12.toString("binary")));
  const store = forge.pkcs12.pkcs12FromAsn1(asn1, passphrase);
  const bags = store.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const cert = bags[0]?.cert;
  if (!cert) throw new Error("The seal certificate file holds no certificate.");
  return subjectField(cert, "CN") ?? subjectField(cert, "O") ?? "Ideas Flow";
}

let loaded: { path: string; identity: SealIdentity | null } | null = null;
let warned = false;

/**
 * The seal configured for this deployment, or null when there is none.
 *
 * Read from the environment each time it is asked for and cached by path, so
 * a change of certificate takes effect on restart and a test can point it at
 * a certificate of its own. A file that will not open is an error at the
 * first approval that needs it rather than a silent unsealed memo; start-up
 * checks the same file first (`check:env`), so that is where it is caught.
 */
export function configuredSeal(): SealIdentity | null {
  const path = process.env.SEAL_P12_PATH?.trim();
  if (!path) {
    if (!warned) {
      warned = true;
      logger.warn("seal.not_configured", {
        note: "SEAL_P12_PATH is not set: approved memos are not digitally sealed.",
      });
    }
    return null;
  }
  if (loaded?.path === path) return loaded.identity;

  const p12 = readFileSync(path);
  const passphrase = process.env.SEAL_P12_PASSWORD ?? "";
  const identity = { p12, passphrase, signerName: certificateName(p12, passphrase) };
  loaded = { path, identity };
  return identity;
}

/** Seal a finished PDF. The bytes returned are the only ones to keep. */
export async function sealPdf(
  pdf: Buffer,
  identity: SealIdentity,
  details: SealDetails,
  signingTime: Date
): Promise<Buffer> {
  const document = await PDFDocument.load(pdf);
  pdflibAddPlaceholder({
    pdfDoc: document,
    reason: details.reason,
    location: details.location,
    contactInfo: details.contactInfo,
    name: identity.signerName,
    signingTime,
    signatureLength: SIGNATURE_LENGTH,
    appName: "Ideas Flow",
  });
  // Object streams would hide the byte range the signature covers inside a
  // compressed stream, where no reader looks for it.
  const prepared = Buffer.from(await document.save({ useObjectStreams: false }));
  const signer = new P12Signer(identity.p12, { passphrase: identity.passphrase });
  return signpdf.sign(prepared, signer, signingTime);
}
