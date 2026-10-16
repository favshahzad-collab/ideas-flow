import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMailConfigured, mailSettings, useStoredMailConfig } from "../lib/mailer";
import { prisma } from "../prisma";
import { makeUser, useCleanDatabase } from "../test/db";
import { mailSettingsService } from "./mailSettings.service";

/**
 * Mail configuration that an administrator owns rather than the server does.
 *
 * The thing worth testing against a real database is the part that is not
 * obvious from the service: a row here is not configuration until something
 * pushes it into `lib/mailer`, and the mailer is what the queue, the test
 * message and the settings screen all read. Every test below therefore asks
 * the mailer what it thinks, not the table.
 */

/**
 * The whole row as text, for "this secret is nowhere in it" assertions.
 *
 * Plain `JSON.stringify` throws on an audit row: `seq` and `write_seq` are
 * BigInt, and BigInt has no JSON representation. It used to pass only because
 * `seq` is null until the sealer runs and these rows are never sealed here -
 * so the assertion worked by accident and stopped the day a second BigInt
 * column arrived that is never null.
 *
 * Nothing production sends a raw row anywhere: every response maps to a DTO
 * first, and the ledger summary hands `seq` out as a string. This is a test
 * concern only, and the point of the assertion - that a credential is not in
 * the row ANYWHERE, including columns nobody thought to check - is worth
 * keeping exactly as it is.
 */
function wholeRowAsText(row: unknown): string {
  return JSON.stringify(row, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
}

useCleanDatabase();

let adminId: string;

type Form = Parameters<typeof mailSettingsService.save>[0];

const form = (overrides: Partial<Form> = {}): Form =>
  ({
    provider: "SMTP",
    host: "smtp.example.com",
    port: 587,
    secure: false,
    // The name and the address are separate columns now: Graph will not take
    // them glued together, and neither will any address validator.
    fromName: "Ideas Flow",
    fromAddress: "no-reply@example.com",
    username: "",
    password: "",
    ...overrides,
  });

const graphForm = (overrides: Partial<Form> = {}): Form =>
  form({
    provider: "MICROSOFT_GRAPH",
    host: "",
    port: undefined,
    fromAddress: "no-reply@example.com",
    tenantId: "11111111-2222-3333-4444-555555555555",
    clientId: "66666666-7777-8888-9999-000000000000",
    clientSecret: "a-client-secret-from-the-app-registration",
    ...overrides,
  });

beforeEach(async () => {
  const admin = await makeUser({ loginRole: "ADMINISTRATOR" });
  adminId = admin.id;
  useStoredMailConfig(null);
});

afterEach(() => {
  // The mailer holds this in a module variable, so a test that leaves one
  // behind configures the next file that runs in this worker.
  useStoredMailConfig(null);
});

describe("saving the mail server from the administration screens", () => {
  it("makes it the configuration the mailer uses", async () => {
    await mailSettingsService.save(form(), adminId);

    expect(isMailConfigured()).toBe(true);
    expect(mailSettings()).toMatchObject({
      configured: true,
      host: "smtp.example.com",
      port: 587,
      from: "Ideas Flow <no-reply@example.com>",
      source: "database",
    });
  });

  it("beats the server's environment", async () => {
    /*
     * The decision this feature rests on. An administrator who fills in the
     * form expects the form to be what happens; a variable quietly winning
     * would be undebuggable from inside the application, because the screen
     * would show one thing and the queue would do another.
     */
    process.env.SMTP_HOST = "smtp.from-the-environment.example";
    process.env.MAIL_FROM = "env@example.com";

    try {
      await mailSettingsService.save(form({ host: "smtp.from-the-form.example" }), adminId);
      expect(mailSettings().host).toBe("smtp.from-the-form.example");
    } finally {
      delete process.env.SMTP_HOST;
      delete process.env.MAIL_FROM;
    }
  });

  it("never stores the password as text", async () => {
    // The whole reason moving this into the database needed care. A backup of
    // this table must not be a relay credential.
    await mailSettingsService.save(
      form({ username: "svc@example.com", password: "hunter2-relay-secret" }),
      adminId
    );

    const row = await prisma.mailSetting.findFirstOrThrow();
    expect(row.passwordCipher).not.toBeNull();
    expect(row.passwordCipher).not.toContain("hunter2-relay-secret");
    expect(wholeRowAsText(row)).not.toContain("hunter2-relay-secret");
  });

  it("keeps the stored password when the field is left blank", async () => {
    // Otherwise changing a port would mean knowing the relay password, which
    // is exactly the situation this feature exists to get somebody out of.
    await mailSettingsService.save(
      form({ username: "svc@example.com", password: "hunter2" }),
      adminId
    );
    const before = await prisma.mailSetting.findFirstOrThrow();

    await mailSettingsService.save(
      form({ username: "svc@example.com", password: "", port: 2525 }),
      adminId
    );

    const after = await prisma.mailSetting.findFirstOrThrow();
    expect(after.port).toBe(2525);
    expect(after.passwordCipher).toBe(before.passwordCipher);
    expect(mailSettings().authenticated).toBe(true);
  });

  it("removes the password only when asked explicitly", async () => {
    await mailSettingsService.save(
      form({ username: "svc@example.com", password: "hunter2" }),
      adminId
    );

    await mailSettingsService.save(
      form({ username: "", clearPassword: true }),
      adminId
    );

    const row = await prisma.mailSetting.findFirstOrThrow();
    expect(row.passwordCipher).toBeNull();
    expect(mailSettings().authenticated).toBe(false);
  });

  it("refuses an account with no password to go with it", async () => {
    // It would fail at the relay, in a way that reads like a network problem,
    // long after the person who typed it has gone home.
    await expect(
      mailSettingsService.save(
        form({ username: "svc@example.com", password: "" }),
        adminId
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("does NOT drop the account just because the field is blank", async () => {
    /*
     * This test asserted the opposite until the day it was nearly acted on.
     * The account field is never populated - the server does not send a
     * username back - so "blank" is what it looks like on every visit, and
     * treating that as "remove it" meant any edit to any other field deleted
     * the relay credentials. Removing them is now the switch below.
     */
    await mailSettingsService.save(
      form({ username: "svc@example.com", password: "hunter2" }),
      adminId
    );

    await mailSettingsService.save(form({ username: "" }), adminId);

    const row = await prisma.mailSetting.findFirstOrThrow();
    expect(row.username).toBe("svc@example.com");
    expect(row.passwordCipher).not.toBeNull();
  });

  it("keeps one row however many times it is saved", async () => {
    // There is a check constraint behind this as well. "What is this system
    // configured to send through" must not become a question about ordering.
    await mailSettingsService.save(form(), adminId);
    await mailSettingsService.save(form({ host: "second.example.com" }), adminId);
    await mailSettingsService.save(form({ host: "third.example.com" }), adminId);

    expect(await prisma.mailSetting.count()).toBe(1);
    expect(mailSettings().host).toBe("third.example.com");
  });

  it("refuses a second row at the database, not just in the service", async () => {
    await mailSettingsService.save(form(), adminId);

    await expect(
      prisma.mailSetting.create({
        data: {
          id: "another",
          host: "smtp.example.com",
          port: 25,
          secure: false,
          fromAddress: "x@example.com",
        },
      })
    ).rejects.toThrow();
  });
});

describe("the address in the links", () => {
  it("is used for the links in every notice", async () => {
    // The failure this prevents is the quiet one: mail sends perfectly and
    // every approver receives a link to somebody's laptop.
    await mailSettingsService.save(
      form({ appUrl: "https://flow.example.com" }),
      adminId
    );

    expect(mailSettings().appUrl).toBe("https://flow.example.com");
    expect(mailSettings().appUrlIsDefault).toBe(false);
  });

  it("has its trailing slashes taken off", async () => {
    await mailSettingsService.save(
      form({ appUrl: "https://flow.example.com///" }),
      adminId
    );

    expect(mailSettings().appUrl).toBe("https://flow.example.com");
  });

  it("still reports the default when nobody has set one", async () => {
    await mailSettingsService.save(form({ appUrl: "" }), adminId);

    expect(mailSettings().appUrlIsDefault).toBe(true);
  });
});

describe("handing mail back to the environment", () => {
  it("stops the stored configuration being used", async () => {
    await mailSettingsService.save(form(), adminId);
    expect(mailSettings().source).toBe("database");

    await mailSettingsService.clear(adminId);

    expect(await prisma.mailSetting.count()).toBe(0);
    expect(mailSettings().source).toBe("none");
    expect(isMailConfigured()).toBe(false);
  });

  it("is safe to do when nothing is stored", async () => {
    await expect(mailSettingsService.clear(adminId)).resolves.toBeUndefined();
  });
});

describe("what the trail records", () => {
  it("writes a row naming the server, and never the password", async () => {
    await mailSettingsService.save(
      form({ username: "svc@example.com", password: "hunter2-relay-secret" }),
      adminId
    );

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: "MAIL_SETTINGS_UPDATED" },
    });
    expect(row.actorId).toBe(adminId);
    expect(JSON.stringify(row.newValue)).toContain("smtp.example.com");
    // The audit trail is exported. A credential must not leave in it.
    expect(wholeRowAsText(row)).not.toContain("hunter2-relay-secret");
    expect(JSON.stringify(row.newValue)).toContain("hasPassword");
  });

  it("distinguishes clearing from changing", async () => {
    await mailSettingsService.save(form(), adminId);
    await mailSettingsService.clear(adminId);

    expect(
      await prisma.auditLog.count({ where: { action: "MAIL_SETTINGS_CLEARED" } })
    ).toBe(1);
  });
});

describe("a password that cannot be read", () => {
  it("is reported as its own state rather than as no password", async () => {
    /*
     * What a rotated JWT_SECRET looks like from the outside. Sending with no
     * password to a relay that expects one fails like an unreachable host, so
     * the screen has to be able to say "re-enter it" instead.
     */
    await mailSettingsService.save(
      form({ username: "svc@example.com", password: "hunter2" }),
      adminId
    );

    await prisma.mailSetting.update({
      where: { id: "singleton" },
      data: { passwordCipher: "gcm1.not.a.value" },
    });
    await mailSettingsService.applyStoredMailSettings();

    expect(mailSettings().passwordUnreadable).toBe(true);
    expect(mailSettings().authenticated).toBe(false);
    // And it is still configured: the host is fine, only the credential is not.
    expect(mailSettings().configured).toBe(true);
  });
});

describe("Microsoft Graph", () => {
  /**
   * The provider to prefer on Microsoft 365, and the reason this screen grew a
   * provider at all: Graph hands the message to Exchange Online directly, so
   * SPF stops being something this deployment has to get right in DNS before
   * anybody is told anything.
   */

  it("becomes the provider the mailer uses", async () => {
    await mailSettingsService.save(graphForm(), adminId);

    expect(isMailConfigured()).toBe(true);
    expect(mailSettings()).toMatchObject({
      configured: true,
      provider: "MICROSOFT_GRAPH",
      source: "database",
      // No host, because there is not one. A screen that showed an SMTP
      // hostname beside Graph would be describing something that does not
      // exist.
      host: null,
      port: null,
    });
  });

  it("never stores the client secret as text", async () => {
    await mailSettingsService.save(
      graphForm({ clientSecret: "a-very-secret-client-secret" }),
      adminId
    );

    const row = await prisma.mailSetting.findFirstOrThrow();
    expect(row.clientSecretCipher).not.toBeNull();
    expect(wholeRowAsText(row)).not.toContain("a-very-secret-client-secret");
  });

  it("never reports the tenant or client id in full", async () => {
    // Not secrets, but together they name a target, and this object goes to a
    // browser and from there into screenshots.
    await mailSettingsService.save(graphForm(), adminId);

    const settings = mailSettings();
    expect(settings.tenantIdMasked).not.toContain("11111111");
    expect(settings.tenantIdMasked).toContain("5555");
    expect(settings.hasClientSecret).toBe(true);
    expect(JSON.stringify(settings)).not.toContain(
      "a-client-secret-from-the-app-registration"
    );
  });

  it("keeps the stored client secret when the field is left blank", async () => {
    // Same reason as the SMTP password: changing the mailbox must not require
    // going back to the portal to regenerate a secret.
    await mailSettingsService.save(graphForm(), adminId);
    const before = await prisma.mailSetting.findFirstOrThrow();

    await mailSettingsService.save(
      graphForm({ clientSecret: "", mailbox: "notices@example.com" }),
      adminId
    );

    const after = await prisma.mailSetting.findFirstOrThrow();
    expect(after.graphMailbox).toBe("notices@example.com");
    expect(after.clientSecretCipher).toBe(before.clientSecretCipher);
  });

  it("refuses to be configured without a secret", async () => {
    /*
     * Refused here rather than at Microsoft, which answers `invalid_client` -
     * a message that reads like the secret being wrong rather than absent, and
     * sends somebody off to regenerate a perfectly good one.
     */
    await expect(
      mailSettingsService.save(graphForm({ clientSecret: "" }), adminId)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses to be configured without a directory or an application", async () => {
    await expect(
      mailSettingsService.save(graphForm({ tenantId: "" }), adminId)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("sends as the address it sends from, unless told otherwise", async () => {
    await mailSettingsService.save(graphForm(), adminId);
    expect(mailSettings().mailbox).toBe("no-reply@example.com");

    await mailSettingsService.save(
      graphForm({ clientSecret: "", mailbox: "notices@example.com" }),
      adminId
    );
    expect(mailSettings().mailbox).toBe("notices@example.com");
  });

  it("forgets the SMTP relay when it takes over", async () => {
    // Otherwise a stale host sits in the row, shows on no screen, and comes
    // back the day somebody switches provider again.
    await mailSettingsService.save(
      form({ username: "svc@example.com", password: "hunter2" }),
      adminId
    );

    await mailSettingsService.save(graphForm(), adminId);

    const row = await prisma.mailSetting.findFirstOrThrow();
    expect(row.host).toBeNull();
    expect(row.port).toBeNull();
    expect(row.username).toBeNull();
    expect(row.passwordCipher).toBeNull();
  });

  it("gives the relay back when SMTP takes over again", async () => {
    await mailSettingsService.save(graphForm(), adminId);
    await mailSettingsService.save(form(), adminId);

    const row = await prisma.mailSetting.findFirstOrThrow();
    expect(row.provider).toBe("SMTP");
    expect(row.tenantId).toBeNull();
    expect(row.clientSecretCipher).toBeNull();
    expect(mailSettings().provider).toBe("SMTP");
  });

  it("keeps a copy in Sent Items unless told not to", async () => {
    await mailSettingsService.save(graphForm(), adminId);
    expect(mailSettings().saveToSentItems).toBe(true);

    await mailSettingsService.save(
      graphForm({ clientSecret: "", saveToSentItems: false }),
      adminId
    );
    expect(mailSettings().saveToSentItems).toBe(false);
  });

  it("writes no credential into the audit trail", async () => {
    await mailSettingsService.save(graphForm(), adminId);

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: "MAIL_SETTINGS_UPDATED" },
      orderBy: { createdAt: "desc" },
    });
    expect(wholeRowAsText(row)).not.toContain(
      "a-client-secret-from-the-app-registration"
    );
    // The identifiers are masked everywhere else; there is no reason for the
    // exported trail to be the one place they are readable.
    expect(wholeRowAsText(row)).not.toContain("11111111-2222");
    expect(JSON.stringify(row.newValue)).toContain("hasClientSecret");
  });
});

describe("editing one field without losing the others", () => {
  /**
   * The rule the screen states, tested for every value the screen refuses to
   * show. It used to hold for the two passwords only, and the account field -
   * which always looks blank, because it is never sent back - deleted the
   * relay account and its password every time somebody changed something else
   * and pressed Save. The next notice failed to authenticate, which a relay
   * reports in a way that reads like a network problem.
   *
   * The specific thing that nearly happened: correcting the sender address
   * from no-reply@ to noreply@ would have taken the Office 365 credentials
   * with it.
   */

  it("keeps the SMTP account when only the sender address changes", async () => {
    await mailSettingsService.save(
      form({ username: "svc@example.com", password: "hunter2" }),
      adminId
    );

    // Exactly what the form sends when somebody edits the address and nothing
    // else: both credential fields blank, because neither is ever populated.
    await mailSettingsService.save(
      form({
        username: "",
        password: "",
        fromAddress: "noreply@example.com",
      }),
      adminId
    );

    const row = await prisma.mailSetting.findFirstOrThrow();
    expect(row.fromAddress).toBe("noreply@example.com");
    expect(row.username).toBe("svc@example.com");
    expect(row.passwordCipher).not.toBeNull();
    expect(mailSettings().authenticated).toBe(true);
  });

  it("still lets the account be changed by typing a new one", async () => {
    await mailSettingsService.save(
      form({ username: "old@example.com", password: "hunter2" }),
      adminId
    );

    await mailSettingsService.save(
      form({ username: "new@example.com", password: "" }),
      adminId
    );

    const row = await prisma.mailSetting.findFirstOrThrow();
    expect(row.username).toBe("new@example.com");
    // The password it already had still works for the account it names.
    expect(row.passwordCipher).not.toBeNull();
  });

  it("removes the account and its password together, when asked", async () => {
    // They are a pair: a username with no password is refused, so one switch
    // has to take both or it leaves a state this service would not accept.
    await mailSettingsService.save(
      form({ username: "svc@example.com", password: "hunter2" }),
      adminId
    );

    await mailSettingsService.save(form({ clearPassword: true }), adminId);

    const row = await prisma.mailSetting.findFirstOrThrow();
    expect(row.username).toBeNull();
    expect(row.passwordCipher).toBeNull();
    expect(mailSettings().authenticated).toBe(false);
  });

  it("keeps the tenant and client ids when only the mailbox changes", async () => {
    // Same rule, same reason: they are shown masked, so the fields are blank.
    await mailSettingsService.save(graphForm(), adminId);

    await mailSettingsService.save(
      graphForm({
        tenantId: "",
        clientId: "",
        clientSecret: "",
        mailbox: "notices@example.com",
      }),
      adminId
    );

    const row = await prisma.mailSetting.findFirstOrThrow();
    expect(row.tenantId).toBe("11111111-2222-3333-4444-555555555555");
    expect(row.clientId).toBe("66666666-7777-8888-9999-000000000000");
    expect(row.clientSecretCipher).not.toBeNull();
    expect(row.graphMailbox).toBe("notices@example.com");
  });

  it("keeps the Graph mailbox when only the sender name changes", async () => {
    await mailSettingsService.save(
      graphForm({ mailbox: "notices@example.com" }),
      adminId
    );

    await mailSettingsService.save(
      graphForm({ tenantId: "", clientId: "", clientSecret: "", mailbox: "", fromName: "Ideas" }),
      adminId
    );

    const row = await prisma.mailSetting.findFirstOrThrow();
    expect(row.fromName).toBe("Ideas");
    expect(row.graphMailbox).toBe("notices@example.com");
  });
});
