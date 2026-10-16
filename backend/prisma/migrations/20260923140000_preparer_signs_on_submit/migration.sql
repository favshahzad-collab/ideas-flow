-- Whether submitting a document also means signing it.
--
-- Default true, which is how this has always worked: the preparer signs at
-- the moment of submission and takes the first column of a typed memo's
-- printed strip. Every deployment upgrading into this column keeps exactly
-- the behaviour it had, and every document already filed was signed that way.
--
-- An organisation whose submitters forward documents for approval rather than
-- authoring them turns it off, and then nobody signs until the first approver
-- does. A memo type may override it either way; this is the answer for an
-- uploaded document, which has no type to ask.
ALTER TABLE "workflow_settings"
  ADD COLUMN "preparer_signs_on_submit" BOOLEAN NOT NULL DEFAULT true;
