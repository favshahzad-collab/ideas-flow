-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "email_messages" (
    "id" UUID NOT NULL,
    "recipient_email" VARCHAR(255) NOT NULL,
    "recipient_id" UUID,
    "subject" VARCHAR(500) NOT NULL,
    "body" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "document_id" UUID,
    "notification_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_messages_status_created_at_idx" ON "email_messages"("status", "created_at");

-- CreateIndex
CREATE INDEX "email_messages_document_id_idx" ON "email_messages"("document_id");

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

