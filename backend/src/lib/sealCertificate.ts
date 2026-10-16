import { generateKeyPairSync, randomBytes } from "node:crypto";
import forge from "node-forge";

/**
 * A self-made certificate for the document seal.
 *
 * Free and immediate, and as strong cryptographically as a bought one. The
 * difference is trust: nobody vouches for it, so Adobe shows its signer as
 * unknown until a PC is told to trust it - which is what the `.cer` file
 * written beside it is for. Replace it with an authority's certificate later
 * by pointing `SEAL_P12_PATH` at that one instead; nothing else changes.
 */
export function createSelfSignedSeal(options: {
  commonName: string;
  organization: string;
  passphrase: string;
  years?: number;
  /** 3072 by default; tests pass less for speed. */
  bits?: number;
}): { p12: Buffer; certificateDer: Buffer; fingerprintSha256: string; validTo: Date } {
  // Native key generation: forge's own is pure JavaScript and takes seconds
  // of the event loop for a 3072-bit key.
  const native = generateKeyPairSync("rsa", {
    modulusLength: options.bits ?? 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const keys = {
    privateKey: forge.pki.privateKeyFromPem(native.privateKey),
    publicKey: forge.pki.publicKeyFromPem(native.publicKey),
  };
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  // A positive serial: the leading byte is kept below 0x80.
  cert.serialNumber = `0${randomBytes(15).toString("hex")}`;
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + (options.years ?? 5));

  const name = [
    { name: "commonName", value: options.commonName },
    { name: "organizationName", value: options.organization },
    { name: "countryName", value: "PK" },
  ];
  cert.setSubject(name);
  cert.setIssuer(name);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    // Signing documents, and standing behind them: what a seal is for.
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
    // Adobe's document-signing purpose, so readers offer it for exactly that.
    { name: "extKeyUsage", emailProtection: true, "1.2.840.113583.1.1.5": true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], options.passphrase, {
    algorithm: "3des",
    friendlyName: options.commonName,
  });
  const p12 = Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), "binary");
  const certificateDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), "binary");
  const digest = forge.md.sha256.create();
  digest.update(certificateDer.toString("binary"));

  return {
    p12,
    certificateDer,
    fingerprintSha256: digest.digest().toHex().toUpperCase().match(/.{2}/g)!.join(":"),
    validTo: cert.validity.notAfter,
  };
}

/** One field of a certificate's subject, such as "CN", as text. */
export function subjectField(cert: forge.pki.Certificate, name: string): string | undefined {
  const field: unknown = cert.subject.getField(name);
  return typeof field === "object" && field !== null && "value" in field && typeof field.value === "string"
    ? field.value
    : undefined;
}
