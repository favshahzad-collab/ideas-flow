import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The six digits from an authenticator app.
 *
 * RFC 6238 on top of RFC 4226, written out rather than pulled in. That is a
 * deliberate choice and worth defending: this is not cryptography being
 * designed, it is an HMAC over a counter and a decimal truncation, both fully
 * specified, and both published with test vectors that this module is checked
 * against in `totp.test.ts`. A dependency here would be a few hundred lines of
 * other people's code, a supply chain, and a version to keep, in return for
 * about sixty lines that the RFC's own vectors prove.
 *
 * SHA-1, six digits, thirty-second steps. Every one of those is the weak
 * choice on paper and the only interoperable one in practice: it is what
 * Microsoft Authenticator, Google Authenticator, 1Password and Authy read out
 * of a QR code, and an algorithm nobody's phone can compute protects nothing.
 * SHA-1 is broken for collisions, which is not what HMAC-SHA-1 rests on.
 */

/** RFC 4648 §6. No 0/1/8/9, so nothing is mistaken for O, I, B or g. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 6238 §4. Everybody's phone assumes it; none of them ask. */
export const STEP_SECONDS = 30;

/** 160 bits, matching the RFC 4226 recommendation and SHA-1's output width. */
const SECRET_BYTES = 20;

/**
 * How far out of step a phone may be.
 *
 * One step either side, so a code is good for at most ninety seconds. Phones
 * drift, and somebody reading six digits across a desk takes a few seconds
 * doing it. Wider than this starts to matter: every extra step is another
 * code an attacker's guess could land on, and the reason to bound it is that
 * the guess space is only a million to begin with.
 */
const WINDOW_STEPS = 1;

export const DIGITS = 6;

/**
 * RFC 4226 §5.3: HMAC the counter, then pull four bytes from an offset the
 * digest itself chooses, and take that modulo a power of ten.
 *
 * The counter is a BigInt because it is a 64-bit field, and the last of the
 * RFC's own test vectors is a time in the year 2603 whose step number does not
 * fit in the 32 bits a JavaScript bitwise operation would give it.
 */
export function hotp(key: Buffer, counter: bigint, digits = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);

  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;

  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Which thirty-second step a moment falls in. */
export function stepAt(atMs: number): number {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

/** Unpadded, because that is what an `otpauth:` URI carries. */
export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31];
  }

  return out;
}

/**
 * Tolerant on the way in: padding, spaces and lower case are all accepted,
 * because people retype these off a screen and an authenticator app shows the
 * secret in groups of four. Anything outside the alphabet is a refusal rather
 * than a silent skip - a typo should not decode to a different key.
 */
export function base32Decode(input: string): Buffer | null {
  const clean = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();

  if (clean.length === 0) {
    return null;
  }

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const character of clean) {
    const index = ALPHABET.indexOf(character);

    if (index === -1) {
      return null;
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/**
 * Compared digit by digit in constant time.
 *
 * Six digits is a small enough space that a timing signal is worth denying
 * even though the practical attack is remote - and `===` on a short string is
 * not obviously cheaper to write than this.
 */
function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The step number this code belongs to, or null if it belongs to none.
 *
 * The step is the return value rather than a boolean on purpose: the caller
 * has to write it down. A correct code stays correct for up to ninety seconds,
 * so anybody who reads one over somebody's shoulder - or off a phishing page -
 * can use it again within the window unless the step it came from is refused
 * afterwards. Storing the step is what makes a code single-use.
 */
export function verifyCode(
  secret: string,
  code: string,
  options: { atMs?: number; afterStep?: number | null } = {}
): number | null {
  const key = base32Decode(secret);
  const digits = code.replace(/\s/g, "");

  if (!key || key.length === 0 || !/^[0-9]{6}$/.test(digits)) {
    return null;
  }

  const current = stepAt(options.atMs ?? Date.now());

  for (let offset = -WINDOW_STEPS; offset <= WINDOW_STEPS; offset += 1) {
    const step = current + offset;

    // Before the window opens: a step at or below the last one accepted is a
    // code that has already been spent.
    if (step < 0 || (options.afterStep != null && step <= options.afterStep)) {
      continue;
    }

    if (sameCode(hotp(key, BigInt(step)), digits)) {
      return step;
    }
  }

  return null;
}

/**
 * What goes in the QR code.
 *
 * The label is `issuer:account` and the issuer is repeated as a parameter -
 * redundant, and both halves are read by different apps. `algorithm`,
 * `digits` and `period` are spelled out even though every value is the
 * default, because an app that guesses differently produces codes that are
 * wrong in a way nobody can debug from the outside.
 */
export function otpauthUri(options: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = `${encodeURIComponent(options.issuer)}:${encodeURIComponent(
    options.account
  )}`;

  const params = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });

  return `otpauth://totp/${label}?${params.toString()}`;
}
