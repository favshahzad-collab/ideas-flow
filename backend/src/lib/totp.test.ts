import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateSecret,
  hotp,
  otpauthUri,
  stepAt,
  verifyCode,
} from "./totp";

/**
 * Checked against the standards' own published vectors, which is the whole
 * argument for writing this rather than installing it.
 *
 * The numbers below are not ones I produced and then asserted - that would
 * only prove the code agrees with itself, which is exactly the failure mode of
 * a hand-written implementation of a published algorithm. They are copied from
 * RFC 4226 Appendix D, RFC 6238 Appendix B and RFC 4648 section 10. If this
 * file passes, somebody's phone will produce the same digits this server does.
 */

/** The seed every one of the OTP RFCs uses: ASCII "12345678901234567890". */
const SEED = Buffer.from("12345678901234567890", "ascii");

describe("HOTP, against RFC 4226 appendix D", () => {
  // Counter 0 through 9 with the standard seed, six digits.
  const VECTORS = [
    "755224",
    "287082",
    "359152",
    "969429",
    "338314",
    "254676",
    "287922",
    "162583",
    "399871",
    "520489",
  ];

  it.each(VECTORS.map((code, counter) => ({ counter, code })))(
    "counter $counter gives $code",
    ({ counter, code }) => {
      expect(hotp(SEED, BigInt(counter))).toBe(code);
    }
  );

  it("keeps the leading zero", () => {
    // 359152 has none, but 07081804 below does, and a number formatted with
    // `String(n)` loses it. Six digits that arrive as five are rejected by
    // every phone, and the bug only shows up about one time in ten.
    expect(hotp(SEED, 37037036n, 8)).toBe("07081804");
  });
});

describe("TOTP, against RFC 6238 appendix B", () => {
  /*
   * Eight digits, because that is what the RFC tabulates. The product uses
   * six; the digit count is a formatting step applied after the algorithm, so
   * these vectors exercise everything that could be wrong.
   */
  const VECTORS: Array<[seconds: number, code: string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    // Year 2603. Its step number needs more than the 32 bits a JavaScript
    // bitwise operator would truncate it to, which is why the counter is a
    // BigInt rather than a number.
    [20000000000, "65353130"],
  ];

  it.each(VECTORS)("at t=%i the code is %s", (seconds, code) => {
    expect(hotp(SEED, BigInt(stepAt(seconds * 1000)), 8)).toBe(code);
  });
});

describe("base32, against RFC 4648 section 10", () => {
  // The RFC's vectors are padded; an `otpauth:` secret is not, so the trailing
  // "=" is stripped from each.
  const VECTORS: Array<[plain: string, encoded: string]> = [
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ];

  it.each(VECTORS)("encodes %s as %s", (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain, "ascii"))).toBe(encoded);
  });

  it.each(VECTORS)("decodes %2$s back to %1$s", (plain, encoded) => {
    expect(base32Decode(encoded)?.toString("ascii")).toBe(plain);
  });

  it("accepts what somebody retypes off a screen", () => {
    // Authenticator apps show the secret lower case in groups of four, and
    // padding survives a copy from almost anywhere.
    expect(base32Decode("mzxw 6ytb-oi======")?.toString("ascii")).toBe("foobar");
  });

  it("refuses a character outside the alphabet rather than skipping it", () => {
    // 0, 1 and 8 are absent from base32 precisely because they are misread as
    // O, I and B. Dropping one would decode a typo into a different key, and
    // the person would be told their correct code was wrong forever after.
    expect(base32Decode("MZXW0YTB")).toBeNull();
    expect(base32Decode("")).toBeNull();
  });
});

describe("a generated secret", () => {
  it("is 160 bits, and different every time", () => {
    const first = generateSecret();

    expect(base32Decode(first)).toHaveLength(20);
    expect(first).not.toBe(generateSecret());
  });

  it("survives the round trip a phone puts it through", () => {
    const secret = generateSecret();
    const key = base32Decode(secret)!;

    // What the app does: read the base32 out of the URI, decode it, and HMAC.
    // If encode and decode disagree anywhere, this is where it shows.
    expect(verifyCode(secret, hotp(key, BigInt(stepAt(Date.now()))))).not.toBeNull();
  });
});

describe("verifying a code", () => {
  const secret = base32Encode(SEED);
  const at = (step: number) => step * 30 * 1000;
  const codeFor = (step: number) => hotp(SEED, BigInt(step));

  it("accepts the code for right now", () => {
    expect(verifyCode(secret, codeFor(1000), { atMs: at(1000) })).toBe(1000);
  });

  it("accepts one step either side, for a phone with a slow clock", () => {
    expect(verifyCode(secret, codeFor(999), { atMs: at(1000) })).toBe(999);
    expect(verifyCode(secret, codeFor(1001), { atMs: at(1000) })).toBe(1001);
  });

  it("refuses two steps out", () => {
    // The bound that matters: every accepted step is another code a guess
    // could land on, and the space is only a million wide to begin with.
    expect(verifyCode(secret, codeFor(998), { atMs: at(1000) })).toBeNull();
    expect(verifyCode(secret, codeFor(1002), { atMs: at(1000) })).toBeNull();
  });

  it("refuses a code that has already been used", () => {
    /*
     * The reason the step is the return value rather than a boolean. A code
     * stays valid for up to ninety seconds, so one read over a shoulder - or
     * typed into a page pretending to be this one - is replayable inside the
     * window unless the step it came from is refused afterwards.
     */
    expect(
      verifyCode(secret, codeFor(1000), { atMs: at(1000), afterStep: 1000 })
    ).toBeNull();
  });

  it("refuses a step before the last one accepted, not only the same one", () => {
    // A phone one step slow, replayed after a newer code went through.
    expect(
      verifyCode(secret, codeFor(999), { atMs: at(1000), afterStep: 1000 })
    ).toBeNull();
  });

  it("still accepts the next step after one is spent", () => {
    expect(
      verifyCode(secret, codeFor(1001), { atMs: at(1000), afterStep: 1000 })
    ).toBe(1001);
  });

  it("ignores the spaces an app puts in the middle", () => {
    const spaced = codeFor(1000).replace(/^(\d{3})/, "$1 ");

    expect(verifyCode(secret, spaced, { atMs: at(1000) })).toBe(1000);
  });

  it("refuses anything that is not six digits", () => {
    for (const nonsense of ["", "12345", "1234567", "abcdef", "12 34"]) {
      expect(verifyCode(secret, nonsense, { atMs: at(1000) })).toBeNull();
    }
  });

  it("refuses rather than throwing when the stored secret is rubbish", () => {
    // Reachable by way of a `JWT_SECRET` rotation: the stored secret decrypts
    // to nothing readable. A throw here would be a 500 on the sign-in screen.
    expect(verifyCode("not base32!", codeFor(1000), { atMs: at(1000) })).toBeNull();
    expect(verifyCode("", codeFor(1000), { atMs: at(1000) })).toBeNull();
  });
});

describe("the QR code's contents", () => {
  const uri = otpauthUri({
    secret: "MZXW6YTBOI",
    account: "shahzad.ali@ideas.com.pk",
    issuer: "IdeasFlow",
  });

  it("names the algorithm, digits and period rather than leaving them assumed", () => {
    // Every value is the default. Spelled out anyway: an app that assumes a
    // different one produces codes that are wrong with nothing to debug from.
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });

  it("labels the entry so it is findable among the others", () => {
    expect(uri).toContain("IdeasFlow:shahzad.ali%40ideas.com.pk");
    expect(uri).toContain("issuer=IdeasFlow");
  });

  it("is a URI a scanner will parse", () => {
    const parsed = new URL(uri);

    expect(parsed.protocol).toBe("otpauth:");
    expect(parsed.searchParams.get("secret")).toBe("MZXW6YTBOI");
  });
});
