-- Signing in with a Microsoft work account.
--
-- A SECOND app registration, and nothing to do with the one that sends mail.
-- That one is app-only: it holds Mail.Send, never sees a browser, and has no
-- redirect URI. This one is a delegated sign-in with a redirect back here, and
-- giving it the mail application's credentials would neither work nor be safe.
-- The two are separate rows for that reason.
CREATE TABLE "sso_settings" (
    "id" VARCHAR(16) NOT NULL,
    -- Off until somebody finishes configuring it. The sign-in button is drawn
    -- from this: a button that cannot work is worse than no button, because
    -- the one screen nobody can get past is where it sits.
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "tenant_id" VARCHAR(100),
    "client_id" VARCHAR(100),
    -- AES-256-GCM via lib/secretBox, keyed from JWT_SECRET. Never returned to
    -- any client, and never logged.
    "client_secret_cipher" TEXT,
    -- Stored rather than derived. Entra matches it character for character
    -- against the registration, and a mismatch is the single most common way
    -- for this to fail - so the value the administrator registered is the
    -- value this sends, and the screen can show them what to paste.
    "redirect_uri" VARCHAR(2048),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "sso_settings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "sso_settings" ADD CONSTRAINT "sso_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One sign-in attempt, from the moment the browser leaves to the moment the
-- application it comes back to is handed a session.
--
-- Server-side because the two halves happen in different requests and this
-- application has no cookies: it is bearer tokens throughout, and introducing
-- a cookie to carry a PKCE verifier would bring session-fixation and CSRF
-- questions to a design that currently has neither.
--
-- One row rather than two tables, because it is one event. `state`,
-- `code_verifier` and `nonce` are what the callback has to prove the round
-- trip with; `user_id` and `code_hash` are written once it has, and are what
-- the single-page app trades for a session.
CREATE TABLE "sso_logins" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    -- Round-tripped through Microsoft and compared on the way back. This is
    -- what stops a callback that nothing here ever started.
    "state" VARCHAR(64) NOT NULL,
    "code_verifier" VARCHAR(128) NOT NULL,
    -- Must appear in the id_token. Without it a token captured from another
    -- sign-in could be replayed into this one.
    "nonce" VARCHAR(64) NOT NULL,
    -- Both null until the callback knows who this is.
    "user_id" UUID,
    -- SHA-256 of the handover code, never the code. Putting a session in the
    -- redirect URL would write it into browser history, the referrer header
    -- and any proxy log on the way; what travels there is worth nothing except
    -- to whoever POSTs it back, once, within the minute.
    "code_hash" VARCHAR(64),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    -- Set the instant it is spent, so a replay finds it and is refused.
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sso_logins_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sso_logins_state_key" ON "sso_logins"("state");
CREATE UNIQUE INDEX "sso_logins_code_hash_key" ON "sso_logins"("code_hash");
CREATE INDEX "sso_logins_expires_at_idx" ON "sso_logins"("expires_at");

ALTER TABLE "sso_logins" ADD CONSTRAINT "sso_logins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SSO_SETTINGS_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SSO_SETTINGS_CLEARED';
