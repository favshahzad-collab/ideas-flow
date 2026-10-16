-- Leave as rejected: a rejected memo's preparer either resubmits it or
-- closes it for good. Until one or the other, the rejection stays in their
-- Inbox under "Needs you".
--
-- rejection_closed_at   when the preparer left it as rejected; null while the
--                       decision is still theirs
-- REJECTION_CLOSED      the audit row for that decision
--
-- Rejected memos already on record are left open, so each preparer decides
-- about their own.
ALTER TABLE "documents" ADD COLUMN "rejection_closed_at" TIMESTAMPTZ(6);
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REJECTION_CLOSED';
