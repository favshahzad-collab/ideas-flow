import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { requireAdmin } from "../middleware/role";
import { validate } from "../middleware/validate";
import { asyncHandler } from "../utils/asyncHandler";
import { workflowTemplatesService } from "../services/workflow-templates.service";
import {
  createWorkflowTemplateSchema,
  updateWorkflowTemplateSchema,
  getWorkflowTemplateSchema,
  workflowTemplateIdSchema,
  listWorkflowTemplatesSchema,
} from "../schemas/workflow-templates.schema";

const router = Router();

router.use(authenticate, requireAdmin);

/**
 * GET /api/admin/workflow-templates
 * Optional query: ?isActive=true|false
 */
router.get(
  "/",
  validate(listWorkflowTemplatesSchema),
  asyncHandler(async (req, res) => {
    const { query } = listWorkflowTemplatesSchema.parse({
      query: req.query,
      params: req.params,
      body: req.body ?? {},
    });
    const templates = await workflowTemplatesService.listTemplates({
      isActive: query.isActive,
      archived: query.archived,
    });
    res.json({ templates });
  })
);

router.get(
  "/:id",
  validate(getWorkflowTemplateSchema),
  asyncHandler(async (req, res) => {
    const template = await workflowTemplatesService.getTemplate(
      req.params.id as string
    );
    res.json(template);
  })
);

router.post(
  "/",
  validate(createWorkflowTemplateSchema),
  asyncHandler(async (req, res) => {
    const template = await workflowTemplatesService.createTemplate(
      req.body,
      req.supabaseUserId!
    );
    res.status(201).json(template);
  })
);

router.patch(
  "/:id",
  validate(updateWorkflowTemplateSchema),
  asyncHandler(async (req, res) => {
    const template = await workflowTemplatesService.updateTemplate(
      req.params.id as string,
      req.body,
      req.supabaseUserId!
    );
    res.json(template);
  })
);

/*
 * There is no DELETE. A template is archived instead, which keeps it; see
 * `archiveTemplate`.
 */
router.post(
  "/:id/archive",
  validate(workflowTemplateIdSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await workflowTemplatesService.archiveTemplate(
        req.params.id as string,
        req.supabaseUserId!
      )
    );
  })
);

router.post(
  "/:id/restore",
  validate(workflowTemplateIdSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await workflowTemplatesService.restoreTemplate(
        req.params.id as string,
        req.supabaseUserId!
      )
    );
  })
);

export default router;
