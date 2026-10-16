-- Give the trail a real insertion order.
--
-- Two audit rows written in one transaction were indistinguishable. `seq` is
-- assigned later, by the sealer, so it is NULL at write time; `created_at`
-- defaults to now(), which in Postgres is the TRANSACTION's start time, so
-- every row a transaction writes carries the same value to the microsecond.
-- Nothing else distinguished them.
--
-- Two consequences, one visible and one not:
--
--   Reading the trail back "in order" returned whatever order the heap
--   happened to hold. A test asserting that a memo's new version is recorded
--   BEFORE the submission that acted on it passed on physical order and
--   failed about one run in five.
--
--   Worse, the sealer broke the same tie with `id` - a random uuid. So the
--   hash chain, whose whole purpose is to fix the order of history, fixed it
--   in an order decided by random numbers whenever two rows shared a
--   transaction.
--
-- `write_seq` comes from a sequence, and nextval is called per INSERT rather
-- than per transaction, so two rows written one after another inside one
-- transaction get increasing values in the order they were written. That is
-- the order the trail is read in, and the order the chain is sealed in.
CREATE SEQUENCE "audit_logs_write_seq_seq";

ALTER TABLE "audit_logs" ADD COLUMN "write_seq" BIGINT;

-- Existing rows: the best reconstruction available is the sealed position
-- where there is one, then time, then id. That is exactly the order the
-- sealer used until now, so no history changes meaning - it is only written
-- down where it can no longer drift.
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY seq ASC NULLS LAST, created_at ASC, id ASC) AS n
  FROM "audit_logs"
)
UPDATE "audit_logs" a
SET "write_seq" = ordered.n
FROM ordered
WHERE a.id = ordered.id;

SELECT setval(
  'audit_logs_write_seq_seq',
  COALESCE((SELECT MAX("write_seq") FROM "audit_logs"), 0) + 1,
  false
);

ALTER TABLE "audit_logs" ALTER COLUMN "write_seq" SET DEFAULT nextval('audit_logs_write_seq_seq');
ALTER TABLE "audit_logs" ALTER COLUMN "write_seq" SET NOT NULL;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_write_seq_key" UNIQUE ("write_seq");
ALTER SEQUENCE "audit_logs_write_seq_seq" OWNED BY "audit_logs"."write_seq";

-- The sealer asks for unsealed rows in write order; this is the index it walks.
DROP INDEX IF EXISTS "audit_logs_seq_created_at_idx";
CREATE INDEX "audit_logs_seq_write_seq_idx" ON "audit_logs" ("seq", "write_seq");
