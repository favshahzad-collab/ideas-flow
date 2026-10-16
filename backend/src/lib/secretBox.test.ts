import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The box the SMTP password sits in once mail is configured from the
 * administration screens rather than the server's environment.
 *
 * Most of what matters here is the failure: what happens when the key is not
 * the one the value was written with. That is not a hypothetical - it is what
 * every deployment sees the day it rotates `JWT_SECRET` - and the difference
 * between "re-enter the password" and a stack trace is whether this returns
 * null or throws.
 *
 * Every test loads the module itself rather than importing it at the top of
 * the file. `env` reads the environment once, at import, so a module imported
 * here would be keyed to whatever secret the test runner happened to start
 * with, and setting `process.env.JWT_SECRET` afterwards would change nothing.
 * A first draft of this file did exactly that: the rotation test passed
 * because the two keys differed by accident, and the restart test failed for
 * the same reason. Loading the module per secret is what makes either of them
 * mean what it says.
 */

const ORIGINAL = process.env.JWT_SECRET;

const SECRET = "a-secret-long-enough-to-look-like-a-real-one";
const OTHER = "a-completely-different-secret-of-adequate-length";

/** The module as a process booted with this secret would have it. */
const boxWith = async (secret: string) => {
  process.env.JWT_SECRET = secret;
  vi.resetModules();
  return import("./secretBox.js");
};

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = ORIGINAL;
  }
});

describe("keeping a small secret in the database", () => {
  it("gives back exactly what it was given", async () => {
    const box = await boxWith(SECRET);
    expect(box.decryptSecret(box.encryptSecret("hunter2"))).toBe("hunter2");
  });

  it("survives the characters a generated password actually contains", async () => {
    // A relay password out of a password manager is not [a-z]. Anything
    // mangled here surfaces as an authentication failure against the mail
    // server, which reads like a network problem.
    const box = await boxWith(SECRET);
    const awkward = "p@ss:w/rd+=?&#\\\"'`|£€ 你好\n\ttrailing ";
    expect(box.decryptSecret(box.encryptSecret(awkward))).toBe(awkward);
  });

  it("never writes the plaintext into the stored value", async () => {
    const box = await boxWith(SECRET);
    const stored = box.encryptSecret("hunter2");
    expect(stored).not.toContain("hunter2");
    expect(Buffer.from(stored).includes("hunter2")).toBe(false);
  });

  it("writes a different value every time, for the same password", async () => {
    // Equal ciphertexts would tell anybody reading the table that two rows
    // share a password without their having to break either.
    const box = await boxWith(SECRET);
    expect(box.encryptSecret("hunter2")).not.toBe(box.encryptSecret("hunter2"));
  });

  it("reads back a value written before an ordinary restart", async () => {
    // The key is derived, not generated, so the same secret in a new process
    // has to arrive at the same key - otherwise every release would silently
    // lose the mail password.
    const before = await boxWith(SECRET);
    const stored = before.encryptSecret("hunter2");

    const afterRestart = await boxWith(SECRET);
    expect(afterRestart.decryptSecret(stored)).toBe("hunter2");
  });

  it("cannot be read once JWT_SECRET is rotated", async () => {
    const before = await boxWith(SECRET);
    const stored = before.encryptSecret("hunter2");

    const afterRotation = await boxWith(OTHER);
    expect(afterRotation.decryptSecret(stored)).toBeNull();
  });

  it("refuses a value that has been edited in the database", async () => {
    // Authenticated encryption, so this is a rejection rather than rubbish
    // being handed to a mail server as a password.
    const box = await boxWith(SECRET);
    const parts = box.encryptSecret("hunter2").split(".");
    const flipped = Buffer.from(parts[3], "base64url");
    flipped[0] ^= 0xff;
    parts[3] = flipped.toString("base64url");

    expect(box.decryptSecret(parts.join("."))).toBeNull();
  });

  it("refuses anything that is not one of these values at all", async () => {
    const box = await boxWith(SECRET);
    for (const nonsense of ["", "hunter2", "gcm1.only.three", "a.b.c.d"]) {
      expect(box.decryptSecret(nonsense)).toBeNull();
    }
  });
});
