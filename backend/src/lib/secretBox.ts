import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { env } from "./env";

/**
 * Small secrets that have to live in the database, kept unreadable there.
 *
 * The SMTP password is the first of them. Putting mail configuration in the
 * administration screens is what an administrator expects and asked for, and
 * the cost is real: a credential that used to sit in a root-only file on the
 * server now sits in a table, inside every backup of that table, and in front
 * of anybody who can read the database. That is a worse place for it, so it
 * does not go in as plaintext.
 *
 * The key is derived from `JWT_SECRET` rather than stored anywhere. It follows
 * that the database on its own is not enough to recover the password - an
 * attacker needs the environment too - and equally that **rotating
 * `JWT_SECRET` makes the stored password unreadable**. That is the intended
 * trade and the reason `decryptSecret` reports a failure the administration
 * screen can explain ("re-enter the password") rather than throwing something
 * that reads like corruption.
 *
 * AES-256-GCM: authenticated, so a value edited in the database is rejected
 * rather than silently decrypted into rubbish.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const FORMAT = "gcm1";

/*
 * A fixed salt, which is normally a mistake and is not one here. Its job in a
 * password hash is to make two equal passwords hash differently; here there is
 * exactly one key, derived once per process from a secret that is already high
 * entropy. A random salt would have to be stored beside the ciphertext and
 * would buy nothing.
 */
const KEY_SALT = "daws.secretBox.v1";

let cachedKey: Buffer | null = null;
let cachedFrom = "";

function key(): Buffer {
  if (!cachedKey || cachedFrom !== env.JWT_SECRET) {
    cachedKey = scryptSync(env.JWT_SECRET, KEY_SALT, KEY_LENGTH);
    cachedFrom = env.JWT_SECRET;
  }

  return cachedKey;
}

/** `gcm1.<iv>.<authTag>.<ciphertext>`, all base64url. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return [
    FORMAT,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * The plaintext, or null if it cannot be read.
 *
 * Null is a real answer here, not an error: the ordinary way to reach it is a
 * rotated `JWT_SECRET`, and what the operator needs then is to be told to type
 * the password in again. Callers must not treat null as "there is no
 * password" - `mailSettings` reports it as a stored password that cannot be
 * read, which is a different thing from not having one.
 */
export function decryptSecret(stored: string): string | null {
  const parts = stored.split(".");

  if (parts.length !== 4 || parts[0] !== FORMAT) {
    return null;
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key(),
      Buffer.from(parts[1], "base64url")
    );
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));

    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // A wrong key fails the GCM tag check, which throws. So does a truncated
    // or edited value. Neither is recoverable and both mean the same thing to
    // the caller.
    return null;
  }
}
