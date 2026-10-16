import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { asyncHandler } from "../utils/asyncHandler";
import { commentsService } from "../services/comments.service";
import { createCommentSchema } from "../schemas/comments.schema";

const router = Router();

router.get(
  "/documents/:id/comments",
  authenticate,
  asyncHandler(async (req, res) => {
    const comments = await commentsService.getComments(
      req.params.id as string,
      req.supabaseUserId!
    );

    res.json({
      comments,
    });
  })
);

router.post(
  "/documents/:id/comments",
  authenticate,
  validate(createCommentSchema),
  asyncHandler(async (req, res) => {
    const comment = await commentsService.createComment(
      req.params.id as string,
      req.supabaseUserId!,
      req.body
    );

    res.status(201).json({
      message: "Comment added successfully.",
      comment,
    });
  })
);

export default router;