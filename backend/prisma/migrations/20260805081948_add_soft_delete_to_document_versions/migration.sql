-- DropIndex
DROP INDEX "document_versions_document_id_idx";

-- AlterTable
ALTER TABLE "document_versions" ADD COLUMN     "is_deleted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "id" SET DEFAULT gen_random_uuid(),
ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "document_versions_document_id_is_deleted_idx" ON "document_versions"("document_id", "is_deleted");
