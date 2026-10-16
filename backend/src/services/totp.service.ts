import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "../prisma";
import { errors } from "../lib/errors";
import { logger } from "../lib/logger";
import { decryptSecret, encryptSecret } from "../lib/secretBox";
import { verifyPassword } from "../lib/password";
import {
  base32Encode,
  generateSecret,
  otpauthUri,
  verifyCode,
} from "../lib/totp";
import { auditService } from "./audit.service";
import { notificationsService } from "./notifications.service";
import { sessionsService, type SessionContext } from "./sessions.service";
import { recordSignIn } from "./signInAudit";

/**
 * The second factor.
 *
 * Per person and opt-in. There is deliberately no organisation-wide switch:
 * this deployment has five accounts and one administrator, and a mandatory
 * second factor is how everybody gets locked out of an approval system on the
 * same afternoon. The administrator reset path below is the other half of
 * being willing to ship this at all - a product that can strand somebody
 * outside their own approvals with no way back is worse than one with no
 * second factor.
 *
 * Enrolment is two steps because the first one proves nothing. Writing a
 * secret down means a QR code was drawn; it does not mean anybody's phone can
 * read it, and switching the factor on at that point is precisely how somebody
 * locks themselves out during setup. The factor turns on when a code from that
 * secret comes back.
 *
 * Single sign-on does not pass through here. Microsoft has already applied
 * whatever the tenant's conditional access policy demands, and asking a second
 * time for a factor the directory has just satisfied trains people to approve
 * prompts they did not start.
 */

/** Long enough to unlock a phone and find the entry. Not long enough to leave open. */
const CHALLENGE_MS = 5 * 60 * 1000;

/**
 * Guesses per challenge.
 *
 * Six digits is one million, which sounds ample and is not: at a thousand
 * guesses a second it is minutes. This is the real bound - the rate limiter on
 * the route is a backstop - because it costs an attacker a fresh,
 * password-verified sign-in for every five tries.
 */
const MAX_ATTEMPTS = 5;

const RECOVERY_CODE_COUNT = 10;

/** 80 bits each. Nothing a person chose, so nothing a dictionary reaches. */
const RECOVERY_CODE_BYTES = 10;

const ISSUER = "IdeasFlow";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Dashes every four characters, which is how anybody transcribes sixteen of
 * them without losing their place. Stripped again on the way back in.
 */
function formatRecoveryCode(raw: string): string {
  return raw.match(/.{1,4}/g)!.join("-");
}

export function normaliseRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

async function issueRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    base32Encode(randomBytes(RECOVERY_CODE_BYTES))
  );

  // The whole set is replaced, never topped up. A set half of which is from
  // the paper somebody lost is not a set anybody can reason about.
  await prisma.$transaction([
    prisma.totpRecoveryCode.deleteMany({ where: { userId } }),
    prisma.totpRecoveryCode.createMany({
      data: codes.map((code) => ({ userId, codeHash: sha256(code) })),
    }),
  ]);

  return codes.map(formatRecoveryCode);
}

/**
 * The stored secret in the clear, or a refusal that says which kind of
 * nothing this is.
 *
 * An unreadable secret is not the same as no secret: it is what a rotated
 * `JWT_SECRET` leaves behind, and the person holding it has a working phone
 * and a code that will never be accepted again. They need an administrator,
 * and the message has to say so rather than repeating "incorrect code" at
 * somebody who is typing the right one.
 */
function readSecret(stored: string | null): string {
  const secret = stored ? decryptSecret(stored) : null;

  if (!secret) {
    throw errors.badRequest(
      "This account's authenticator secret cannot be read on this server. Ask an administrator to reset two-step sign-in for you.",
      "TOTP_SECRET_UNREADABLE"
    );
  }

  return secret;
}

export const totpService = {
  /** What the account screen draws. Never the secret. */
  async status(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { totpSecret: true, totpActivatedAt: true },
    });

    if (!user) {
      throw errors.notFound("User not found");
    }

    const [remaining, used] = await Promise.all([
      prisma.totpRecoveryCode.count({ where: { userId, usedAt: null } }),
      prisma.totpRecoveryCode.count({ where: { userId, usedAt: { not: null } } }),
    ]);

    return {
      enabled: Boolean(user.totpActivatedAt),
      activatedAt: user.totpActivatedAt,
      /*
       * Enrolment that was started and never finished. The screen offers to
       * carry on rather than silently handing out a second secret, because
       * somebody who has already scanned the first one would find their codes
       * refused with nothing on screen to explain it.
       */
      pending: Boolean(user.totpSecret) && !user.totpActivatedAt,
      recoveryCodesRemaining: remaining,
      recoveryCodesUsed: used,
      /*
       * A secret that is there and unreadable. Told apart from "no secret"
       * because the fix is different and neither the person nor the
       * administrator can guess which one they are looking at.
       */
      secretUnreadable:
        Boolean(user.totpActivatedAt) &&
        (!user.totpSecret || decryptSecret(user.totpSecret) === null),
    };
  },

  /**
   * Step one: a secret and something to scan.
   *
   * Starting again replaces any unfinished secret. Two half-finished
   * enrolments on one account is a state where the phone holds one secret and
   * the server another, and the only symptom is a correct code being refused.
   */
  async beginEnrolment(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, totpActivatedAt: true },
    });

    if (!user) {
      throw errors.notFound("User not found");
    }

    if (user.totpActivatedAt) {
      throw errors.conflict(
        "Two-step sign-in is already switched on for this account. Turn it off first if you want to use a different phone.",
        "TOTP_ALREADY_ON"
      );
    }

    const secret = generateSecret();

    await prisma.user.update({
      where: { id: userId },
      data: { totpSecret: encryptSecret(secret), totpLastStep: null },
    });

    return {
      secret,
      otpauthUri: otpauthUri({ secret, account: user.email, issuer: ISSUER }),
    };
  },

  /**
   * Step two: the code off the phone, which is what actually switches it on.
   *
   * The recovery codes are returned here and nowhere else, ever. They are not
   * stored in a form this server can read, so a screen that could show them
   * again would mean a table of live credentials sitting in plaintext.
   */
  async activate(userId: string, code: string, ipAddress?: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { totpSecret: true, totpActivatedAt: true },
    });

    if (!user) {
      throw errors.notFound("User not found");
    }

    if (user.totpActivatedAt) {
      throw errors.conflict(
        "Two-step sign-in is already switched on for this account.",
        "TOTP_ALREADY_ON"
      );
    }

    if (!user.totpSecret) {
      throw errors.badRequest(
        "Start setting up two-step sign-in before confirming a code.",
        "TOTP_NOT_STARTED"
      );
    }

    const step = verifyCode(readSecret(user.totpSecret), code);

    if (step === null) {
      throw errors.badRequest(
        "That code was not accepted. Check your phone's clock is set automatically, then try the current code.",
        "TOTP_CODE_INVALID"
      );
    }

    const activatedAt = new Date();

    await prisma.user.update({
      where: { id: userId },
      data: { totpActivatedAt: activatedAt, totpLastStep: BigInt(step) },
    });

    const recoveryCodes = await issueRecoveryCodes(userId);

    await auditService.createAuditLog({
      actorId: userId,
      action: "TWO_FACTOR_ENABLED",
      entityType: "User",
      entityId: userId,
      oldValue: { enabled: false },
      newValue: { enabled: true, recoveryCodes: RECOVERY_CODE_COUNT },
      ipAddress,
    });

    return { activatedAt, recoveryCodes };
  },

  /**
   * Turning it off, which needs the password.
   *
   * The password rather than a code, on purpose: the threat is an unlocked
   * laptop somebody walked away from, and a phone in a pocket across the room
   * is no obstacle to that person if all they have to do is press "turn off".
   */
  async disable(userId: string, password: string, ipAddress?: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, totpActivatedAt: true },
    });

    if (!user) {
      throw errors.notFound("User not found");
    }

    if (!(await verifyPassword(password, user.passwordHash))) {
      throw errors.unauthorized("That password is not correct.", "PASSWORD_INVALID");
    }

    await this.clear(userId);

    await auditService.createAuditLog({
      actorId: userId,
      action: "TWO_FACTOR_DISABLED",
      entityType: "User",
      entityId: userId,
      oldValue: { enabled: Boolean(user.totpActivatedAt) },
      newValue: { enabled: false },
      ipAddress,
    });

    await this.tellTheOwner(
      userId,
      "Two-factor authentication turned off",
      "Two-factor authentication was turned off on your Ideas Flow account. " +
        "If that was not you, tell your administrator now - whoever did it " +
        "can sign in with your password alone."
    );

    return { enabled: false };
  },

  /** A fresh set, in exchange for a live code. Replaces the old set entirely. */
  async replaceRecoveryCodes(userId: string, code: string, ipAddress?: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { totpSecret: true, totpActivatedAt: true, totpLastStep: true },
    });

    if (!user?.totpActivatedAt) {
      throw errors.badRequest(
        "Two-step sign-in is not switched on for this account.",
        "TOTP_NOT_ON"
      );
    }

    const step = verifyCode(readSecret(user.totpSecret), code, {
      afterStep: user.totpLastStep === null ? null : Number(user.totpLastStep),
    });

    if (step === null) {
      throw errors.badRequest(
        "That code was not accepted. Try the current code from your authenticator app.",
        "TOTP_CODE_INVALID"
      );
    }

    await prisma.user.update({
      where: { id: userId },
      data: { totpLastStep: BigInt(step) },
    });

    const recoveryCodes = await issueRecoveryCodes(userId);

    await auditService.createAuditLog({
      actorId: userId,
      action: "TWO_FACTOR_ENABLED",
      entityType: "User",
      entityId: userId,
      oldValue: { recoveryCodes: "replaced" },
      newValue: { recoveryCodes: RECOVERY_CODE_COUNT },
      ipAddress,
    });

    return { recoveryCodes };
  },

  /**
   * An administrator taking the factor off somebody else's account.
   *
   * The lost-phone-and-lost-codes path, and the reason this feature is
   * shippable. It is loud in the audit trail rather than quiet, because it is
   * also exactly what somebody would do with a stolen administrator session:
   * strip a second factor and then sign in as that person.
   */
  async resetFor(userId: string, actorId: string | undefined, ipAddress?: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, totpActivatedAt: true },
    });

    if (!user) {
      throw errors.notFound("User not found");
    }

    if (!user.totpActivatedAt) {
      throw errors.badRequest(
        "Two-step sign-in is not switched on for that account.",
        "TOTP_NOT_ON"
      );
    }

    await this.clear(userId);

    await auditService.createAuditLog({
      actorId,
      action: "TWO_FACTOR_RESET",
      entityType: "User",
      entityId: userId,
      oldValue: { enabled: true, email: user.email },
      newValue: { enabled: false },
      ipAddress,
    });

    /*
     * To the owner, not the administrator, who plainly knows - they just did
     * it. Saying an administrator did it matters: the owner who did not ask
     * for it should be alarmed, and the one who rang up and asked should not
     * be.
     */
    await this.tellTheOwner(
      userId,
      "Two-factor authentication reset by an administrator",
      "An administrator reset two-factor authentication on your Ideas Flow " +
        "account, so it is switched off and your old recovery codes no longer " +
        "work. If you did not ask for this, tell your administrator now."
    );

    return { enabled: false };
  },

  /**
   * Tell the account's owner that its protection changed.
   *
   * Deliberately outside whatever transaction the caller is in, and never
   * allowed to fail the action it describes. Turning a second factor off must
   * not be refused because a mail row could not be written - the alternative
   * is an account whose protection is off in one table and on in another.
   * A failure here is logged and the trail still holds the event.
   */
  async tellTheOwner(userId: string, title: string, message: string) {
    try {
      await notificationsService.createNotification({
        recipientId: userId,
        type: "SECURITY_ALERT",
        title,
        message,
      });
    } catch (error) {
      logger.error("security.notice.failed", {
        userId,
        title,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  },

  /** Secret, confirmation, recovery codes and any half-finished sign-in. */
  async clear(userId: string) {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { totpSecret: null, totpActivatedAt: null, totpLastStep: null },
      }),
      prisma.totpRecoveryCode.deleteMany({ where: { userId } }),
      prisma.totpChallenge.deleteMany({ where: { userId } }),
    ]);
  },

  /**
   * The password was right and the account wants a code. Returns what the
   * browser has to send back with it.
   *
   * Worth nothing on its own. It names no account to whoever holds it, carries
   * no session, and expires in five minutes.
   */
  async challenge(userId: string): Promise<{ challenge: string; expiresAt: Date }> {
    const challenge = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + CHALLENGE_MS);

    await prisma.totpChallenge.create({
      data: { userId, codeHash: sha256(challenge), expiresAt },
    });

    // Swept on the way past rather than by a background job: the table only
    // grows when somebody signs in, so this bounds it against the traffic
    // that fills it.
    await prisma.totpChallenge.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - CHALLENGE_MS) } },
    });

    return { challenge, expiresAt };
  },

  /**
   * The second half of a sign-in: six digits, or one recovery code.
   *
   * One field for both. Somebody who has reached for the envelope is already
   * having a bad morning, and a second control to find first is the wrong
   * thing to put in front of them.
   */
  async completeChallenge(
    input: { challenge: string; code: string },
    context: SessionContext = {}
  ) {
    const refuse = () =>
      errors.unauthorized(
        "That sign-in has expired. Start again from the sign-in screen.",
        "TOTP_CHALLENGE_INVALID"
      );

    const row = await prisma.totpChallenge.findUnique({
      where: { codeHash: sha256(input.challenge) },
      select: {
        id: true,
        userId: true,
        codeHash: true,
        attempts: true,
        consumedAt: true,
        expiresAt: true,
        user: {
          select: {
            id: true,
            email: true,
            loginRole: true,
            totpSecret: true,
            totpActivatedAt: true,
            totpLastStep: true,
          },
        },
      },
    });

    if (
      !row ||
      row.consumedAt ||
      row.expiresAt.getTime() < Date.now() ||
      row.attempts >= MAX_ATTEMPTS ||
      !sameToken(row.codeHash, sha256(input.challenge)) ||
      !row.user.totpActivatedAt
    ) {
      throw refuse();
    }

    /*
     * Counted before the code is checked, not after. A guess that throws on
     * the way out would otherwise cost nothing, and "increment afterwards" is
     * the version where a client that hangs up mid-request guesses free.
     */
    const { count } = await prisma.totpChallenge.updateMany({
      where: { id: row.id, consumedAt: null, attempts: row.attempts },
      data: { attempts: { increment: 1 } },
    });

    if (count === 0) {
      // Two requests raced for the same challenge. Refuse both rather than
      // letting the loser retry the same attempt number for free.
      throw refuse();
    }

    const digits = input.code.replace(/[\s-]/g, "");
    const looksLikeTotp = /^[0-9]{6}$/.test(digits);

    const matched = looksLikeTotp
      ? await this.spendTotp(row.user, digits)
      : await this.spendRecoveryCode(row.user.id, input.code);

    if (!matched) {
      const left = MAX_ATTEMPTS - (row.attempts + 1);

      logger.error("totp.challenge.rejected", { userId: row.userId, left });
      await recordSignIn("SIGN_IN_FAILED", row.user.id, {
        method: "two-step",
        reason: "code",
        ...context,
      });

      throw errors.unauthorized(
        left > 0
          ? `That code was not accepted. ${left} ${left === 1 ? "try" : "tries"} left before you have to sign in again.`
          : "That code was not accepted. Sign in again to try once more.",
        "TOTP_CODE_INVALID"
      );
    }

    await prisma.totpChallenge.update({
      where: { id: row.id },
      data: { consumedAt: new Date() },
    });

    if (matched === "recovery") {
      await auditService.createAuditLog({
        actorId: row.user.id,
        action: "TWO_FACTOR_RECOVERY_USED",
        entityType: "User",
        entityId: row.user.id,
        newValue: {
          remaining: await prisma.totpRecoveryCode.count({
            where: { userId: row.user.id, usedAt: null },
          }),
        },
        ipAddress: context.ipAddress ?? undefined,
      });

      /*
       * Only for a recovery code, never for an ordinary one from the phone.
       * A recovery code is the exception - it is what somebody uses when they
       * have lost the phone, which is also what somebody uses when they have
       * taken the codes. A notice on every sign-in would be the noise that
       * teaches people to ignore this one.
       */
      await this.tellTheOwner(
        row.user.id,
        "A recovery code was used to sign in",
        "Somebody signed in to your Ideas Flow account with one of your " +
          "recovery codes rather than a code from your phone. If that was " +
          "not you, tell your administrator now."
      );
    }

    const { accessToken, refreshToken } = await sessionsService.issue(
      row.user.id,
      context
    );

    await recordSignIn("SIGN_IN_SUCCEEDED", row.user.id, {
      method: "two-step",
      ...(matched === "recovery" ? { reason: "recovery-code" } : {}),
      ...context,
    });

    // The shape `/login` and `/sso/exchange` both answer with, so the
    // application stores a session without knowing which route produced it.
    return {
      accessToken,
      refreshToken,
      user: {
        id: row.user.id,
        email: row.user.email,
        role: row.user.loginRole,
      },
    };
  },

  /** The code from the app, and the step it came from written down. */
  async spendTotp(
    user: {
      id: string;
      totpSecret: string | null;
      totpLastStep: bigint | null;
    },
    code: string
  ): Promise<"totp" | null> {
    const secret = user.totpSecret ? decryptSecret(user.totpSecret) : null;

    if (!secret) {
      // A rotated JWT_SECRET. Nothing this person types can work, and saying
      // so at the sign-in screen would tell an attacker the same thing - so
      // the log carries it and the caller reports an ordinary refusal.
      logger.error("totp.secret_unreadable", { userId: user.id });
      return null;
    }

    const step = verifyCode(secret, code, {
      afterStep: user.totpLastStep === null ? null : Number(user.totpLastStep),
    });

    if (step === null) {
      return null;
    }

    /*
     * Conditional on the step not having moved. Two tabs submitting the same
     * code at the same moment would both verify it; this is what makes the
     * second one lose.
     */
    const { count } = await prisma.user.updateMany({
      where: {
        id: user.id,
        OR: [{ totpLastStep: null }, { totpLastStep: { lt: BigInt(step) } }],
      },
      data: { totpLastStep: BigInt(step) },
    });

    return count === 1 ? "totp" : null;
  },

  /** One from the envelope, marked spent by the same conditional update. */
  async spendRecoveryCode(
    userId: string,
    code: string
  ): Promise<"recovery" | null> {
    const normalised = normaliseRecoveryCode(code);

    if (normalised.length === 0) {
      return null;
    }

    const { count } = await prisma.totpRecoveryCode.updateMany({
      where: { userId, codeHash: sha256(normalised), usedAt: null },
      data: { usedAt: new Date() },
    });

    return count === 1 ? "recovery" : null;
  },
};
