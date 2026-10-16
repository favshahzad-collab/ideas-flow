-- Two tiers of administrator.
--
-- A Super Administrator holds every power, including managing administrators
-- and the security settings (single sign-on, mail). An Administrator holds
-- only the powers a Super Administrator has given them, one by one.
--
-- users.is_super_admin   the top tier; meaningful with login_role ADMINISTRATOR
-- users.admin_powers     capability ids given to a limited administrator
-- ADMIN_POWERS_CHANGED   a Super Administrator changed somebody's tier or powers
--
-- Nobody loses access: every administrator today becomes a Super
-- Administrator, as they already held every power. A Super Administrator
-- then lowers whoever should have less.

ALTER TABLE "users" ADD COLUMN "is_super_admin" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "admin_powers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "users" SET "is_super_admin" = true WHERE "login_role" = 'ADMINISTRATOR';

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_POWERS_CHANGED';
