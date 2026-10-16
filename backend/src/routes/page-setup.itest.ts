import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import app from "../app";
import { LoginRole } from "../generated/prisma/client";
import { DEFAULT_PAGE_SETUP } from "../lib/memoTemplate/geometry";
import { hashPassword } from "../lib/password";
import { prisma } from "../prisma";
import { makeDepartment, useCleanDatabase } from "../test/db";
import { pageSetupService } from "../services/pageSetup.service";

/**
 * The page setup screen's two calls, over real HTTP.
 *
 * The refusals are the interesting half. A margin the renderer would quietly
 * clamp is a margin the administrator asked for and did not get, and drawing
 * something other than what the form said is how a settings screen stops
 * being believed. So the validator refuses and says which edge to change.
 */

useCleanDatabase();

let server: Server;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

const PASSWORD = "correct horse battery staple";

async function tokenFor(role: LoginRole): Promise<string> {
  const department = await makeDepartment(`Dept ${Math.random().toString(36).slice(2, 7)}`);
  const email = `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

  await prisma.user.create({
    data: {
      firstName: "Test",
      lastName: "Person",
      email,
      passwordHash: await hashPassword(PASSWORD),
      departmentId: department.id,
      loginRole: role,
      isSuperAdmin: role === "ADMINISTRATOR",
    },
  });

  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });

  const body = (await response.json()) as { accessToken?: string };
  if (!body.accessToken) throw new Error(`Could not sign in as ${email}`);
  return body.accessToken;
}

async function call(
  method: "GET" | "PUT",
  token: string,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/admin/page-setup`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

let admin: string;
let ordinary: string;

beforeEach(async () => {
  pageSetupService.forget();
  admin = await tokenFor(LoginRole.ADMINISTRATOR);
  ordinary = await tokenFor(LoginRole.USER);
});

const LETTER = {
  paper: "LETTER",
  marginLeft: 72,
  marginRight: 54,
  marginTop: 60,
  marginBottom: 60,
};

describe("reading the page setup", () => {
  it("starts on the delivered default", async () => {
    const res = await call("GET", admin);

    expect(res.status).toBe(200);
    expect(res.body.setup).toEqual(DEFAULT_PAGE_SETUP);
    expect(res.body.default).toEqual(DEFAULT_PAGE_SETUP);
  });

  it("serves the sheets and the bounds with it", async () => {
    // So the screen's own limits cannot drift from the validator's: a slider
    // that stops somewhere different from where the server refuses is a form
    // that rejects what it just allowed.
    const res = await call("GET", admin);

    expect(res.body.papers).toEqual(
      expect.arrayContaining([
        { name: "A4", width: 595.28, height: 841.89 },
        { name: "LETTER", width: 612, height: 792 },
      ])
    );

    const bounds = res.body.bounds as { minMargin: number; maxMargin: number };
    expect(bounds.minMargin).toBeGreaterThan(0);
    expect(bounds.maxMargin).toBeGreaterThan(bounds.minMargin);
  });

  it("is refused to somebody who is not an administrator", async () => {
    expect((await call("GET", ordinary)).status).toBe(403);
  });
});

describe("changing the page setup", () => {
  it("saves, and answers with what is now live", async () => {
    const saved = await call("PUT", admin, LETTER);

    expect(saved.status).toBe(200);
    expect(saved.body.setup).toEqual(LETTER);
    expect((await call("GET", admin)).body.setup).toEqual(LETTER);
  });

  it("writes a row saying who changed it, and from what", async () => {
    await call("PUT", admin, LETTER);

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: "PAGE_SETUP_UPDATED" },
      orderBy: { createdAt: "desc" },
    });

    // Both sides: "why does this memo look different from that one" needs the
    // page it changed FROM, not only the one it changed to.
    expect(entry.oldValue).toMatchObject({ paper: "A4" });
    expect(entry.newValue).toMatchObject({ paper: "LETTER" });
  });

  it("is refused to somebody who is not an administrator", async () => {
    expect((await call("PUT", ordinary, LETTER)).status).toBe(403);
  });

  it("refuses a margin narrower than a printer can manage", async () => {
    const res = await call("PUT", admin, { ...LETTER, marginLeft: 2 });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/at least/i);
  });

  it("refuses a margin wider than the bound", async () => {
    expect((await call("PUT", admin, { ...LETTER, marginTop: 400 })).status).toBe(400);
  });

  it("refuses two margins that are each legal but together leave nothing", async () => {
    /*
     * The case a per-field check cannot see: 216pt is inside the bound, and
     * two of them leave 163pt of A4 to write on - a column no table fits in.
     */
    const res = await call("PUT", admin, {
      ...LETTER,
      paper: "A4",
      marginLeft: 216,
      marginRight: 216,
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/to write on/i);
  });

  it("refuses a paper it cannot draw", async () => {
    expect((await call("PUT", admin, { ...LETTER, paper: "FOOLSCAP" })).status).toBe(400);
  });

  it("changes nothing when it refuses", async () => {
    await call("PUT", admin, { ...LETTER, marginLeft: 2 });

    expect((await call("GET", admin)).body.setup).toEqual(DEFAULT_PAGE_SETUP);
  });
});
