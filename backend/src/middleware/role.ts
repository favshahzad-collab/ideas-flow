import { Request, Response, NextFunction } from "express";
import { errors } from "../lib/errors";
import { prisma } from "../prisma";
import {
  ACCESS_SELECT,
  CAPABILITIES,
  capabilitiesOf,
  capabilityForRequest,
  viewOnlyOf,
} from "../lib/capabilities";

/**
 * The administration routes, for whichever administrator holds the power.
 *
 * Two tiers. A Super Administrator holds every power. Any other administrator
 * holds the powers a Super Administrator gave them, so this works out which
 * power the request needs - from its method and path, against the matrix in
 * lib/capabilities, which the route tests keep complete - and lets it through
 * only if they hold it. A route the matrix does not describe is refused for
 * them: nobody was ever given it.
 *
 * Worked out from the path rather than from `req.route` because most of these
 * routes are guarded router-wide, before Express has matched one.
 */
export const requireAdmin = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.supabaseUserId! },
      select: ACCESS_SELECT,
    });

    if (!user || user.loginRole !== "ADMINISTRATOR") {
      return next(errors.forbidden("Admin access required"));
    }

    if (user.isSuperAdmin) return next();

    const needed = capabilityForRequest(req.method, req.originalUrl);

    // Given the area to see but not change: its reading routes, nothing else.
    const reading = req.method === "GET" || req.method === "HEAD";
    if (needed && reading && viewOnlyOf(user).includes(needed)) return next();

    if (!needed || !capabilitiesOf(user).includes(needed)) {
      if (needed && viewOnlyOf(user).includes(needed)) {
        return next(
          errors.forbidden(
            "You can see this, but not change it. A Super Administrator can give you the power to change it.",
            "POWER_REQUIRED"
          )
        );
      }
      const title = CAPABILITIES.find((capability) => capability.id === needed)?.title;
      return next(
        errors.forbidden(
          title
            ? `You do not have the power to ${title.charAt(0).toLowerCase()}${title.slice(1)}. A Super Administrator can give it to you.`
            : "This needs a Super Administrator.",
          "POWER_REQUIRED"
        )
      );
    }

    next();
  } catch (error) {
    next(error);
  }
};

/** Super Administrators only, whatever powers anybody else holds. */
export const requireSuperAdmin = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.supabaseUserId! },
      select: ACCESS_SELECT,
    });

    if (!user || user.loginRole !== "ADMINISTRATOR" || !user.isSuperAdmin) {
      return next(errors.forbidden("This needs a Super Administrator.", "POWER_REQUIRED"));
    }

    next();
  } catch (error) {
    next(error);
  }
};
