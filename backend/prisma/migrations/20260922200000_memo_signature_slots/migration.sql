-- Where each signatory's signature belongs on a generated memo's PDF.
--
-- Additive and nullable: every existing version row is an uploaded memo with
-- no printed signature strip, and null is the correct answer for all of them.
ALTER TABLE "document_versions" ADD COLUMN "signature_slots" JSONB;
