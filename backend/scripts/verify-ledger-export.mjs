#!/usr/bin/env node
/**
 * Check an Ideas Flow ledger export, with nothing but Node.
 *
 *   node verify-ledger-export.mjs ideas-flow-ledger-2026-10-05.jsonl
 *
 * Written for an auditor, so it depends on nothing in this repository and
 * nothing from npm: copy this one file next to the export and run it. It
 * recomputes every record's SHA-256 digest from the record's own content and
 * the digest before it, checks that positions run 1, 2, 3 without a gap, and
 * checks that every checkpoint in the header names a record that is there
 * with the same digest - which is what shows the chain was not cut short.
 *
 * The digest format is the application's (`auditRecordPayload`, version 1,
 * in backend/src/lib/ledger.ts) and is described in DEPLOY.md. It is written
 * out again here on purpose, rather than imported, so that this check does
 * not trust the code it is checking.
 *
 * Exit status 0 when everything verifies, 1 when anything does not, 2 when
 * the file cannot be read as an export.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const GENESIS = "0".repeat(64);

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
    return sorted;
  }
  return value;
}

function digest(line) {
  const r = line.record;
  const payload = JSON.stringify({
    v: 1,
    seq: line.seq,
    prevHash: line.prevHash,
    id: r.id,
    actorId: r.actorId,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    oldValue: sortKeys(r.oldValue ?? null),
    newValue: sortKeys(r.newValue ?? null),
    ipAddress: r.ipAddress,
    userAgent: r.userAgent,
    createdAt: r.createdAt,
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function fail(message) {
  console.error(`NOT VERIFIED: ${message}`);
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error("Usage: node verify-ledger-export.mjs <export.jsonl>");
  process.exit(2);
}

let lines;
try {
  lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((text) => text.trim() !== "")
    .map((text) => JSON.parse(text));
} catch (error) {
  console.error(`Could not read ${file} as a ledger export: ${error.message}`);
  process.exit(2);
}

const [header, ...records] = lines;
if (!header || header.format !== "ideas-flow-ledger" || header.version !== 1) {
  console.error(`${file} is not an Ideas Flow ledger export (version 1).`);
  process.exit(2);
}

const bySeq = new Map();
let expectedSeq = 1n;
let expectedPrev = header.genesisHash ?? GENESIS;

for (const line of records) {
  const seq = BigInt(line.seq);
  if (seq !== expectedSeq) {
    fail(`expected record ${expectedSeq} next, found ${seq}: records are missing or out of order.`);
  }
  if (line.prevHash !== expectedPrev) {
    fail(`record ${seq} does not link to the record before it.`);
  }
  const recomputed = digest(line);
  if (recomputed !== line.hash) {
    fail(`record ${seq} (${line.record.action}, ${line.record.id}) has been changed since it was sealed: its content no longer produces its digest.`);
  }
  bySeq.set(line.seq, line.hash);
  expectedSeq = seq + 1n;
  expectedPrev = line.hash;
}

for (const checkpoint of header.checkpoints ?? []) {
  const found = bySeq.get(checkpoint.seq);
  if (found === undefined) {
    fail(`the checkpoint taken at record ${checkpoint.seq} (${checkpoint.sealedAt}) names a record that is not in this export: the chain has been cut short.`);
  }
  if (found !== checkpoint.hash) {
    fail(`record ${checkpoint.seq} does not match the digest witnessed when it was sealed (${checkpoint.sealedAt}): the chain was rebuilt.`);
  }
}

const tip = records.length > 0 ? records[records.length - 1] : null;
console.log(
  `VERIFIED: ${records.length} records, positions 1 to ${tip ? tip.seq : 0}, ` +
    `${(header.checkpoints ?? []).length} checkpoints, exported ${header.exportedAt}.`
);
if (tip) console.log(`Last digest: ${tip.hash}`);
process.exit(0);
