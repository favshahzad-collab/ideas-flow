import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  authorizeUrl,
  createNonce,
  createPkcePair,
  exchangeCode,
  verifyIdToken,
} from "../lib/entra";
import { entraConfig } from "./ssoSettings.service";
import { issueStepUpToken, STEP_UP_TTL_MS } from "../lib/tokens";
import { errors } from "../lib/errors";
import { logger } from "../lib/logger";
import { prisma } from "../prisma";
import { sessionsService, type SessionContext } from "./sessions.service";
import { recordSignIn } from "./signInAudit";

/**
 * Signing in with a Microsoft work account.
 *
 * Three steps, in three requests. `start` sends the browser to Microsoft with
 * a state, a nonce and a PKCE challenge, and writes the matching secrets down
 * here. `callback` is where Microsoft returns: it proves the round trip, trades
 * the code for an identity, and finds the person. `exchange` is the
 * single-page application collecting the session.
 *
 * The third step exists because the second one is a redirect. Putting a
 * session in a redirect URL writes it into browser history, the referrer
 * header and every proxy log between here and the browser; what goes there
 * instead is a code worth nothing except to whoever POSTs it back, once,
 * within the minute.
 *
 * Nothing here creates an account. Holding a mailbox in the directory is not
 * the same as being a person in an HR approval chain, and a system that
 * enrolled every new starter automatically would put strangers in a list of
 * approvers. An unmatched sign-in is refused and says so.
 */

/** Long enough to find a password manager and answer an MFA prompt. */
const ROUND_TRIP_MS = 10 * 60 * 1000;

/** Long enough for one redirect and one POST. Nothing else needs it alive. */
const HANDOVER_MS = 60 * 1000;

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/**
 * Compared in constant time, and only after the lengths match.
 *
 * These are database lookups by hash, so a timing signal here buys very
 * little - but "very little" is an argument for the cheap version, not for
 * the naive one.
 */
function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

export const ssoService = {
  /**
   * Begin. Returns where to send the browser.
   *
   * Refuses rather than redirecting anywhere when sign-in is not configured:
   * the button is only drawn when it is, so reaching this without it means
   * somebody typed the URL or the configuration changed mid-session.
   */
  async start(stepUpFor?: string): Promise<string> {
    const config = await entraConfig();

    if (!config) {
      throw errors.badRequest(
        "Signing in with Microsoft is not switched on for this deployment.",
        "SSO_DISABLED"
      );
    }

    const state = randomBytes(24).toString("base64url");
    const nonce = createNonce();
    const { verifier, challenge } = createPkcePair();

    await prisma.ssoLogin.create({
      data: {
        state,
        nonce,
        codeVerifier: verifier,
        expiresAt: new Date(Date.now() + ROUND_TRIP_MS),
        ...(stepUpFor ? { purpose: "step-up", forUserId: stepUpFor } : {}),
      },
    });

    /*
     * Housekeeping on the way past rather than a fourth background sweep. The
     * table only grows when somebody starts a sign-in, so bounding it here
     * bounds it against exactly the traffic that fills it.
     */
    await prisma.ssoLogin.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - ROUND_TRIP_MS) } },
    });

    return authorizeUrl(config, {
      state,
      nonce,
      codeChallenge: challenge,
      ...(stepUpFor ? { prompt: "login" as const } : {}),
    });
  },

  /**
   * Start a fresh Microsoft sign-in to confirm it is you.
   *
   * For the people who sign in only with Microsoft and so have no password
   * here to type. Microsoft is told to ask for the credentials again - and to
   * run its own two-step check - rather than wave through a remembered
   * session, and the account that comes back must be this person's.
   */
  async startStepUp(userId: string): Promise<string> {
    return this.start(userId);
  },

  /** Which kind of round trip a returning state belongs to. */
  async purposeOf(state: string): Promise<"sign-in" | "step-up"> {
    const login = await prisma.ssoLogin.findUnique({
      where: { state },
      select: { purpose: true },
    });
    return login?.purpose === "step-up" ? "step-up" : "sign-in";
  },

  /**
   * Spend a confirmation handover for the signed-in person, and answer with
   * the same five-minute confirmation a password or a code would have earned.
   */
  async confirmStepUp(
    code: string,
    userId: string
  ): Promise<{ stepUpToken: string; expiresAt: string }> {
    const claimed = await prisma.ssoLogin.updateMany({
      where: {
        codeHash: sha256(code),
        purpose: "step-up",
        forUserId: userId,
        userId,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });

    if (claimed.count === 0) {
      throw errors.forbidden(
        "That Microsoft confirmation has expired or was not yours. Try again.",
        "STEP_UP_REFUSED"
      );
    }

    return {
      stepUpToken: await issueStepUpToken(userId, "MICROSOFT"),
      expiresAt: new Date(Date.now() + STEP_UP_TTL_MS).toISOString(),
    };
  },

  /**
   * Microsoft has come back. Prove it, then find the person.
   *
   * Returns the handover code, which the caller puts in a redirect to the
   * application. Every refusal here is deliberately vague to the browser and
   * specific in the log: this endpoint is reachable by anyone.
   */
  async callback(params: { code: string; state: string }): Promise<string> {
    const config = await entraConfig();

    if (!config) {
      throw errors.badRequest(
        "Signing in with Microsoft is not switched on for this deployment.",
        "SSO_DISABLED"
      );
    }

    const login = await prisma.ssoLogin.findUnique({
      where: { state: params.state },
    });

    /*
     * One refusal for four different failures - unknown state, already used,
     * expired, or a state that does not survive the comparison. Telling them
     * apart would tell somebody probing this endpoint which of their guesses
     * was closest.
     */
    if (
      !login ||
      login.consumedAt ||
      login.userId ||
      login.expiresAt.getTime() < Date.now() ||
      !sameToken(login.state, params.state)
    ) {
      logger.error("sso.callback.state_rejected", {
        known: Boolean(login),
        spent: Boolean(login?.consumedAt ?? login?.userId),
      });

      throw errors.badRequest(
        "That sign-in could not be completed. Start again from the sign-in screen.",
        "SSO_STATE_INVALID"
      );
    }

    const idToken = await exchangeCode(config, {
      code: params.code,
      codeVerifier: login.codeVerifier,
    });

    const identity = await verifyIdToken(config, idToken, login.nonce);

    /*
     * A confirmation must be a fresh sign-in. `prompt=login` asked for one,
     * and the request asked Microsoft to say when the credentials were last
     * entered: that must be inside this round trip, or a remembered session
     * slipped through.
     *
     * No time at all is refused too. It used to be let through, on the
     * strength of `prompt=login` alone - and Microsoft leaves the time out
     * unless asked, so in practice the check almost never ran.
     */
    if (login.purpose === "step-up" && !identity.authenticatedAt) {
      logger.warn("sso.step_up.no_auth_time", { objectId: identity.objectId });
      throw errors.unauthorized(
        "Microsoft did not say when you signed in, so this cannot count as confirming it is you. Ask your administrator to add the auth_time optional claim to the app registration, or confirm with your password or authenticator app.",
        "SSO_NOT_FRESH"
      );
    }

    if (
      login.purpose === "step-up" &&
      identity.authenticatedAt &&
      identity.authenticatedAt.getTime() < login.createdAt.getTime() - 60_000
    ) {
      logger.warn("sso.step_up.not_fresh", { objectId: identity.objectId });
      throw errors.unauthorized(
        "Microsoft did not ask for your password again. Try again.",
        "SSO_NOT_FRESH"
      );
    }

    /*
     * Matched on the address and nothing else, and matched against an account
     * that must already exist. A switched-off account is refused below.
     *
     * An account with no password set can sign in this way, and that is
     * deliberate: the directory is the credential here, and refusing somebody
     * who has never been given a local password would refuse exactly the
     * people single sign-on exists for.
     */
    const user = await prisma.user.findUnique({
      where: { email: identity.email },
      select: { id: true, deactivatedAt: true },
    });

    // A confirmation must come back as the person who asked for it.
    if (login.purpose === "step-up" && (!user || user.id !== login.forUserId)) {
      logger.warn("sso.step_up.wrong_account", { objectId: identity.objectId });
      throw errors.unauthorized(
        "That was a different Microsoft account. Confirm with your own.",
        "SSO_WRONG_ACCOUNT"
      );
    }

    if (!user) {
      // The one refusal worth naming to the person: they signed in to
      // Microsoft successfully and still cannot get in, and "ask for an
      // account" is the only thing they can do about it.
      logger.error("sso.callback.no_account", { objectId: identity.objectId });

      throw errors.unauthorized(
        "That Microsoft account is not set up in IdeasFlow. Ask an administrator to add you.",
        "SSO_NO_ACCOUNT"
      );
    }

    /*
     * Switched off. Named to the person for the same reason as above - they
     * have proved who they are to Microsoft, so there is nothing to withhold
     * - and refused here rather than at the handover, so no code is issued
     * against an account that cannot use one.
     *
     * The single-sign-on door has to be shut separately from the password
     * door. An account switched off but still in the directory would
     * otherwise walk straight past the one that was closed.
     */
    if (user.deactivatedAt) {
      logger.warn("sso.callback.deactivated", { objectId: identity.objectId });

      throw errors.forbidden(
        "This account has been switched off. Ask an administrator to turn it back on.",
        "ACCOUNT_DEACTIVATED"
      );
    }

    const handover = randomBytes(32).toString("base64url");

    /*
     * The verifier is overwritten rather than kept. It has done its job, and a
     * row that holds a spent PKCE verifier next to a live handover code is two
     * secrets where one will do.
     */
    await prisma.ssoLogin.update({
      where: { id: login.id },
      data: {
        userId: user.id,
        codeHash: sha256(handover),
        codeVerifier: "",
        expiresAt: new Date(Date.now() + HANDOVER_MS),
      },
    });

    return handover;
  },

  /**
   * The application collecting its session.
   *
   * The row is claimed with a conditional update rather than a read followed
   * by a write: two tabs posting the same code at once would both pass a read,
   * and both would be issued a session from one sign-in.
   */
  async exchange(code: string, context: SessionContext = {}) {
    const claimed = await prisma.ssoLogin.updateMany({
      where: {
        codeHash: sha256(code),
        // A confirmation's handover is never a session.
        purpose: "sign-in",
        consumedAt: null,
        expiresAt: { gt: new Date() },
        userId: { not: null },
      },
      data: { consumedAt: new Date() },
    });

    if (claimed.count === 0) {
      throw errors.unauthorized(
        "That sign-in has already been used or has expired. Start again from the sign-in screen.",
        "SSO_CODE_INVALID"
      );
    }

    const login = await prisma.ssoLogin.findUnique({
      where: { codeHash: sha256(code) },
      select: {
        userId: true,
        user: { select: { id: true, email: true, loginRole: true } },
      },
    });

    if (!login?.user) {
      throw errors.unauthorized(
        "That sign-in has already been used or has expired. Start again from the sign-in screen.",
        "SSO_CODE_INVALID"
      );
    }

    const { accessToken, refreshToken } = await sessionsService.issue(
      login.user.id,
      context
    );

    await recordSignIn("SIGN_IN_SUCCEEDED", login.user.id, { method: "microsoft", ...context });

    // The same shape `POST /api/auth/login` answers with, so the application
    // stores a session from either route without knowing which it used.
    return {
      accessToken,
      refreshToken,
      user: {
        id: login.user.id,
        email: login.user.email,
        role: login.user.loginRole,
      },
    };
  },
};
