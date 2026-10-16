-- Withdraw instead of delete, and supporting files kept per version
-- (fit-gap decisions 3 and 8).

ALTER TABLE "documents" ADD COLUMN "withdrawal_reason" VARCHAR(1000);
ALTER TABLE "documents" ADD COLUMN "withdrawn_by_id" UUID;

ALTER TABLE "supporting_documents" ADD COLUMN "added_in_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "supporting_documents" ADD COLUMN "removed_in_version" INTEGER;

-- Files already attached: the version that existed when each was uploaded,
-- and, for one taken out of view by a later resubmission, the first version
-- made after it. Read from the timestamps; nothing else recorded it.
UPDATE "supporting_documents" s SET "added_in_version" = COALESCE((
  SELECT MAX(v."version_number") FROM "document_versions" v
  WHERE v."document_id" = s."document_id" AND v."uploaded_at" <= s."uploaded_at" + INTERVAL '5 seconds'
), 1);

UPDATE "supporting_documents" s SET "removed_in_version" = COALESCE((
  SELECT MIN(v."version_number") FROM "document_versions" v
  WHERE v."document_id" = s."document_id" AND v."version_number" > s."added_in_version"
), s."added_in_version" + 1)
WHERE s."is_deleted" = true;

ALTER TYPE "AuditAction" ADD VALUE 'DOCUMENT_WITHDRAWN';
ALTER TYPE "AuditAction" ADD VALUE 'DOCUMENT_CANCELLED';
