-- Local password authentication.
-- Authentication moved off Supabase Auth onto this database, so the user row
-- now carries its own scrypt password hash. Nullable: an account can exist
-- before a password is set, and login refuses any user without one.
ALTER TABLE "users" ADD COLUMN "password_hash" TEXT;
