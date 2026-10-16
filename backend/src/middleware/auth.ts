import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/tokens";
import { errors } from "../lib/errors";
import { prisma } from "../prisma";
import { adminTwoFactorRequired } from "../lib/env";

/**
 * What an administrator without two-step sign-in may still reach: who they
 * are, the two steps of setting it up, and the way out.
 */
const ENROLMENT_ONLY = new Set([
  "GET /api/auth/me",
  "GET /api/auth/2fa",
  "POST /api/auth/2fa/setup",
  "POST /api/auth/2fa/activate",
  "POST /api/auth/sign-out",
]);

declare global {
  namespace Express {
    interface Request {
      /**
       * Id of the authenticated user. Named `supabaseUserId` historically;
       * the token is now issued locally, but the name is kept so every route
       * that reads it keeps working.
       */
      supabaseUserId?: string;
      /**
       * Set by `requireSigningConfirmation`: when the signer last confirmed
       * it was them. Present only on a request that applies a signature.
       */
      signingConfirmedAt?: Date;
      /** How they confirmed it, where the confirmation says. */
      signingConfirmedBy?: import("../lib/tokens").IdentityMethod | null;
    }
  }
}

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      throw errors.unauthorized("No token provided");
    }

    const token = authHeader.substring(7);
    const claim = await verifyToken(token, "access");

    if (!claim) {
      throw errors.unauthorized("Invalid or expired token");
    }

    /*
     * One indexed read, on every request, and it is worth it.
     *
     * Without it a signed token is simply true for its full two hours: an
     * account deleted this morning still approves memos until lunchtime, and
     * a password changed because a laptop was stolen changes nothing the
     * thief is holding. A JWT cannot be recalled, so the only place the
     * answer can live is the account it names - which means asking.
     */
    const account = await prisma.user.findUnique({
      where: { id: claim.id },
      select: { sessionsValidFrom: true, loginRole: true, totpActivatedAt: true },
    });

    if (!account) {
      throw errors.unauthorized("Invalid or expired token");
    }

    // Exact, because the token carries the millisecond it was issued at. A
    // token minted after the cutoff - by signing in again straight away -
    // passes; one minted before it does not, with no second of grace in which
    // a revoked session still works.
    if (claim.issuedAt.getTime() < account.sessionsValidFrom.getTime()) {
      throw errors.unauthorized("This session has been ended. Sign in again.");
    }

    /*
     * An administrator without two-step sign-in may do one thing: set it up.
     *
     * Checked here, on every request, rather than by refusing the sign-in. A
     * refused sign-in has nowhere to send the person - setting up the second
     * factor needs a session - and a separate half-signed-in state would be a
     * second session model to get right. So they are signed in, and every
     * request but the few that enrol is refused in words the app turns into
     * the setup screen. The moment the factor is on, the same session works.
     *
     * It follows the account, not the sign-in: promoting somebody, or an
     * administrator losing their phone and having it reset, closes the rest of
     * the product to them on their next request until they enrol.
     */
    if (
      account.loginRole === "ADMINISTRATOR" &&
      !account.totpActivatedAt &&
      adminTwoFactorRequired() &&
      !ENROLMENT_ONLY.has(`${req.method} ${req.baseUrl}${req.path}`)
    ) {
      throw errors.forbidden(
        "Administrators must set up two-step sign-in before doing anything else. Set it up to continue.",
        "TWO_FACTOR_ENROLMENT_REQUIRED"
      );
    }

    req.supabaseUserId = claim.id;

    next();
  } catch (error) {
    next(error);
  }
}
