import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appUrl, isMailConfigured, mailSettings } from "./mailer";

/**
 * What an administrator is told about the mail configuration.
 *
 * `configured` used to be the whole answer, and it only ever meant two
 * environment variables were set - not that the host answers, not that the
 * credentials are accepted, and not that the links in a notice point anywhere
 * a person could follow. This is the surface that replaced it, so the tests
 * are about what it reveals and, more importantly, what it must not.
 */

const KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "MAIL_FROM",
  "APP_URL",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function configure(overrides: Partial<Record<(typeof KEYS)[number], string>> = {}) {
  process.env.SMTP_HOST = "smtp.ideas.com.pk";
  process.env.MAIL_FROM = "Ideas Flow <no-reply@ideas.com.pk>";
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
}

describe("what it never says", () => {
  it("does not carry the password, whatever else it carries", () => {
    /*
     * The one hard rule. This object is returned to an administrator's browser
     * and, from there, into a screenshot in a support thread. Nothing here is
     * worth a relay credential.
     */
    configure({ SMTP_USER: "flow@ideas.com.pk", SMTP_PASSWORD: "hunter2-relay-secret" });

    const settings = mailSettings();

    expect(JSON.stringify(settings)).not.toContain("hunter2-relay-secret");
    expect(Object.keys(settings)).not.toContain("pass");
    expect(Object.keys(settings)).not.toContain("password");
  });

  it("does not carry the account name either", () => {
    // A username is half a credential and names a real mailbox. Whether one is
    // in use is the only part worth reporting.
    configure({ SMTP_USER: "svc-approvals@ideas.com.pk", SMTP_PASSWORD: "x" });

    expect(JSON.stringify(mailSettings())).not.toContain("svc-approvals");
  });

  it("says whether authentication is in use, because silence looks like a network fault", () => {
    // A relay that expects a login and is given none refuses in a way that
    // reads like the host being unreachable, which sends somebody to the
    // firewall rather than to the credentials.
    configure({ SMTP_USER: "flow@ideas.com.pk", SMTP_PASSWORD: "x" });
    expect(mailSettings().authenticated).toBe(true);

    delete process.env.SMTP_PASSWORD;
    expect(mailSettings().authenticated).toBe(false);
  });
});

describe("what it reports", () => {
  it("says nothing is configured when nothing is", () => {
    expect(isMailConfigured()).toBe(false);
    expect(mailSettings()).toMatchObject({
      configured: false,
      host: null,
      port: null,
      from: null,
      authenticated: false,
    });
  });

  it("needs both a host and a from address, not one of them", () => {
    // Either alone cannot send anything, and reporting "configured" for half a
    // configuration is how somebody stops looking for the reason.
    process.env.SMTP_HOST = "smtp.ideas.com.pk";
    expect(mailSettings().configured).toBe(false);

    delete process.env.SMTP_HOST;
    process.env.MAIL_FROM = "flow@ideas.com.pk";
    expect(mailSettings().configured).toBe(false);
  });

  it("reports the host and sender an operator can check against the relay", () => {
    configure({ SMTP_PORT: "2525" });

    expect(mailSettings()).toMatchObject({
      configured: true,
      host: "smtp.ideas.com.pk",
      port: 2525,
      from: "Ideas Flow <no-reply@ideas.com.pk>",
    });
  });

  it("treats 465 as implicit TLS without being told", () => {
    configure({ SMTP_PORT: "465" });
    expect(mailSettings().secure).toBe(true);

    configure({ SMTP_PORT: "587" });
    expect(mailSettings().secure).toBe(false);
  });
});

describe("the link every notice carries", () => {
  it("flags the development default, which is the silent failure", () => {
    /*
     * Mail can be configured perfectly and still be useless: every notice
     * carries a link built from APP_URL, and unset it points at the dev UI. The
     * mail is accepted, the queue reads clean, and every approver in the
     * organisation gets a link that only works on the server itself.
     */
    configure();

    expect(mailSettings()).toMatchObject({
      configured: true,
      appUrl: "http://localhost:5173",
      appUrlIsDefault: true,
    });
  });

  it("stops flagging it once somebody sets it", () => {
    configure({ APP_URL: "https://flow.ideas.com.pk" });

    expect(mailSettings()).toMatchObject({
      appUrl: "https://flow.ideas.com.pk",
      appUrlIsDefault: false,
    });
  });

  it("drops a trailing slash so a link is not built with two", () => {
    // `${appUrl}/documents/x` against "https://flow/" gives "https://flow//documents/x",
    // which some mail clients truncate at the double slash.
    process.env.APP_URL = "https://flow.ideas.com.pk///";
    expect(appUrl()).toBe("https://flow.ideas.com.pk");
  });

  it("ignores whitespace somebody left in the env file", () => {
    process.env.APP_URL = "   ";
    expect(mailSettings().appUrlIsDefault).toBe(true);
    expect(appUrl()).toBe("http://localhost:5173");
  });
});
