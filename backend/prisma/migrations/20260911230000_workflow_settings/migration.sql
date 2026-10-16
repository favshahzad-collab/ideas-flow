-- Two workflow policies that were environment variables only.
--
-- Both are decisions an organisation owns rather than constants this code can
-- pick, and both were discovered to be wrong at the worst possible moment -
-- "no approver has ever been chased" is not something anybody notices until a
-- memo is three weeks late. "Edit a file on the server and restart the API"
-- was the only way to change either, which is exactly the manual intervention
-- outside the application this product is meant not to need.
--
-- Same shape as mail_settings: one row, the row wins over the environment, and
-- the environment stays supported for deployments that already manage it that
-- way. Deleting the row hands both back to the environment.
CREATE TABLE "workflow_settings" (
    "id" VARCHAR(16) NOT NULL,
    -- NULL is a real answer and the default one: no deadline, nobody chased,
    -- no due date invented on a queue. It is not "unset, use a fallback".
    "sla_default_days" INTEGER,
    "allow_step_skip" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "workflow_settings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "workflow_settings" ADD CONSTRAINT "workflow_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A deadline policy is an administrative act on a live system: it decides who
-- gets chased and when, so it belongs in the same trail as everything else.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WORKFLOW_SETTINGS_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WORKFLOW_SETTINGS_CLEARED';
