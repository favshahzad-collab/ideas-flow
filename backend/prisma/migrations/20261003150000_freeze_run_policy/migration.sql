-- Each approval cycle keeps the workflow policy it started with.
--
-- The default deadline, whether a step may be skipped, and whether the
-- approved memo is sealed are written onto the run when a cycle starts, and
-- read from there. A later change on the policy screen reaches cycles already
-- in flight only when an administrator applies it to them on purpose.
--
-- Additive: four nullable columns. A run with no snapshot (policy_frozen_at
-- null) follows the current policy, exactly as every run did before this.

ALTER TABLE "workflow_runs" ADD COLUMN "policy_frozen_at" TIMESTAMPTZ(6);
ALTER TABLE "workflow_runs" ADD COLUMN "policy_sla_default_days" INTEGER;
ALTER TABLE "workflow_runs" ADD COLUMN "policy_allow_step_skip" BOOLEAN;
ALTER TABLE "workflow_runs" ADD COLUMN "policy_seal_approved_memos" BOOLEAN;

-- Cycles already in progress take the policy stored on the screen today, so
-- they too are protected from the next change. Where nothing is stored, the
-- policy comes from the server's environment, which SQL cannot read; those
-- runs are left without a snapshot and follow it as before.
UPDATE "workflow_runs" AS r
SET "policy_frozen_at" = now(),
    "policy_sla_default_days" = CASE WHEN s."sla_default_days" > 0 THEN s."sla_default_days" END,
    "policy_allow_step_skip" = s."allow_step_skip",
    "policy_seal_approved_memos" = s."seal_approved_memos"
FROM "workflow_settings" AS s
WHERE s."id" = 'singleton'
  AND r."status" = 'IN_PROGRESS';
