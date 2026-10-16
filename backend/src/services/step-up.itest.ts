import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../app";
import { hashPassword } from "../lib/password";
import { encryptSecret } from "../lib/secretBox";
import { base32Decode, hotp, stepAt } from "../lib/totp";
import { verifyToken } from "../lib/tokens";
import { prisma } from "../prisma";
import { makeDepartment, makeUser, useCleanDatabase } from "../test/db";
import { sessionsService } from "./sessions.service";

/**
 * Confirming it is you before a sensitive change, over real HTTP.
 *
 * A session proves somebody typed a password up to two hours ago. The changes
 * that hand control of an account to somebody else - another person's
 * two-step sign-in, their role, email or password, making an administrator,
 * importing people, the mail and sign-on credentials - now ask again. These
 * drive the refusal, the confirmation, and what it does and does not cover.
 */

useCleanDatabase();

const PASSWORD = "copper kettle morning rain";
// Base32 for a fixed 20-byte key, so a code can be computed here.
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

let server: Server;
let base: string;
let admin: { id: string; email: string };
let token: string;
let departmentId: string;
let target: { id: string };

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      resolve();
    });
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(async () => {
  const department = await makeDepartment();
  departmentId = department.id;
  admin = await prisma.user.create({
    data: {
      firstName: "Sana",
      lastName: "Malik",
      email: "sana@example.com",
      passwordHash: await hashPassword(PASSWORD),
      departmentId,
      loginRole: "ADMINISTRATOR",
      isSuperAdmin: true,
      totpSecret: encryptSecret(SECRET),
      totpActivatedAt: new Date(),
    },
    select: { id: true, email: true },
  });
  target = await makeUser({ firstName: "Omar", departmentId });
  // Issued directly: the two-step challenge at sign-in is not what is under test.
  ({ accessToken: token } = await sessionsService.issue(admin.id));
});

const call = (method: string, path: string, body?: unknown, stepUp?: string) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(stepUp ? { "x-step-up": stepUp } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const codeOf = async (response: Response) =>
  ((await response.json()) as { error?: { code?: string } }).error?.code ?? null;

async function confirmed(body: { password?: string; code?: string } = { password: PASSWORD }) {
  const response = await call("POST", "/api/auth/step-up", body);
  expect(response.status).toBe(200);
  return ((await response.json()) as { stepUpToken: string }).stepUpToken;
}

describe("a sensitive change", () => {
  it("is refused without a confirmation, in words the app can act on", async () => {
    const response = await call("DELETE", `/api/admin/users/${target.id}/two-factor`);

    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("STEP_UP_REQUIRED");
  });

  it("goes through with a confirmation made from the password", async () => {
    const stepUp = await confirmed();

    const response = await call(
      "PATCH",
      `/api/admin/users/${target.id}`,
      { loginRole: "ADMINISTRATOR" },
      stepUp,
    );

    expect(response.status).toBe(200);
  });

  it("says in the confirmation how it was made, so a signature record can", async () => {
    const byPassword = await verifyToken(await confirmed(), "step-up");
    expect(byPassword?.how).toBe("PASSWORD");

    const code = hotp(base32Decode(SECRET)!, BigInt(stepAt(Date.now())));
    const byCode = await verifyToken(await confirmed({ code }), "step-up");
    expect(byCode?.how).toBe("AUTHENTICATOR");
  });

  it("goes through with a confirmation made from an authenticator code", async () => {
    const code = hotp(base32Decode(SECRET)!, BigInt(stepAt(Date.now())));
    const stepUp = await confirmed({ code });

    const response = await call("DELETE", `/api/admin/users/${target.id}/two-factor`, undefined, stepUp);

    expect(response.status).not.toBe(403);
  });

  it("asks on every route it covers", async () => {
    // Each of these hands control of an account, or of how people sign in.
    const covered: [string, string, unknown?][] = [
      ["PATCH", `/api/admin/users/${target.id}`, { password: "a-whole-new-phrase-9" }],
      ["PATCH", `/api/admin/users/${target.id}`, { email: "omar.new@example.com" }],
      ["PATCH", `/api/admin/users/${target.id}`, { loginRole: "ADMINISTRATOR" }],
      [
        "POST",
        "/api/admin/users",
        {
          email: "second.admin@example.com",
          password: "a-whole-new-phrase-9",
          firstName: "Second",
          lastName: "Admin",
          departmentId,
          loginRole: "ADMINISTRATOR",
        },
      ],
      ["DELETE", `/api/admin/users/${target.id}/two-factor`],
      ["DELETE", "/api/admin/mail/settings"],
      ["DELETE", "/api/admin/sso/settings"],
    ];

    const answers = [];
    for (const [method, path, body] of covered) {
      const response = await call(method, path, body);
      answers.push([method, path, response.status, await codeOf(response)]);
    }

    expect(answers).toEqual(
      covered.map(([method, path]) => [method, path, 403, "STEP_UP_REQUIRED"]),
    );
  });
});

describe("what stays routine", () => {
  it("does not ask to rename somebody or move their department", async () => {
    const response = await call("PATCH", `/api/admin/users/${target.id}`, { firstName: "Omar-Renamed" });

    expect(response.status).toBe(200);
  });

  it("does not ask when the form sends back the role and email unchanged", async () => {
    // The edit form sends every field every time.
    const current = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });

    const response = await call("PATCH", `/api/admin/users/${target.id}`, {
      firstName: "Omar",
      email: current.email.toUpperCase(),
      loginRole: current.loginRole,
    });

    expect(response.status).toBe(200);
  });

  it("does not ask to add an ordinary account", async () => {
    const response = await call("POST", "/api/admin/users", {
      email: "new.person@example.com",
      password: "a-whole-new-phrase-9",
      firstName: "New",
      lastName: "Person",
      departmentId,
      loginRole: "USER",
    });

    expect(response.status).toBe(201);
  });
});

describe("the confirmation itself", () => {
  it("is refused for a wrong password, without ending the session", async () => {
    const response = await call("POST", "/api/auth/step-up", { password: "not it at all" });

    // 403, never 401: a 401 would send the app off to refresh and then to
    // the sign-in screen for one mistyped password.
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("STEP_UP_REFUSED");
    expect((await call("GET", "/api/auth/me")).status).toBe(200);
  });

  it("wants exactly one of a password or a code", async () => {
    expect((await call("POST", "/api/auth/step-up", {})).status).toBe(400);
    expect(
      (await call("POST", "/api/auth/step-up", { password: PASSWORD, code: "123456" })).status,
    ).toBe(400);
  });

  it("will not let the same authenticator code confirm twice", async () => {
    const code = hotp(base32Decode(SECRET)!, BigInt(stepAt(Date.now())));
    await confirmed({ code });

    const again = await call("POST", "/api/auth/step-up", { code });

    expect(again.status).toBe(403);
  });

  it("belongs to the person who made it", async () => {
    const stepUp = await confirmed();
    const other = await prisma.user.create({
      data: {
        firstName: "Other",
        lastName: "Admin",
        email: "other@example.com",
        passwordHash: await hashPassword(PASSWORD),
        departmentId,
        loginRole: "ADMINISTRATOR",
        isSuperAdmin: true,
        totpActivatedAt: new Date(),
      },
    });
    ({ accessToken: token } = await sessionsService.issue(other.id));

    const response = await call("DELETE", `/api/admin/users/${target.id}/two-factor`, undefined, stepUp);

    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("STEP_UP_REQUIRED");
  });

  it("ends when every session is ended", async () => {
    const stepUp = await confirmed();
    await sessionsService.endAll(admin.id);
    ({ accessToken: token } = await sessionsService.issue(admin.id));

    const response = await call("DELETE", `/api/admin/users/${target.id}/two-factor`, undefined, stepUp);

    expect(response.status).toBe(403);
  });
});
