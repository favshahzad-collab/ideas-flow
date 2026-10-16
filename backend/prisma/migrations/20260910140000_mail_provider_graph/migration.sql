-- Microsoft Graph as a mail provider, beside SMTP.
--
-- On Microsoft 365 this is the one to prefer: the message is handed to
-- Exchange Online through the API rather than relayed in over SMTP, so SPF and
-- DKIM are the tenant's business instead of a DNS record every deployment has
-- to get right before anybody is told anything.

-- CreateEnum
CREATE TYPE "MailProvider" AS ENUM ('SMTP', 'MICROSOFT_GRAPH');

-- AlterTable
ALTER TABLE "mail_settings"
    ADD COLUMN "provider" "MailProvider" NOT NULL DEFAULT 'SMTP',
    ADD COLUMN "from_name" VARCHAR(255),
    ADD COLUMN "tenant_id" VARCHAR(100),
    ADD COLUMN "client_id" VARCHAR(100),
    ADD COLUMN "client_secret_cipher" TEXT,
    ADD COLUMN "graph_mailbox" VARCHAR(320),
    ADD COLUMN "save_to_sent_items" BOOLEAN NOT NULL DEFAULT true;

-- Graph has no host to point at, so these stop being required. Existing rows
-- are SMTP and keep theirs.
ALTER TABLE "mail_settings" ALTER COLUMN "host" DROP NOT NULL;
ALTER TABLE "mail_settings" ALTER COLUMN "port" DROP NOT NULL;

-- `from_address` used to hold whatever an administrator typed, which in
-- practice is `Ideas Flow <no-reply@ideas.com.pk>` - the useful form, and not
-- an address any API will accept as one. Graph wants the name and the address
-- separately, so any existing row is split here rather than parsed on every
-- send forever.
--
-- Left alone when there is no angle bracket: that row already holds a bare
-- address, which is exactly what the column is becoming.
UPDATE "mail_settings"
SET "from_name" = NULLIF(BTRIM(SUBSTRING("from_address" FROM '^(.*?)\s*<'), '"'), ''),
    "from_address" = BTRIM(SUBSTRING("from_address" FROM '<([^>]+)>'))
WHERE "from_address" LIKE '%<%>%';
