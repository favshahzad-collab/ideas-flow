-- A fresh Microsoft sign-in can confirm it is you before a sensitive action.
ALTER TABLE "sso_logins" ADD COLUMN "purpose" VARCHAR(16) NOT NULL DEFAULT 'sign-in';
ALTER TABLE "sso_logins" ADD COLUMN "for_user_id" UUID;
