-- Evidence a signature and an approved memo carry, for anybody checking later.
--
-- users.signature_checksum   SHA-256 of the saved signature image, so every
--                            signature made with it records which image it was.
-- documents.sealed_by        whose digital seal the approved file carries, or
--                            null when it was not sealed.
-- SIGNATURE_SAVED / SIGNATURE_REMOVED
--                            changing a saved signature is now confirmed and
--                            recorded; it used to be neither.
-- LEDGER_EXPORTED            an administrator took the auditor's export.
--
-- Additive: two nullable columns and three audit actions. Memos approved
-- before this keep sealed_by null; their files are unchanged.

ALTER TABLE "users" ADD COLUMN "signature_checksum" VARCHAR(64);
ALTER TABLE "documents" ADD COLUMN "sealed_by" VARCHAR(255);

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SIGNATURE_SAVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SIGNATURE_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LEDGER_EXPORTED';
