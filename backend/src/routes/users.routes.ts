import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { uploadSignature } from "../middleware/upload";
import { requireStepUp } from "../middleware/stepUp";
import { asyncHandler } from "../utils/asyncHandler";
import { authService } from "../services/auth.service";
import { usersService } from "../services/users.service";
import { validate } from "../middleware/validate";
import {
  changeOwnPasswordSchema,
  listAssignableUsersSchema,
} from "../schemas/user.schema";
import { passwordChangeLimiter } from "../middleware/rateLimit";

const router = Router();

router.use(authenticate);

router.get(
  "/",
  validate(listAssignableUsersSchema),
  asyncHandler(async (req, res) => {
    // Parsed a second time on purpose: `validate` reports the failure but
    // writes only the body back, so the checked and split `ids` are here and
    // nowhere else. Reading req.query raw again would put the unvalidated
    // strings back on the road to Prisma.
    const { query } = listAssignableUsersSchema.parse({
      query: req.query,
      params: req.params,
      body: req.body ?? {},
    });

    const result = await usersService.listAssignableUsers({
      q: query.q,
      limit: query.limit,
      ids: query.ids,
    });
    res.json(result);
  })
);

router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const result = await authService.getMe(req.supabaseUserId!);
    res.json(result);
  })
);

/**
 * Change your own password.
 *
 * The only route by which anybody but an administrator can. Without it
 * every account keeps whatever password the spreadsheet import gave it,
 * and the administrator who wrote that spreadsheet knows the credentials
 * of every person whose signature carries approval authority.
 */
router.patch(
  "/me/password",
  passwordChangeLimiter,
  validate(changeOwnPasswordSchema),
  asyncHandler(async (req, res) => {
    const result = await usersService.changeOwnPassword(
      req.supabaseUserId!,
      req.body as { currentPassword: string; newPassword: string },
      { ipAddress: req.ip }
    );
    res.json(result);
  })
);

// Changing the image every future signature uses is confirmed, like the
// other changes that act in somebody's name (middleware/stepUp).
router.post(
  "/me/signature",
  requireStepUp,
  uploadSignature.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "Signature image is required" });
      return;
    }

    const result = await usersService.uploadSignature(req.supabaseUserId!, req.file, {
      ipAddress: req.ip,
    });
    res.status(201).json(result);
  })
);

router.get(
  "/me/signature",
  asyncHandler(async (req, res) => {
    const { buffer, contentType } = await usersService.getSignature(req.supabaseUserId!);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=60");
    res.send(buffer);
  })
);

router.delete(
  "/me/signature",
  requireStepUp,
  asyncHandler(async (req, res) => {
    const result = await usersService.deleteSignature(req.supabaseUserId!, {
      ipAddress: req.ip,
    });
    res.json(result);
  })
);

export default router;
