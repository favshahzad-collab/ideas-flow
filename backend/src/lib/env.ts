import "dotenv/config";

import { storedWorkflowPolicy } from "./workflowPolicy";

function getEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing environment variable: ${key}`);
  }
  return value;
}

const NODE_ENV = (process.env.NODE_ENV || "development").trim();

/**
 * The signing secret for locally issued JWTs. Required in production; in
 * development a stable default keeps sessions alive across restarts without
 * anyone having to invent one.
 */
function getJwtSecret(): string {
  const value = process.env.JWT_SECRET?.trim();

  if (!value) {
    if (NODE_ENV === "production") {
      throw new Error(
        "Missing environment variable: JWT_SECRET (required in production)"
      );
    }
    return "daws-development-secret-do-not-use-in-production";
  }

  if (NODE_ENV === "production" && value.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters in production");
  }

  return value;
}

/**
 * How many proxies stand in front of this API, if any.
 *
 * Express reads the client's address off the socket unless it is told
 * otherwise, and behind a reverse proxy that address is the proxy's. Three
 * things quietly go wrong when it is: every approval's audit row records the
 * proxy instead of the approver, the per-address sign-in cap becomes a cap on
 * the whole organisation rather than on one device, and the per-account cap
 * loses the half that was meant to keep one office off another's back.
 *
 * Unset means trust nothing, which is right for an API exposed directly and
 * is what the test suite runs with. `TRUST_PROXY=1` is right for the single
 * reverse proxy in DEPLOY.md. Express also accepts `true`, a comma-separated
 * list of addresses or subnets, and its own names such as `loopback` - those
 * are passed through untouched.
 *
 * A hop count rather than `true` on purpose: `true` accepts whatever the
 * left-most `X-Forwarded-For` entry says, which any client can write. A count
 * makes Express walk in from the socket end and stop at the first address the
 * proxy itself put there.
 */
export function trustProxySetting(
  raw: string | undefined = process.env.TRUST_PROXY
): boolean | number | string {
  const value = raw?.trim();

  if (!value) return false;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;

  const hops = Number(value);
  if (Number.isInteger(hops) && hops >= 0) return hops;

  return value;
}

/**
 * May the preparer pass over an approver who has not acted yet?
 *
 * No, unless somebody switches it on for this deployment. The workflow's whole
 * claim is that a memo carries the approvals it says it carries, and a bypass
 * in the hands of the person who most wants the memo through is the one hole
 * that claim cannot survive. The code is still here - an organisation that
 * genuinely needs it, with the audit row and the mandatory reason it writes,
 * can set `ALLOW_STEP_SKIP=true` and own that decision explicitly.
 *
 * Read at the point of use rather than frozen at import: an administrator can
 * turn it off without a restart, and the test suite can prove both answers in
 * one process - which is how there is a test for the refusal at all.
 *
 * The policy row wins over the environment where there is one. See
 * `lib/workflowPolicy`.
 */
export function stepSkipAllowed(): boolean {
  const policy = storedWorkflowPolicy();

  if (policy) return policy.allowStepSkip;

  return environmentStepSkipAllowed();
}

/** What the environment alone says. See `environmentSlaDays` in `lib/sla`. */
export function environmentStepSkipAllowed(): boolean {
  return (process.env.ALLOW_STEP_SKIP ?? "").trim().toLowerCase() === "true";
}

/**
 * Does submitting a document also mean signing it?
 *
 * Read the same way as the step-skip policy, and defaulting the other way
 * round: this has always been true, every document already filed was signed
 * by its preparer at submission, and a deployment that says nothing must keep
 * getting that. So only the word "false" turns it off - an unset variable, an
 * empty one, or anything misspelt leaves submitters signing.
 */
export function preparerSignsOnSubmit(): boolean {
  const policy = storedWorkflowPolicy();

  if (policy) return policy.preparerSignsOnSubmit;

  return environmentPreparerSignsOnSubmit();
}

/** What the environment alone says. */
export function environmentPreparerSignsOnSubmit(): boolean {
  return (
    (process.env.PREPARER_SIGNS_ON_SUBMIT ?? "").trim().toLowerCase() !==
    "false"
  );
}

/**
 * Does the final approval seal the approved PDF?
 *
 * Defaults to yes, like signing at submission: a deployment that configured a
 * certificate did so to have memos sealed, so only the word "false" turns it
 * off. Without a certificate there is nothing to seal with, and this answer
 * changes nothing.
 */
export function sealApprovedMemos(): boolean {
  const policy = storedWorkflowPolicy();

  if (policy) return policy.sealApprovedMemos;

  return environmentSealApprovedMemos();
}

/** What the environment alone says. */
export function environmentSealApprovedMemos(): boolean {
  return (
    (process.env.SEAL_APPROVED_MEMOS ?? "").trim().toLowerCase() !== "false"
  );
}

/**
 * Must an administrator have two-step sign-in before they can do anything?
 *
 * On unless the environment says exactly "false". An administrator can read
 * every memo, change anybody's role and reach every configuration screen, so
 * a password on its own is the one credential here worth refusing - and the
 * safe default for a deployment that says nothing is the strict one. Read on
 * every request rather than once at boot, so a test or a deployment that sets
 * it is obeyed without a restart.
 */
export function adminTwoFactorRequired(): boolean {
  return (process.env.REQUIRE_ADMIN_TWO_FACTOR ?? "").trim().toLowerCase() !== "false";
}

export const env = {
  DATABASE_URL: getEnv("DATABASE_URL"),
  DIRECT_URL: process.env.DIRECT_URL?.trim() || undefined,
  JWT_SECRET: getJwtSecret(),
  /** Where uploaded PDFs and signatures are written. */
  STORAGE_DIR: (process.env.STORAGE_DIR || "./storage").trim(),
  PORT: (process.env.PORT || "3000").trim(),
  /** The address to listen on; unset is every interface. */
  HOST: process.env.HOST?.trim() || undefined,
  NODE_ENV,
} as const;
