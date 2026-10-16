import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { requireAdmin } from "../middleware/role";
import {
  requireDecisionConfirmation,
  requireSigningConfirmation,
  requireStepUp,
} from "../middleware/stepUp";
import { validate } from "../middleware/validate";
import { asyncHandler } from "../utils/asyncHandler";
import { approvalService } from "../services/approval.service";
import {
  approveDocumentSchema,
  reassignStepSchema,
  rejectDocumentSchema,
  remindApproverSchema,
  requestRevisionSchema,
  skipWorkflowStepSchema,
} from "../schemas/approval.schema";
import { remindersService } from "../services/reminders.service";

const router = Router();

/**
 * Ask whoever is holding this memo to look at it.
 *
 * Sits with the approval actions because it is about the step rather than the
 * document, but it changes nothing: no state moves, and the only trace is a
 * notice, a mail and the audit row that makes the cooldown honest.
 */
router.post(
  "/documents/:id/remind",
  authenticate,
  validate(remindApproverSchema),
  asyncHandler(async (req, res) => {
    const result = await remindersService.remind(
      req.params.id as string,
      req.supabaseUserId!,
      req.ip
    );

    res.json(result);
  })
);

router.post(
  "/documents/:id/approve",
  authenticate,
  requireSigningConfirmation,
  validate(approveDocumentSchema),
  asyncHandler(async (req, res) => {
    const result = await approvalService.approve(
      req.params.id as string,
      req.supabaseUserId!,
      req.body,
      req.ip,
      {
        identityConfirmedAt: req.signingConfirmedAt!,
        identityConfirmedBy: req.signingConfirmedBy ?? null,
        consented: true,
      }
    );

    res.json(result);
  })
);

router.post(
  "/documents/:id/reject",
  authenticate,
  requireDecisionConfirmation,
  validate(rejectDocumentSchema),
  asyncHandler(async (req, res) => {
    const result = await approvalService.reject(
      req.params.id as string,
      req.supabaseUserId!,
      req.body,
      req.ip,
      req.signingConfirmedAt
    );

    res.json(result);
  })
);

router.post(
  "/documents/:id/request-revision",
  authenticate,
  requireDecisionConfirmation,
  validate(requestRevisionSchema),
  asyncHandler(async (req, res) => {
    const result = await approvalService.requestRevision(
      req.params.id as string,
      req.supabaseUserId!,
      req.body,
      req.ip,
      req.signingConfirmedAt
    );

    res.json(result);
  })
);

/**
 * Hand an in-flight step to a different approver.
 *
 * `requireAdmin` before `validate`, so an ordinary user is refused for being
 * an ordinary user rather than for the shape of their request - and the
 * refusal does not depend on them having filled the form in correctly.
 *
 * The service checks the capability again. Not defensiveness for its own
 * sake: every test of the rules calls the service directly, and a rule that
 * only exists on the route is a rule those tests cannot see.
 */
router.post(
  "/documents/:id/reassign-step",
  authenticate,
  requireAdmin,
  requireStepUp,
  validate(reassignStepSchema),
  asyncHandler(async (req, res) => {
    const result = await approvalService.reassignStep(
      req.params.id as string,
      req.supabaseUserId!,
      req.body,
      req.ip
    );

    res.json(result);
  })
);

router.post(
  "/documents/:id/skip-step",
  authenticate,
  requireDecisionConfirmation,
  validate(skipWorkflowStepSchema),
  asyncHandler(async (req, res) => {
    const result = await approvalService.skipWorkflowStep(
      req.params.id as string,
      req.supabaseUserId!,
      req.body,
      req.ip,
    );

    res.json(result);
  })
);

export default router;
