import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SIGNING_CONSENT_STATEMENT,
  signatureMethod,
  signedRecord,
} from "./signingAttestation";

describe("the statement a signer agrees to", () => {
  it("is the sentence the signing screens show, word for word", () => {
    // The server stores its own copy with every signature; the screens show
    // theirs beside the tick box. If the two drift, somebody reads one
    // sentence and has another filed against their name.
    const screen = readFileSync(
      path.resolve(__dirname, "../../../frontend/src/components/SigningConsent.tsx"),
      "utf8"
    ).replace(/\s+/g, " ");

    expect(screen).toContain(`'${SIGNING_CONSENT_STATEMENT}'`);
  });
});

describe("the DOCUMENT_SIGNED record", () => {
  const base = {
    capacity: "APPROVER" as const,
    versionNumber: 2,
    stepOrder: 2,
    method: "SAVED_SIGNATURE" as const,
    signaturePage: 1,
    signedPdfChecksum: "a".repeat(64),
  };

  it("names how the mark was made", () => {
    expect(signatureMethod({ useSavedSignature: true })).toBe("SAVED_SIGNATURE");
    expect(signatureMethod({ useSavedSignature: false })).toBe("DRAWN");
    expect(signatureMethod({})).toBe("DRAWN");
  });

  it("carries the confirmation and the statement when the route proved them", () => {
    const at = new Date("2026-10-01T09:30:00.000Z");
    expect(signedRecord({ ...base, attestation: { identityConfirmedAt: at, consented: true } })).toEqual({
      status: "SIGNED",
      capacity: "APPROVER",
      versionNumber: 2,
      stepOrder: 2,
      method: "SAVED_SIGNATURE",
      signaturePage: 1,
      signedPdfChecksum: "a".repeat(64),
      signatureImageChecksum: null,
      onBehalfOfId: null,
      identityConfirmedAt: "2026-10-01T09:30:00.000Z",
      // How they confirmed it, where the confirmation said; null otherwise.
      identityConfirmedBy: null,
      consentStatement: SIGNING_CONSENT_STATEMENT,
    });
  });

  it("records how the signer confirmed it was them", () => {
    const at = new Date("2026-10-01T09:30:00.000Z");
    expect(
      signedRecord({
        ...base,
        attestation: { identityConfirmedAt: at, identityConfirmedBy: "MICROSOFT", consented: true },
      })
    ).toMatchObject({ identityConfirmedBy: "MICROSOFT" });
  });

  it("claims neither when nothing proved them", () => {
    // A seed or a script signing inside the process: the record says no
    // confirmation and no agreement, rather than asserting checks that never ran.
    expect(signedRecord(base)).toMatchObject({ identityConfirmedAt: null, consentStatement: null });
  });
});
