import { createHash } from "node:crypto";

/**
 * Digests over the files the system calls the record.
 *
 * A signed memo is evidence. What makes it evidence is not that the service
 * promises never to overwrite it - code changes - but that the bytes can be
 * checked against something written down when they were produced. That is all
 * this is: SHA-256, hex, taken once at the moment a file is written and stored
 * beside the row that points at it.
 *
 * It answers "are these the bytes that were signed?" It does not answer "who
 * signed them" - the signature block on the page and the approval row do that -
 * and it is not a secret, so nothing here is constant-time.
 */
export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Three answers, not two.
 *
 * `unrecorded` is the memo approved before digests existed: nothing was
 * written down, so nothing can be checked, and saying "verified" about it
 * would be the one lie this module must not tell. It is not `mismatch`
 * either - there is no evidence of tampering, only no evidence at all.
 */
export type IntegrityVerdict = "verified" | "unrecorded" | "mismatch";

export function verifyChecksum(
  data: Buffer,
  recorded: string | null | undefined
): IntegrityVerdict {
  const expected = recorded?.trim().toLowerCase();

  if (!expected) {
    return "unrecorded";
  }

  return sha256(data) === expected ? "verified" : "mismatch";
}
