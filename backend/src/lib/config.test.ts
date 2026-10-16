import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSelfSignedSeal } from "./sealCertificate";
import { assertAppUrlConfigured, assertEnvironment, environmentProblems } from "./config";

/**
 * The startup check. Every value below is one the code used to read and
 * quietly replace with its default; these pin that it is now named instead,
 * and that nothing the code accepts is refused.
 */

const base = { DATABASE_URL: "postgresql://daws:pw@localhost:5432/daws" };
const production = {
  ...base,
  NODE_ENV: "production",
  JWT_SECRET: "x".repeat(32),
  TRUST_PROXY: "1",
};

describe("environmentProblems", () => {
  it("accepts the smallest environment that runs, and the DEPLOY.md one", () => {
    expect(environmentProblems(base)).toEqual([]);
    expect(environmentProblems(production)).toEqual([]);
  });

  it("treats empty as unset, as every use site does", () => {
    expect(
      environmentProblems({ ...base, SMTP_PORT: "", SLA_DEFAULT_DAYS: "  ", ALLOW_STEP_SKIP: "" })
    ).toEqual([]);
  });

  it("accepts every form the code reads", () => {
    expect(
      environmentProblems({
        ...base,
        NODE_ENV: "development",
        DIRECT_URL: "postgres://daws@db/daws",
        PORT: "3106",
        APP_URL: "https://flow.example.com",
        LOG_LEVEL: "debug",
        MAIL_PROVIDER: "microsoft-graph",
        SMTP_PORT: "25",
        SMTP_SECURE: "FALSE",
        MAIL_FROM_ADDRESS: "noreply@example.com",
        GRAPH_MAILBOX: "noreply@example.com",
        GRAPH_SAVE_TO_SENT_ITEMS: "true",
        MAIL_SWEEP_SECONDS: "5",
        LEDGER_SEAL_SECONDS: "30",
        SLA_SWEEP_MINUTES: "1",
        SLA_DEFAULT_DAYS: "3",
        ALLOW_STEP_SKIP: "True",
        PREPARER_SIGNS_ON_SUBMIT: "false",
        REQUIRE_ADMIN_TWO_FACTOR: "false",
        CLAMAV_HOST: "clamd",
        CLAMAV_PORT: "3310",
        CLAMAV_TIMEOUT_MS: "30000",
      })
    ).toEqual([]);
  });

  it("names every problem at once, not one per restart", () => {
    expect(
      environmentProblems({
        ...base,
        NODE_ENV: "prod",
        SLA_DEFAULT_DAYS: "5d",
        ALLOW_STEP_SKIP: "yes",
        MAIL_SWEEP_SECONDS: "2",
        SMTP_PORT: "smtp",
        APP_URL: "flow.example.com",
        LOG_LEVEL: "verbose",
        CLAMAV_PORT: "70000",
      })
    ).toEqual([
      "NODE_ENV must be development, production or test",
      "APP_URL must be a full http:// or https:// address",
      "LOG_LEVEL must be debug, info, warn, error or silent",
      "SMTP_PORT must be a whole number from 1 to 65535",
      "MAIL_SWEEP_SECONDS must be a whole number from 5 up",
      "SLA_DEFAULT_DAYS must be a whole number from 1 up",
      "ALLOW_STEP_SKIP must be true or false",
      "CLAMAV_PORT must be a whole number from 1 to 65535",
    ]);
  });

  it("requires a database, and a real connection string for it", () => {
    expect(environmentProblems({})).toEqual(["DATABASE_URL is required"]);
    expect(environmentProblems({ DATABASE_URL: "mysql://x" })).toEqual([
      "DATABASE_URL must be a postgresql:// connection string",
    ]);
  });

  describe("in production", () => {
    it("requires TRUST_PROXY to be decided, and accepts false as the decision", () => {
      const { TRUST_PROXY: _unset, ...withoutProxy } = production;

      expect(environmentProblems(withoutProxy)).toEqual([
        "TRUST_PROXY is required in production: 1 behind the one reverse proxy in DEPLOY.md, or false if nothing stands in front of the API",
      ]);
      expect(environmentProblems({ ...production, TRUST_PROXY: "false" })).toEqual([]);
      expect(environmentProblems({ ...production, TRUST_PROXY: "0" })).toEqual([]);
    });

    it("requires a JWT secret of 32 characters or more", () => {
      expect(environmentProblems({ ...production, JWT_SECRET: "short" })).toEqual([
        "JWT_SECRET is required in production and must be at least 32 characters",
      ]);
    });

    it("does not ask development for either", () => {
      expect(environmentProblems({ ...base, NODE_ENV: "development" })).toEqual([]);
    });
  });
});

describe("assertEnvironment", () => {
  it("throws one error listing every problem", () => {
    expect(() =>
      assertEnvironment({ ...base, ALLOW_STEP_SKIP: "yes", SLA_DEFAULT_DAYS: "0" })
    ).toThrow(
      "The environment has 2 problems:\n" +
        "  - SLA_DEFAULT_DAYS must be a whole number from 1 up\n" +
        "  - ALLOW_STEP_SKIP must be true or false"
    );
  });

  it("is silent for a sound environment", () => {
    expect(() => assertEnvironment(production)).not.toThrow();
  });
});

describe("assertAppUrlConfigured", () => {
  it("refuses production when neither the environment nor Mail settings give one", () => {
    expect(() => assertAppUrlConfigured(true, "production")).toThrow(
      "APP_URL is required in production"
    );
  });

  it("accepts production once either gives one", () => {
    expect(() => assertAppUrlConfigured(false, "production")).not.toThrow();
  });

  it("leaves development to the localhost default", () => {
    expect(() => assertAppUrlConfigured(true, "development")).not.toThrow();
    expect(() => assertAppUrlConfigured(true, undefined)).not.toThrow();
  });
});

describe("the seal certificate, checked before the API starts", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "daws-seal-config-"));
  const p12Path = path.join(folder, "seal.p12");
  writeFileSync(
    p12Path,
    createSelfSignedSeal({ commonName: "Seal", organization: "Test", passphrase: "the right one", bits: 2048 }).p12
  );

  it("accepts a certificate that opens with its passphrase", () => {
    expect(environmentProblems({ ...base, SEAL_P12_PATH: p12Path, SEAL_P12_PASSWORD: "the right one" })).toEqual([]);
  });

  it("refuses a passphrase that does not open it, without repeating the passphrase", () => {
    const problems = environmentProblems({ ...base, SEAL_P12_PATH: p12Path, SEAL_P12_PASSWORD: "the wrong one" });
    expect(problems).toEqual([expect.stringContaining("could not be opened with SEAL_P12_PASSWORD")]);
    expect(problems.join(" ")).not.toContain("the wrong one");
  });

  it("refuses a path with no file at it", () => {
    expect(environmentProblems({ ...base, SEAL_P12_PATH: path.join(folder, "missing.p12") })).toEqual([
      expect.stringContaining("names a file that does not exist"),
    ]);
  });

  it("is not required: no seal configured is a valid deployment", () => {
    expect(environmentProblems(base)).toEqual([]);
  });

  it("refuses a time zone that is not one", () => {
    expect(environmentProblems({ ...base, TIME_ZONE: "Asia/Karachii" })).toEqual([
      expect.stringContaining("TIME_ZONE must be a time zone name"),
    ]);
  });
});
