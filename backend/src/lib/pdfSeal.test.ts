import { PDFDocument } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { certificateName, sealPdf, type SealIdentity } from "./pdfSeal";
import { verifySeal } from "./pdfSealVerify";
import { createSelfSignedSeal } from "./sealCertificate";

const PASSPHRASE = "a passphrase only this test knows";
const details = { reason: "Approved in Ideas Flow", location: "Karachi", contactInfo: "hr@example.com" };

let identity: SealIdentity;
let memo: Buffer;

beforeAll(async () => {
  // 2048 bits to keep the suite quick; the real certificate is 3072.
  const seal = createSelfSignedSeal({
    commonName: "Ideas Flow document seal",
    organization: "IDEAS (Pvt.) Ltd.",
    passphrase: PASSPHRASE,
    bits: 2048,
  });
  identity = { p12: seal.p12, passphrase: PASSPHRASE, signerName: certificateName(seal.p12, PASSPHRASE) };

  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]).drawText("Annual Increment Approval", { x: 72, y: 760, size: 14 });
  pdf.addPage([595, 842]);
  memo = Buffer.from(await pdf.save());
}, 60_000);

describe("the self-made seal certificate", () => {
  it("names the organisation's seal", () => {
    expect(identity.signerName).toBe("Ideas Flow document seal");
  });

  it("will not open with the wrong passphrase", () => {
    expect(() => certificateName(identity.p12, "not it")).toThrow();
  });
});

describe("sealing an approved memo", () => {
  it("produces a file whose seal checks out, signed by the certificate, at the time given", async () => {
    const at = new Date("2026-10-01T09:15:00.000Z");
    const sealed = await sealPdf(memo, identity, details, at);
    const check = verifySeal(sealed);

    expect(check).toMatchObject({ sealed: true, intact: true, signerName: "Ideas Flow document seal", coversWholeFile: true });
    expect(check.sealed && check.signedAt?.toISOString()).toBe(at.toISOString());
  });

  it("keeps every page of the memo", async () => {
    const sealed = await sealPdf(memo, identity, details, new Date());
    expect((await PDFDocument.load(sealed)).getPageCount()).toBe(2);
  });

  it("tells a reader what the seal is for", async () => {
    const sealed = (await sealPdf(memo, identity, details, new Date())).toString("latin1");
    expect(sealed).toContain("/SubFilter /adbe.pkcs7.detached");
    expect(sealed).toContain("Approved in Ideas Flow");
  });

  it("shows as broken once a single byte of the memo is changed", async () => {
    const sealed = await sealPdf(memo, identity, details, new Date());
    const tampered = Buffer.from(sealed);
    // A byte in the middle of the first signed range - inside the memo's own
    // content, which pdf-lib stores compressed, so it is found by position.
    const [, length] = /\/ByteRange\s*\[\s*0\s+(\d+)/.exec(sealed.toString("latin1"))!;
    const at = Math.floor(Number(length) / 2);
    tampered[at] = tampered[at] === 0x41 ? 0x42 : 0x41;

    expect(verifySeal(tampered)).toMatchObject({ sealed: true, intact: false });
  });

  it("does not cover bytes added after sealing", async () => {
    // An incremental update appended later is outside the signed range; the
    // check says so rather than calling the longer file sealed end to end.
    const sealed = await sealPdf(memo, identity, details, new Date());
    const appended = Buffer.concat([sealed, Buffer.from("\n% appended later\n")]);
    expect(verifySeal(appended)).toMatchObject({ sealed: true, coversWholeFile: false });
  });

  it("reports an unsealed file as unsealed", () => {
    expect(verifySeal(memo)).toEqual({ sealed: false });
  });
});
