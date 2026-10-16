-- Asking somebody to look at a memo that is sitting with them.
--
-- The only thing that chased a memo was the deadline sweep, and it chases
-- exactly one case: a step that has run past the working days it was given.
-- With no `slaDays` on the step and no `SLA_DEFAULT_DAYS` on the deployment
-- there is no deadline, so nothing is ever chased and a memo can sit for a
-- week with nobody told anything. What the preparer had instead was walking
-- down the corridor.
--
-- `APPROVAL_REMINDER` is deliberately not `APPROVAL_OVERDUE`. Overdue is a
-- statement about a deadline that exists and has passed; the sweep sends it
-- once per step and records that it did. A reminder says only that somebody
-- is waiting, and it must not be able to make a memo look late when nothing
-- ever said when it was due.
--
-- `APPROVAL_REMINDER_SENT` is what makes the cooldown honest: the server
-- reads its own last entry for the memo to decide whether another may be
-- sent yet, rather than trusting a client not to ask twice.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'APPROVAL_REMINDER';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APPROVAL_REMINDER_SENT';
