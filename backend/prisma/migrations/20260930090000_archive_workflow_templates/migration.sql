-- Workflow templates are archived, not deleted.
--
-- Deleting one removed the design it held for good; it was refused only while
-- a memo still pointed at it. An archived template is hidden from choosing and
-- from Workflow studio's main list, cannot be edited, and is kept - with its
-- graph and its audit rows - until somebody restores it.
--
-- Additive: a nullable column, an index, and two audit actions. Nothing that
-- exists today changes, and no template is archived by this migration.

ALTER TABLE "workflow_templates" ADD COLUMN "archived_at" TIMESTAMPTZ(6);

CREATE INDEX "workflow_templates_archived_at_idx" ON "workflow_templates"("archived_at");

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WORKFLOW_TEMPLATE_ARCHIVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WORKFLOW_TEMPLATE_RESTORED';
