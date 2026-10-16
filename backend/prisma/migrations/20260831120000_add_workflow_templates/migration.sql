-- CreateTable
CREATE TABLE "workflow_templates" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "graph" JSONB NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_templates_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN "template_id" UUID;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "workflow_templates_is_active_idx" ON "workflow_templates"("is_active");

-- CreateIndex
CREATE INDEX "workflow_templates_created_by_id_idx" ON "workflow_templates"("created_by_id");

-- CreateIndex
CREATE INDEX "documents_template_id_idx" ON "documents"("template_id");
