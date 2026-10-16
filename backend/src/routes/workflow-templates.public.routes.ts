import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { workflowTemplatesService } from "../services/workflow-templates.service";
import { validate } from "../middleware/validate";
import { templateRouteSchema } from "../schemas/workflow-templates.schema";

const router = Router();

/**
 * Public/authenticated read-only routes for workflow templates.
 * Used by the Submit Document page so any authenticated user can pick a template.
 * No admin guard — only returns active templates.
 */
router.get(
  "/",
  authenticate,
  asyncHandler(async (_req, res) => {
    const templates = await workflowTemplatesService.listTemplates({
      isActive: true,
    });
    res.json({ templates });
  })
);

router.get(
  "/:id",
  authenticate,
  asyncHandler(async (req, res) => {
    const template = await workflowTemplatesService.getTemplate(
      req.params.id as string
    );
    if (!template.isActive) {
      // Non-admins can't see inactive templates
      res.status(404).json({ error: "Workflow template not found" });
      return;
    }
    res.json(template);
  })
);

/**
 * The route a template gives this memo, worked out by the same compiler that
 * submission uses.
 *
 * The submit screen used to keep its own copy of the compiler to preview the
 * route, and the copy drifted: it took the Yes branch when a condition failed
 * with no No branch, ordered joins by a plain walk, and dropped an approval
 * with nobody on it where submission refuses it. So the preview could show an
 * approver the memo would never reach. Asked here instead, the preview and
 * the submission cannot disagree.
 */
router.post(
  "/:id/route",
  authenticate,
  validate(templateRouteSchema),
  asyncHandler(async (req, res) => {
    const template = await workflowTemplatesService.getTemplate(
      req.params.id as string
    );
    if (!template.isActive) {
      res.status(404).json({ error: "Workflow template not found" });
      return;
    }
    const { title, description } = req.body as { title: string; description?: string };
    const steps = workflowTemplatesService.compileGraphToSteps(template.graph as never, {
      title,
      description: description ?? null,
    });
    res.json({ steps });
  })
);

export default router;
