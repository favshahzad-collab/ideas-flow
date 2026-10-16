-- The paper a memo is drawn on, and the page each filed version used.
--
-- Two separate things, and the difference is the whole point.
--
-- `branding_settings` gains the organisation's CURRENT choice. It sits beside
-- the organisation name and the letterhead because it is the same kind of
-- answer: how a generated memo looks. Every column is nullable, and null means
-- the delivered default - A4 with ~0.6in sides and ~0.8in top, which is what
-- every memo filed before today was drawn with. A deployment that never opens
-- the settings screen keeps exactly the document it had.
--
-- `document_versions` gains the page that version was ACTUALLY drawn on. A
-- memo is a write-once artefact and the audit trail cites its checksum, so the
-- renderer must never re-draw an old memo using a setting somebody changed
-- afterwards - the reprint would no longer match the hash it is filed under.
-- Null everywhere it is added, which is correct: every existing version was
-- drawn on the default page, and null reads as exactly that.
--
-- Deliberately one JSONB rather than five more columns on `document_versions`:
-- what is recorded is a snapshot to be handed back to the renderer whole, not
-- something any query filters or aggregates on.

ALTER TABLE "branding_settings"
  ADD COLUMN "page_paper"         VARCHAR(16),
  ADD COLUMN "page_margin_left"   DOUBLE PRECISION,
  ADD COLUMN "page_margin_right"  DOUBLE PRECISION,
  ADD COLUMN "page_margin_top"    DOUBLE PRECISION,
  ADD COLUMN "page_margin_bottom" DOUBLE PRECISION;

ALTER TABLE "document_versions"
  ADD COLUMN "page_setup_json" JSONB;
