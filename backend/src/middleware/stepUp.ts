import type { NextFunction, Request, Response } from "express";
import { errors } from "../lib/errors";
import { verifyToken, type IdentityMethod } from "../lib/tokens";
import { prisma } from "../prisma";

/**
 * Whether this request carries a confirmation, made in the last five minutes,
 * by the person the request is signed in as.
 *
 * The confirmation arrives in its own header rather than in the body, so the
 * request schemas - which refuse fields they do not know - need not change for
 * every route that asks for one. It must belong to the signed-in person, and
 * it must postdate the last "sign out everywhere", so ending somebody's
 * sessions also ends a confirmation they were holding.
 */
export async function stepUpConfirmed(request: Request): Promise<boolean> {
  return (await stepUpConfirmedAt(request)) !== null;
}

/** When the confirmation this request carries was made, or null without one. */
async function stepUpConfirmedAt(request: Request): Promise<Date | null> {
  return (await stepUpConfirmation(request))?.at ?? null;
}

/** The confirmation this request carries - when, and how - or null. */
async function stepUpConfirmation(
  request: Request
): Promise<{ at: Date; how: IdentityMethod | null } | null> {
  const header = request.get("x-step-up");
  const userId = request.supabaseUserId;
  if (!header || !userId) return null;

  const claim = await verifyToken(header, "step-up");
  if (!claim || claim.id !== userId) return null;

  const account = await prisma.user.findUnique({
    where: { id: userId },
    select: { sessionsValidFrom: true },
  });

  return account && claim.issuedAt.getTime() >= account.sessionsValidFrom.getTime()
    ? { at: claim.issuedAt, how: claim.how }
    : null;
}

/** The refusal the app answers by asking for the password or a code. */
export const stepUpRequired = () =>
  errors.forbidden(
    "Confirm it is you to make this change: enter your password or a code from your authenticator app.",
    "STEP_UP_REQUIRED"
  );

/** For routes where every request needs a confirmation. After `authenticate`. */
export async function requireStepUp(
  request: Request,
  _response: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!(await stepUpConfirmed(request))) throw stepUpRequired();
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Before any signature is applied: the signer proves it is them.
 *
 * A signed-in browser is not the same thing as the person. A tab left open on
 * a shared desk, or a stolen session, would otherwise be enough to put
 * somebody's signature on a memo. The same five-minute confirmation the
 * sensitive administration changes use is asked for here, so one password or
 * code covers several signatures made in a row.
 *
 * Its own code, so the app can say what the confirmation is for - "to sign",
 * not "to change how people sign in". When it was made goes on the request
 * and into the signature's audit record.
 */
export const signingConfirmationRequired = () =>
  errors.forbidden(
    "Confirm it is you to sign: enter your password or a code from your authenticator app.",
    "STEP_UP_REQUIRED_TO_SIGN"
  );

async function confirmSigning(request: Request): Promise<void> {
  const confirmation = await stepUpConfirmation(request);
  if (!confirmation) throw signingConfirmationRequired();
  request.signingConfirmedAt = confirmation.at;
  request.signingConfirmedBy = confirmation.how;
}

/** For a route that always applies a signature. After `authenticate`. */
export async function requireSigningConfirmation(
  request: Request,
  _response: Response,
  next: NextFunction
): Promise<void> {
  try {
    await confirmSigning(request);
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Before a decision that is not a signature: rejecting a memo, sending it
 * back, or skipping a step.
 *
 * A rejection ends a memo as surely as the last signature completes it, and
 * "it was not me, somebody used my open laptop" is as available for one as
 * for the other. So a decision asks for the same five-minute confirmation a
 * signature does, and when it was made goes into the decision's audit row.
 *
 * Its own code, so the app can say "to reject or send back" rather than "to
 * sign" - nobody is signing anything.
 */
export const decisionConfirmationRequired = () =>
  errors.forbidden(
    "Confirm it is you to record this decision: enter your password or a code from your authenticator app.",
    "STEP_UP_REQUIRED_TO_DECIDE"
  );

/** For a route that records a decision on a memo. After `authenticate`. */
export async function requireDecisionConfirmation(
  request: Request,
  _response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const confirmation = await stepUpConfirmation(request);
    if (!confirmation) throw decisionConfirmationRequired();
    request.signingConfirmedAt = confirmation.at;
    request.signingConfirmedBy = confirmation.how;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * For a route where only some requests are sensitive - a delegation arranged
 * for somebody else, say, where arranging one's own cover is not. `sensitive`
 * decides from the request; a request it calls sensitive needs the same
 * confirmation `requireStepUp` asks for.
 */
export function requireStepUpWhen(
  sensitive: (request: Request) => boolean | Promise<boolean>
) {
  return async (request: Request, _response: Response, next: NextFunction) => {
    try {
      if ((await sensitive(request)) && !(await stepUpConfirmed(request))) {
        throw stepUpRequired();
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * For a route that applies a signature only when one is sent - submitting or
 * resubmitting a memo, where the preparer signs if the policy asks them to.
 * After the multipart fields are parsed, so `signature` is there to see.
 */
export async function requireSigningConfirmationWhenSigned(
  request: Request,
  _response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.signature !== undefined && body.signature !== null && body.signature !== "") {
      await confirmSigning(request);
    }
    next();
  } catch (error) {
    next(error);
  }
}
