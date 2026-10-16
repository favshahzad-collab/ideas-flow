-- Delegation scope and a configurable route per memo type
-- (fit-gap decisions 6 and 7).

ALTER TABLE "delegations" ADD COLUMN "memo_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "memo_type_routes" (
  "memo_type" VARCHAR(64) NOT NULL,
  "template_id" UUID,
  "updated_by_id" UUID,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "memo_type_routes_pkey" PRIMARY KEY ("memo_type")
);
ALTER TABLE "memo_type_routes" ADD CONSTRAINT "memo_type_routes_template_id_fkey"
  FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TYPE "AuditAction" ADD VALUE 'MEMO_TYPE_ROUTE_CHANGED';
