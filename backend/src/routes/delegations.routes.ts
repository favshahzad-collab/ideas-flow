import { ACCESS_SELECT, capabilitiesOf } from "../lib/capabilities";
import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { requireStepUpWhen } from "../middleware/stepUp";
import { validate } from "../middleware/validate";
import { asyncHandler } from "../utils/asyncHandler";
import { errors } from "../lib/errors";
import { prisma } from "../prisma";
import { delegationsService, type Actor } from "../services/delegations.service";
import {
  createDelegationSchema,
  listDelegationsSchema,
  revokeDelegationSchema,
  type CreateDelegationBody,
} from "../schemas/delegations.schema";

const router = Router();

router.use(authenticate);

/**
 * Who is asking, and whether they may act for other people.
 *
 * Read per request rather than trusted from the token: an account demoted out
 * of the administrator role should stop being able to arrange other people's
 * approvals immediately, not when their session expires.
 */
async function actorFor(userId: string): Promise<Actor> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: ACCESS_SELECT,
  });

  if (!user) {
    throw errors.unauthorized("Sign in again.");
  }

  // Arranging cover for somebody else is people administration: the power
  // that comes with managing people, not with merely being an administrator.
  return { id: userId, isAdministrator: capabilitiesOf(user).includes("users.manage") };
}

router.get(
  "/",
  validate(listDelegationsSchema),
  asyncHandler(async (req, res) => {
    const actor = await actorFor(req.supabaseUserId!);
    const requested =
      typeof req.query.userId === "string" ? req.query.userId : undefined;

    if (requested && requested !== actor.id && !actor.isAdministrator) {
      throw errors.forbidden("You can only read your own delegations.");
    }

    res.json(await delegationsService.listForUser(requested ?? actor.id));
  })
);

/*
 * Cover arranged for somebody else hands their signature to a third person,
 * so it asks the arranger to confirm it is them. Arranging one's own cover
 * does not: it is the everyday case, and the person is handing over only
 * what is already theirs.
 */
const forSomebodyElse = (req: { body?: unknown; supabaseUserId?: string }) => {
  const body = (req.body ?? {}) as { delegatorId?: unknown };
  return typeof body.delegatorId === "string" && body.delegatorId !== req.supabaseUserId;
};

router.post(
  "/",
  validate(createDelegationSchema),
  requireStepUpWhen(forSomebodyElse),
  asyncHandler(async (req, res) => {
    /*
     * `validate` above has already parsed this body and written the coerced
     * value back onto the request. Parsing it a second time here was a bug
     * that made the whole feature unusable: `startsAt` and `endsAt` are Date
     * objects by now, the schema that produced them expects strings, and the
     * ZodError thrown inside the handler - past the middleware that turns
     * those into a 400 - came out as a 500. Every delegation the panel sent
     * named an end date, so every one of them failed.
     */
    const body = req.body as CreateDelegationBody;

    const delegation = await delegationsService.create(
      body,
      await actorFor(req.supabaseUserId!),
      req.ip
    );

    res.status(201).json({
      message: "Delegation saved.",
      delegation,
    });
  })
);

router.delete(
  "/:id",
  validate(revokeDelegationSchema),
  // Ending cover one is not part of - neither giving nor holding it - is an
  // administrator acting on other people's signatures.
  requireStepUpWhen(async (req) => {
    const delegation = await prisma.delegation.findUnique({
      where: { id: req.params.id as string },
      select: { delegatorId: true, delegateId: true },
    });
    return Boolean(
      delegation &&
        delegation.delegatorId !== req.supabaseUserId &&
        delegation.delegateId !== req.supabaseUserId
    );
  }),
  asyncHandler(async (req, res) => {
    const delegation = await delegationsService.revoke(
      req.params.id as string,
      await actorFor(req.supabaseUserId!),
      req.ip
    );

    res.json({
      message: "Delegation ended.",
      delegation,
    });
  })
);

export default router;
