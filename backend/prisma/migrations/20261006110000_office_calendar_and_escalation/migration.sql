-- Line managers, escalation, receipts and the office calendar (fit-gap decisions 2 and 4).

ALTER TABLE "users" ADD COLUMN "line_manager_id" UUID;
ALTER TABLE "users" ADD CONSTRAINT "users_line_manager_id_fkey"
  FOREIGN KEY ("line_manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_line_manager_not_self"
  CHECK ("line_manager_id" IS NULL OR "line_manager_id" <> "id");
CREATE INDEX "users_line_manager_id_idx" ON "users"("line_manager_id");

ALTER TABLE "workflow_runs" ADD COLUMN "escalated_at" TIMESTAMPTZ(6);

ALTER TYPE "NotificationType" ADD VALUE 'SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'ESCALATED';

ALTER TYPE "AuditAction" ADD VALUE 'WORKFLOW_STEP_ESCALATED';
ALTER TYPE "AuditAction" ADD VALUE 'HOLIDAY_ADDED';
ALTER TYPE "AuditAction" ADD VALUE 'HOLIDAY_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE 'OFFICE_TIME_ZONE_CHANGED';

CREATE TABLE "public_holidays" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "date" DATE NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "public_holidays_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "public_holidays_date_key" ON "public_holidays"("date");
ALTER TABLE "public_holidays" ADD CONSTRAINT "public_holidays_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "calendar_settings" (
  "id" VARCHAR(16) NOT NULL,
  "time_zone" VARCHAR(64) NOT NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "updated_by_id" UUID,
  CONSTRAINT "calendar_settings_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "calendar_settings" ADD CONSTRAINT "calendar_settings_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
