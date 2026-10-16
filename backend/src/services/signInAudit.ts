import { logger } from "../lib/logger";
import { auditService } from "./audit.service";
import type { SessionContext } from "./sessions.service";

/**
 * A row in the sealed trail for every sign-in, failed sign-in and refused
 * attempt on a real account.
 *
 * The trail knew who approved what and when a session ended, but not who got
 * in, who kept failing, or when the sign-in limit started refusing somebody -
 * the first three questions after a suspected break-in. Those were only in a
 * log file that rotates.
 *
 * An address with no account has no user to point the row at (the row's
 * subject is a real id), so those attempts go to the log alone. The address
 * that was tried is kept on a failure, because "somebody is working through
 * our staff list" is visible in it; the password never is.
 *
 * Best effort in one direction only: a trail that cannot be written must not
 * change what the person signing in is told. A refused sign-in stays refused
 * and a good one stays good; the failure to record it is logged.
 */

export type SignInMethod = "password" | "two-step" | "microsoft";

export async function recordSignIn(
  outcome: "SIGN_IN_SUCCEEDED" | "SIGN_IN_FAILED" | "SIGN_IN_THROTTLED",
  userId: string,
  detail: {
    method: SignInMethod;
    /** Why a failed one failed, as a short code: "password", "code", "switched-off". */
    reason?: string;
    email?: string;
  } & SessionContext,
): Promise<void> {
  try {
    await auditService.createAuditLog({
      actorId: userId,
      action: outcome,
      entityType: "User",
      entityId: userId,
      newValue: {
        method: detail.method,
        ...(detail.reason ? { reason: detail.reason } : {}),
        ...(detail.email ? { email: detail.email.toLowerCase() } : {}),
      },
      ipAddress: detail.ipAddress ?? undefined,
      userAgent: detail.userAgent?.slice(0, 500) ?? undefined,
    });
  } catch (error) {
    logger.error("audit.sign_in.unwritten", { outcome, userId, error });
  }
}
