import { readFileSync } from "node:fs";
import { certificateName } from "./pdfSeal";
import { isTimeZone } from "./signatureCertificate";
import { z } from "zod";

/**
 * Every environment variable the API reads, checked once, at startup.
 *
 * Each is still read where it is used - several are read on every request so
 * a test or an administrator can change the answer without a restart - and
 * each use site keeps its default. What was missing is anybody saying when a
 * value is wrong. `SLA_DEFAULT_DAYS=5d` meant no deadline at all,
 * `ALLOW_STEP_SKIP=yes` meant no, `MAIL_SWEEP_SECONDS=2` meant sixty, and
 * `NODE_ENV=prod` meant development - JWT secret checks and all. Each of those
 * ran for as long as it took somebody to notice the behaviour, not the typo.
 *
 * So the rules below are exactly what the code already accepts; the only
 * change is that anything else stops the API from starting, with every
 * problem named at once rather than one per restart.
 *
 * `npm run check:env` runs the same check without starting anything - run it
 * against a server's environment before deploying a version with this in.
 */

/** Unset and empty are the same thing everywhere in this codebase. */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }, schema.optional());

const flag = (name: string) =>
  optional(
    z.string().refine((value) => /^(true|false)$/i.test(value), {
      message: `${name} must be true or false`,
    })
  );

const wholeNumber = (name: string, min: number, max = Number.MAX_SAFE_INTEGER) =>
  optional(
    z.string().refine(
      (value) => {
        const n = Number(value);
        return Number.isInteger(n) && n >= min && n <= max;
      },
      { message: `${name} must be a whole number from ${min}${max === Number.MAX_SAFE_INTEGER ? " up" : ` to ${max}`}` }
    )
  );

const port = (name: string) => wholeNumber(name, 1, 65535);

const postgresUrl = (name: string) =>
  z.string().refine((value) => /^postgres(ql)?:\/\/.+/.test(value), {
    message: `${name} must be a postgresql:// connection string`,
  });

const httpUrl = (name: string) =>
  z.string().refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: `${name} must be a full http:// or https:// address` }
  );

const emailAddress = (name: string) =>
  z.string().refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), {
    message: `${name} must be an email address`,
  });

export const environmentSchema = z
  .object({
    NODE_ENV: optional(
      z.enum(["development", "production", "test"], {
        message: "NODE_ENV must be development, production or test",
      })
    ),
    DATABASE_URL: z.preprocess(
      (value) => (typeof value === "string" ? value.trim() : value),
      z.string({ message: "DATABASE_URL is required" }).min(1, "DATABASE_URL is required").pipe(postgresUrl("DATABASE_URL"))
    ),
    DIRECT_URL: optional(postgresUrl("DIRECT_URL")),
    JWT_SECRET: optional(z.string()),
    STORAGE_DIR: optional(z.string()),
    PORT: port("PORT"),
    /* The address the API listens on. Unset is every interface, as always;
       127.0.0.1 keeps it off the network when only a proxy on the same
       machine talks to it - which is what makes TRUST_PROXY safe there. */
    HOST: optional(z.string()),
    TRUST_PROXY: optional(z.string()),
    APP_URL: optional(httpUrl("APP_URL")),
    /* The zone the signature certificate shows times in. Checked against the
       runtime's own zone list, so a typo is caught at start-up rather than
       printing every approved memo in the wrong zone. */
    /* The organisation's seal on approved memos: a PKCS#12 certificate and
       the passphrase that opens it. See `lib/pdfSeal.ts`. */
    SEAL_P12_PATH: optional(z.string()),
    SEAL_P12_PASSWORD: optional(z.string()),
    TIME_ZONE: optional(
      z.string().refine(isTimeZone, {
        message: "TIME_ZONE must be a time zone name such as Asia/Karachi or UTC",
      })
    ),
    LOG_LEVEL: optional(
      z.enum(["debug", "info", "warn", "error", "silent"], {
        message: "LOG_LEVEL must be debug, info, warn, error or silent",
      })
    ),

    MAIL_PROVIDER: optional(
      z.enum(["smtp", "microsoft-graph"], {
        message: "MAIL_PROVIDER must be smtp or microsoft-graph",
      })
    ),
    SMTP_HOST: optional(z.string()),
    SMTP_PORT: port("SMTP_PORT"),
    SMTP_SECURE: flag("SMTP_SECURE"),
    SMTP_USER: optional(z.string()),
    SMTP_PASSWORD: optional(z.string()),
    MAIL_FROM: optional(z.string()),
    MICROSOFT_TENANT_ID: optional(z.string()),
    MICROSOFT_CLIENT_ID: optional(z.string()),
    MICROSOFT_CLIENT_SECRET: optional(z.string()),
    MAIL_FROM_ADDRESS: optional(emailAddress("MAIL_FROM_ADDRESS")),
    MAIL_FROM_NAME: optional(z.string()),
    GRAPH_MAILBOX: optional(emailAddress("GRAPH_MAILBOX")),
    GRAPH_SAVE_TO_SENT_ITEMS: flag("GRAPH_SAVE_TO_SENT_ITEMS"),

    MAIL_SWEEP_SECONDS: wholeNumber("MAIL_SWEEP_SECONDS", 5),
    LEDGER_SEAL_SECONDS: wholeNumber("LEDGER_SEAL_SECONDS", 5),
    SLA_SWEEP_MINUTES: wholeNumber("SLA_SWEEP_MINUTES", 1),
    SLA_DEFAULT_DAYS: wholeNumber("SLA_DEFAULT_DAYS", 1),

    ALLOW_STEP_SKIP: flag("ALLOW_STEP_SKIP"),
    PREPARER_SIGNS_ON_SUBMIT: flag("PREPARER_SIGNS_ON_SUBMIT"),
    REQUIRE_ADMIN_TWO_FACTOR: flag("REQUIRE_ADMIN_TWO_FACTOR"),

    CLAMAV_HOST: optional(z.string()),
    CLAMAV_PORT: port("CLAMAV_PORT"),
    CLAMAV_TIMEOUT_MS: wholeNumber("CLAMAV_TIMEOUT_MS", 1),
  })
  .superRefine((env, ctx) => {
    /*
     * A seal that is configured has to open. Found out at the first final
     * approval instead, it would refuse to approve a memo in front of the
     * person approving it - or, worse, a quiet fallback would file it
     * unsealed. The passphrase is never part of the message.
     */
    if (env.SEAL_P12_PATH) {
      try {
        certificateName(readFileSync(env.SEAL_P12_PATH), env.SEAL_P12_PASSWORD ?? "");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        ctx.addIssue({
          code: "custom",
          path: ["SEAL_P12_PATH"],
          message:
            code === "ENOENT"
              ? `SEAL_P12_PATH names a file that does not exist: ${env.SEAL_P12_PATH}`
              : "SEAL_P12_PATH could not be opened with SEAL_P12_PASSWORD: check the passphrase, and that the file is a .p12 certificate with its key",
        });
      }
    }

    if (env.NODE_ENV !== "production") return;

    if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
      ctx.addIssue({
        code: "custom",
        path: ["JWT_SECRET"],
        message: "JWT_SECRET is required in production and must be at least 32 characters",
      });
    }

    /*
     * Required rather than defaulted, because both answers are right
     * somewhere and a wrong one is silent: behind a proxy, unset records the
     * proxy as every approver and caps sign-in attempts for the whole
     * organisation at once. `false` (or 0) is a deliberate "nothing in front
     * of this API", and is accepted.
     */
    if (env.TRUST_PROXY === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["TRUST_PROXY"],
        message:
          "TRUST_PROXY is required in production: 1 behind the one reverse proxy in DEPLOY.md, or false if nothing stands in front of the API",
      });
    }
  });

/** Every problem with this environment, one line each. Empty means none. */
export function environmentProblems(source: NodeJS.ProcessEnv = process.env): string[] {
  const result = environmentSchema.safeParse(source);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.message);
}

/** Throws one error naming every problem, for the API to refuse to start on. */
export function assertEnvironment(source: NodeJS.ProcessEnv = process.env): void {
  const problems = environmentProblems(source);
  if (problems.length > 0) {
    throw new Error(
      `The environment has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n` +
        problems.map((problem) => `  - ${problem}`).join("\n")
    );
  }
}

/**
 * Where links in email point, when this is production.
 *
 * Asked after the stored mail settings have loaded, because APP_URL can be
 * set on Administration -> Mail instead of in the environment, and that wins.
 * With neither, every notice links to the development UI on localhost -
 * delivered, accepted, and useless - so production refuses to start rather
 * than send one.
 */
export function assertAppUrlConfigured(isDefault: boolean, nodeEnv = process.env.NODE_ENV): void {
  if (nodeEnv?.trim() === "production" && isDefault) {
    throw new Error(
      "APP_URL is required in production: set it to the address people open the application at, " +
        "in the environment or on Administration -> Mail"
    );
  }
}
