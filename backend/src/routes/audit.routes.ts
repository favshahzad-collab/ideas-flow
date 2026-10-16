import { Router, Response } from "express";
import { authenticate } from "../middleware/auth";
import { requireAdmin } from "../middleware/role";
import { requireStepUp } from "../middleware/stepUp";
import { validate } from "../middleware/validate";
import { asyncHandler } from "../utils/asyncHandler";
import { auditService } from "../services/audit.service";
import { ledgerService } from "../services/ledger.service";
import {
  exportDocumentAuditSchema,
  getAdministrationAuditSchema,
  getAllDocumentsAuditSchema,
  getAuditHistorySchema,
} from "../schemas/audit.schema";

const router = Router();

function sendCsv(res: Response, filename: string, csv: string) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}

/**
 * Where the seal on the audit trail has reached.
 *
 * Counts and one digest - nothing about what any record says - so it is open
 * to anyone signed in. The trail is the one screen where a claim about
 * integrity has to be checkable by the people relying on it, not only by the
 * administrator who would be the one tampering.
 */
router.get(
  "/audit/ledger",
  authenticate,
  asyncHandler(async (_req, res) => {
    res.json(await ledgerService.summary());
  })
);

/**
 * Read the whole chain back and recompute it.
 *
 * A POST because it does two things that are not reads: it seals whatever is
 * outstanding first, so the answer covers everything written up to now, and
 * it walks every record in the table. Administrators only - not because the
 * answer is sensitive, but because the work is.
 */
router.post(
  "/audit/ledger/verify",
  authenticate,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    await ledgerService.seal();
    res.json(await ledgerService.verify());
  })
);

/**
 * What was done to the system itself, rather than to any memo.
 *
 * Administrators only, and not scoped to the caller: it is the record of what
 * administrators did, so showing each one only their own rows would defeat
 * the reason for keeping it.
 */
/*
 * The same row, named for the audit trail: `entity_id` is a UUID and the
 * ledger has no row of its own. A constant, so every export groups under one
 * entity. Mail settings took ...0001 and workflow settings ...0002.
 */
const LEDGER_AUDIT_ID = "00000000-0000-4000-8000-000000000003";

/**
 * The whole sealed chain, for an auditor to check outside this application
 * with `scripts/verify-ledger-export.mjs`. It carries every record's content,
 * IP addresses included, so it is confirmed like any change made in
 * somebody's name, and taking it is itself recorded.
 */
router.get(
  "/audit/ledger/export",
  authenticate,
  requireAdmin,
  requireStepUp,
  asyncHandler(async (req, res) => {
    // Everything written so far, so the file ends where the trail does now.
    await ledgerService.seal();

    const day = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="ideas-flow-ledger-${day}.jsonl"`
    );

    const { records } = await ledgerService.exportChain((line) => {
      res.write(`${line}\n`);
    });
    res.end();

    await auditService.createAuditLog({
      actorId: req.supabaseUserId!,
      action: "LEDGER_EXPORTED",
      entityType: "Ledger",
      entityId: LEDGER_AUDIT_ID,
      newValue: { records },
      ipAddress: req.ip,
    });
  })
);

router.get(
  "/audit/administration",
  authenticate,
  requireAdmin,
  validate(getAdministrationAuditSchema),
  asyncHandler(async (req, res) => {
    const { query } = getAdministrationAuditSchema.parse({
      query: req.query,
      params: req.params,
      body: req.body ?? {},
    });

    res.json(await auditService.getAdministrationActivity(query));
  })
);

router.get(
  "/audit/documents/export",
  authenticate,
  asyncHandler(async (req, res) => {
    const csv = await auditService.exportAllDocumentsAuditCsv(
      req.supabaseUserId!
    );

    sendCsv(res, "documents-audit.csv", csv);
  })
);

router.get(
  "/audit/documents",
  authenticate,
  validate(getAllDocumentsAuditSchema),
  asyncHandler(async (req, res) => {
    const { query } = getAllDocumentsAuditSchema.parse({
      query: req.query,
      params: req.params,
      body: req.body ?? {},
    });

    // `total` and `returned` travel with the rows so the ledger screen can say
    // which slice of the trail it is showing. It used to be handed a window and
    // no count, and printed the window's size as the number of entries there
    // are - which reads as "this is all of it" on the one screen where it must
    // not.
    const page = await auditService.getAllDocumentsAuditHistory(
      req.supabaseUserId!,
      { limit: query.limit, offset: query.offset }
    );

    res.json(page);
  })
);

router.get(
  "/documents/:id/audit/export",
  authenticate,
  validate(exportDocumentAuditSchema),
  asyncHandler(async (req, res) => {
    const documentId = req.params.id as string;
    const csv = await auditService.exportDocumentAuditCsv(
      documentId,
      req.supabaseUserId!
    );

    sendCsv(res, `document-audit-${documentId}.csv`, csv);
  })
);

router.get(
  "/documents/:id/audit",
  authenticate,
  validate(getAuditHistorySchema),
  asyncHandler(async (req, res) => {
    const history = await auditService.getDocumentAuditHistory(
      req.params.id as string,
      req.supabaseUserId!
    );

    res.json({
      auditHistory: history,
    });
  })
);

export default router;
