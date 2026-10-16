-- CreateTable
CREATE TABLE "ledger_checkpoints" (
    "id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "hash" VARCHAR(64) NOT NULL,
    "sealed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_checkpoints_seq_key" ON "ledger_checkpoints"("seq");

-- CreateIndex
CREATE INDEX "ledger_checkpoints_sealed_at_idx" ON "ledger_checkpoints"("sealed_at");

