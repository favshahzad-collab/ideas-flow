-- Give every already-submitted memo the submission time it should have had.
--
-- `createDocument` set the status to PENDING_REVIEW and started the workflow
-- run but never stamped `submitted_at`, so every memo submitted through the
-- Submit Document screen has carried a null one. Two things went wrong with
-- that, and both are invisible until there is real data: sorting by
-- submission put those memos last under "newest first", and the dashboard's
-- median cycle time is measured from `submitted_at`, so it could never be
-- computed at all.
--
-- The workflow run is the honest source for when the memo was submitted -- it
-- is created in the same transaction as the submission and nothing else
-- starts one. `created_at` is the fallback for the rows whose run has since
-- been superseded, and it is the same instant to within the transaction.
--
-- Drafts are left alone: a draft has not been submitted, and a null there is
-- the truth.
UPDATE "documents" d
SET "submitted_at" = COALESCE(
  (
    SELECT MIN(r."started_at")
    FROM "workflow_runs" r
    WHERE r."document_id" = d."id"
  ),
  d."created_at"
)
WHERE d."submitted_at" IS NULL
  AND d."status" <> 'DRAFT';
