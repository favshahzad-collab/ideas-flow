-- AlterEnum
ALTER TYPE "EmailStatus" ADD VALUE 'SENDING';

-- AlterTable
ALTER TABLE "email_messages" ADD COLUMN     "claimed_at" TIMESTAMPTZ(6);

