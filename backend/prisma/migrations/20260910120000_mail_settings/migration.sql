-- The mail server this deployment sends through, set from the administration
-- screens instead of the server's environment.

-- CreateTable
CREATE TABLE "mail_settings" (
    "id" VARCHAR(16) NOT NULL,
    "host" VARCHAR(255) NOT NULL,
    "port" INTEGER NOT NULL,
    "secure" BOOLEAN NOT NULL DEFAULT false,
    "from_address" VARCHAR(320) NOT NULL,
    "username" VARCHAR(255),
    "password_cipher" TEXT,
    "app_url" VARCHAR(2048),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "mail_settings_pkey" PRIMARY KEY ("id")
);

-- One row, and the database is where that is settled rather than in whichever
-- service happens to write next. "What is this system configured to send
-- through" has to have one answer; a second row would make it a question about
-- ordering, and the answer would change depending on who asked.
--
-- Prisma cannot express a check constraint, so this lives here and the model
-- carries a comment pointing at it.
ALTER TABLE "mail_settings"
    ADD CONSTRAINT "mail_settings_is_singleton" CHECK ("id" = 'singleton');

-- AddForeignKey
ALTER TABLE "mail_settings" ADD CONSTRAINT "mail_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
