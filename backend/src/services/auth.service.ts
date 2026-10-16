import { randomUUID } from "node:crypto";
import { prisma } from "../prisma";
import { errors } from "../lib/errors";
import { capabilitiesOf, viewOnlyOf } from "../lib/capabilities";
import { adminTwoFactorRequired, preparerSignsOnSubmit, stepSkipAllowed } from "../lib/env";
import { hashPassword, verifyPassword, verifyAgainstNothing } from "../lib/password";
import { assertAcceptablePassword } from "../lib/passwordPolicy";
import { verifyToken } from "../lib/tokens";
import { sessionsService, type SessionContext } from "./sessions.service";
import { totpService } from "./totp.service";
import { auditService } from "./audit.service";
import { recordSignIn } from "./signInAudit";
import type { LoginRole } from "../generated/prisma/client";
import { LoginInput, SignUpInput, RefreshTokenInput } from "../schemas/auth.schema";

/** A sign-in that finished: the shape `/sso/exchange` and `/2fa` also answer with. */
export type SignedIn = {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; role: LoginRole };
};

/**
 * A sign-in that stopped for a code.
 *
 * It names no account. Somebody who guessed a password correctly learns that
 * the account has a second factor and nothing else about it.
 */
export type SecondFactorWanted = {
  twoFactorRequired: true;
  challenge: string;
  expiresAt: string;
};

export type LoginResult = SignedIn | SecondFactorWanted;

/**
 * Which of the two came back.
 *
 * Exported because every caller has to branch, and the compiler should be the
 * thing that says so rather than a field turning out to be undefined at
 * runtime. That is also why `login` returns a union at all: the alternative
 * was one shape with every field optional, which tells a caller nothing.
 */
export function wantsSecondFactor(
  result: LoginResult
): result is SecondFactorWanted {
  return "twoFactorRequired" in result;
}

class AuthService {
  async login(
    input: LoginInput,
    context: SessionContext = {}
  ): Promise<LoginResult> {
    const user = await prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
      select: {
        id: true,
        email: true,
        loginRole: true,
        passwordHash: true,
        totpActivatedAt: true,
        deactivatedAt: true,
      },
    });

    // Same message and the same work whether the address is unknown or the
    // password is wrong, so neither the response nor the time it takes
    // reveals which. An account with no password of its own - Microsoft
    // sign-in only - takes the same path as no account.
    const ok = user?.passwordHash
      ? await verifyPassword(input.password, user.passwordHash)
      : await verifyAgainstNothing(input.password);

    if (!user || !ok) {
      if (user) {
        // Not awaited: only a real account gets a row, so waiting for the
        // write would make a wrong password for a real address answer a few
        // milliseconds later than one for an address that does not exist.
        void recordSignIn("SIGN_IN_FAILED", user.id, {
          method: "password",
          reason: "password",
          email: input.email,
          ...context,
        });
      }
      throw errors.unauthorized("Incorrect email or password");
    }

    /*
     * Switched off, and said so - but only on the far side of the password
     * check, which is what keeps it from being an oracle. Anybody who reaches
     * this line has typed the right password for this address, so naming the
     * account tells them nothing they did not already know.
     *
     * Before the second factor rather than after: a person who cannot sign in
     * at all should not be asked for a code first, and an account that is off
     * must not be able to spend one of its recovery codes proving it.
     */
    if (user.deactivatedAt) {
      await recordSignIn("SIGN_IN_FAILED", user.id, {
        method: "password",
        reason: "switched-off",
        ...context,
      });
      throw errors.forbidden(
        "This account has been switched off. Ask an administrator to turn it back on.",
        "ACCOUNT_DEACTIVATED"
      );
    }

    /*
     * Half a sign-in.
     *
     * No session is issued here and none exists yet: what comes back is a
     * challenge worth nothing on its own, which the browser sends to
     * `/api/auth/2fa` together with the code. The account is never named in
     * this response - somebody who guessed a password correctly learns that
     * the account has a second factor and nothing else about it.
     *
     * Additive, and only reachable for an account that switched the factor
     * on. Every other sign-in answers exactly as it always did.
     */
    if (user.totpActivatedAt) {
      const { challenge, expiresAt } = await totpService.challenge(user.id);

      return {
        twoFactorRequired: true as const,
        challenge,
        expiresAt: expiresAt.toISOString(),
      };
    }

    const { accessToken, refreshToken } = await sessionsService.issue(
      user.id,
      context
    );

    // Only here, where a session exists. An account with two-step sign-in has
    // not signed in yet at the challenge above; that row is written when the
    // code is accepted.
    await recordSignIn("SIGN_IN_SUCCEEDED", user.id, { method: "password", ...context });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.loginRole,
      },
    };
  }

  /**
   * End this one session, or every session this account holds.
   *
   * Both exist because they answer different fears. Signing out on a shared
   * machine should not sign you out of your phone; a stolen laptop should
   * sign you out of everything, and should reach the access token in it.
   */
  async signOut(
    userId: string,
    refreshToken: string | undefined,
    everywhere: boolean,
    ipAddress?: string
  ) {
    if (everywhere) {
      const { ended } = await sessionsService.endAll(userId, { ipAddress });
      return {
        message: "Signed out of every device. Sign in again to continue.",
        sessionsEnded: ended,
      };
    }

    if (!refreshToken) {
      // Nothing to end precisely, so end everything rather than quietly
      // ending nothing: a client that asked to sign out must not stay signed
      // in because it forgot to say which session it meant.
      const { ended } = await sessionsService.endAll(userId, { ipAddress });
      return { message: "Signed out.", sessionsEnded: ended };
    }

    await sessionsService.endOne(refreshToken, userId, ipAddress);
    return { message: "Signed out.", sessionsEnded: 1 };
  }

  /**
   * An administrator creating a staff account through the older route.
   * Recorded like every other account created, by whoever did it - it used
   * to leave nothing in the trail, so an account could appear that Change
   * history never mentioned.
   */
  async signUp(input: SignUpInput, actorId?: string, ipAddress?: string) {
    const { email, password, firstName, lastName, departmentId } = input;

    const department = await prisma.department.findUnique({
      where: { id: departmentId },
    });

    if (!department) {
      throw errors.badRequest("Department not found");
    }

    assertAcceptablePassword(password, { email, firstName, lastName });

    try {
      const user = await prisma.user.create({
        data: {
          id: randomUUID(),
          email: email.toLowerCase(),
          passwordHash: await hashPassword(password),
          firstName,
          lastName,
          departmentId,
          loginRole: "USER",
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          designation: true,
          loginRole: true,
          department: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      await auditService.createAuditLog({
        actorId,
        action: "USER_CREATED",
        entityType: "User",
        entityId: user.id,
        newValue: {
          email: user.email,
          loginRole: user.loginRole,
          departmentId,
          hasPassword: true,
        },
        ipAddress,
      });

      return {
        user,
        message: "User created successfully",
      };
    } catch (error: any) {
      if (error?.code === "P2002") {
        throw errors.conflict("User with this email already exists");
      }
      throw error;
    }
  }

  async refresh(input: RefreshTokenInput, context: SessionContext = {}) {
    const payload = await verifyToken(input.refreshToken, "refresh");

    if (!payload) {
      throw errors.unauthorized("Invalid or expired refresh token");
    }

    // The account may have been removed since the refresh token was issued.
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { id: true, sessionsValidFrom: true },
    });

    if (!user) {
      throw errors.unauthorized("Invalid or expired refresh token");
    }

    // The cutoff applies to refresh tokens too, and is checked here rather
    // than in the middleware because this route has no access token to read.
    if (payload.issuedAt.getTime() < user.sessionsValidFrom.getTime()) {
      throw errors.unauthorized("This session has been ended. Sign in again.");
    }

    const rotated = await sessionsService.rotate(
      input.refreshToken,
      user.id,
      context
    );

    if (!rotated) {
      throw errors.unauthorized("Invalid or expired refresh token");
    }

    return rotated;
  }

  async getMe(userId: string) {
    const found = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        designation: true,
        email: true,
        loginRole: true,
        isSuperAdmin: true,
        adminPowers: true,
        signatureStoragePath: true,
        department: {
          select: {
            id: true,
            name: true,
          },
        },
        createdAt: true,
        totpActivatedAt: true,
        passwordHash: true,
      },
    });

    if (!found) {
      throw errors.notFound("User not found");
    }

    const { totpActivatedAt, passwordHash, ...user } = found;

    /*
     * What this person may do, alongside who they are.
     *
     * Additive: `loginRole` is still here and still what the guards read. This
     * is so the client can stop deciding for itself what a role implies - it
     * was comparing the role string to "ADMINISTRATOR" in the shell, on the
     * route guards and in a handful of screens, which is four copies of a rule
     * that lives on the server.
     *
     * `workflowPolicy` is here for a narrower reason. Whether a preparer may
     * skip an approver used to be a deployment decision fixed in the
     * environment, so the client could carry a build-time flag and the two
     * agreed. It is a database row an administrator can change now, and a
     * build-time flag cannot follow that - which left an administration screen
     * offering a switch that turned nothing on. The client asks instead.
     */
    return {
      ...user,
      // What this person holds: a Super Administrator everything, any other
      // administrator what a Super Administrator gave them.
      capabilities: capabilitiesOf(user),
      // Areas given to see but not change, so a screen can say so up front
      // rather than at the first refused save.
      viewOnly: viewOnlyOf(user),
      workflowPolicy: {
        allowStepSkip: stepSkipAllowed(),
        preparerSignsOnSubmit: preparerSignsOnSubmit(),
      },
      /*
       * True for an administrator who has not set up two-step sign-in, while
       * the deployment requires it. Every other request of theirs is refused
       * until they do; this is how the app knows to show the setup screen
       * instead of pages that would each fail.
       */
      twoFactorEnrolmentRequired:
        user.loginRole === "ADMINISTRATOR" && !totpActivatedAt && adminTwoFactorRequired(),
      /*
       * How this person can confirm it is them. Somebody who signs in only
       * with Microsoft has no password here; they confirm with a fresh
       * Microsoft sign-in, and are asked to set up an authenticator app too,
       * so a Microsoft outage does not stop them signing. Whether - never the
       * hash itself.
       */
      hasPassword: Boolean(passwordHash),
      hasAuthenticator: Boolean(totpActivatedAt),
    };
  }
}

export const authService = new AuthService();
