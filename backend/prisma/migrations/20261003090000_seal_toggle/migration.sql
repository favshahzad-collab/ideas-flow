-- An administrator's switch for the digital seal on approved memos.
--
-- Until now the seal was on whenever a certificate was configured, and the
-- only way to stop it was editing the server's environment and restarting.
--
-- Additive: one column, defaulting to true, so a deployment with a stored
-- policy row keeps sealing exactly as it does today.

ALTER TABLE "workflow_settings" ADD COLUMN "seal_approved_memos" BOOLEAN NOT NULL DEFAULT true;
