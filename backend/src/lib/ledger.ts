import { sha256 } from "./checksum";

/**
 * The audit trail, made tamper-evident.
 *
 * Append-only is a property of the API: there is no endpoint that updates or
 * deletes an audit record. It is not a property of the data. Anyone who can
 * reach the database can edit a row to move an approval onto somebody else's
 * name, or delete the rejection that came before it, and nothing in the
 * application would notice - the trail would simply read as though it had
 * always said that.
 *
 * A hash chain closes that. Each record is sealed with a digest taken over its
 * own content *and the digest of the record before it*, so changing one record
 * invalidates every record after it. There is no key to steal and no signature
 * to forge; that is also the limit of the claim, and it is worth stating
 * plainly: someone who can write to the table can recompute the whole chain
 * from the row they altered onwards. What they cannot do is change one row and
 * leave the rest alone, which is what tampering in an approval system actually
 * looks like - and if the tip digest has been written down anywhere outside
 * this database, they cannot hide a recomputation either.
 *
 * Everything here is pure. The rows come from `ledger.service.ts`.
 */

/**
 * What sits before the first record. Sixty-four zeroes is not a hash of
 * anything - it is a value no SHA-256 will ever collide with in practice, and
 * it means "nothing came before this", which is a different statement from a
 * missing link.
 */
export const GENESIS_HASH = "0".repeat(64);

/** A record as it comes out of the database, before or after sealing. */
export type AuditRecordContent = {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  oldValue: unknown;
  newValue: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
};

export type SealedPosition = {
  seq: bigint;
  prevHash: string;
  hash: string;
};

export type SealedRecord = AuditRecordContent & SealedPosition;

/**
 * The same data must produce the same bytes today and in five years, on any
 * machine, whatever order Postgres chose to store a `jsonb` object's keys in -
 * so keys are sorted, recursively, and the digest is taken over the result.
 *
 * The rest of the row goes in as JSON rather than joined with a separator for
 * a duller reason: without quoting, an actor called "ab" acting on "c" and one
 * called "a" acting on "bc" hash identically, and an audit chain that can be
 * made to agree about the wrong actor is not a chain.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeys(source[key]);
    }

    return sorted;
  }

  return value;
}

/**
 * The exact bytes a record's digest is taken over.
 *
 * Exported, and stable on purpose: an auditor who wants to check this without
 * running our code needs to know what was hashed, and "whatever the service
 * happened to serialise" is not an answer. The field order below is part of
 * the format - do not reorder it, and do not add a field to it, without
 * accepting that every existing digest becomes wrong.
 */
export function auditRecordPayload(
  record: AuditRecordContent,
  seq: bigint,
  prevHash: string
): string {
  return JSON.stringify({
    v: 1,
    seq: seq.toString(),
    prevHash,
    id: record.id,
    actorId: record.actorId,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId,
    oldValue: sortKeys(record.oldValue ?? null),
    newValue: sortKeys(record.newValue ?? null),
    ipAddress: record.ipAddress,
    userAgent: record.userAgent,
    createdAt: record.createdAt.toISOString(),
  });
}

export function hashAuditRecord(
  record: AuditRecordContent,
  seq: bigint,
  prevHash: string
): string {
  return sha256(Buffer.from(auditRecordPayload(record, seq, prevHash), "utf8"));
}

/** Where the chain currently ends. Null when nothing has been sealed yet. */
export type ChainTip = { seq: bigint; hash: string } | null;

/**
 * Give a batch of unsealed records their positions.
 *
 * Pure, so the whole of the interesting arithmetic - the first record starting
 * from genesis, each digest feeding the next - can be tested without a
 * database, and so the service is left with nothing but reading and writing.
 */
export function chainFrom<T extends AuditRecordContent>(
  tip: ChainTip,
  records: readonly T[]
): (T & SealedPosition)[] {
  let seq = (tip?.seq ?? 0n) + 1n;
  let prevHash = tip?.hash ?? GENESIS_HASH;

  return records.map((record) => {
    const hash = hashAuditRecord(record, seq, prevHash);
    const sealed = { ...record, seq, prevHash, hash };

    seq += 1n;
    prevHash = hash;

    return sealed;
  });
}

/**
 * The three ways a chain can be wrong, kept apart because they mean different
 * things to whoever has to act on the answer.
 *
 * `missing` - a position exists in the sequence with no record at it. Records
 *   are numbered contiguously as they are sealed, so a gap is a deletion.
 * `link` - the record does not point at the record before it. Something was
 *   inserted, removed or reordered around it.
 * `content` - the record is where it should be and points where it should,
 *   but its digest no longer matches what it says. The row was edited.
 */
export type LedgerBreakKind = "missing" | "link" | "content";

export type LedgerBreak = {
  kind: LedgerBreakKind;
  seq: string;
  recordId: string | null;
  detail: string;
};

/**
 * Check one record against the position it claims and the record before it.
 * Returns null when it is intact.
 */
export function checkRecord(
  record: SealedRecord,
  expectedSeq: bigint,
  expectedPrevHash: string
): LedgerBreak | null {
  if (record.seq !== expectedSeq) {
    return {
      kind: "missing",
      seq: expectedSeq.toString(),
      recordId: null,
      detail: `No record at position ${expectedSeq.toString()}; the next one held is ${record.seq.toString()}.`,
    };
  }

  if (record.prevHash !== expectedPrevHash) {
    return {
      kind: "link",
      seq: record.seq.toString(),
      recordId: record.id,
      detail:
        "This record does not follow the one before it: it was sealed after a different record, or something between them is gone.",
    };
  }

  if (record.hash !== hashAuditRecord(record, record.seq, record.prevHash)) {
    return {
      kind: "content",
      seq: record.seq.toString(),
      recordId: record.id,
      detail:
        "This record has been changed since it was sealed - its contents no longer match its own digest.",
    };
  }

  return null;
}
