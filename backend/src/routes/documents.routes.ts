import { NextFunction, Request, Response, Router } from "express";
import { authenticate } from "../middleware/auth";
import { requireAdmin } from "../middleware/role";
import { requireSigningConfirmationWhenSigned, requireStepUp } from "../middleware/stepUp";
import type { SigningAttestation } from "../lib/signingAttestation";
import { validate } from "../middleware/validate";
import { errors } from "../lib/errors";
import { asyncHandler } from "../utils/asyncHandler";
import {
  checkDocumentUploadContent,
  uploadDocumentWithSupporting,
} from "../middleware/upload";
import { documentsService } from "../services/documents.service";
import {
  documentFileSchema,
  documentIdParamsSchema,
  withdrawDocumentSchema,
  listDocumentsSchema,
  supportingDocumentFileSchema,
  updateDocumentSchema,
  createDocumentSchema,
} from "../schemas/documents.schema";

const router = Router();

function getUploadedFiles(req: Express.Request): {
  mainFile?: Express.Multer.File;
  supportingFiles: Express.Multer.File[];
} {
  const files = req.files as
    | { [fieldname: string]: Express.Multer.File[] }
    | undefined;

  return {
    mainFile: files?.file?.[0],
    supportingFiles: files?.supportingFiles ?? [],
  };
}

/**
 * The two structured parts of a submission travel as JSON strings inside the
 * multipart form, so they have to be parsed before the schema can look at
 * them. Submit and resubmit share this middleware rather than each keeping a
 * copy: they are the two halves of one screen, and a copy that fell behind
 * would have them disagreeing about what they accept.
 */
const MULTIPART_JSON_FIELDS = {
  approvalChain: "approval chain",
  signature: "signature",
  // A memo typed in the portal travels the same way. Without this it reaches
  // the schema as a string and is refused as "expected object, received
  // string" - which is true, and tells the preparer nothing.
  body: "memo body",
  // Notes placed on the page travel the same way, and for the same reason.
  notes: "notes on the page",
  // The supporting files taken off a revision, too.
  removeSupportingIds: "supporting files to remove",
} as const;

/**
 * What the route proved about a preparer's signature, when one was sent.
 * `requireSigningConfirmationWhenSigned` set the time; the schema required
 * the tick box.
 */
function signingAttestationOf(req: Request): SigningAttestation | undefined {
  return req.signingConfirmedAt
    ? {
        identityConfirmedAt: req.signingConfirmedAt,
        identityConfirmedBy: req.signingConfirmedBy ?? null,
        consented: true,
        ipAddress: req.ip,
      }
    : undefined;
}

function parseMultipartJsonFields(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  const body = (req.body ?? {}) as Record<string, unknown>;

  for (const [field, label] of Object.entries(MULTIPART_JSON_FIELDS)) {
    const raw = body[field];
    if (typeof raw !== "string" || raw.length === 0) {
      continue;
    }

    try {
      body[field] = JSON.parse(raw) as unknown;
    } catch {
      // Name the part. The preparer is looking at one form with two hidden
      // fields in it, and "one of these two is malformed" tells them nothing
      // they can act on; which one does.
      next(
        errors.badRequest(
          `The ${label} could not be read. Reload the page and submit again.`
        )
      );
      return;
    }
  }

  next();
}

router.get(
  "/",
  authenticate,
  validate(listDocumentsSchema),
  asyncHandler(async (req, res) => {
    // Re-parsed here because `validate` cannot write the query back - Express
    // 5 exposes req.query through a getter - which is the same reason the
    // audit and notification lists parse twice.
    const { query } = listDocumentsSchema.parse({
      query: req.query,
      params: req.params,
      body: (req.body ?? {}) as unknown,
    });

    const result = await documentsService.getDocuments(
      req.supabaseUserId!,
      query
    );

    res.json(result);
  })
);

// Organisation-wide view of everything in flight. Administrators only.
router.get(
  "/oversight",
  authenticate,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await documentsService.getApprovalOversight());
  })
);

router.get(
  "/pending-count",
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await documentsService.getPendingApprovalCount(
      req.supabaseUserId!
    );
    res.json(result);
  })
);

router.get(
  "/:id/file",
  authenticate,
  validate(documentFileSchema),
  asyncHandler(async (req, res) => {
    const { buffer, fileName } = await documentsService.getDocumentFile(
      req.params.id as string,
      req.supabaseUserId!,
      req.query.reason === "view" ? "VIEW" : "DOWNLOAD"
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    res.send(buffer);
  })
);

router.get(
  "/:id/supporting/:attachmentId/file",
  authenticate,
  validate(supportingDocumentFileSchema),
  asyncHandler(async (req, res) => {
    const { buffer, fileName, contentType } =
      await documentsService.getSupportingDocumentFile(
        req.params.id as string,
        req.params.attachmentId as string,
        req.supabaseUserId!
      );

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(fileName)}"`
    );
    res.send(buffer);
  })
);

/*
 * What changed between the version in flight and the one before it. The same
 * access as opening the document: it is a reading of text the caller could
 * already open version by version, laid side by side.
 */
router.get(
  "/:id/changes",
  authenticate,
  validate(documentIdParamsSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await documentsService.getVersionChanges(
        req.params.id as string,
        req.supabaseUserId!
      )
    );
  })
);

router.get(
  "/:id",
  authenticate,
  validate(documentIdParamsSchema),
  asyncHandler(async (req, res) => {
    const document = await documentsService.getDocumentById(
      req.params.id as string,
      req.supabaseUserId!
    );

    res.json(document);
  })
);

router.post(
  "/",
  authenticate,
  uploadDocumentWithSupporting,
  parseMultipartJsonFields,
  requireSigningConfirmationWhenSigned,
  validate(createDocumentSchema),
  checkDocumentUploadContent,
  asyncHandler(async (req, res) => {
    const { mainFile, supportingFiles } = getUploadedFiles(req);

    /*
     * One route, two ways of arriving at a PDF.
     *
     * A memo typed in the portal carries its body instead of a file and the
     * server draws it; an uploaded one carries the file and always has. The
     * schema has already refused a request that is half of each, so the only
     * thing left to catch here is a submission with neither.
     */
    if (!mainFile && !req.body.body) {
      throw errors.badRequest("Attach the document PDF.");
    }

    const result = await documentsService.createDocument(
      req.body,
      mainFile ?? null,
      req.supabaseUserId!,
      supportingFiles,
      signingAttestationOf(req)
    );
    res.status(201).json(result);
  })
);

router.post(
  "/:id/print",
  authenticate,
  validate(documentIdParamsSchema),
  asyncHandler(async (req, res) => {
    await documentsService.printDocument(
      req.params.id as string,
      req.supabaseUserId!
    );

    // Nothing to send back: the caller already has the file it is printing,
    // and what this call is for is the row saying the approved memo was put
    // on paper. A body here would only invite a client to render it.
    res.status(204).end();
  })
);

/**
 * Withdraw: the preparer takes their memo back, with a reason. It stays on
 * record and can be resubmitted. Replaces deleting, which the fit-gap review
 * retired - nothing that entered a workflow disappears without a reason.
 */
router.post(
  "/:id/withdraw",
  authenticate,
  validate(withdrawDocumentSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await documentsService.withdrawDocument(
        req.params.id as string,
        req.supabaseUserId!,
        (req.body as { reason: string }).reason
      )
    );
  })
);

/**
 * Cancel an abandoned memo, by an administrator with the power to. Asks for
 * the "confirm it's you" every other change to who signs asks for.
 */
router.post(
  "/:id/cancel",
  authenticate,
  requireAdmin,
  requireStepUp,
  validate(withdrawDocumentSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await documentsService.cancelDocument(
        req.params.id as string,
        req.supabaseUserId!,
        (req.body as { reason: string }).reason
      )
    );
  })
);

/**
 * Leave as rejected: the preparer of a rejected memo decides not to send it
 * round again. Closes it for good; it stays on record as rejected.
 */
router.post(
  "/:id/leave-rejected",
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(
      await documentsService.leaveRejected(req.params.id as string, req.supabaseUserId!)
    );
  })
);

router.patch(
  "/:id",
  authenticate,
  uploadDocumentWithSupporting,
  parseMultipartJsonFields,
  requireSigningConfirmationWhenSigned,
  validate(updateDocumentSchema),
  checkDocumentUploadContent,
  asyncHandler(async (req, res) => {
    const { mainFile, supportingFiles } = getUploadedFiles(req);
    const result = await documentsService.updateDocument(
      req.params.id as string,
      req.body,
      mainFile,
      req.supabaseUserId!,
      supportingFiles,
      signingAttestationOf(req)
    );

    res.json(result);
  })
);

export default router;
