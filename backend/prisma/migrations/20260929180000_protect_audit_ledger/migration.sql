-- The audit ledger is append-only, and until now only the application said so.
--
-- Nothing in the API updates or deletes an audit row except the sealer, and
-- the hash chain catches a row that was changed afterwards - but catching is
-- after the fact, and a stray UPDATE from a console, a script, or a bug would
-- still have run. These triggers make the database refuse it.
--
-- What is still allowed, because the sealer does it:
--   an unsealed row (seq IS NULL) being given its seq, hash, prev_hash and
--   sealed_at, with every other column left exactly as it was.
-- What is refused:
--   any other UPDATE, including re-sealing or unsealing a row; any DELETE;
--   and, on ledger_checkpoints, any UPDATE or DELETE at all.
--
-- The row is compared as JSON minus the four seal columns, so a column added
-- later is protected without anybody remembering to add it here.
--
-- Not covered: TRUNCATE (row triggers do not fire for it; the test suite
-- empties tables that way), and the table owner, who can disable a trigger.
-- The hash chain is what catches those. See DEPLOY.md, "Protecting the audit
-- ledger in the database".

CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_logs is append-only: rows cannot be deleted (id %)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.seq IS NULL
     AND OLD.hash IS NULL
     AND OLD.prev_hash IS NULL
     AND OLD.sealed_at IS NULL
     AND NEW.seq IS NOT NULL
     AND NEW.hash IS NOT NULL
     AND NEW.sealed_at IS NOT NULL
     AND (to_jsonb(NEW) - 'seq' - 'hash' - 'prev_hash' - 'sealed_at')
       = (to_jsonb(OLD) - 'seq' - 'hash' - 'prev_hash' - 'sealed_at')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audit_logs is append-only: only sealing an unsealed row is allowed (id %)', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

CREATE OR REPLACE FUNCTION ledger_checkpoints_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_checkpoints is append-only: rows cannot be changed or deleted (id %)', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER ledger_checkpoints_append_only
  BEFORE UPDATE OR DELETE ON ledger_checkpoints
  FOR EACH ROW EXECUTE FUNCTION ledger_checkpoints_append_only();
