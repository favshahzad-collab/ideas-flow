import { describe, expect, it } from "vitest";
import { sha256, verifyChecksum } from "./checksum";

/**
 * The digest is what a dispute about a signed memo comes down to, so the two
 * things worth pinning are that it is the standard SHA-256 anybody can compute
 * with any tool, and that "nothing was recorded" never reads as "checked out".
 */

describe("sha256", () => {
  it("is the SHA-256 any other tool would produce", () => {
    // `printf 'abc' | sha256sum`. Written out rather than computed here, so
    // this test would catch the digest quietly changing algorithm.
    expect(sha256(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("is lowercase hex, 64 characters, whatever went in", () => {
    expect(sha256(Buffer.from([0x00, 0xff]))).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(Buffer.alloc(0))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a single byte does", () => {
    const pdf = Buffer.from("%PDF-1.7 approved memo");
    const tampered = Buffer.from("%PDF-1.7 approved memo!");

    expect(sha256(pdf)).not.toBe(sha256(tampered));
  });
});

describe("verifyChecksum", () => {
  const bytes = Buffer.from("the signed memo");

  it("verifies bytes that match what was written down", () => {
    expect(verifyChecksum(bytes, sha256(bytes))).toBe("verified");
  });

  it("reports a mismatch when the file has changed underneath the row", () => {
    expect(verifyChecksum(Buffer.from("something else"), sha256(bytes))).toBe(
      "mismatch"
    );
  });

  it.each([[null], [undefined], [""], ["   "]])(
    "says unrecorded, not verified, for %p",
    (recorded) => {
      // A memo approved before digests existed. Nothing was recorded, so
      // nothing is proven - and the caller has to be able to tell that apart
      // from a file that checked out.
      expect(verifyChecksum(bytes, recorded)).toBe("unrecorded");
    }
  );

  it("ignores the case and the padding of the recorded value", () => {
    expect(verifyChecksum(bytes, `  ${sha256(bytes).toUpperCase()}  `)).toBe(
      "verified"
    );
  });
});
