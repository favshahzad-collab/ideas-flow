import { createHash } from "node:crypto";
import forge from "node-forge";
import { subjectField } from "./sealCertificate";

/**
 * Check a sealed PDF the way a reader does.
 *
 * The seal is a detached PKCS#7 signature stored in the file's `/Contents`,
 * over every byte of the file except that gap - `/ByteRange` says which. So
 * checking it is: take those bytes, hash them, and confirm the signature's own
 * record of the hash matches and was signed by the certificate it carries.
 * Change any byte inside the range and the hash no longer matches.
 */
/*
 * forge has taken an options object here since 1.3; its published types still
 * say `strict?: boolean`. `parseAllBytes: false` stops at the end of the
 * signature the header declares and leaves the zero padding after it alone.
 */
const parseDer = forge.asn1.fromDer as unknown as (
  bytes: string,
  options: { parseAllBytes: boolean }
) => forge.asn1.Asn1;
const fromDerIgnoringPadding = (bytes: string) => parseDer(bytes, { parseAllBytes: false });

export type SealCheck =
  | { sealed: false }
  | {
      sealed: true;
      intact: boolean;
      signerName: string | null;
      signedAt: Date | null;
      /** True when the signature covers the whole file, end to end. */
      coversWholeFile: boolean;
    };

export function verifySeal(pdf: Buffer): SealCheck {
  const text = pdf.toString("latin1");
  const range = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);
  if (!range) return { sealed: false };

  const [a, b, c, d] = range.slice(1).map(Number) as [number, number, number, number];
  const signed = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);
  /*
   * The whole gap, padding and all. The signature's DER header says how long
   * it is, and the parser stops there; trimming the zero padding first would
   * also eat a genuine signature that happens to end in a zero byte - one in
   * every 256 - and report a good seal as broken.
   */
  const hex = pdf.subarray(a + b + 1, c - 1).toString("latin1");

  let intact: boolean;
  let signerName: string | null = null;
  let signedAt: Date | null = null;
  try {
    const raw = forge.util.hexToBytes(hex);
    const message = forge.pkcs7.messageFromAsn1(fromDerIgnoringPadding(raw)) as forge.pkcs7.PkcsSignedData & {
      rawCapture: { authenticatedAttributes: forge.asn1.Asn1[]; signature: string };
    };
    const cert = message.certificates[0];
    signerName = subjectField(cert, "CN") ?? null;

    // The digest the signer recorded, and the time, from the signed attributes.
    const attributes = message.rawCapture.authenticatedAttributes;
    let recordedDigest: string | null = null;
    for (const attribute of attributes) {
      const [type, set] = attribute.value as forge.asn1.Asn1[];
      const oid = forge.asn1.derToOid(type.value as string);
      const [inner] = set.value as forge.asn1.Asn1[];
      if (oid === forge.pki.oids.messageDigest) recordedDigest = forge.util.bytesToHex(inner.value as string);
      if (oid === forge.pki.oids.signingTime) {
        signedAt = forge.asn1.utcTimeToDate(inner.value as string);
      }
    }
    const actualDigest = createHash("sha256").update(signed).digest("hex");

    // The attributes are what the key signed: re-encode them as a SET and
    // check the signature over their hash with the certificate's public key.
    const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attributes);
    const attributesDigest = forge.md.sha256.create();
    attributesDigest.update(forge.asn1.toDer(set).getBytes());
    const publicKey = cert.publicKey as forge.pki.rsa.PublicKey;
    const signatureValid = publicKey.verify(attributesDigest.digest().getBytes(), message.rawCapture.signature);

    intact = signatureValid && recordedDigest === actualDigest;
  } catch {
    intact = false;
  }

  return {
    sealed: true,
    intact,
    signerName,
    signedAt,
    coversWholeFile: a === 0 && c + d === pdf.length,
  };
}
