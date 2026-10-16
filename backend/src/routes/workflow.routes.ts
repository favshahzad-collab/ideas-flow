import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { workflowService } from "../services/workflow.service";

const router = Router();

router.get(
  "/documents/:id/workflow",
  authenticate,
  asyncHandler(async (req, res) => {
    const workflow = await workflowService.getWorkflow(
      req.params.id as string,
      req.supabaseUserId!
    );

    res.json(workflow);
  })
);

export default router;