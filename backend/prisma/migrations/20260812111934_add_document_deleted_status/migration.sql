-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'DOCUMENT_DELETED';

-- AlterEnum
ALTER TYPE "DocumentStatus" ADD VALUE 'DELETED';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'DOCUMENT_DELETED';

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "deleted_at" TIMESTAMPTZ(6);
