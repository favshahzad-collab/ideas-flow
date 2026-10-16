-- Two-factor sign-in with an authenticator app.
--
-- Per person and opt-in. There is no organisation-wide switch here on purpose:
-- this deployment has five accounts and one administrator, and a mandatory
-- second factor with nobody able to reset it is how everybody gets locked out
-- of an approval system at once. The administrator reset path is the other
-- half of shipping this at all.

-- The shared secret, encrypted with lib/secretBox (AES-256-GCM, keyed from
-- JWT_SECRET). Rotating JWT_SECRET makes every one of these unreadable, which
-- is the same trade the mail password already makes - and the reason
-- verification treats an unreadable secret as a refusal an administrator can
-- fix, rather than a crash.
ALTER TABLE "users" ADD COLUMN "totp_secret" TEXT;

-- Null until a code from that secret has actually been typed back in. A
-- secret written down at the start of enrolment proves nothing: it means a QR
-- code was drawn, not that anybody's phone can read it. Switching the factor
-- on before that confirmation is how somebody locks themselves out during
-- setup.
ALTER TABLE "users" ADD COLUMN "totp_activated_at" TIMESTAMPTZ(6);

-- The last thirty-second step accepted for this account, so a code cannot be
-- used twice. A correct code stays correct for up to ninety seconds; without
-- this, one read over a shoulder or typed into a page pretending to be the
-- sign-in screen is replayable for the rest of its window.
ALTER TABLE "users" ADD COLUMN "totp_last_step" BIGINT;

-- The way back in when the phone is gone.
--
-- Single-use, hashed the way a password is not: these are 80 bits of random
-- from a generator, not something a person chose, so there is nothing for a
-- dictionary to attack and SHA-256 is the right tool. A scrypt derivation per
-- code would put ten of them on the critical path of every sign-in.
CREATE TABLE "totp_recovery_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    -- Set the instant it is spent. The row is kept rather than deleted so the
    -- screen can say how many are left and how many have been used, which is
    -- what tells somebody it is time to generate a new set.
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "totp_recovery_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "totp_recovery_codes_code_hash_key" ON "totp_recovery_codes"("code_hash");
CREATE INDEX "totp_recovery_codes_user_id_idx" ON "totp_recovery_codes"("user_id");

ALTER TABLE "totp_recovery_codes" ADD CONSTRAINT "totp_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A sign-in that has passed the password and not yet passed the code.
--
-- Server-side for the same reason the SSO round trip is: the two halves are
-- different requests and this application has no cookies. It could have been a
-- signed token instead, and is not, because a token cannot count attempts -
-- and six digits is a space of one million, which is small enough that the
-- per-challenge cap is the real defence and the rate limiter is the backstop.
--
-- Holding one of these is worth nothing on its own: the password has been
-- proven, the second factor has not, and no session exists until it is.
CREATE TABLE "totp_challenges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    -- SHA-256 of the challenge, never the challenge. It travels to the browser
    -- and back in a POST body, so the table never holds the live value.
    "code_hash" VARCHAR(64) NOT NULL,
    -- Guesses so far. The challenge dies on the fifth, which costs an attacker
    -- a fresh password-verified sign-in for every five tries at the digits.
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "totp_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "totp_challenges_code_hash_key" ON "totp_challenges"("code_hash");
CREATE INDEX "totp_challenges_expires_at_idx" ON "totp_challenges"("expires_at");

ALTER TABLE "totp_challenges" ADD CONSTRAINT "totp_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TWO_FACTOR_ENABLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TWO_FACTOR_DISABLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TWO_FACTOR_RESET';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TWO_FACTOR_RECOVERY_USED';
