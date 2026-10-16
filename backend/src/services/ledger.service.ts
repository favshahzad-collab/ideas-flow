import { prisma } from "../prisma";
import { Prisma } from "../generated/prisma/client";
import {
  chainFrom,
  checkRecord,
  GENESIS_HASH,
  type ChainTip,
  type LedgerBreak,
  type SealedRecord,
} from "../lib/ledger";

/**
 * Sealing the audit trail, and checking the seal.
 *
 * Two jobs, deliberately apart. Sealing is a sweep - cheap, frequent, and
 * never inside the transaction that wrote the record, because the chain has to
 * be built one record at a time and an approval must not queue behind somebody
 * else's audit write to get committed. Checking walks the whole chain and is
 * therefore something a person asks for, not something that runs on a timer.
 *
 * The gap between a record being written and being sealed is the honest limit
 * of this: a record removed inside that window leaves nothing behind. It is
 * one sweep wide - thirty seconds by default - and it is the newest records,
 * not the historical trail, which is what a hash chain is for.
 */

/** How many unsealed records one pass takes. */
const SEAL_BATCH = 500;
/** How many passes one call will make before leaving the rest to the next. */
const MAX_PASSES = 40;
/** How many sealed records are pulled into memory at a time when verifying. */
const VERIFY_BATCH = 500;

/**
 * The advisory lock every sealer takes. Arbitrary, fixed, and shared by every
 * process against this database - two sealers running at once would race for
 * the same positions, and the unique index on `seq` would turn that race into
 * an error rather than a corrupted chain. This turns it into a wait instead.
 */
const SEAL_LOCK_KEY = 8_417_223_004n;

const RECORD_SHAPE = {
  id: true,
  actorId: true,
  action: true,
  entityType: true,
  entityId: true,
  oldValue: true,
  newValue: true,
  ipAddress: true,
  userAgent: true,
  createdAt: true,
} as const;

export type LedgerSummary = {
  /** Records that have a position in the chain. */
  sealed: number;
  /** Records written but not sealed yet. Normally zero or a handful. */
  unsealed: number;
  /** Where the chain currently ends. */
  tip: { seq: string; hash: string; sealedAt: Date | null } | null;
  /** How many times the end of the chain has been witnessed. */
  witnesses: number;
};

export type LedgerReport = LedgerSummary & {
  /** Records read back and recomputed. */
  checked: number;
  intact: boolean;
  break: LedgerBreak | null;
  checkedAt: Date;
  durationMs: number;
};

class LedgerService {
  /**
   * Give every unsealed record a position, oldest first.
   *
   * Order is by `created_at`, then `id` to break a tie - so the chain runs in
   * the order things happened, as closely as a timestamp can say it. A record
   * from a long transaction can commit after records that started later and
   * will then be sealed after them; the chain's order is the order rows became
   * visible, which is the only order any reader could have seen them in.
   */
  async seal(now: Date = new Date()): Promise<{ sealed: number }> {
    let sealed = 0;

    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const count = await this.sealBatch(now);
      sealed += count;

      if (count < SEAL_BATCH) break;
    }

    return { sealed };
  }

  private async sealBatch(now: Date): Promise<number> {
    return prisma.$transaction(async (tx) => {
      // Held for the rest of this transaction, which is why the transaction
      // does nothing but seal: no file work, no mail, no approval.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEAL_LOCK_KEY})`;

      const tipRow = await tx.auditLog.findFirst({
        where: { seq: { not: null } },
        orderBy: { seq: "desc" },
        select: { seq: true, hash: true },
      });

      const tip: ChainTip =
        tipRow?.seq != null && tipRow.hash
          ? { seq: tipRow.seq, hash: tipRow.hash }
          : null;

      const pending = await tx.auditLog.findMany({
        where: { seq: null },
        /*
         * `seq` leads the sort only so the planner can walk the index that
         * starts with it; every row here has the same (null) value for it.
         * `writeSeq` is what actually decides the order.
         *
         * It used to be `createdAt` then `id`, and both were wrong for rows
         * written in one transaction: `created_at` defaults to now(), which
         * is the TRANSACTION's start time, so they tie exactly - leaving the
         * chain's order to be settled by comparing two random uuids. A hash
         * chain exists to fix the order of history; fixing it by lottery
         * whenever two things happened in one breath is not that.
         */
        orderBy: [{ seq: "asc" }, { writeSeq: "asc" }],
        take: SEAL_BATCH,
        select: RECORD_SHAPE,
      });

      if (pending.length === 0) return 0;

      const chained = chainFrom(tip, pending);

      const values = chained.map(
        (record) =>
          Prisma.sql`(${record.id}::uuid, ${record.seq}::bigint, ${record.hash}, ${record.prevHash})`
      );

      // One statement rather than five hundred round trips, all inside the
      // lock, so the window where the chain is half-written is as short as it
      // can be made.
      await tx.$executeRaw`
        UPDATE audit_logs AS a
        SET seq = v.seq, hash = v.hash, prev_hash = v.prev_hash, sealed_at = ${now}
        FROM (VALUES ${Prisma.join(values)}) AS v(id, seq, hash, prev_hash)
        WHERE a.id = v.id`;

      const last = chained[chained.length - 1];

      // The witness. Written in the same transaction as the seal it attests
      // to, so there is no state in which the chain has moved on and nothing
      // recorded that it did.
      await tx.ledgerCheckpoint.create({
        data: { seq: last.seq, hash: last.hash, sealedAt: now },
      });

      return chained.length;
    });
  }

  async summary(): Promise<LedgerSummary> {
    const [sealed, unsealed, tipRow, witnesses] = await Promise.all([
      prisma.auditLog.count({ where: { seq: { not: null } } }),
      prisma.auditLog.count({ where: { seq: null } }),
      prisma.auditLog.findFirst({
        where: { seq: { not: null } },
        orderBy: { seq: "desc" },
        select: { seq: true, hash: true, sealedAt: true },
      }),
      prisma.ledgerCheckpoint.count(),
    ]);

    return {
      sealed,
      unsealed,
      tip:
        tipRow?.seq != null && tipRow.hash
          ? {
              seq: tipRow.seq.toString(),
              hash: tipRow.hash,
              sealedAt: tipRow.sealedAt,
            }
          : null,
      witnesses,
    };
  }

  /**
   * Read every sealed record back and recompute it.
   *
   * Stops at the first break and says where it is. There is no value in
   * listing the rest: after a break every later record fails too, and a page
   * of ten thousand failures says nothing the first one did not.
   */
  async verify(): Promise<LedgerReport> {
    const startedAt = Date.now();
    const summary = await this.summary();

    let expectedSeq = 1n;
    let expectedPrevHash = GENESIS_HASH;
    let checked = 0;
    let found: LedgerBreak | null = null;

    walk: for (;;) {
      const batch = await prisma.auditLog.findMany({
        where: { seq: { gte: expectedSeq } },
        orderBy: { seq: "asc" },
        take: VERIFY_BATCH,
        select: { ...RECORD_SHAPE, seq: true, hash: true, prevHash: true },
      });

      if (batch.length === 0) break;

      for (const row of batch) {
        const record = {
          ...row,
          seq: row.seq!,
          hash: row.hash ?? "",
          prevHash: row.prevHash ?? "",
        } satisfies SealedRecord;

        found = checkRecord(record, expectedSeq, expectedPrevHash);
        if (found) break walk;

        checked += 1;
        expectedSeq = record.seq + 1n;
        expectedPrevHash = record.hash;
      }
    }

    // Only worth asking once the chain itself reads clean: if it is already
    // broken at position 40, a witness disagreeing at 900 is the same damage
    // reported twice.
    const truncation = found
      ? null
      : await this.checkWitnesses(summary.tip ? BigInt(summary.tip.seq) : null);

    const breakFound = found ?? truncation;

    return {
      ...summary,
      checked,
      intact: breakFound === null,
      break: breakFound,
      checkedAt: new Date(),
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Compare the chain against what was witnessed while it was being built.
   *
   * This is what catches the trail being cut short. Removing the last few
   * records leaves a shorter chain that verifies perfectly against itself -
   * the witnesses are the only thing that remembers they were ever there.
   */
  private async checkWitnesses(tipSeq: bigint | null): Promise<LedgerBreak | null> {
    let after = 0n;

    for (;;) {
      const witnesses = await prisma.ledgerCheckpoint.findMany({
        where: { seq: { gt: after } },
        orderBy: { seq: "asc" },
        take: VERIFY_BATCH,
        select: { seq: true, hash: true, sealedAt: true },
      });

      if (witnesses.length === 0) return null;

      const records = await prisma.auditLog.findMany({
        where: { seq: { in: witnesses.map((witness) => witness.seq) } },
        select: { seq: true, hash: true },
      });

      const bySeq = new Map(
        records.map((record) => [record.seq!.toString(), record.hash])
      );

      for (const witness of witnesses) {
        const hash = bySeq.get(witness.seq.toString());

        if (!hash || (tipSeq !== null && witness.seq > tipSeq)) {
          return {
            kind: "missing",
            seq: witness.seq.toString(),
            recordId: null,
            detail: `The trail has been cut short: position ${witness.seq.toString()} was sealed on ${witness.sealedAt.toISOString()} and is no longer there.`,
          };
        }

        if (hash !== witness.hash) {
          return {
            kind: "content",
            seq: witness.seq.toString(),
            recordId: null,
            detail: `The record at position ${witness.seq.toString()} no longer matches the digest witnessed when it was sealed, so the chain has been rebuilt from somewhere at or before it.`,
          };
        }
      }

      after = witnesses[witnesses.length - 1].seq;
    }
  }

  /**
   * The whole sealed chain, for an auditor to check without this application.
   *
   * JSON Lines: a header, then one sealed record per line in chain order,
   * carrying exactly the fields its digest is taken over (`auditRecordPayload`
   * in lib/ledger) plus its position, the digest before it and its own.
   * `scripts/verify-ledger-export.mjs` recomputes every digest and link from
   * the file alone, with nothing but Node; DEPLOY.md describes the format for
   * anybody who would rather write their own.
   *
   * The checkpoints ride in the header: they are what show the chain was not
   * cut short, which no amount of internal consistency can.
   *
   * Written a page at a time, so a large ledger is never held in memory.
   */
  async exportChain(write: (line: string) => void): Promise<{ records: number }> {
    const checkpoints = await prisma.ledgerCheckpoint.findMany({
      orderBy: { seq: "asc" },
      select: { seq: true, hash: true, sealedAt: true },
    });

    write(
      JSON.stringify({
        format: "ideas-flow-ledger",
        version: 1,
        exportedAt: new Date().toISOString(),
        genesisHash: GENESIS_HASH,
        digest: "sha256 of auditRecordPayload v1 (see DEPLOY.md, 'Checking the ledger outside the application')",
        checkpoints: checkpoints.map((checkpoint) => ({
          seq: checkpoint.seq.toString(),
          hash: checkpoint.hash,
          sealedAt: checkpoint.sealedAt.toISOString(),
        })),
      })
    );

    let records = 0;
    let after = 0n;

    for (;;) {
      const batch = await prisma.auditLog.findMany({
        where: { seq: { gt: after } },
        orderBy: { seq: "asc" },
        take: VERIFY_BATCH,
        select: { ...RECORD_SHAPE, seq: true, hash: true, prevHash: true, sealedAt: true },
      });

      if (batch.length === 0) break;

      for (const row of batch) {
        write(
          JSON.stringify({
            seq: row.seq!.toString(),
            prevHash: row.prevHash,
            hash: row.hash,
            sealedAt: row.sealedAt?.toISOString() ?? null,
            record: {
              id: row.id,
              actorId: row.actorId,
              action: row.action,
              entityType: row.entityType,
              entityId: row.entityId,
              oldValue: row.oldValue ?? null,
              newValue: row.newValue ?? null,
              ipAddress: row.ipAddress,
              userAgent: row.userAgent,
              createdAt: row.createdAt.toISOString(),
            },
          })
        );
        records += 1;
      }

      after = batch[batch.length - 1].seq!;
    }

    return { records };
  }
}

export const ledgerService = new LedgerService();
