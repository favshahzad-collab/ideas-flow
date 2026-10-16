
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'DOCUMENT_DOWNLOADED';
ALTER TYPE "AuditAction" ADD VALUE 'DOCUMENT_PRINTED';

-- AlterTable
ALTER TABLE "document_versions" ADD COLUMN     "original_storage_path" VARCHAR(1024);

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "final_signed_storage_path" VARCHAR(1024),
ADD COLUMN     "reference_number" VARCHAR(64);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "designation" VARCHAR(120);

-- CreateIndex
CREATE UNIQUE INDEX "documents_reference_number_key" ON "documents"("reference_number");

