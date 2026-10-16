import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../app";
import { hashPassword } from "../lib/password";
import { base32Decode, hotp, stepAt } from "../lib/totp";
import { prisma } from "../prisma";
import { makeDepartment, useCleanDatabase } from "../test/db";

/**
 * Two-step sign-in required of administrators, over real HTTP.
 *
 * An administrator can read every memo, change anybody's role and reach every
 * setting, and two-step sign-in was optional for them. With the requirement
 * on, an administrator with no second factor is signed in but can do nothing
 * except set one up. These drive that through the app itself, because the
 * gate lives in the request path and a service test cannot see it.
 */

useCleanDatabase();

const PASSWORD = "copper kettle morning rain";

let server: Server;
let base: string;

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

// The suite runs with the requirement off; these are the tests that turn it on.
beforeEach(() => {
  process.env.REQUIRE_ADMIN_TWO_FACTOR = "true";
});

afterEach(() => {
  process.env.REQUIRE_ADMIN_TWO_FACTOR = "false";
});

async function person(role: "ADMINISTRATOR" | "USER", email: string) {
  const department = await makeDepartment();
  return prisma.user.create({
    data: {
      firstName: role === "ADMINISTRATOR" ? "Sana" : "Omar",
      lastName: "Malik",
      email,
      passwordHash: await hashPassword(PASSWORD),
      departmentId: department.id,
      loginRole: role,
      isSuperAdmin: role === "ADMINISTRATOR",
    },
  });
}

async function signIn(email: string): Promise<string> {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = (await response.json()) as { accessToken?: string };
  if (!body.accessToken) throw new Error(`no session for ${email}: ${response.status}`);
  return body.accessToken;
}

const call = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const codeOf = async (response: Response) =>
  ((await response.json()) as { error?: { code?: string } }).error?.code ?? null;

describe("an administrator with no second factor", () => {
  it("is signed in, but refused everything except setting one up", async () => {
    await person("ADMINISTRATOR", "sana@example.com");
    const token = await signIn("sana@example.com");

    const refused = await call(token, "GET", "/api/admin/users");
    expect(refused.status).toBe(403);
    expect(await codeOf(refused)).toBe("TWO_FACTOR_ENROLMENT_REQUIRED");

    // A memo route and a user route too: the gate is on every door, not one.
    expect((await call(token, "GET", "/api/documents")).status).toBe(403);
    expect((await call(token, "GET", "/api/notifications")).status).toBe(403);

    // What stays open: who they are, the setup, and the way out.
    const me = await call(token, "GET", "/api/auth/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ twoFactorEnrolmentRequired: true });
    expect((await call(token, "GET", "/api/auth/2fa")).status).toBe(200);
  });

  it("gets the rest of the product on the same session once it is set up", async () => {
    await person("ADMINISTRATOR", "sana@example.com");
    const token = await signIn("sana@example.com");

    const setup = await call(token, "POST", "/api/auth/2fa/setup");
    expect(setup.status).toBe(200);
    const { secret } = (await setup.json()) as { secret: string };

    const code = hotp(base32Decode(secret)!, BigInt(stepAt(Date.now())));
    const activated = await call(token, "POST", "/api/auth/2fa/activate", { code });
    expect(activated.status).toBe(200);

    expect((await call(token, "GET", "/api/admin/users")).status).toBe(200);
    expect(await (await call(token, "GET", "/api/auth/me")).json()).toMatchObject({
      twoFactorEnrolmentRequired: false,
    });
  });

  it("can still sign out", async () => {
    await person("ADMINISTRATOR", "sana@example.com");
    const token = await signIn("sana@example.com");

    expect((await call(token, "POST", "/api/auth/sign-out", {})).status).not.toBe(403);
  });
});

describe("who the requirement does not touch", () => {
  it("leaves ordinary accounts alone", async () => {
    await person("USER", "omar@example.com");
    const token = await signIn("omar@example.com");

    expect((await call(token, "GET", "/api/documents")).status).toBe(200);
    expect(await (await call(token, "GET", "/api/auth/me")).json()).toMatchObject({
      twoFactorEnrolmentRequired: false,
    });
  });

  it("lets every administrator through when the deployment turns it off", async () => {
    process.env.REQUIRE_ADMIN_TWO_FACTOR = "false";
    await person("ADMINISTRATOR", "sana@example.com");
    const token = await signIn("sana@example.com");

    expect((await call(token, "GET", "/api/admin/users")).status).toBe(200);
  });
});

describe("the requirement follows the account", () => {
  it("closes the product to somebody on their next request once they are made an administrator", async () => {
    const promoted = await person("USER", "omar@example.com");
    const token = await signIn("omar@example.com");
    expect((await call(token, "GET", "/api/documents")).status).toBe(200);

    await prisma.user.update({ where: { id: promoted.id }, data: { loginRole: "ADMINISTRATOR" } });

    const refused = await call(token, "GET", "/api/documents");
    expect(refused.status).toBe(403);
    expect(await codeOf(refused)).toBe("TWO_FACTOR_ENROLMENT_REQUIRED");
  });
});
