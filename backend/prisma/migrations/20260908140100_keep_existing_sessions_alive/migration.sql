-- The column above defaults to "now", which on an existing deployment would
-- mean every token issued before the upgrade is refused the moment it lands:
-- everybody signed out mid-approval by a migration that had nothing to do with
-- their session. The cutoff belongs at the account's creation instead, so the
-- upgrade invalidates nothing and only a deliberate act moves it forward.
--
-- A separate migration rather than an extra statement in the one before it,
-- because that one has already been applied and editing an applied migration
-- changes its checksum.
UPDATE users SET sessions_valid_from = created_at;
