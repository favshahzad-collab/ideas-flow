import { errors } from "../lib/errors";
import { logger } from "../lib/logger";
import { verifyAgainstNothing, verifyPassword } from "../lib/password";
import { issueStepUpToken, STEP_UP_TTL_MS } from "../lib/tokens";
import { prisma } from "../prisma";
import { totpService } from "./totp.service";

/**
 * Confirming it is you, just before something that cannot be taken back.
 *
 * A session is proof that somebody typed a password up to two hours ago. That
 * is not good enough for the handful of changes that hand control of an
 * account to somebody else: turning off another person's two-step sign-in,
 * changing their role, email or password, making an administrator, importing
 * people, and replacing the mail or sign-on credentials. A laptop left open,
 * or a session token lifted from it, could do any of those - and the first
 * two are exactly how one account is turned into another.
 *
 * So those ask again. The answer is a confirmation that lasts five minutes,
 * which the app attaches to what follows so a run of edits is one prompt.
 *
 * Either the password or a code from the authenticator app, because an
 * administrator who signs in with Microsoft has no password here - and every
 * administrator has the app, which two-step sign-in now requires. A code is
 * spent like a sign-in code, so the one typed here cannot be replayed.
 */

export const STEP_UP_REFUSED =
  "That password or code is not right. Try again, or sign out and back in.";

export const stepUpService = {
  async confirm(
    userId: string,
    input: { password?: string; code?: string },
  ): Promise<{ stepUpToken: string; expiresAt: string }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true, totpSecret: true, totpActivatedAt: true, totpLastStep: true },
    });

    if (!user) throw errors.unauthorized("Sign in again.");

    let confirmed = false;

    if (input.code) {
      const digits = input.code.replace(/[\s-]/g, "");
      confirmed =
        Boolean(user.totpActivatedAt) &&
        /^[0-9]{6}$/.test(digits) &&
        (await totpService.spendTotp(user, digits)) === "totp";
    } else if (input.password) {
      confirmed = user.passwordHash
        ? await verifyPassword(input.password, user.passwordHash)
        : await verifyAgainstNothing(input.password);
    }

    if (!confirmed) {
      logger.warn("step_up.refused", { userId, by: input.code ? "code" : "password" });
      // 403, not 401: the session is fine, only this confirmation failed. A
      // 401 sends the app off to refresh the session and, failing that, to
      // the sign-in screen - for one mistyped password.
      throw errors.forbidden(STEP_UP_REFUSED, "STEP_UP_REFUSED");
    }

    return {
      stepUpToken: await issueStepUpToken(userId, input.code ? "AUTHENTICATOR" : "PASSWORD"),
      expiresAt: new Date(Date.now() + STEP_UP_TTL_MS).toISOString(),
    };
  },
};
