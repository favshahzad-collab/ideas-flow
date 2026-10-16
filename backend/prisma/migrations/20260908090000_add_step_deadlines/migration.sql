-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'WORKFLOW_STEP_OVERDUE';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'APPROVAL_OVERDUE';

-- AlterTable
ALTER TABLE "approval_chain_steps" ADD COLUMN     "sla_days" INTEGER;

-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN     "breach_notified_at" TIMESTAMPTZ(6),
ADD COLUMN     "current_step_started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "workflow_runs_status_current_step_started_at_idx" ON "workflow_runs"("status", "current_step_started_at");


-- Existing runs would otherwise all claim their current step began the moment
-- this migration ran, which would show a fortnight-old memo as arriving today
-- and reset any deadline it had already blown. The best evidence available is
-- the last action taken on the run; failing that, the run's own start.
UPDATE workflow_runs r
SET current_step_started_at = COALESCE(
  (
    SELECT max(a.created_at)
    FROM approval_actions a
    WHERE a.workflow_run_id = r.id
  ),
  r.started_at
);
