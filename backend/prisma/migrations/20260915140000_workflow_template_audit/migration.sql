-- Making, rewriting and removing the chain a memo is submitted against.
--
-- All three were already recorded, and all three said the wrong thing. Making
-- and rewriting a template both wrote `APPROVAL_CHAIN_CREATED`, which means a
-- chain was built on a document; so the trail could not tell a template that
-- was created from one that was rewritten, and the history of a template read
-- as though it had been created three times. Removing one wrote
-- `DOCUMENT_DELETED` against something that is not a document.
--
-- A template is what routes every memo of its kind, so "who changed this, and
-- when" is a governance question. It had an answer. The answer was wrong.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WORKFLOW_TEMPLATE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WORKFLOW_TEMPLATE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WORKFLOW_TEMPLATE_DELETED';
