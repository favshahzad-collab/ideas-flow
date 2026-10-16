import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, useCleanDatabase } from "../test/db";
import { hashPassword } from "../lib/password";
import { base32Decode, hotp, stepAt } from "../lib/totp";
import { prisma } from "../prisma";
import { authService, wantsSecondFactor } from "./auth.service";
import { totpService } from "./totp.service";
import { usersService } from "./users.service";

/**
 * What the owner of an account is told when its protection changes.
 *
 * The audit trail already records every one of these - TWO_FACTOR_DISABLED,
 * TWO_FACTOR_RESET, TWO_FACTOR_RECOVERY_USED, PASSWORD_RESET. That is a
 * forensic record an administrator reads afterwards, when they already have a
 * reason to look. It is not the same thing as telling the person whose
 * account it is, at the moment it happens.
 *
 * The difference is the whole attack: somebody holding a stolen session turns
 * the second factor off and changes the password, and every one of those
 * actions is faithfully written down where nobody is watching. The owner's
 * first sign that anything happened is being unable to sign in.
 *
 * These assert the WHOLE list of notices each action produces, not that some
 * particular row exists. A row-at-a-time test cannot see a notice that was
 * never written, and cannot see a second one that should not have been.
 */

useCleanDatabase();

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a different horse entirely";

let user: Awaited<ReturnType<typeof makeUser>>;
let secret: string;

/** The code the person's phone would be showing right now. */
function phoneShows(): string {
  return hotp(base32Decode(secret)!, BigInt(stepAt(Date.now())));
}

/**
 * An account with the second factor switched on.
 *
 * `totpLastStep` is cleared afterwards because activation legitimately spends
 * the code it was given, and every test below wants the next code to work.
 */
async function enrolled(): Promise<string[]> {
  const started = await totpService.beginEnrolment(user.id);
  secret = started.secret;

  const { recoveryCodes } = await totpService.activate(user.id, phoneShows());

  await prisma.user.update({
    where: { id: user.id },
    data: { totpLastStep: null },
  });

  return recoveryCodes;
}

/**
 * Every notice queued, as "who | what".
 *
 * Sorted by time and then by the line itself. The tiebreaker is not cosmetic:
 * `created_at` defaults to `now()`, which in Postgres is the TRANSACTION's
 * start time, so notices raised by one action share a timestamp exactly and
 * their order among themselves is the planner's business. Compared with `<`
 * rather than `localeCompare`, which would hand the answer to a locale.
 */
async function notices(): Promise<string[]> {
  const messages = await prisma.emailMessage.findMany({
    select: { recipientEmail: true, subject: true, createdAt: true },
  });

  return messages
    .map((message) => ({
      at: message.createdAt.getTime(),
      line: `${message.recipientEmail.split("@")[0]} | ${message.subject}`,
    }))
    .sort((a, b) => a.at - b.at || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0))
    .map((message) => message.line);
}

/** Every inbox row, as "type | title". */
async function inbox(): Promise<string[]> {
  const rows = await prisma.notification.findMany({
    select: { type: true, title: true, createdAt: true },
  });

  return rows
    .map((row) => ({ at: row.createdAt.getTime(), line: `${row.type} | ${row.title}` }))
    .sort((a, b) => a.at - b.at || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0))
    .map((row) => row.line);
}

beforeEach(async () => {
  user = await makeUser({ firstName: "Owner" });

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(PASSWORD) },
  });
});

describe("turning the second factor off", () => {
  it("tells the person whose account it is", async () => {
    await enrolled();
    await totpService.disable(user.id, PASSWORD);

    expect(await notices()).toEqual([
      `${user.email.split("@")[0]} | Security alert`,
    ]);
  });

  it("puts it in their inbox as well as their mail", async () => {
    await enrolled();
    await totpService.disable(user.id, PASSWORD);

    expect(await inbox()).toEqual([
      "SECURITY_ALERT | Two-factor authentication turned off",
    ]);
  });

  it("says what happened, not merely that something did", async () => {
    await enrolled();
    await totpService.disable(user.id, PASSWORD);

    const notice = await prisma.notification.findFirstOrThrow();

    // The message is the whole value of the notice: somebody reading "a
    // security setting changed" cannot tell whether to worry.
    expect(notice.message).toContain("Two-factor authentication");
    expect(notice.message.toLowerCase()).toContain("turned off");
  });
});

describe("an administrator lifting somebody's second factor", () => {
  it("tells the person it belonged to, not only the trail", async () => {
    await enrolled();

    const admin = await makeUser({ firstName: "Admin" });
    await totpService.resetFor(user.id, admin.id);

    // Exactly one notice, to the owner. The administrator already knows: they
    // just did it.
    expect(await notices()).toEqual([
      `${user.email.split("@")[0]} | Security alert`,
    ]);
  });

  it("says an administrator did it, because that changes what the owner should do", async () => {
    await enrolled();

    const admin = await makeUser({ firstName: "Admin" });
    await totpService.resetFor(user.id, admin.id);

    const notice = await prisma.notification.findFirstOrThrow();

    expect(notice.message.toLowerCase()).toContain("administrator");
  });
});

describe("a recovery code being spent", () => {
  it("tells the account owner that one was used", async () => {
    const codes = await enrolled();

    const started = await authService.login({
      email: user.email,
      password: PASSWORD,
    });

    if (!wantsSecondFactor(started)) {
      throw new Error("the account should have asked for a second factor");
    }

    await totpService.completeChallenge({
      challenge: started.challenge,
      code: codes[0],
    });

    expect(await notices()).toEqual([
      `${user.email.split("@")[0]} | Security alert`,
    ]);
  });

  it("does not raise one for an ordinary code from the phone", async () => {
    // The point of the notice is that a recovery code is exceptional. One on
    // every sign-in would train people to ignore it.
    await enrolled();

    const started = await authService.login({
      email: user.email,
      password: PASSWORD,
    });

    if (!wantsSecondFactor(started)) {
      throw new Error("the account should have asked for a second factor");
    }

    await totpService.completeChallenge({
      challenge: started.challenge,
      code: phoneShows(),
    });

    expect(await notices()).toEqual([]);
  });
});

describe("changing a password", () => {
  it("tells the account owner", async () => {
    await usersService.changeOwnPassword(user.id, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(await notices()).toEqual([
      `${user.email.split("@")[0]} | Security alert`,
    ]);
  });

  it("sends ONE notice, not one for the password and another for the sessions", async () => {
    /*
     * `changeOwnPassword` ends every session as part of the change, which is
     * the honest consequence of it. If both the change and the ending raised
     * a notice, one action would produce two mails saying almost the same
     * thing - and the second would be the one that got the account owner to
     * filter the first.
     */
    await usersService.changeOwnPassword(user.id, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(await inbox()).toHaveLength(1);
  });

  it("mentions that the other sessions ended, since that is what the owner will notice", async () => {
    await usersService.changeOwnPassword(user.id, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    const notice = await prisma.notification.findFirstOrThrow();

    expect(notice.message.toLowerCase()).toContain("signed out");
  });

  it("raises nothing when the change was refused", async () => {
    // A wrong current password is a failed attempt, not a change. Notifying
    // on it hands anybody who can reach the endpoint a way to send mail.
    await expect(
      usersService.changeOwnPassword(user.id, {
        currentPassword: "not the password",
        newPassword: NEW_PASSWORD,
      })
    ).rejects.toThrow();

    expect(await notices()).toEqual([]);
    expect(await inbox()).toEqual([]);
  });
});
