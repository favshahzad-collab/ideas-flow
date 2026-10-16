-- A ledger entry per signature applied: who (the entry's actor), how the mark
-- was made, when they confirmed it was them, and the statement they agreed to.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DOCUMENT_SIGNED';
