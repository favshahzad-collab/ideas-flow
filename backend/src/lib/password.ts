import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import type { ScryptOptions } from "node:crypto";

const scrypt = (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (error, derived) =>
      error ? reject(error) : resolve(derived),
    );
  });

/**
 * Password hashing built on Node's own scrypt — a memory-hard KDF, so no
 * native module to compile and nothing to install.
 *
 * Stored format: `scrypt$<N>$<saltHex>$<hashHex>`. The cost parameter is part
 * of the record, so it can be raised later without invalidating old hashes.
 *
 * That promise used to be empty. The cost was written into the record and
 * then ignored in both directions: hashing and checking both used Node's
 * default, which only happened to equal the value written down. Raising
 * `COST` would have produced records claiming the new cost but hashed at the
 * old one, and nobody would have noticed until the default changed under
 * them - at which point every password in the database stops matching. Both
 * sides now use the number in the record.
 */
const KEYLEN = 64;
const SALT_BYTES = 16;
const COST = 16384; // 2^14
const BLOCK_SIZE = 8;
const PARALLELISM = 1;

/** Headroom for a raised cost: scrypt needs 128 * N * r bytes and refuses past maxmem. */
const optionsFor = (cost: number): ScryptOptions => ({
  N: cost,
  r: BLOCK_SIZE,
  p: PARALLELISM,
  maxmem: 256 * cost * BLOCK_SIZE,
});

/** The costs this code will agree to run, so a record cannot ask for a ruinous one. */
const MIN_COST = 1024;
const MAX_COST = 1 << 20;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEYLEN, optionsFor(COST));
  return `scrypt$${COST}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string | null | undefined
): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;

  const [, costText, saltHex, hashHex] = parts;
  if (!saltHex || !hashHex) return false;

  const cost = Number(costText);
  // A power of two in range, or the record is not one this code wrote.
  if (
    !Number.isInteger(cost) ||
    cost < MIN_COST ||
    cost > MAX_COST ||
    (cost & (cost - 1)) !== 0
  ) {
    return false;
  }

  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  const derived = await scrypt(
    password,
    Buffer.from(saltHex, "hex"),
    expected.length,
    optionsFor(cost),
  );

  // Constant-time: never leak how much of the hash matched.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * The same work as checking a real password, against nothing.
 *
 * Sign-in answers "incorrect email or password" either way, but an unknown
 * address used to return at once while a real one paid for scrypt - so the
 * time the answer took said which addresses have accounts. Calling this when
 * there is no account, or no password on it, spends the same time and always
 * says no.
 */
let decoy: Promise<string> | null = null;

export async function verifyAgainstNothing(password: string): Promise<false> {
  decoy ??= hashPassword(randomBytes(18).toString("base64"));
  await verifyPassword(password, await decoy);
  return false;
}
