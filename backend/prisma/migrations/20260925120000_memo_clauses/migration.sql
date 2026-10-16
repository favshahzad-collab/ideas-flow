-- Standard wording an administrator keeps for preparers to insert.
--
-- A recommendation paragraph, an approval condition, the sentence a memo of a
-- given kind always opens with: wording that is typed the same way a hundred
-- times, and typed slightly differently each time. Kept here once, inserted
-- into a memo as a COPY - the memo keeps the words it was signed with however
-- the clause is edited afterwards - so the table carries no link back from a
-- document and nothing about a filed memo depends on it.
--
-- `body_json` holds the same node set a memo body does (see
-- `document_versions.body_json`), validated by the same schema, so the editor
-- inserts it as it is and the renderer draws it as it draws anything else.
--
-- Archiving is a timestamp rather than a delete: the wording may sit on many
-- filed memos, and the audit trail names it by id.
--
-- Additive: a new table, and four new audit actions.

CREATE TABLE "memo_clauses" (
  "id"            UUID NOT NULL,
  "title"         VARCHAR(120) NOT NULL,
  "body_json"     JSONB NOT NULL,
  "archived_at"   TIMESTAMPTZ(6),
  "created_by_id" UUID,
  "updated_by_id" UUID,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "memo_clauses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "memo_clauses_archived_at_idx" ON "memo_clauses"("archived_at");

ALTER TABLE "memo_clauses"
  ADD CONSTRAINT "memo_clauses_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "memo_clauses"
  ADD CONSTRAINT "memo_clauses_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MEMO_CLAUSE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MEMO_CLAUSE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MEMO_CLAUSE_ARCHIVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MEMO_CLAUSE_RESTORED';
