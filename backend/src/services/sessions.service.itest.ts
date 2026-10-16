import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { makeUser, useCleanDatabase } from "../test/db";
import { adminService } from "./admin.service";
import { authService, wantsSecondFactor } from "./auth.service";
import { sessionsService } from "./sessions.service";
import { hashPassword } from "../lib/password";
import { verifyToken } from "../lib/tokens";

/**
 * Ending a session, which is the thing signed tokens are worst at.
 *
 * A JWT is a claim the holder carries; nothing on this side can reach into
 * their laptop and take it back. So every test here is really the same
 * question asked in different words: after the server has said "no longer",
 * does the token the client is still holding actually stop working?
 *
 * Two mechanisms answer it, and both are needed. A session row ends one
 * device's refresh token. The cutoff on the account ends everything including
 * an access token sitting unused in a tab - which no session row can reach,
 * because the client has not presented it yet.
 */

useCleanDatabase();

const PASSWORD = "correct horse battery";
const EMAIL = "sessions@example.com";

let userId: string;

beforeEach(async () => {
  const user = await makeUser();
  userId = user.id;
  await prisma.user.update({
    where: { id: userId },
    data: { email: EMAIL, passwordHash: await hashPassword(PASSWORD) },
  });
});

/**
 * A sign-in that is expected to produce a session.
 *
 * Narrowed here rather than at every call below: `login` can now answer with a
 * second-factor challenge instead, and none of these accounts has one. If that
 * ever changes, this throws with a name rather than each test failing on an
 * undefined token.
 */
const signIn = async () => {
  const result = await authService.login({ email: EMAIL, password: PASSWORD });

  if (wantsSecondFactor(result)) {
    throw new Error("this account unexpectedly asked for a second factor");
  }

  return result;
};

const stillValid = async (accessToken: string) => {
  const claim = await verifyToken(accessToken, "access");
  if (!claim) return false;

  const account = await prisma.user.findUniqueOrThrow({
    where: { id: claim.id },
    select: { sessionsValidFrom: true },
  });

  // The same comparison the middleware makes.
  return claim.issuedAt.getTime() >= account.sessionsValidFrom.getTime();
};

describe("signing in", () => {
  it("records the session, so there is something to end", async () => {
    await signIn();

    const { sessions } = await sessionsService.listFor(userId);
    expect(sessions).toHaveLength(1);
  });

  it("never stores the token itself", async () => {
    // A database dump must not be a drawer full of live sessions.
    const { refreshToken } = await signIn();
    const rows = await prisma.refreshSession.findMany();

    expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(refreshToken);
  });

  it("keeps each device apart", async () => {
    await signIn();
    await signIn();

    expect((await sessionsService.listFor(userId)).sessions).toHaveLength(2);
  });
});

describe("signing out of one device", () => {
  it("stops that refresh token", async () => {
    const { refreshToken } = await signIn();

    await authService.signOut(userId, refreshToken, false);

    await expect(authService.refresh({ refreshToken })).rejects.toThrow(
      /Invalid or expired refresh token/
    );
  });

  it("leaves the other device signed in", async () => {
    // The distinction that makes this worth having: signing out on a shared
    // machine must not sign somebody out of their phone.
    const phone = await signIn();
    const shared = await signIn();

    await authService.signOut(userId, shared.refreshToken, false);

    await expect(
      authService.refresh({ refreshToken: phone.refreshToken })
    ).resolves.toMatchObject({ accessToken: expect.any(String) });
  });

  it("does not tell a caller whether the token was already dead", async () => {
    // Signing out twice is not an error, and the answer must not be a probe
    // for whether a token is live.
    const { refreshToken } = await signIn();
    await authService.signOut(userId, refreshToken, false);

    await expect(
      authService.signOut(userId, refreshToken, false)
    ).resolves.toMatchObject({ message: "Signed out." });
  });

  it("ends everything when the client cannot say which session it means", async () => {
    // Better than ending nothing: a client that asked to sign out must not
    // stay signed in because it forgot to send the token.
    const a = await signIn();
    const b = await signIn();

    await authService.signOut(userId, undefined, false);

    await expect(authService.refresh({ refreshToken: a.refreshToken })).rejects.toThrow();
    await expect(authService.refresh({ refreshToken: b.refreshToken })).rejects.toThrow();
  });
});

describe("signing out everywhere", () => {
  it("ends every refresh token", async () => {
    const a = await signIn();
    const b = await signIn();

    await authService.signOut(userId, a.refreshToken, true);

    await expect(authService.refresh({ refreshToken: a.refreshToken })).rejects.toThrow();
    await expect(authService.refresh({ refreshToken: b.refreshToken })).rejects.toThrow();
  });

  it("reaches an access token that was never presented", async () => {
    // The one a stolen laptop is actually about. A session row cannot do
    // this - the token is in the thief's browser and has not been shown to
    // us - so the cutoff on the account has to.
    const { accessToken } = await signIn();
    expect(await stillValid(accessToken)).toBe(true);

    await authService.signOut(userId, undefined, true);

    expect(await stillValid(accessToken)).toBe(false);
  });

  it("leaves nothing open to look at", async () => {
    await signIn();
    await signIn();

    await authService.signOut(userId, undefined, true);

    expect((await sessionsService.listFor(userId)).sessions).toHaveLength(0);
  });

  it("writes it to the audit trail", async () => {
    await signIn();
    await authService.signOut(userId, undefined, true);

    const rows = await prisma.auditLog.findMany({
      where: { action: "SESSIONS_ENDED_EVERYWHERE", entityId: userId },
    });

    expect(rows).toHaveLength(1);
  });

  it("lets them sign in again straight away", async () => {
    // Ending sessions is not locking an account out.
    await signIn();
    await authService.signOut(userId, undefined, true);

    const fresh = await signIn();
    expect(await stillValid(fresh.accessToken)).toBe(true);
  });
});

describe("refreshing", () => {
  it("hands back a session that works", async () => {
    const first = await signIn();
    const second = await authService.refresh({ refreshToken: first.refreshToken });

    expect(await stillValid(second.accessToken)).toBe(true);
  });

  it("burns the token it was given", async () => {
    // Rotation is what makes a stolen refresh token worth less than a stolen
    // password: it stops working the moment the real client refreshes.
    const first = await signIn();
    await authService.refresh({ refreshToken: first.refreshToken });

    await expect(
      authService.refresh({ refreshToken: first.refreshToken })
    ).rejects.toThrow(/Invalid or expired refresh token/);
  });

  it("does not leave a session behind on every refresh", async () => {
    const first = await signIn();
    const second = await authService.refresh({ refreshToken: first.refreshToken });
    await authService.refresh({ refreshToken: second.refreshToken });

    expect((await sessionsService.listFor(userId)).sessions).toHaveLength(1);
  });

  it("refuses a token this server never issued", async () => {
    // Correctly signed, and belonging to no session - which is what a token
    // minted before sessions existed, or replayed after a prune, looks like.
    const { refreshToken } = await signIn();
    await prisma.refreshSession.deleteMany({});

    await expect(authService.refresh({ refreshToken })).rejects.toThrow();
  });

  it("refuses one issued before the account was signed out of everywhere", async () => {
    const { refreshToken } = await signIn();
    await authService.signOut(userId, undefined, true);

    await expect(authService.refresh({ refreshToken })).rejects.toThrow(
      /session has been ended|Invalid or expired/
    );
  });
});

describe("what a password change is for", () => {
  it("ends every session the old password opened", async () => {
    // Most of the point of changing one. Without this the tokens issued
    // against the old password go on working for thirty days, which makes
    // the change a gesture.
    const { accessToken, refreshToken } = await signIn();

    await adminService.updateUser(userId, { password: "a brand new password" });

    expect(await stillValid(accessToken)).toBe(false);
    await expect(authService.refresh({ refreshToken })).rejects.toThrow();
  });

  it("ends them when somebody stops being an administrator", async () => {
    const { accessToken } = await signIn();

    await adminService.updateUser(userId, { loginRole: "ADMINISTRATOR" });

    expect(await stillValid(accessToken)).toBe(false);
  });

  it("leaves them alone for an ordinary edit", async () => {
    // Changing a job title must not sign somebody out mid-approval.
    const { accessToken } = await signIn();

    await adminService.updateUser(userId, { designation: "Deputy Director" });

    expect(await stillValid(accessToken)).toBe(true);
  });
});

describe("housekeeping", () => {
  it("keeps a recently expired session, which is evidence", async () => {
    await signIn();
    await prisma.refreshSession.updateMany({
      data: { expiresAt: new Date(Date.now() - 60 * 1000) },
    });

    await sessionsService.pruneExpired();

    expect(await prisma.refreshSession.count()).toBe(1);
  });

  it("drops one that expired long enough ago to be no use", async () => {
    await signIn();
    await prisma.refreshSession.updateMany({
      data: { expiresAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    });

    await sessionsService.pruneExpired();

    expect(await prisma.refreshSession.count()).toBe(0);
  });
});
