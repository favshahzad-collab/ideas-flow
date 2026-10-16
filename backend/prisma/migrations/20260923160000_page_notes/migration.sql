-- Notes placed on the page rather than typed into the body.
--
-- Recorded for the same reason `signature_slots` is: the artefact is
-- immutable and hashed, so what was drawn on it has to be answerable later
-- without redrawing the memo as it would look today.
--
-- Null everywhere it is added, which is correct: no memo filed before this
-- carried a note, and each must keep drawing exactly as it did.
--
-- Deliberately not `document_versions.notes`, which already exists and holds
-- a line of prose about the version.
ALTER TABLE "document_versions" ADD COLUMN "page_notes_json" JSONB;
ALTER TABLE "memo_drafts" ADD COLUMN "page_notes_json" JSONB;
