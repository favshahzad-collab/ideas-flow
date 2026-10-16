import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { linesOf } from "../test/pdfText";
import {
  appendSignatureCertificate,
  CERTIFICATE_TITLE,
  formatCertificateTime,
  isTimeZone,
  type CertificateData,
  type CertificateSigner,
} from "./signatureCertificate";

/** A memo with nothing drawn on it, so every line read back is the certificate's. */
async function blankMemo(pages = 2): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) pdf.addPage([595, 842]);
  return Buffer.from(await pdf.save());
}

const pageCount = async (pdf: Buffer) => (await PDFDocument.load(pdf)).getPageCount();
const text = (pdf: Buffer) => linesOf(pdf).join("\n");

const at = (iso: string) => new Date(iso);

const preparer: CertificateSigner = {
  name: "Aamir Raza",
  designation: "Senior Manager",
  role: "Preparer",
  signedAt: at("2026-10-01T05:00:00.000Z"),
  ipAddress: "10.0.0.7",
  method: "DRAWN",
  identityConfirmedAt: at("2026-10-01T04:59:30.000Z"),
  agreedToStatement: true,
};

const data = (overrides: Partial<CertificateData> = {}): CertificateData => ({
  title: "Annual Increment Approval",
  referenceNumber: "MEMO-2026-0012",
  documentId: "e57ded1f-9e21-4ea5-88e7-5206ac97c40e",
  versionNumber: 2,
  submittedAt: at("2026-10-01T05:00:00.000Z"),
  submittedChecksum: "ab".repeat(32),
  approvedAt: at("2026-10-01T09:15:00.000Z"),
  timeZone: "Asia/Karachi",
  signers: [
    preparer,
    {
      name: "Areeb Khan",
      designation: "POWER BI",
      role: "Reviewer",
      signedAt: at("2026-10-01T07:30:00.000Z"),
      ipAddress: "10.0.0.9",
      method: "SAVED_SIGNATURE",
      identityConfirmedAt: at("2026-10-01T07:29:10.000Z"),
      identityConfirmedBy: "PASSWORD",
      agreedToStatement: true,
    },
    {
      name: "Adnan Mumtaz",
      designation: "Deputy Manager",
      role: "Approver",
      signedAt: at("2026-10-01T08:00:00.000Z"),
      ipAddress: null,
      method: null,
      identityConfirmedAt: null,
      agreedToStatement: false,
      onBehalfOf: "Moiz Somrow",
    },
  ],
  ...overrides,
});

describe("the signature certificate page", () => {
  it("is added after the memo's own pages, which are left as they were", async () => {
    const memo = await blankMemo(2);
    const certified = await appendSignatureCertificate(memo, data());

    expect(await pageCount(certified)).toBe(3);
    expect(linesOf(memo)).toEqual([]);
  });

  it("names the memo, its version and the fingerprint it was submitted with", async () => {
    const page = text(await appendSignatureCertificate(await blankMemo(), data()));

    expect(page).toContain(CERTIFICATE_TITLE);
    expect(page).toContain("Subject: Annual Increment Approval");
    expect(page).toContain("Reference: MEMO-2026-0012");
    expect(page).toContain("Document ID: e57ded1f-9e21-4ea5-88e7-5206ac97c40e");
    expect(page).toContain("Version: 2");
    expect(page.replace(/\n/g, "")).toContain("ab".repeat(32));
  });

  it("lists every signer in order, with their role, time, address and how they proved it was them", async () => {
    const lines = linesOf(await appendSignatureCertificate(await blankMemo(), data()));
    const joined = lines.join("\n");

    expect(lines.indexOf("1. Aamir Raza")).toBeLessThan(lines.indexOf("2. Areeb Khan"));
    expect(lines.indexOf("2. Areeb Khan")).toBeLessThan(lines.indexOf("3. Adnan Mumtaz"));
    expect(joined).toContain("POWER BI · Reviewer");
    expect(joined).toContain("IP address: 10.0.0.9");
    expect(joined).toContain("Signature: Saved signature");
    expect(joined).toContain("Signature: Drawn at signing");
    expect(joined).toContain("Identity confirmed: Password, 01 Oct 2026, 12:29:10 (Asia/Karachi) · 07:29:10 UTC");
    expect(joined).toContain("Signed: 01 Oct 2026, 12:30:00 (Asia/Karachi) · 07:30:00 UTC");
    expect(joined).toContain("Agreed that this is their signature: Yes");
  });

  it("says how each signer proved it was them, and never guesses where that was not kept", async () => {
    /*
     * It used to print "Password or authenticator code" for everybody, so a
     * signer who confirmed with a fresh Microsoft sign-in was certified as
     * having typed a password they may not even have.
     */
    const page = async (identityConfirmedBy: CertificateSigner["identityConfirmedBy"]) =>
      linesOf(
        await appendSignatureCertificate(
          await blankMemo(),
          data({ signers: [{ ...preparer, identityConfirmedBy }] })
        )
      ).join("\n");

    expect(await page("MICROSOFT")).toContain("Identity confirmed: Microsoft sign-in, entered again, 01 Oct 2026");
    expect(await page("AUTHENTICATOR")).toContain("Identity confirmed: Authenticator app code, 01 Oct 2026");
    expect(await page("PASSWORD")).toContain("Identity confirmed: Password, 01 Oct 2026");

    const older = await page(null);
    expect(older).toContain("(method not recorded)");
    expect(older).not.toMatch(/Password|Authenticator|Microsoft/);
  });

  it("says who a delegate signed for, and what was not recorded for an older signature", async () => {
    const joined = text(await appendSignatureCertificate(await blankMemo(), data()));

    expect(joined).toContain("Signed for: Moiz Somrow");
    expect(joined).toContain("IP address: Not recorded");
    expect(joined).toContain("Signature: Not recorded");
    expect(joined).toContain("Identity confirmed: Not recorded (signed before this check was introduced)");
  });

  it("lists a step that was passed over, with who passed it and why", async () => {
    const joined = text(
      await appendSignatureCertificate(
        await blankMemo(),
        data({
          skipped: [
            {
              role: "Approver",
              assignee: "Moiz Somrow",
              skippedBy: "Aamir Raza",
              at: at("2026-10-01T08:30:00.000Z"),
              reason: "On leave",
            },
          ],
        })
      )
    );

    expect(joined).toContain("Steps passed over");
    expect(joined.replace(/\n/g, " ")).toContain("Approver (Moiz Somrow): skipped by Aamir Raza");
    expect(joined.replace(/\n/g, " ")).toContain("Reason: On leave");
  });

  it("runs onto a second page rather than off the bottom of the first", async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ ...preparer, name: `Signer ${i + 1}` }));
    const certified = await appendSignatureCertificate(await blankMemo(1), data({ signers: many }));

    expect(await pageCount(certified)).toBeGreaterThanOrEqual(3);
    const joined = text(certified);
    expect(joined).toContain("14. Signer 14");
    expect(joined).toContain(`${CERTIFICATE_TITLE} (continued, page 2)`);
  });

  it("keeps a name Helvetica cannot spell, rather than refusing to approve", async () => {
    const certified = await appendSignatureCertificate(
      await blankMemo(),
      data({ signers: [{ ...preparer, name: "Zoë Ahmed 李" }] })
    );
    expect(text(certified)).toContain("1. Zoë Ahmed ?");
  });

  it("prints on the memo's own paper size", async () => {
    const letter = await PDFDocument.create();
    letter.addPage([612, 792]);
    const certified = await PDFDocument.load(
      await appendSignatureCertificate(Buffer.from(await letter.save()), data())
    );
    expect(certified.getPages().at(-1)!.getSize()).toEqual({ width: 612, height: 792 });
  });
});

describe("times on the certificate", () => {
  it("shows the local time with UTC beside it, so it is never ambiguous", () => {
    expect(formatCertificateTime(at("2026-10-01T19:05:09.000Z"), "Asia/Karachi")).toBe(
      "02 Oct 2026, 00:05:09 (Asia/Karachi) · 19:05:09 UTC"
    );
  });

  it("does not repeat itself in UTC", () => {
    expect(formatCertificateTime(at("2026-10-01T19:05:09.000Z"), "UTC")).toBe("01 Oct 2026, 19:05:09 UTC");
  });

  it("knows a real zone from a typo", () => {
    expect(isTimeZone("Asia/Karachi")).toBe(true);
    expect(isTimeZone("Asia/Karachii")).toBe(false);
  });
});

describe("the month on the certificate", () => {
  it("is spelled the same whatever the runtime's locale data says", () => {
    // Some ICU versions say "Sept"; the rest of the app, and every memo
    // approved before, says "Sep".
    expect(formatCertificateTime(new Date("2026-09-24T06:10:00.000Z"), "Asia/Karachi")).toBe(
      "24 Sep 2026, 11:10:00 (Asia/Karachi) · 06:10:00 UTC"
    );
  });

  it("reads midnight as 00, not 24", () => {
    expect(formatCertificateTime(new Date("2026-10-01T19:00:00.000Z"), "Asia/Karachi")).toBe(
      "02 Oct 2026, 00:00:00 (Asia/Karachi) · 19:00:00 UTC"
    );
  });
});

describe("the seal, mentioned on the certificate", () => {
  it("says the file carries the seal when it will", async () => {
    const joined = text(await appendSignatureCertificate(await blankMemo(), data({ sealedBy: "Ideas Flow document seal" })));
    expect(joined.replace(/\n/g, " ")).toContain("This file carries the digital seal of Ideas Flow document seal.");
  });

  it("says nothing of a seal when there is none", async () => {
    expect(text(await appendSignatureCertificate(await blankMemo(), data()))).not.toContain("digital seal");
  });
});
