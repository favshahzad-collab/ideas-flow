import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  signature,
  submitDocument,
  tamperWithLedger,
  useCleanDatabase,
} from "../test/db";
import { approvalService } from "./approval.service";
import { auditService } from "./audit.service";
import { ledgerService } from "./ledger.service";
import { GENESIS_HASH, hashAuditRecord } from "../lib/ledger";
import type { AuditAction, Prisma } from "../generated/prisma/client";

/**
 * The seal on the audit trail, against a real database.
 *
 * The unit suite proves the arithmetic. This proves the part that only a
 * database can be wrong about: that positions are handed out once and once
 * only, that sealing twice does not reseal, and - the whole point - that every
 * way of quietly editing the trail from outside the application is caught and
 * named. Each of the tampering tests reaches past the service and writes SQL
 * directly, because that is exactly the threat: somebody with a database
 * prompt and a reason to want the record to say something else.
 *
 * Since the append-only triggers, the database refuses those writes - see
 * "the database itself" below. So the tampering tests switch the triggers off
 * first (`tamperWithLedger`), which is what the table's owner can still do,
 * and which is the case the hash chain is for.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;

/*
 * A clock for the written records, so no two of them share a timestamp.
 *
 * `seal()` orders what is pending by (created_at, id). The id is there only to
 * break a tie - two rows must never contend for one position - and it is a
 * random uuid, so when a tie happens the order records are sealed in stops
 * matching the order they were written in. Written as fast as a test writes
 * them, several rows land inside the same timestamp easily.
 *
 * That made every assertion below of the form "the second record I wrote is at
 * position 2" a coin toss. It came up heads on this machine for weeks and
 * tails on the first CI runner, which is faster: `written[1]` was sealed at
 * position 1, so editing it broke the link at 2 rather than at 3.
 *
 * Records a second apart is what production looks like anyway - separate
 * requests write these - so the suite is made deterministic here by being made
 * realistic, rather than by asserting less.
 */
const WRITE_EPOCH = Date.UTC(2026, 0, 1, 9, 0, 0);
let writeClock = 0;

beforeEach(async () => {
  cast = await makeCast();
  writeClock = 0;
});

/** An audit record, written the way the services write them. */
async function writeRecord(
  action: AuditAction = "DOCUMENT_CREATED",
  newValue: Prisma.InputJsonObject = { note: "one" }
) {
  return auditService.createAuditLog({
    actorId: cast.preparer.id,
    action,
    entityType: "Document",
    entityId: cast.preparer.id,
    newValue,
    ipAddress: "10.0.0.4",
  });
}

async function writeRecords(count: number) {
  const written = [];
  // Written with their timestamps rather than given them afterwards: the
  // table refuses an UPDATE to anything but the seal columns. Spread in time,
  // and increasing across calls within one test: `carries on from where the
  // last sweep stopped` writes a second batch after sealing the first, and
  // that batch must not land before it in the ordering. Otherwise exactly
  // what `auditService.createAuditLog` writes.
  for (let index = 0; index < count; index += 1) {
    written.push(
      await prisma.auditLog.create({
        data: {
          actorId: cast.preparer.id,
          action: "DOCUMENT_CREATED",
          entityType: "Document",
          entityId: cast.preparer.id,
          newValue: { note: `entry ${index}` },
          ipAddress: "10.0.0.4",
          createdAt: new Date(WRITE_EPOCH + (writeClock += 1) * 1000),
        },
      })
    );
  }

  // Refetched, in the order the seal will read them, so `written[n]` and
  // position n + 1 are the same record by construction rather than by luck.
  return prisma.auditLog.findMany({
    where: { id: { in: written.map((record) => record.id) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

const positions = () =>
  prisma.auditLog.findMany({
    where: { seq: { not: null } },
    orderBy: { seq: "asc" },
    select: { id: true, seq: true, hash: true, prevHash: true, sealedAt: true },
  });

describe("sealing", () => {
  it("gives the first record position one, after nothing", async () => {
    const [record] = await writeRecords(1);

    await ledgerService.seal();

    const sealed = await prisma.auditLog.findUniqueOrThrow({ where: { id: record.id } });
    expect(sealed.seq).toBe(1n);
    expect(sealed.prevHash).toBe(GENESIS_HASH);
    expect(sealed.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.sealedAt).toBeInstanceOf(Date);
  });

  it("numbers records in the order they were written", async () => {
    const written = await writeRecords(3);

    await ledgerService.seal();

    const chain = await positions();
    expect(chain.map(row => row.id)).toEqual(written.map(row => row.id));
    expect(chain.map(row => row.seq)).toEqual([1n, 2n, 3n]);

    // The records went in at distinct times, which is what makes the line
    // above a statement about ordering rather than about uuid luck. If this
    // ever fails, every position assertion in this file is a coin toss again.
    const stamps = written.map(row => row.createdAt.getTime());
    expect(new Set(stamps).size).toBe(stamps.length);
    expect([...stamps]).toEqual([...stamps].sort((a, b) => a - b));
  });

  it("ties each record to the one before it", async () => {
    await writeRecords(3);
    await ledgerService.seal();

    const chain = await positions();
    expect(chain[1].prevHash).toBe(chain[0].hash);
    expect(chain[2].prevHash).toBe(chain[1].hash);
  });

  it("carries on from where the last sweep stopped", async () => {
    await writeRecords(2);
    await ledgerService.seal();

    const [third] = await writeRecords(1);
    await ledgerService.seal();

    const sealed = await prisma.auditLog.findUniqueOrThrow({ where: { id: third.id } });
    const chain = await positions();
    expect(sealed.seq).toBe(3n);
    expect(sealed.prevHash).toBe(chain[1].hash);
  });

  it("does not touch a record it has already sealed", async () => {
    await writeRecords(2);
    await ledgerService.seal();
    const before = await positions();

    const again = await ledgerService.seal();

    expect(again.sealed).toBe(0);
    expect(await positions()).toEqual(before);
  });

  it("does nothing at all when the trail is empty", async () => {
    expect(await ledgerService.seal()).toEqual({ sealed: 0 });
    expect(await prisma.ledgerCheckpoint.count()).toBe(0);
  });

  it("witnesses where it got to, once per sweep", async () => {
    await writeRecords(2);
    await ledgerService.seal();
    await writeRecords(1);
    await ledgerService.seal();

    const witnesses = await prisma.ledgerCheckpoint.findMany({ orderBy: { seq: "asc" } });
    const chain = await positions();

    expect(witnesses.map(w => w.seq)).toEqual([2n, 3n]);
    expect(witnesses[1].hash).toBe(chain[2].hash);
  });

  it("refuses to put two records in the same position", async () => {
    // The database's job, not the service's: the unique index is the last
    // thing standing between a race and a chain that forks.
    await writeRecords(2);
    await ledgerService.seal();
    const chain = await positions();

    // With the append-only guard off, so that it is the index being tested
    // here and not the guard, which would refuse this first.
    await expect(
      tamperWithLedger(() =>
        prisma.auditLog.update({ where: { id: chain[1].id }, data: { seq: 1n } })
      )
    ).rejects.toThrow(/Unique constraint/);
  });

  it("seals what two sweeps started at the same moment exactly once", async () => {
    await writeRecords(20);

    // The advisory lock is what makes this a wait rather than a race; without
    // it both sweeps read the same tip and try to claim the same positions.
    await Promise.all([ledgerService.seal(), ledgerService.seal()]);

    const chain = await positions();
    expect(chain).toHaveLength(20);
    expect(chain.map(row => row.seq)).toEqual(
      Array.from({ length: 20 }, (_, index) => BigInt(index + 1))
    );
    expect((await ledgerService.verify()).intact).toBe(true);
  });
});

describe("what the summary says", () => {
  it("counts what is sealed apart from what is not", async () => {
    await writeRecords(2);
    await ledgerService.seal();
    await writeRecords(3);

    const summary = await ledgerService.summary();

    expect(summary.sealed).toBe(2);
    expect(summary.unsealed).toBe(3);
  });

  it("names where the chain ends", async () => {
    await writeRecords(2);
    await ledgerService.seal();

    const summary = await ledgerService.summary();
    const chain = await positions();

    expect(summary.tip).toMatchObject({ seq: "2", hash: chain[1].hash });
    expect(summary.witnesses).toBe(1);
  });

  it("says the chain has not started rather than inventing a tip", async () => {
    await writeRecords(1);

    const summary = await ledgerService.summary();

    expect(summary.tip).toBeNull();
    expect(summary.sealed).toBe(0);
    expect(summary.unsealed).toBe(1);
  });
});

describe("verifying an untouched trail", () => {
  it("reads clean", async () => {
    await writeRecords(5);
    await ledgerService.seal();

    const report = await ledgerService.verify();

    expect(report.intact).toBe(true);
    expect(report.break).toBeNull();
    expect(report.checked).toBe(5);
    expect(report.sealed).toBe(5);
  });

  it("reads clean with nothing in it, rather than claiming a break", async () => {
    const report = await ledgerService.verify();

    expect(report.intact).toBe(true);
    expect(report.checked).toBe(0);
  });

  it("reports records not sealed yet without calling them broken", async () => {
    await writeRecords(2);
    await ledgerService.seal();
    await writeRecords(1);

    const report = await ledgerService.verify();

    expect(report.intact).toBe(true);
    expect(report.checked).toBe(2);
    expect(report.unsealed).toBe(1);
  });

  it("reads clean across a trail sealed in more than one sweep", async () => {
    for (let sweep = 0; sweep < 3; sweep += 1) {
      await writeRecords(2);
      await ledgerService.seal();
    }

    expect(await ledgerService.verify()).toMatchObject({ intact: true, checked: 6 });
  });

  it("covers what a real approval wrote", async () => {
    const { id } = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.approver),
    });
    const { useSavedSignature: _s, ...placement } = signature();
    await approvalService.approve(id, cast.reviewer.id, {
      ...placement,
      useSavedSignature: false,
    });

    await ledgerService.seal();
    const report = await ledgerService.verify();

    expect(report.intact).toBe(true);
    // Not an assertion about the exact number of records an approval writes -
    // that changes. Only that the ones it wrote are in the chain.
    expect(report.checked).toBe(report.sealed);
    expect(report.sealed).toBeGreaterThan(0);
  });
});

describe("catching a trail that was edited", () => {
  it("names the record whose contents were changed", async () => {
    const written = await writeRecords(3);
    await ledgerService.seal();

    // Somebody moves an action onto a different person's name.
    await tamperWithLedger(() => prisma.$executeRaw`
      UPDATE audit_logs SET actor_id = ${cast.approver.id}::uuid WHERE id = ${written[1].id}::uuid`);

    const report = await ledgerService.verify();

    expect(report.intact).toBe(false);
    expect(report.break).toMatchObject({ kind: "content", seq: "2", recordId: written[1].id });
    expect(report.checked).toBe(1);
  });

  it("catches a changed timestamp, not only a changed actor", async () => {
    const written = await writeRecords(2);
    await ledgerService.seal();

    await tamperWithLedger(() => prisma.$executeRaw`
      UPDATE audit_logs SET created_at = created_at - interval '3 days' WHERE id = ${written[0].id}::uuid`);

    expect((await ledgerService.verify()).break).toMatchObject({ kind: "content", seq: "1" });
  });

  it("catches a change buried inside the JSON a record carries", async () => {
    const written = await writeRecords(2);
    await ledgerService.seal();

    await tamperWithLedger(() => prisma.$executeRaw`
      UPDATE audit_logs SET new_value = '{"note":"something else"}'::jsonb WHERE id = ${written[1].id}::uuid`);

    expect((await ledgerService.verify()).break).toMatchObject({ kind: "content", seq: "2" });
  });

  it("does not cry tamper when Postgres hands the JSON back in another key order", async () => {
    // jsonb does not preserve key order. If that reached the digest, every
    // record with an object in it would fail verification for no reason, and
    // the whole thing would be noise.
    await writeRecord("DOCUMENT_UPDATED", { zebra: 1, apple: { yak: 1, ant: 2 } });
    await ledgerService.seal();

    expect((await ledgerService.verify()).intact).toBe(true);
  });
});

describe("catching a trail that was cut", () => {
  it("names the position a deleted record used to hold", async () => {
    const written = await writeRecords(4);
    await ledgerService.seal();

    await tamperWithLedger(() => prisma.auditLog.delete({ where: { id: written[1].id } }));

    const report = await ledgerService.verify();

    expect(report.break).toMatchObject({ kind: "missing", seq: "2" });
    expect(report.break?.detail).toContain("the next one held is 3");
  });

  it("catches records removed from the end, which the chain alone cannot see", async () => {
    // A shorter chain verifies perfectly against itself. The witness taken
    // when those records were sealed is the only thing that remembers them.
    const written = await writeRecords(3);
    await ledgerService.seal();

    await tamperWithLedger(() => prisma.auditLog.delete({ where: { id: written[2].id } }));

    const report = await ledgerService.verify();

    expect(report.intact).toBe(false);
    expect(report.break).toMatchObject({ kind: "missing", seq: "3" });
    expect(report.break?.detail).toContain("cut short");
  });

  it("catches the whole trail being emptied", async () => {
    await writeRecords(3);
    await ledgerService.seal();

    await tamperWithLedger(() => prisma.$executeRaw`DELETE FROM audit_logs`);

    expect((await ledgerService.verify()).intact).toBe(false);
  });

  it("catches a record inserted between two that were already sealed", async () => {
    const written = await writeRecords(3);
    await ledgerService.seal();
    const chain = await positions();

    // Rewriting position 2 onto a record of somebody's choosing: the digest at
    // 2 no longer follows 1, whatever else was done to it.
    await tamperWithLedger(() => prisma.$executeRaw`
      UPDATE audit_logs SET prev_hash = ${"f".repeat(64)} WHERE id = ${written[1].id}::uuid`);

    const report = await ledgerService.verify();

    expect(report.break).toMatchObject({ kind: "link", seq: "2", recordId: written[1].id });
    expect(chain).toHaveLength(3);
  });
});

describe("catching a trail that was rebuilt to look untouched", () => {
  it("catches an edited record whose own digest was recomputed", async () => {
    // The obvious next move once you know the digest is stored beside the row:
    // change the row, take the digest again, put it back. The record now reads
    // clean on its own - and the record after it no longer follows it.
    const written = await writeRecords(3);
    await ledgerService.seal();

    const target = await prisma.auditLog.findUniqueOrThrow({ where: { id: written[1].id } });
    const edited = { ...target, actorId: cast.approver.id, oldValue: null, newValue: target.newValue };
    const rehashed = hashAuditRecord(edited, target.seq!, target.prevHash!);

    await tamperWithLedger(() => prisma.$executeRaw`
      UPDATE audit_logs SET actor_id = ${cast.approver.id}::uuid, hash = ${rehashed}
      WHERE id = ${written[1].id}::uuid`);

    const report = await ledgerService.verify();

    expect(report.break).toMatchObject({ kind: "link", seq: "3" });
  });

  it("catches a chain rebuilt end to end, because the witnesses were not", async () => {
    // The thorough version: edit a record, recompute its digest, and relink
    // every record after it so the chain agrees with itself again. Nothing in
    // the chain can tell. What can is the digest written down separately at
    // the moment the batch was sealed.
    const written = await writeRecords(2);
    await ledgerService.seal();

    const rows = await prisma.auditLog.findMany({
      where: { seq: { not: null } },
      orderBy: { seq: "asc" },
    });

    let prevHash = GENESIS_HASH;
    for (const row of rows) {
      const content =
        row.id === written[0].id ? { ...row, actorId: cast.approver.id } : row;
      const hash = hashAuditRecord(content, row.seq!, prevHash);

      await tamperWithLedger(() => prisma.$executeRaw`
        UPDATE audit_logs
        SET actor_id = ${content.actorId}::uuid, hash = ${hash}, prev_hash = ${prevHash}
        WHERE id = ${row.id}::uuid`);

      prevHash = hash;
    }

    const report = await ledgerService.verify();

    // The chain itself is beyond reproach now; the witness is not fooled.
    expect(report.intact).toBe(false);
    expect(report.break).toMatchObject({ kind: "content", seq: "2" });
    expect(report.break?.detail).toContain("rebuilt");
  });

  it("reports how long the check took and when it was run", async () => {
    await writeRecords(2);
    await ledgerService.seal();

    const report = await ledgerService.verify();

    expect(report.checkedAt).toBeInstanceOf(Date);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("the database itself", () => {
  /*
   * The append-only triggers (migration 20260929180000). Everything above
   * proves the chain catches an edit after the fact; these prove the database
   * refuses one in the first place - to anybody who has not switched the
   * triggers off, which is the application, a script, and a mistyped UPDATE.
   */
  const refused = /append-only/;

  it("still lets the sealer seal", async () => {
    await writeRecords(3);

    await expect(ledgerService.seal()).resolves.toEqual({ sealed: 3 });
    expect((await ledgerService.verify()).intact).toBe(true);
  });

  it("refuses to change what a sealed record says", async () => {
    const written = await writeRecords(2);
    await ledgerService.seal();

    await expect(
      prisma.$executeRaw`UPDATE audit_logs SET actor_id = ${cast.approver.id}::uuid WHERE id = ${written[1].id}::uuid`
    ).rejects.toThrow(refused);
    expect((await ledgerService.verify()).intact).toBe(true);
  });

  it("refuses to change what a record says before it is sealed, too", async () => {
    const written = await writeRecords(1);

    await expect(
      prisma.auditLog.update({ where: { id: written[0].id }, data: { newValue: { note: "else" } } })
    ).rejects.toThrow(refused);
  });

  it("refuses to seal a record and change it in the same statement", async () => {
    const written = await writeRecords(1);

    await expect(
      prisma.$executeRaw`
        UPDATE audit_logs SET seq = 1, hash = ${"a".repeat(64)}, sealed_at = now(), ip_address = '10.9.9.9'
        WHERE id = ${written[0].id}::uuid`
    ).rejects.toThrow(refused);
  });

  it("refuses to reseal or unseal a sealed record", async () => {
    const written = await writeRecords(1);
    await ledgerService.seal();

    await expect(
      prisma.$executeRaw`UPDATE audit_logs SET hash = ${"b".repeat(64)} WHERE id = ${written[0].id}::uuid`
    ).rejects.toThrow(refused);
    await expect(
      prisma.$executeRaw`UPDATE audit_logs SET seq = NULL, hash = NULL, prev_hash = NULL, sealed_at = NULL WHERE id = ${written[0].id}::uuid`
    ).rejects.toThrow(refused);
  });

  it("refuses to delete a record, sealed or not", async () => {
    const written = await writeRecords(2);
    await ledgerService.seal();
    await writeRecord();

    await expect(prisma.auditLog.delete({ where: { id: written[0].id } })).rejects.toThrow(refused);
    await expect(prisma.$executeRaw`DELETE FROM audit_logs`).rejects.toThrow(refused);
    expect(await prisma.auditLog.count()).toBe(3);
  });

  it("refuses to change or delete a witness", async () => {
    await writeRecords(1);
    await ledgerService.seal();
    const [witness] = await prisma.ledgerCheckpoint.findMany();

    await expect(
      prisma.ledgerCheckpoint.update({ where: { id: witness.id }, data: { hash: "c".repeat(64) } })
    ).rejects.toThrow(refused);
    await expect(prisma.ledgerCheckpoint.delete({ where: { id: witness.id } })).rejects.toThrow(refused);
    expect(await prisma.ledgerCheckpoint.count()).toBe(1);
  });

  it("refuses to delete a person who acted, rather than blanking their name on the record", async () => {
    // The foreign key is ON DELETE SET NULL, which would rewrite every audit
    // row the person appears on. People are switched off, never deleted; the
    // database now holds that line as well as the API.
    await writeRecords(1);

    await expect(prisma.user.delete({ where: { id: cast.preparer.id } })).rejects.toThrow(refused);
  });

  it("is switched back on after tampering, even when the tampering fails", async () => {
    const written = await writeRecords(1);

    await expect(
      tamperWithLedger(() => Promise.reject(new Error("changed my mind")))
    ).rejects.toThrow("changed my mind");

    await expect(prisma.auditLog.delete({ where: { id: written[0].id } })).rejects.toThrow(refused);
  });
});
