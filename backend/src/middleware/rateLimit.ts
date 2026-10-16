import { rateLimit, ipKeyGenerator, type Options } from "express-rate-limit";
import type { Request, Response } from "express";
import { prisma } from "../prisma";
import { recordSignIn } from "../services/signInAudit";

/**
 * Sign-in had no attempt cap at all: an unlimited number of guesses could be
 * thrown at any known address. scrypt makes each guess slow, which raises the
 * cost of a brute-force run but does not bound it.
 *
 * Only the auth routes are limited. A general cap on `/api` would have to be
 * loose enough for a dashboard that fires several requests per navigation,
 * which makes it security theatre; the value here is all on the credential
 * endpoints.
 */

const WINDOW_MS = 15 * 60 * 1000;

/** The app's error shape, so the client renders the message rather than falling back. */
function tooManyRequests(message: string): Options["handler"] {
  return (_request: Request, response: Response) => {
    response.status(429).json({
      error: { message, code: "TOO_MANY_REQUESTS" },
    });
  };
}

/**
 * The address a sign-in is for, lowercased, or "". The limiters run before
 * schema validation, so the body is untrusted and read as `unknown`.
 */
function emailIn(request: Request): string {
  const body: unknown = request.body;
  if (typeof body !== "object" || body === null || !("email" in body)) return "";
  return typeof body.email === "string" ? body.email.toLowerCase().trim() : "";
}

const shared = {
  windowMs: WINDOW_MS,
  standardHeaders: "draft-8",
  legacyHeaders: false,
} as const;

/**
 * Per address being signed in to, not per IP alone: a whole office behind one
 * NAT address must not be locked out because one account is under attack.
 * Successful sign-ins are not counted, so nobody is penalised for using the
 * product normally.
 */
export const loginAccountLimiter = rateLimit({
  ...shared,
  limit: 8,
  skipSuccessfulRequests: true,
  keyGenerator: (request: Request) =>
    `${ipKeyGenerator(request.ip ?? "")}:${emailIn(request)}`,
  handler: (request: Request, response: Response, next, options) => {
    void recordThrottled(request);
    return tooManyRequests(
      "Too many sign-in attempts for this account. Try again in 15 minutes."
    )(request, response, next, options);
  },
});

/**
 * The account the limit just started refusing, into the trail - once per
 * account per window, not once per refused request, so somebody hammering the
 * form cannot fill the trail with it. Only for an address that has an
 * account; an unknown one has no row to point at.
 */
const throttledRecently = new Map<string, number>();

async function recordThrottled(request: Request): Promise<void> {
  const email = emailIn(request);
  if (!email) return;

  const now = Date.now();
  for (const [key, at] of throttledRecently) {
    if (now - at > WINDOW_MS) throttledRecently.delete(key);
  }
  if (throttledRecently.has(email)) return;
  throttledRecently.set(email, now);

  try {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) return;
    await recordSignIn("SIGN_IN_THROTTLED", user.id, {
      method: "password",
      email,
      ipAddress: request.ip ?? null,
      userAgent: request.get("user-agent") ?? null,
    });
  } catch {
    // recordSignIn logs its own failures; the lookup failing leaves the 429 as it was.
  }
}

/**
 * The second half of the pair: the per-account limit alone would still let one
 * IP spray a password across many addresses, one failure each.
 */
export const loginAddressLimiter = rateLimit({
  ...shared,
  limit: 40,
  skipSuccessfulRequests: true,
  handler: tooManyRequests(
    "Too many sign-in attempts from this device. Try again in 15 minutes."
  ),
});

/**
 * The single sign-on round trip.
 *
 * One person signing in touches this three times - start, callback, exchange -
 * and a browser that fails halfway will be retried a few times by hand. Well
 * clear of that, and still a bound on somebody grinding at the handover code,
 * which is the one guessable thing in the flow.
 */
export const ssoStartLimiter = rateLimit({
  ...shared,
  limit: 60,
  handler: tooManyRequests(
    "Too many sign-in attempts from this device. Try again in 15 minutes."
  ),
});

/**
 * Refresh is called once per expiring session, so a legitimate client is
 * nowhere near this. It bounds guessing at a refresh token.
 */
export const refreshLimiter = rateLimit({
  ...shared,
  limit: 60,
  handler: tooManyRequests("Too many requests. Wait a moment and try again."),
});

/**
 * The test-notice button sends real mail to a real mailbox.
 *
 * Held down, it is a way to post a few hundred messages through the
 * organisation's relay from inside the product - which is how a sender's
 * reputation gets spent and how a relay starts refusing the approval notices
 * that matter. Five in fifteen minutes is more than anybody needs to satisfy
 * themselves the path works.
 *
 * Keyed on the administrator rather than the address: they are already
 * authenticated, and several of them behind one office address must not share
 * a budget.
 */
/**
 * Changing your own password.
 *
 * The endpoint checks the current password, which makes it a place to
 * guess one. Keyed on the account rather than the address, because the
 * caller is authenticated and the thing worth protecting is the account.
 */
export const passwordChangeLimiter = rateLimit({
  ...shared,
  limit: 10,
  keyGenerator: (request: Request) =>
    request.supabaseUserId ?? ipKeyGenerator(request.ip ?? ""),
  handler: tooManyRequests(
    "Too many password attempts. Wait a few minutes before trying again."
  ),
});

/**
 * The second factor.
 *
 * The real bound on guessing lives on the challenge row, which dies after
 * five tries - this is the backstop that stops somebody cycling through fresh
 * challenges to get five more each time. Keyed on the address because the
 * caller has no session yet and the challenge names no account to anyone
 * holding it.
 *
 * Set where a person re-reading a code off a phone, mistyping it twice and
 * reaching for the recovery envelope stays well clear.
 */
export const twoFactorLimiter = rateLimit({
  ...shared,
  limit: 20,
  skipSuccessfulRequests: true,
  handler: tooManyRequests(
    "Too many codes tried from this device. Try again in 15 minutes."
  ),
});

/**
 * Enrolment and the codes typed into it.
 *
 * Authenticated, so keyed on the account. Confirming a setup takes one or two
 * attempts; anything near this is somebody grinding at their own secret,
 * which is pointless, or at somebody else's session, which is not.
 */
export const totpSetupLimiter = rateLimit({
  ...shared,
  limit: 20,
  keyGenerator: (request: Request) =>
    request.supabaseUserId ?? ipKeyGenerator(request.ip ?? ""),
  handler: tooManyRequests(
    "Too many attempts. Wait a few minutes before trying again."
  ),
});

export const mailTestLimiter = rateLimit({
  ...shared,
  limit: 5,
  keyGenerator: (request: Request) =>
    request.supabaseUserId ?? ipKeyGenerator(request.ip ?? ""),
  handler: tooManyRequests(
    "Too many test notices. Wait a few minutes before trying again."
  ),
});

/**
 * Drawing a memo preview.
 *
 * Unlike every other route in the app, this one does real work per request:
 * it embeds five fonts and lays out up to 120,000 characters, all on the one
 * thread that serves everybody else. The cap is loose enough that somebody
 * writing a memo and previewing it after every paragraph never meets it, and
 * tight enough that a loop cannot hold the event loop for fifteen minutes.
 *
 * Keyed on the account rather than the address: this needs a session, so
 * there is always somebody to attribute it to, and a shared office address
 * should not slow everyone down because one person is drafting.
 */
export const memoPreviewLimiter = rateLimit({
  ...shared,
  limit: 150,
  keyGenerator: (request: Request) =>
    request.supabaseUserId ?? ipKeyGenerator(request.ip ?? ""),
  handler: tooManyRequests(
    "Too many previews. Wait a few minutes, then preview again."
  ),
});
