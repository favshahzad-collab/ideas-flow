import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../lib/password";
import { prisma } from "../prisma";
import { makeDepartment, makeUser, rejection, useCleanDatabase } from "../test/db";
import { adminService } from "./admin.service";
import { auditService } from "./audit.service";
import { authService } from "./auth.service";
import { REUSE_GRACE_MS, sessionsService } from "./sessions.service";
import { usersService } from "./users.service";

/**
 * Signing in, against a real database: what the trail now records, how a
 * sign-in token is exchanged, and the rule a new password is held to.
 */

useCleanDatabase();

const PASSWORD = "copper kettle morning rain";

let person: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  const department = await makeDepartment();
  person = await makeUser({ firstName: "Ayesha", lastName: "Khan", departmentId: department.id });
  await prisma.user.update({
    where: { id: person.id },
    data: { passwordHash: await hashPassword(PASSWORD) },
  });
});

/** Every sign-in row for this person, oldest first, as action and method/reason. */
const signIns = async (userId: string) =>
  (
    await prisma.auditLog.findMany({
      where: {
        entityId: userId,
        action: { in: ["SIGN_IN_SUCCEEDED", "SIGN_IN_FAILED", "SIGN_IN_THROTTLED"] },
      },
      orderBy: { writeSeq: "asc" },
      select: { action: true, newValue: true },
    })
  ).map((row) => {
    const value = row.newValue as { method?: string; reason?: string } | null;
    return [row.action, value?.method ?? null, value?.reason ?? null];
  });

describe("the trail of signing in", () => {
  it("records a sign-in that issued a session", async () => {
    await authService.login({ email: person.email, password: PASSWORD });

    expect(await signIns(person.id)).toEqual([["SIGN_IN_SUCCEEDED", "password", null]]);
  });

  it("records a wrong password for a real account, with the address tried", async () => {
    await expect(
      authService.login({ email: person.email, password: "not the password at all" }),
    ).rejects.toMatchObject({ statusCode: 401 });

    // Written without holding up the answer, so it lands a moment later.
    await vi.waitFor(async () =>
      expect(await signIns(person.id)).toEqual([["SIGN_IN_FAILED", "password", "password"]]),
    );

    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: "SIGN_IN_FAILED" } });
    expect(row.newValue).toMatchObject({ email: person.email.toLowerCase() });
    // And never the password, anywhere on the row.
    expect(
      JSON.stringify({ ...row, writeSeq: String(row.writeSeq), seq: String(row.seq) }),
    ).not.toContain("not the password at all");
  });

  it("writes nothing for an address with no account", async () => {
    await expect(
      authService.login({ email: "nobody-here@example.com", password: PASSWORD }),
    ).rejects.toMatchObject({ statusCode: 401 });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      await prisma.auditLog.count({ where: { action: { in: ["SIGN_IN_FAILED", "SIGN_IN_SUCCEEDED"] } } }),
    ).toBe(0);
  });

  it("records a switched-off account that typed the right password", async () => {
    await prisma.user.update({ where: { id: person.id }, data: { deactivatedAt: new Date() } });

    await expect(
      authService.login({ email: person.email, password: PASSWORD }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(await signIns(person.id)).toEqual([["SIGN_IN_FAILED", "password", "switched-off"]]);
  });

  it("keeps sign-ins out of Change history, which is for changes", async () => {
    await authService.login({ email: person.email, password: PASSWORD });
    await adminService.createDepartment({ name: "Estates" }, person.id);

    const { entries } = await auditService.getAdministrationActivity({ limit: 200 });

    expect(entries.map((entry) => entry.action)).toEqual(["DEPARTMENT_CREATED"]);
  });
});

describe("a password stored before the rule", () => {
  it("still signs in, because the rule is for new passwords only", async () => {
    await prisma.user.update({
      where: { id: person.id },
      data: { passwordHash: await hashPassword("short1") },
    });

    await expect(
      authService.login({ email: person.email, password: "short1" }),
    ).resolves.toMatchObject({ user: { id: person.id } });
  });
});

describe("exchanging a sign-in token", () => {
  const signedIn = async () => {
    const result = await authService.login({ email: person.email, password: PASSWORD });
    if (!("refreshToken" in result)) throw new Error("expected a session");
    return result.refreshToken;
  };

  const liveSessions = () =>
    prisma.refreshSession.count({ where: { userId: person.id, revokedAt: null } });

  it("gives one new session to two requests racing with the same token, not two", async () => {
    const token = await signedIn();

    const results = await Promise.all([
      sessionsService.rotate(token, person.id),
      sessionsService.rotate(token, person.id),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await liveSessions()).toBe(1);
  });

  it("quietly refuses a spent token back within the grace period, ending nothing", async () => {
    // Two tabs of one browser refreshing at once: the second is not a thief.
    const token = await signedIn();
    expect(await sessionsService.rotate(token, person.id)).not.toBeNull();

    expect(await sessionsService.rotate(token, person.id)).toBeNull();

    expect(await liveSessions()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "REFRESH_TOKEN_REUSED" } })).toBe(0);
  });

  it("ends every session when a spent token comes back later, and says why", async () => {
    const token = await signedIn();
    await signedIn(); // a second device, which is also ended
    expect(await sessionsService.rotate(token, person.id)).not.toBeNull();

    // Exchanged well over the grace period ago.
    await prisma.refreshSession.updateMany({
      where: { userId: person.id, rotatedAt: { not: null } },
      data: { rotatedAt: new Date(Date.now() - REUSE_GRACE_MS - 60_000) },
    });

    expect(await sessionsService.rotate(token, person.id)).toBeNull();

    expect(await liveSessions()).toBe(0);
    expect(
      (
        await prisma.auditLog.findMany({
          where: { entityId: person.id, action: { in: ["REFRESH_TOKEN_REUSED", "SESSIONS_ENDED_EVERYWHERE"] } },
          orderBy: { writeSeq: "asc" },
          select: { action: true },
        })
      ).map((row) => row.action),
    ).toEqual(["SESSIONS_ENDED_EVERYWHERE", "REFRESH_TOKEN_REUSED"]);
  });

  it("treats a token ended by signing out as ended, not as stolen", async () => {
    const token = await signedIn();
    await sessionsService.endOne(token, person.id);

    expect(await sessionsService.rotate(token, person.id)).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "REFRESH_TOKEN_REUSED" } })).toBe(0);
  });
});

describe("the rule for a new password, where it is stored", () => {
  it("refuses a short one when an administrator adds somebody", async () => {
    const department = await makeDepartment();

    const refused = await rejection(
      adminService.createUser({
        email: "new.person@example.com",
        password: "short-pw",
        firstName: "New",
        lastName: "Person",
        departmentId: department.id,
        loginRole: "USER",
      }),
    );

    expect(refused.statusCode).toBe(400);
    expect(refused.message).toMatch(/at least 12/);
  });

  it("refuses one built from the person's own name", async () => {
    const refused = await rejection(
      adminService.updateUser(person.id, { password: "ayesha-summer-2026" }),
    );

    expect(refused.statusCode).toBe(400);
    expect(refused.message).toMatch(/name or email/);
  });

  it("refuses a common one when somebody changes their own", async () => {
    const refused = await rejection(
      usersService.changeOwnPassword(person.id, {
        currentPassword: PASSWORD,
        newPassword: "password1234",
      }),
    );

    expect(refused.statusCode).toBe(400);
    expect(refused.message).toMatch(/lists people try first/);
  });

  it("refuses a weak one in the spreadsheet import, row by row", async () => {
    const department = await prisma.department.findFirstOrThrow();
    const csv = [
      "firstName,lastName,email,password,department,role",
      `Omar,Farooq,omar@example.com,short,${department.name},USER`,
      `Sana,Iqbal,sana@example.com,three-words-here,${department.name},USER`,
    ].join("\n");

    const result = await adminService.bulkCreateUsers({
      buffer: Buffer.from(csv),
      originalname: "people.csv",
    });

    expect(result.created).toBe(1);
    expect(result.failed.map((failure) => failure.email)).toEqual(["omar@example.com"]);
  });
});
