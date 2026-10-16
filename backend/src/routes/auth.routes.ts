import { Router } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { validate } from "../middleware/validate";
import { authenticate } from "../middleware/auth";
import { authService } from "../services/auth.service";
import {
  loginSchema,
  signUpSchema,
  refreshTokenSchema,
  signOutSchema,
  ssoExchangeSchema,
  twoFactorSchema,
  totpCodeSchema,
  totpDisableSchema,
  stepUpSchema,
} from "../schemas/auth.schema";
import { totpService } from "../services/totp.service";
import { stepUpService } from "../services/stepUp.service";
import { sessionsService } from "../services/sessions.service";
import { ssoService } from "../services/sso.service";
import { ssoSettingsService } from "../services/ssoSettings.service";
import { logger } from "../lib/logger";
import { requireAdmin } from "../middleware/role";
import {
  loginAccountLimiter,
  loginAddressLimiter,
  refreshLimiter,
  ssoStartLimiter,
  totpSetupLimiter,
  twoFactorLimiter,
} from "../middleware/rateLimit";

const router = Router();

router.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await authService.getMe(req.supabaseUserId!);
    res.json(result);
  })
);

router.post(
  "/login",
  // Ahead of validation: a flood of malformed bodies should be capped too.
  loginAddressLimiter,
  loginAccountLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.login(req.body, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json(result);
  })
);

/**
 * The second half of a sign-in that stopped for a code.
 *
 * Public, because there is no session yet - the password has been proven and
 * nothing else has. What the caller holds is a challenge that names no
 * account to anybody who intercepts it and is worth nothing without the code.
 *
 * Answers in exactly the shape `/login` does, so the application stores a
 * session without knowing which route produced it.
 */
router.post(
  "/2fa",
  twoFactorLimiter,
  validate(twoFactorSchema),
  asyncHandler(async (req, res) => {
    const result = await totpService.completeChallenge(req.body, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json(result);
  })
);

/** Whether this account has a second factor, and how many recovery codes are left. */
router.get(
  "/2fa",
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await totpService.status(req.supabaseUserId!));
  })
);

/**
 * Step one of enrolment: a secret and something to scan.
 *
 * The secret is in this response and nowhere else afterwards. That is the
 * point of it - the phone needs it once, and the server keeps only an
 * encrypted copy it will never hand back.
 */
/**
 * Confirm it is you, for five minutes, before a sensitive change.
 *
 * Answers with a confirmation the app sends back in `X-Step-Up`. See
 * `services/stepUp.service.ts` for which changes ask for one and why.
 */
router.post(
  "/step-up",
  authenticate,
  totpSetupLimiter,
  validate(stepUpSchema),
  asyncHandler(async (req, res) => {
    res.json(await stepUpService.confirm(req.supabaseUserId!, req.body as { password?: string; code?: string }));
  })
);

router.post(
  "/2fa/setup",
  authenticate,
  totpSetupLimiter,
  asyncHandler(async (req, res) => {
    res.json(await totpService.beginEnrolment(req.supabaseUserId!));
  })
);

/**
 * Step two, which is what actually switches it on.
 *
 * Returns the recovery codes, once. They are stored hashed, so there is no
 * second chance to read them and no screen that could offer one.
 */
router.post(
  "/2fa/activate",
  authenticate,
  totpSetupLimiter,
  validate(totpCodeSchema),
  asyncHandler(async (req, res) => {
    const result = await totpService.activate(
      req.supabaseUserId!,
      req.body.code,
      req.ip
    );
    res.json(result);
  })
);

/** A fresh set of recovery codes, in exchange for a live code. */
router.post(
  "/2fa/recovery-codes",
  authenticate,
  totpSetupLimiter,
  validate(totpCodeSchema),
  asyncHandler(async (req, res) => {
    const result = await totpService.replaceRecoveryCodes(
      req.supabaseUserId!,
      req.body.code,
      req.ip
    );
    res.json(result);
  })
);

/** Turning it off, which needs the password rather than a code. */
router.post(
  "/2fa/disable",
  authenticate,
  totpSetupLimiter,
  validate(totpDisableSchema),
  asyncHandler(async (req, res) => {
    const result = await totpService.disable(
      req.supabaseUserId!,
      req.body.password,
      req.ip
    );
    res.json(result);
  })
);

/**
 * Whether to draw the "Continue with Microsoft" button.
 *
 * Public and deliberately one boolean. This is reachable by anyone, and the
 * directory and application ids are not secrets but do name a target - a
 * screen that has to know whether a button works does not have to know that.
 */
router.get(
  "/sso/available",
  asyncHandler(async (_req, res) => {
    const { enabled, configured } = await ssoSettingsService.get();
    res.json({ available: enabled && configured });
  })
);

/** Begin. Nothing is decided here; it is a redirect to Microsoft. */
router.get(
  "/sso/start",
  ssoStartLimiter,
  asyncHandler(async (_req, res) => {
    res.redirect(await ssoService.start());
  })
);

/**
 * Where Microsoft returns.
 *
 * Always a redirect back to the application, never a JSON body: a person is
 * looking at this in their address bar, and an error object rendered as a page
 * of raw JSON is the worst thing to hand somebody who was trying to sign in.
 *
 * What travels in the URL is a fixed reason code, never Microsoft's own text.
 * The detail is in the log, where an administrator can read it and nobody can
 * steer it.
 */
router.get(
  "/sso/callback",
  ssoStartLimiter,
  asyncHandler(async (req, res) => {
    /*
     * Back to the origin the browser is actually on, which is the origin of
     * the registered redirect URI - NOT the mail app URL. See
     * `ssoSettingsService.returnOrigin`. This used `appUrl()`, and on any
     * machine where the two differ that ended a successful sign-in on the
     * OTHER host with the handover code in the query string.
     */
    const origin = await ssoSettingsService.returnOrigin();
    const back = (query: string) => res.redirect(`${origin}/login${query}`);
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";

    /*
     * A confirmation round trip returns to its own small page, which hands
     * the code to the window that asked and closes - never to the sign-in
     * screen, which would start a second session.
     */
    if (state && (await ssoService.purposeOf(state)) === "step-up") {
      const done = (query: string) => res.redirect(`${origin}/sso/confirm${query}`);
      if (!code) return done("?result=refused");
      try {
        const handover = await ssoService.callback({ code, state });
        return done(`?code=${encodeURIComponent(handover)}`);
      } catch (error) {
        logger.error("sso.step_up.failed", {
          message: error instanceof Error ? error.message : "unknown",
        });
        return done("?result=failed");
      }
    }

    // Microsoft reports a refusal by redirecting here with `error` rather than
    // `code` - a consent that was declined, or an account the tenant blocked.
    if (!code || !state) {
      logger.error("sso.callback.refused_by_microsoft", {
        error: typeof req.query.error === "string" ? req.query.error : "missing_code",
      });
      return back("?sso=refused");
    }

    try {
      const handover = await ssoService.callback({ code, state });
      return back(`/sso?code=${encodeURIComponent(handover)}`);
    } catch (error) {
      const reason =
        (error as { code?: string }).code === "SSO_NO_ACCOUNT"
          ? "no-account"
          : "failed";

      logger.error("sso.callback.failed", {
        reason,
        message: error instanceof Error ? error.message : "unknown",
      });

      return back(`?sso=${reason}`);
    }
  })
);

/**
 * Confirm it is you with Microsoft, for somebody who signs in that way.
 *
 * Answers with where to open Microsoft rather than redirecting, because it is
 * called from a signed-in page that opens the address in a small window.
 */
router.post(
  "/step-up/microsoft/start",
  authenticate,
  ssoStartLimiter,
  asyncHandler(async (req, res) => {
    res.json({ url: await ssoService.startStepUp(req.supabaseUserId!) });
  })
);

/** The signed-in page spending the code the small window handed it. */
router.post(
  "/step-up/microsoft",
  authenticate,
  ssoStartLimiter,
  validate(ssoExchangeSchema),
  asyncHandler(async (req, res) => {
    res.json(await ssoService.confirmStepUp((req.body as { code: string }).code, req.supabaseUserId!));
  })
);

/**
 * The application collecting its session.
 *
 * A POST because it spends the code, and because a GET would put it in
 * history a second time. Answers in exactly the shape `/login` does.
 */
router.post(
  "/sso/exchange",
  ssoStartLimiter,
  validate(ssoExchangeSchema),
  asyncHandler(async (req, res) => {
    const result = await ssoService.exchange(req.body.code, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json(result);
  })
);

router.post("/sign-up", 
  authenticate, 
  requireAdmin, 
  validate(signUpSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.signUp(req.body, req.supabaseUserId, req.ip);
    res.status(201).json(result);
  })
);

router.post(
  "/refresh",
  refreshLimiter,
  validate(refreshTokenSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.refresh(req.body, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json(result);
  })
);

/**
 * Sign out.
 *
 * There was no way to do this at all: tokens were signed and stateless, so
 * "sign out" was the client forgetting them and the server never knowing. A
 * refresh token stayed good for thirty days in anybody's hands.
 */
router.post(
  "/sign-out",
  authenticate,
  validate(signOutSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as { refreshToken?: string; everywhere?: boolean };

    const result = await authService.signOut(
      req.supabaseUserId!,
      body.refreshToken,
      body.everywhere === true,
      req.ip
    );

    res.json(result);
  })
);

/**
 * What this account currently has open.
 *
 * "Am I signed in anywhere I did not mean to be?" is the question somebody
 * asks after losing a phone, and it is unanswerable without this.
 */
router.get(
  "/sessions",
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await sessionsService.listFor(req.supabaseUserId!));
  })
);

// `POST /create-admin` was removed: it let any authenticated user mint an
// ADMINISTRATOR account with a hardcoded password. The seed creates the first
// admin; further users go through `/sign-up`, which is admin-gated.

export default router;
