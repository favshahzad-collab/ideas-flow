-- Somebody who has left keeps a working password until this exists: deleting
-- them is refused the moment they have prepared, approved or commented on
-- anything, which is everybody worth deleting.
--
-- Nullable, so every account already on the system stays in use. The index is
-- there because every people list and every approver picker filters on it.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deactivated_at" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "users_deactivated_at_idx" ON "users"("deactivated_at");

-- Its own pair of actions rather than a USER_UPDATED with a changed field:
-- the change history is read to answer "who can still get in".
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'USER_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'USER_REACTIVATED';
