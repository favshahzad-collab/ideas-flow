import { randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyAgainstNothing, verifyPassword } from "./password";

describe("hashPassword", () => {
  it("produces the documented record format", async () => {
    const stored = await hashPassword("correct horse battery staple");
    const [scheme, cost, salt, hash] = stored.split("$");

    expect(scheme).toBe("scrypt");
    expect(Number(cost)).toBe(16384);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toMatch(/^[0-9a-f]{128}$/);
  });

  it("salts, so the same password never hashes to the same record", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");

    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });
});

describe("verifyPassword", () => {
  it("accepts the right password and rejects a wrong one", async () => {
    const stored = await hashPassword("s3cret-passphrase");

    expect(await verifyPassword("s3cret-passphrase", stored)).toBe(true);
    expect(await verifyPassword("s3cret-passphras", stored)).toBe(false);
    expect(await verifyPassword("S3cret-passphrase", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  /**
   * `login` calls this with `user?.passwordHash` — undefined when the address
   * is unknown — so that an unknown address costs the same as a wrong
   * password. If this threw, the two cases would be trivially distinguishable.
   */
  it("returns false for a missing stored hash instead of throwing", async () => {
    expect(await verifyPassword("anything", undefined)).toBe(false);
    expect(await verifyPassword("anything", null)).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
  });

  it("returns false for records it cannot parse", async () => {
    const malformed = [
      "not-a-record",
      "bcrypt$16384$aabb$ccdd",
      "scrypt$16384$aabb",
      "scrypt$16384$$ccdd",
      "scrypt$16384$aabb$",
    ];

    for (const stored of malformed) {
      expect(await verifyPassword("anything", stored)).toBe(false);
    }
  });

  it("checks against the cost written in the record, not a default", async () => {
    // A record hashed at a cost other than Node's default. Checking used to
    // ignore the number in the record, so this matched nothing - which is
    // what every password would do the day the cost was raised.
    const salt = randomBytes(16);
    const derived = scryptSync("raised-cost-phrase", salt, 64, { N: 2048, r: 8, p: 1 });
    const stored = `scrypt$2048$${salt.toString("hex")}$${derived.toString("hex")}`;

    expect(await verifyPassword("raised-cost-phrase", stored)).toBe(true);
    expect(await verifyPassword("another-phrase", stored)).toBe(false);
  });

  it("refuses a record asking for a cost it would not have written", async () => {
    // Not a power of two, far too small, or large enough to exhaust memory.
    for (const cost of ["3000", "16", String(1 << 24), "abc"]) {
      expect(await verifyPassword("anything", `scrypt$${cost}$aabb$ccdd`)).toBe(false);
    }
  });
});

describe("verifyAgainstNothing", () => {
  it("always says no, whatever it is given", async () => {
    expect(await verifyAgainstNothing("anything")).toBe(false);
    expect(await verifyAgainstNothing("")).toBe(false);
  });
});
