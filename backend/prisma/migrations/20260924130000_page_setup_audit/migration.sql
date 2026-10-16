-- An audit action for changing the memo page.
--
-- Its own value rather than reusing one of the settings actions, because the
-- question it answers is specific: "why does this memo look different from
-- that one" is asked about a document, and the answer is a margin somebody
-- changed on a date. Folding it into a general settings action would leave
-- that answer buried among mail server edits.
--
-- Additive: adding a value to an enum invalidates nothing already written.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PAGE_SETUP_UPDATED';
