import { describe, expect, it } from "vitest";
import {
  auditRecordPayload,
  chainFrom,
  checkRecord,
  GENESIS_HASH,
  hashAuditRecord,
  type AuditRecordContent,
  type SealedRecord,
} from "./ledger";

/**
 * The arithmetic of the chain, with no database in sight.
 *
 * Everything that decides whether a tampered record is caught lives in this
 * file: what goes into a digest, in what order, and how one record is tied to
 * the one before it. The integration suite proves the rows get written; this
 * proves the sums are right.
 */

const record = (
  overrides: Partial<AuditRecordContent> = {}
): AuditRecordContent => ({
  id: "11111111-1111-4111-8111-111111111111",
  actorId: "22222222-2222-4222-8222-222222222222",
  action: "WORKFLOW_APPROVED",
  entityType: "Document",
  entityId: "33333333-3333-4333-8333-333333333333",
  oldValue: null,
  newValue: { stepOrder: 2, nextStepOrder: 3 },
  ipAddress: "10.0.0.4",
  userAgent: "Mozilla/5.0",
  createdAt: new Date("2026-09-07T09:15:00.000Z"),
  ...overrides,
});

const sealed = (overrides: Partial<SealedRecord> = {}): SealedRecord => {
  const base = { ...record(), seq: 1n, prevHash: GENESIS_HASH, ...overrides };

  return { ...base, hash: overrides.hash ?? hashAuditRecord(base, base.seq, base.prevHash) };
};

describe('what "nothing came before this" is', () => {
  it('is sixty-four zeroes, which is not a digest of anything', () => {
    expect(GENESIS_HASH).toBe('0'.repeat(64));
    expect(GENESIS_HASH).toHaveLength(64);
  });
});

describe('the bytes a digest is taken over', () => {
  it('does not depend on the order a database handed the JSON back in', () => {
    // Postgres stores jsonb with its own key order and is free to change it.
    // If that reached the digest, a record would stop verifying because it was
    // read back, not because anyone touched it.
    const a = record({ newValue: { alpha: 1, beta: { x: 1, y: 2 } } });
    const b = record({ newValue: { beta: { y: 2, x: 1 }, alpha: 1 } });

    expect(auditRecordPayload(a, 1n, GENESIS_HASH)).toBe(
      auditRecordPayload(b, 1n, GENESIS_HASH)
    );
  });

  it('sorts keys all the way down, not just at the top', () => {
    const a = record({ oldValue: { outer: { b: 1, a: 2 } } });
    const b = record({ oldValue: { outer: { a: 2, b: 1 } } });

    expect(hashAuditRecord(a, 1n, GENESIS_HASH)).toBe(
      hashAuditRecord(b, 1n, GENESIS_HASH)
    );
  });

  it('keeps the order of an array, which carries meaning', () => {
    const a = record({ newValue: { steps: ['one', 'two'] } });
    const b = record({ newValue: { steps: ['two', 'one'] } });

    expect(hashAuditRecord(a, 1n, GENESIS_HASH)).not.toBe(
      hashAuditRecord(b, 1n, GENESIS_HASH)
    );
  });

  it('cannot be made to agree by moving a character across a field boundary', () => {
    // The reason the payload is JSON and not a join: "ab" acting on "c" and
    // "a" acting on "bc" must not produce the same bytes.
    const a = record({ entityType: 'ab', entityId: 'c' });
    const b = record({ entityType: 'a', entityId: 'bc' });

    expect(hashAuditRecord(a, 1n, GENESIS_HASH)).not.toBe(
      hashAuditRecord(b, 1n, GENESIS_HASH)
    );
  });

  it('treats a missing value and an explicit null as the same absence', () => {
    expect(auditRecordPayload(record({ oldValue: undefined }), 1n, GENESIS_HASH)).toBe(
      auditRecordPayload(record({ oldValue: null }), 1n, GENESIS_HASH)
    );
  });

  it('carries a format version, so a later change can be told apart', () => {
    expect(JSON.parse(auditRecordPayload(record(), 1n, GENESIS_HASH))).toMatchObject({
      v: 1,
    });
  });

  it('is the same bytes every time it is asked', () => {
    const one = record();

    expect(hashAuditRecord(one, 4n, GENESIS_HASH)).toBe(
      hashAuditRecord(one, 4n, GENESIS_HASH)
    );
  });

  it('is sixty-four hex characters', () => {
    expect(hashAuditRecord(record(), 1n, GENESIS_HASH)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('every field that can be tampered with changes the digest', () => {
  const base = hashAuditRecord(record(), 1n, GENESIS_HASH);

  const changes: [string, Partial<AuditRecordContent>][] = [
    ['the record id', { id: '44444444-4444-4444-8444-444444444444' }],
    ['who did it', { actorId: '55555555-5555-4555-8555-555555555555' }],
    ['nobody having done it', { actorId: null }],
    ['what they did', { action: 'WORKFLOW_REJECTED' }],
    ['what it was done to', { entityType: 'Delegation' }],
    ['which one', { entityId: '66666666-6666-4666-8666-666666666666' }],
    ['what it was before', { oldValue: { status: 'DRAFT' } }],
    ['what it became', { newValue: { stepOrder: 3, nextStepOrder: 4 } }],
    ['where from', { ipAddress: '10.0.0.5' }],
    ['what with', { userAgent: 'curl/8.6.0' }],
    ['when', { createdAt: new Date('2026-09-07T09:15:00.001Z') }],
  ];

  for (const [what, change] of changes) {
    it(`notices a change to ${what}`, () => {
      expect(hashAuditRecord(record(change), 1n, GENESIS_HASH)).not.toBe(base);
    });
  }

  it('notices the record being moved to a different position', () => {
    expect(hashAuditRecord(record(), 2n, GENESIS_HASH)).not.toBe(base);
  });

  it('notices a different record being put in front of it', () => {
    expect(hashAuditRecord(record(), 1n, 'a'.repeat(64))).not.toBe(base);
  });
});

describe('building the chain', () => {
  const three = [
    record({ id: 'aaaaaaaa-0000-4000-8000-000000000001' }),
    record({ id: 'aaaaaaaa-0000-4000-8000-000000000002' }),
    record({ id: 'aaaaaaaa-0000-4000-8000-000000000003' }),
  ];

  it('starts the first record at position one, after nothing', () => {
    const [first] = chainFrom(null, three);

    expect(first.seq).toBe(1n);
    expect(first.prevHash).toBe(GENESIS_HASH);
  });

  it('numbers them one after another', () => {
    expect(chainFrom(null, three).map(r => r.seq)).toEqual([1n, 2n, 3n]);
  });

  it('ties each record to the digest of the one before it', () => {
    const chained = chainFrom(null, three);

    expect(chained[1].prevHash).toBe(chained[0].hash);
    expect(chained[2].prevHash).toBe(chained[1].hash);
  });

  it('carries on from where an existing chain ended', () => {
    const tipHash = 'b'.repeat(64);
    const chained = chainFrom({ seq: 41n, hash: tipHash }, three);

    expect(chained.map(r => r.seq)).toEqual([42n, 43n, 44n]);
    expect(chained[0].prevHash).toBe(tipHash);
  });

  it('gives two identical records different digests, because their positions differ', () => {
    // Two audit rows can be identical in content - the same action on the same
    // document by the same person in the same millisecond is unlikely but not
    // impossible - and they must still be distinguishable in the chain.
    const twins = [record({ id: 'c0000000-0000-4000-8000-000000000001' }), record({ id: 'c0000000-0000-4000-8000-000000000001' })];
    const chained = chainFrom(null, twins);

    expect(chained[0].hash).not.toBe(chained[1].hash);
  });

  it('leaves the chain alone when there is nothing to add', () => {
    expect(chainFrom({ seq: 41n, hash: 'b'.repeat(64) }, [])).toEqual([]);
  });

  it('does not mutate what it was given', () => {
    const one = record();
    chainFrom(null, [one]);

    expect(one).not.toHaveProperty('hash');
  });
});

describe('checking a record', () => {
  it('says nothing when it is where it should be and says what it said', () => {
    expect(checkRecord(sealed(), 1n, GENESIS_HASH)).toBeNull();
  });

  it('reports a deletion as a gap in the numbering', () => {
    // Positions are handed out one after another, so a position with no record
    // at it is a record that was removed.
    const found = checkRecord(sealed({ seq: 7n }), 5n, GENESIS_HASH);

    expect(found?.kind).toBe('missing');
    expect(found?.seq).toBe('5');
    expect(found?.detail).toContain('the next one held is 7');
  });

  it('reports a record that does not follow the one before it', () => {
    const found = checkRecord(sealed({ seq: 2n, prevHash: 'd'.repeat(64) }), 2n, 'e'.repeat(64));

    expect(found?.kind).toBe('link');
    expect(found?.seq).toBe('2');
  });

  it('reports an edited record, and names it', () => {
    const original = sealed();
    // The row was changed in the database; its stored digest was not.
    const edited: SealedRecord = { ...original, actorId: '99999999-9999-4999-8999-999999999999' };

    const found = checkRecord(edited, 1n, GENESIS_HASH);

    expect(found?.kind).toBe('content');
    expect(found?.recordId).toBe(edited.id);
  });

  it('reports a digest that was replaced with one taken over different content', () => {
    // The subtle version: somebody edits the row and recomputes its own digest,
    // but not the chain after it. The record itself now reads clean - which is
    // why the record after it is the one that catches this.
    const edited = record({ actorId: '99999999-9999-4999-8999-999999999999' });
    const restamped = sealed({ ...edited, seq: 1n, prevHash: GENESIS_HASH, hash: undefined });

    expect(checkRecord(restamped, 1n, GENESIS_HASH)).toBeNull();

    const next = sealed({ seq: 2n, prevHash: hashAuditRecord(record(), 1n, GENESIS_HASH) });

    expect(checkRecord(next, 2n, restamped.hash)?.kind).toBe('link');
  });

  it('reports a record whose digest was never written', () => {
    expect(checkRecord(sealed({ hash: '' }), 1n, GENESIS_HASH)?.kind).toBe('content');
  });
});
