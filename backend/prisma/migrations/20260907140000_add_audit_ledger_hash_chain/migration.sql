-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "hash" VARCHAR(64),
ADD COLUMN     "prev_hash" VARCHAR(64),
ADD COLUMN     "sealed_at" TIMESTAMPTZ(6),
ADD COLUMN     "seq" BIGINT;

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_seq_key" ON "audit_logs"("seq");

-- CreateIndex
CREATE INDEX "audit_logs_seq_created_at_idx" ON "audit_logs"("seq", "created_at");

