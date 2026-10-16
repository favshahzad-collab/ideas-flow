-- Handing somebody's approvals to somebody else is worth telling them about.
--
-- The arrangement itself notified nobody. Memos flowing THROUGH it always
-- did - a document reaching a covered step tells the approver and the
-- delegate - which is what made the silence hard to see: the feature
-- demonstrably sent mail.
--
-- It matters most in the case the permission rule deliberately allows: an
-- administrator may hand one person's approvals to another. In a product
-- where a signature carries authority, that is a transfer of authority, and
-- the two people it concerns were exactly the two not told. DELEGATION_CREATED
-- went into the audit trail and no further.
--
-- Two types rather than one, because "you are covering for somebody" and "you
-- are no longer covering for somebody" are opposite facts, and a delegate
-- reading a list of four rows needs to know which way round each one is.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DELEGATION_STARTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DELEGATION_ENDED';
