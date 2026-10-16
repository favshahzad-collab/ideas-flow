/**
 * Make the self-made certificate approved memos are sealed with.
 *
 *   SEAL_P12_PASSWORD='<a long passphrase>' npm run seal:create-certificate -- <folder>
 *
 * Writes two files into <folder>:
 *
 *   ideas-flow-seal.p12   the certificate AND its private key. Secret: keep it
 *                         on the server only, readable by the service account,
 *                         and back it up. Point SEAL_P12_PATH at it.
 *   ideas-flow-seal.cer   the public certificate only. Safe to share: install
 *                         it as trusted on PCs that should show the seal as
 *                         valid in Adobe Reader.
 *
 * The passphrase is read from SEAL_P12_PASSWORD, never from the command line,
 * so it does not land in shell history, and it is never printed. Refuses to
 * overwrite an existing .p12: replacing the certificate is a decision, not an
 * accident, and memos already sealed stay verifiable with the old one.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createSelfSignedSeal } from "../src/lib/sealCertificate";

const folder = process.argv[2];
const passphrase = process.env.SEAL_P12_PASSWORD ?? "";

if (!folder) {
  console.error("Say where to write it: npm run seal:create-certificate -- <folder>");
  process.exit(1);
}
if (passphrase.length < 16) {
  console.error("Set SEAL_P12_PASSWORD to a passphrase of at least 16 characters first.");
  process.exit(1);
}

const p12Path = path.resolve(folder, "ideas-flow-seal.p12");
const cerPath = path.resolve(folder, "ideas-flow-seal.cer");
if (existsSync(p12Path)) {
  console.error(`${p12Path} already exists. Move it aside first if you really mean to replace it.`);
  process.exit(1);
}

mkdirSync(path.dirname(p12Path), { recursive: true });
console.log("Generating a 3072-bit key...");
const seal = createSelfSignedSeal({
  commonName: process.env.SEAL_COMMON_NAME ?? "Ideas Flow document seal",
  organization: process.env.SEAL_ORGANIZATION ?? "IDEAS (Pvt.) Ltd.",
  passphrase,
});
writeFileSync(p12Path, seal.p12, { mode: 0o600 });
writeFileSync(cerPath, seal.certificateDer);

console.log(`Certificate and key: ${p12Path}  (secret - server only)`);
console.log(`Public certificate:  ${cerPath}  (share it to trust the seal on PCs)`);
console.log(`Valid until:         ${seal.validTo.toISOString().slice(0, 10)}`);
console.log(`SHA-256 fingerprint: ${seal.fingerprintSha256}`);
console.log("Next: set SEAL_P12_PATH to the .p12 path and SEAL_P12_PASSWORD to the passphrase, then restart.");
