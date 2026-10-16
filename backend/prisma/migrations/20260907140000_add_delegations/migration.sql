-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'DELEGATION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'DELEGATION_REVOKED';

-- AlterTable
ALTER TABLE "approval_actions" ADD COLUMN     "on_behalf_of_id" UUID;

-- CreateTable
CREATE TABLE "delegations" (
    "id" UUID NOT NULL,
    "delegator_id" UUID NOT NULL,
    "delegate_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMPTZ(6),
    "reason" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delegations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delegations_delegator_id_revoked_at_idx" ON "delegations"("delegator_id", "revoked_at");

-- CreateIndex
CREATE INDEX "delegations_delegate_id_revoked_at_idx" ON "delegations"("delegate_id", "revoked_at");

-- CreateIndex
CREATE INDEX "approval_actions_on_behalf_of_id_idx" ON "approval_actions"("on_behalf_of_id");

-- AddForeignKey
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_on_behalf_of_id_fkey" FOREIGN KEY ("on_behalf_of_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_delegator_id_fkey" FOREIGN KEY ("delegator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_delegate_id_fkey" FOREIGN KEY ("delegate_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

