-- Changing mail configuration is an administrative act on a live system, so it
-- belongs in the same trail as everything else. Two values rather than one:
-- handing mail back to the environment is a different decision from pointing it
-- somewhere new, and reads differently when somebody is working out why notices
-- stopped arriving.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MAIL_SETTINGS_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MAIL_SETTINGS_CLEARED';
