-- Audit actions for signing in.
--
-- The trail recorded who approved what, and that a session was ended, but not
-- who got in, who tried and failed, or when a stolen sign-in token was used.
-- Those are the first questions after a suspected break-in, and the answer
-- was only in a log file that rotates.
--
--   SIGN_IN_SUCCEEDED     a session was issued: password, two-step or
--                         Microsoft sign-in
--   SIGN_IN_FAILED        a wrong password or two-step code for a real
--                         account (an address with no account has no row to
--                         point at, and goes to the log instead)
--   SIGN_IN_THROTTLED     the sign-in limit refused an attempt on an account
--   REFRESH_TOKEN_REUSED  a sign-in token already exchanged came back after
--                         the grace period, so somebody else holds a copy;
--                         every session on the account was ended
--
-- Additive: adding a value to an enum invalidates nothing already written.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SIGN_IN_SUCCEEDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SIGN_IN_FAILED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SIGN_IN_THROTTLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REFRESH_TOKEN_REUSED';

-- When a session ended because its token was exchanged for a new one, as
-- opposed to signing out or an administrator ending it. Only a token ended
-- this way coming back is evidence that somebody else has a copy. Null on
-- every row written before this, which is what they were: nothing could tell.
ALTER TABLE "refresh_sessions" ADD COLUMN "rotated_at" TIMESTAMPTZ(6);
