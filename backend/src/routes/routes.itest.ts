import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../app";
import { LoginRole } from "../generated/prisma/client";
import { hashPassword } from "../lib/password";
import { prisma } from "../prisma";
import { makeDepartment, missingId, useCleanDatabase } from "../test/db";
import {
  CAPABILITIES,
  SUPER_ADMIN_ONLY,
  VIEWABLE_POWERS,
  capabilityForRequest,
  viewPower,
} from "../lib/capabilities";

/**
 * The route layer, over real HTTP.
 *
 * Services have their own tests; what is only visible here is the wiring -
 * whether a route is behind `authenticate` at all, whether an admin-only
 * route is behind `requireAdmin`, and what an error looks like by the time it
 * reaches a client. A route that forgets its guard is not a bug any service
 * test can see, because the service is never asked.
 */

useCleanDatabase();

let server: Server;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    // `listen`'s callback is typed as taking an error, so passing `resolve`
    // straight in does not type-check even though it works.
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

// ---------------------------------------------------------------- requests

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function call(
  method: Method,
  path: string,
  options: { token?: string; body?: unknown } = {}
) {
  const response = await fetch(`${base}${path}`, {
    method,
    /*
     * Observe a redirect, never chase it. The sign-on callback answers with a
     * 302 to the single-page application, and `fetch` follows that by default
     * - so this suite quietly depended on something listening on the front-end
     * port. It passed on a developer machine with `npm run dev` running and
     * failed in CI with ECONNREFUSED, which reads as the route being broken
     * rather than the test reaching outside the app it is testing.
     */
    redirect: "manual",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });

  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    // A CSV export, or an empty body. The status is the point.
  }

  return { status: response.status, json, text, headers: response.headers };
}

// ------------------------------------------------------------- the routes

const ID = "00000000-0000-4000-8000-000000000000";

/** Every route that must refuse a caller with no token. */
const PROTECTED: [Method, string][] = [
  ["GET", "/api/auth/me"],
  ["POST", "/api/auth/sign-up"],
  ["POST", "/api/auth/sign-out"],
  ["GET", "/api/auth/sessions"],

  ["GET", "/api/users/"],
  ["GET", "/api/users/me"],
  ["PATCH", "/api/users/me/password"],
  ["POST", "/api/users/me/signature"],
  ["GET", "/api/users/me/signature"],
  ["DELETE", "/api/users/me/signature"],

  ["GET", "/api/admin/departments"],
  ["POST", "/api/admin/departments"],
  ["PATCH", `/api/admin/departments/${ID}`],
  ["DELETE", `/api/admin/departments/${ID}`],
  ["GET", "/api/admin/mail"],
  ["PUT", "/api/admin/mail/settings"],
  ["DELETE", "/api/admin/mail/settings"],
  ["POST", "/api/admin/mail/test"],
  ["POST", "/api/admin/mail/test-connection"],
  ["GET", "/api/admin/workflow/settings"],
  ["PUT", "/api/admin/workflow/settings"],
  ["DELETE", "/api/admin/workflow/settings"],
  ["GET", "/api/admin/calendar"],
  ["PUT", "/api/admin/calendar"],
  ["POST", "/api/admin/calendar/holidays"],
  ["DELETE", `/api/admin/calendar/holidays/${ID}`],
  ["GET", "/api/admin/memo-type-routes"],
  ["PUT", `/api/admin/memo-type-routes/${ID}`],
  ["GET", "/api/admin/page-setup"],
  ["PUT", "/api/admin/page-setup"],
  ["GET", "/api/admin/memo-clauses"],
  ["POST", "/api/admin/memo-clauses"],
  ["PUT", `/api/admin/memo-clauses/${ID}`],
  ["GET", "/api/admin/memo-dictionary"],
  ["POST", "/api/admin/memo-dictionary"],
  ["DELETE", `/api/admin/memo-dictionary/${ID}`],
  ["GET", "/api/admin/sso/settings"],
  ["PUT", "/api/admin/sso/settings"],
  ["DELETE", "/api/admin/sso/settings"],
  ["GET", "/api/admin/users"],
  ["POST", "/api/admin/users/bulk"],
  ["GET", `/api/admin/users/${ID}`],
  ["GET", `/api/admin/users/${ID}/holds`],
  ["POST", `/api/admin/users/${ID}/active`],
  ["PATCH", `/api/admin/users/${ID}`],
  ["POST", "/api/admin/users"],

  ["GET", "/api/admin/workflow-templates/"],
  ["GET", `/api/admin/workflow-templates/${ID}`],
  ["POST", "/api/admin/workflow-templates/"],
  ["PATCH", `/api/admin/workflow-templates/${ID}`],
  ["POST", `/api/admin/workflow-templates/${ID}/archive`],
  ["POST", `/api/admin/workflow-templates/${ID}/restore`],

  ["GET", "/api/workflow-templates/"],
  ["GET", `/api/workflow-templates/${ID}`],
  ["POST", `/api/workflow-templates/${ID}/route`],

  ["GET", "/api/documents/"],
  ["GET", "/api/documents/oversight"],
  ["GET", "/api/documents/pending-count"],
  ["GET", `/api/documents/${ID}/file`],
  ["GET", `/api/documents/${ID}/supporting/${ID}/file`],
  ["GET", `/api/documents/${ID}`],
  ["GET", `/api/documents/${ID}/changes`],
  ["POST", "/api/documents/"],
  ["POST", `/api/documents/${ID}/withdraw`],
  ["POST", `/api/documents/${ID}/cancel`],
  ["POST", `/api/documents/${ID}/leave-rejected`],
  ["PATCH", `/api/documents/${ID}`],

  ["GET", `/api/documents/${ID}/comments`],
  ["POST", `/api/documents/${ID}/comments`],
  ["GET", `/api/documents/${ID}/workflow`],

  ["GET", "/api/audit/ledger"],
  ["GET", "/api/audit/administration"],
  ["POST", "/api/audit/ledger/verify"],
  ["GET", "/api/audit/ledger/export"],
  ["GET", "/api/audit/documents/export"],
  ["GET", "/api/audit/documents"],
  ["GET", `/api/documents/${ID}/audit/export`],
  ["GET", `/api/documents/${ID}/audit`],

  ["POST", `/api/documents/${ID}/approve`],
  ["POST", `/api/documents/${ID}/reject`],
  ["POST", `/api/documents/${ID}/request-revision`],
  ["POST", `/api/documents/${ID}/skip-step`],
  // Moving a step to a different approver. Behind `requireAdmin` as well as
  // `authenticate`, which is what the administrator-only list below proves.
  ["POST", `/api/documents/${ID}/reassign-step`],
  // Chasing a memo that is sitting with somebody. Guarded like every other
  // action on a document: the service decides whether this particular person
  // is the one waiting for it, but nobody unauthenticated gets that far.
  ["POST", `/api/documents/${ID}/remind`],
  ["POST", `/api/documents/${ID}/print`],

  ["GET", "/api/notifications/"],
  ["GET", "/api/notifications/unread-count"],
  ["PATCH", "/api/notifications/read-all"],
  ["PATCH", `/api/notifications/${ID}/read`],
  ["DELETE", "/api/notifications/"],
  ["DELETE", `/api/notifications/${ID}`],

  ["GET", "/api/delegations/"],
  ["POST", "/api/delegations/"],
  ["DELETE", `/api/delegations/${ID}`],

  // Memos being typed in the portal. Every one of these is scoped to the
  // signed-in preparer inside the service; there is no administrator view of
  // somebody's unfinished memo, so none of them appear in ADMIN_ONLY.
  ["GET", "/api/memo-types"],
  ["GET", "/api/memo-clauses"],
  ["GET", "/api/memo-dictionary"],
  ["GET", "/api/memo-drafts"],
  ["POST", "/api/memo-drafts"],
  ["POST", "/api/memo-drafts/preview"],
  ["GET", `/api/memo-drafts/${ID}`],
  ["PATCH", `/api/memo-drafts/${ID}`],
  ["DELETE", `/api/memo-drafts/${ID}`],

  ["GET", "/api/admin/access-control"],
  ["GET", "/api/admin/sessions"],
  ["POST", `/api/admin/users/${ID}/sessions/end`],
  ["DELETE", `/api/admin/users/${ID}/two-factor`],
  ["PUT", `/api/admin/users/${ID}/powers`],
  ["POST", "/api/admin/super-admin/transfer"],

  ["GET", "/api/auth/2fa"],
  ["POST", "/api/auth/2fa/setup"],
  ["POST", "/api/auth/2fa/activate"],
  ["POST", "/api/auth/step-up"],
  ["POST", "/api/auth/step-up/microsoft/start"],
  ["POST", "/api/auth/step-up/microsoft"],
  ["GET", "/api/memo-type-routes"],
  ["POST", "/api/auth/2fa/recovery-codes"],
  ["POST", "/api/auth/2fa/disable"],
];

/** Routes that are open on purpose, and why. */
const PUBLIC: [Method, string, string][] = [
  ["GET", "/api/health", "asked by CI, healthchecks and load balancers before anyone has a token"],
  ["POST", "/api/auth/login", "is how you get a token"],
  ["POST", "/api/auth/refresh", "is how you get another one"],
  [
    "GET",
    "/api/auth/sso/available",
    "is what the sign-in screen asks before drawing a button, with no token to ask it with",
  ],
  ["GET", "/api/auth/sso/start", "is the first half of signing in"],
  [
    "GET",
    "/api/auth/sso/callback",
    "is where Microsoft returns, and Microsoft has no token of ours",
  ],
  [
    "POST",
    "/api/auth/sso/exchange",
    "is how a completed sign-in becomes a session",
  ],
  [
    "POST",
    "/api/auth/2fa",
    "is the second half of a sign-in, and there is no session yet to present",
  ],
];

/** Routes an ordinary signed-in user must still be refused. */
const ADMIN_ONLY: [Method, string][] = [
  ["POST", "/api/auth/sign-up"],
  ["GET", "/api/admin/departments"],
  ["POST", "/api/admin/departments"],
  ["PATCH", `/api/admin/departments/${ID}`],
  ["DELETE", `/api/admin/departments/${ID}`],
  ["GET", "/api/admin/mail"],
  ["PUT", "/api/admin/mail/settings"],
  ["DELETE", "/api/admin/mail/settings"],
  ["POST", "/api/admin/mail/test"],
  ["POST", "/api/admin/mail/test-connection"],
  ["GET", "/api/admin/workflow/settings"],
  ["PUT", "/api/admin/workflow/settings"],
  ["DELETE", "/api/admin/workflow/settings"],
  ["GET", "/api/admin/calendar"],
  ["PUT", "/api/admin/calendar"],
  ["POST", "/api/admin/calendar/holidays"],
  ["DELETE", `/api/admin/calendar/holidays/${ID}`],
  ["GET", "/api/admin/memo-type-routes"],
  ["PUT", `/api/admin/memo-type-routes/${ID}`],
  ["GET", "/api/admin/page-setup"],
  ["PUT", "/api/admin/page-setup"],
  ["GET", "/api/admin/memo-clauses"],
  ["POST", "/api/admin/memo-clauses"],
  ["PUT", `/api/admin/memo-clauses/${ID}`],
  ["GET", "/api/admin/memo-dictionary"],
  ["POST", "/api/admin/memo-dictionary"],
  ["DELETE", `/api/admin/memo-dictionary/${ID}`],
  ["GET", "/api/admin/sso/settings"],
  ["PUT", "/api/admin/sso/settings"],
  ["DELETE", "/api/admin/sso/settings"],
  ["GET", "/api/admin/users"],
  ["POST", "/api/admin/users"],
  ["POST", "/api/admin/users/bulk"],
  ["GET", `/api/admin/users/${ID}`],
  ["GET", `/api/admin/users/${ID}/holds`],
  ["POST", `/api/admin/users/${ID}/active`],
  ["PATCH", `/api/admin/users/${ID}`],
  ["GET", "/api/admin/workflow-templates/"],
  ["POST", "/api/admin/workflow-templates/"],
  ["PATCH", `/api/admin/workflow-templates/${ID}`],
  ["POST", `/api/admin/workflow-templates/${ID}/archive`],
  ["POST", `/api/admin/workflow-templates/${ID}/restore`],
  // Reading how far the seal has reached is open to anyone signed in - the
  // people relying on the trail are the ones who need to be able to check it.
  // Walking the whole chain is not: it is minutes of work on a large trail.
  ["POST", "/api/audit/ledger/verify"],
  ["GET", "/api/audit/ledger/export"],
  // Every memo in flight, including ones the caller is not party to. It has
  // always been behind `requireAdmin`; it was missing from this list, so
  // nothing proved it.
  ["GET", "/api/documents/oversight"],
  /*
   * The only route that changes who is entitled to sign a memo after it was
   * submitted. It sits among the document actions rather than under /admin,
   * which is exactly why it is worth naming here: nothing about its path
   * says it is an administrator's, so nothing but this would notice if the
   * guard came off it.
   */
  ["POST", `/api/documents/${ID}/reassign-step`],
  ["POST", `/api/documents/${ID}/cancel`],
  // What administrators did to the system. Not under /admin, because it is
  // read beside the rest of the trail; administrator-only all the same.
  ["GET", "/api/audit/administration"],
  ["GET", "/api/admin/access-control"],
  ["GET", "/api/admin/sessions"],
  ["POST", `/api/admin/users/${ID}/sessions/end`],
  ["DELETE", `/api/admin/users/${ID}/two-factor`],
  ["PUT", `/api/admin/users/${ID}/powers`],
  ["POST", "/api/admin/super-admin/transfer"],
];

// ------------------------------------------------------------------ users

const PASSWORD = "correct horse battery";
const ADMIN_EMAIL = "route-admin@example.com";
const USER_EMAIL = "route-user@example.com";
/** An administrator who is not a Super Administrator, with no powers given. */
const LIMITED_EMAIL = "route-limited@example.com";

beforeEach(async () => {
  const departmentId = (await makeDepartment()).id;
  const passwordHash = await hashPassword(PASSWORD);

  await prisma.user.createMany({
    data: [
      {
        firstName: "Route",
        lastName: "Admin",
        email: ADMIN_EMAIL,
        passwordHash,
        departmentId,
        loginRole: LoginRole.ADMINISTRATOR,
        isSuperAdmin: true,
      },
      {
        firstName: "Route",
        lastName: "User",
        email: USER_EMAIL,
        passwordHash,
        departmentId,
        loginRole: LoginRole.USER,
      },
      {
        firstName: "Route",
        lastName: "Limited",
        email: LIMITED_EMAIL,
        passwordHash,
        departmentId,
        loginRole: LoginRole.ADMINISTRATOR,
        isSuperAdmin: false,
        adminPowers: [],
      },
    ],
  });
});

async function signIn(email: string) {
  const { status, json } = await call("POST", "/api/auth/login", {
    body: { email, password: PASSWORD },
  });
  expect(status, `sign-in for ${email} failed`).toBe(200);
  return json as { accessToken: string; refreshToken: string };
}

// ------------------------------------------------------------------ tests

describe("the route table", () => {
  it("lists every route the app registers", () => {
    /*
     * The guard on the tables above. Without it, a route added next month is
     * simply not in `PROTECTED`, every test below still passes, and nothing
     * says the new route was never checked for a guard.
     */
    type Layer = { route?: unknown; handle?: { stack?: Layer[] } };
    const count = (layers: Layer[]): number =>
      layers.reduce(
        (total, layer) =>
          total +
          (layer.route ? 1 : 0) +
          (layer.handle?.stack ? count(layer.handle.stack) : 0),
        0
      );

    const registered = count(
      (app as unknown as { router: { stack: Layer[] } }).router.stack
    );

    expect(registered).toBe(PROTECTED.length + PUBLIC.length);
  });
});

describe("every protected route", () => {
  it.each(PROTECTED)("refuses %s %s with no token", async (method, path) => {
    const { status, json } = await call(method, path);

    expect(status).toBe(401);
    expect(json).toMatchObject({ error: { message: "No token provided" } });
  });

  it.each(PROTECTED)("refuses %s %s with a bad token", async (method, path) => {
    const { status } = await call(method, path, { token: "not.a.real.token" });

    expect(status).toBe(401);
  });

  it("refuses a refresh token used as a session", async () => {
    // Both are signed with the same secret and only the `typ` claim separates
    // them, so this is the difference between a thirty-day credential and a
    // two-hour one.
    const { refreshToken } = await signIn(USER_EMAIL);

    const { status } = await call("GET", "/api/auth/me", {
      token: refreshToken,
    });

    expect(status).toBe(401);
  });
});

describe("the public routes", () => {
  it.each(PUBLIC)("lets %s %s through, because it %s", async (method, path) => {
    const { status } = await call(
      method,
      path,
      method === "POST" ? { body: {} } : {}
    );

    // Not 200 - login with an empty body is a 400 - but never 401.
    expect(status).not.toBe(401);
  });

  it("reports the database from the health endpoint", async () => {
    const { status, json } = await call("GET", "/api/health");

    expect(status).toBe(200);
    expect(json).toMatchObject({ status: "ok", database: "up" });
  });

  it("reports the background sweeps, so a stalled one is not silence", async () => {
    // The app object is built without them - the sweeps are started by
    // index.ts, never here - so "off" is the honest answer in this process.
    // What matters is that the field exists and a monitor can read it: a
    // stalled mail queue looked exactly like a quiet week.
    const { json } = await call("GET", "/api/health");

    expect(json).toMatchObject({
      jobs: { mail: "off", ledger: "off", deadlines: "off" },
    });
  });

  it("says nothing about what is inside, because it has no token", async () => {
    // Every caller that needs this asks before anybody has one - a load
    // balancer, a container healthcheck, CI. States only, never counts.
    const { json } = await call("GET", "/api/health");

    expect(JSON.stringify(json)).not.toMatch(/[0-9]{2,}/);
  });
});

describe("admin-only routes", () => {
  it.each(ADMIN_ONLY)(
    "refuses an ordinary user %s %s",
    async (method, path) => {
      const { accessToken } = await signIn(USER_EMAIL);

      const { status, json } = await call(method, path, {
        token: accessToken,
        ...(method === "POST" || method === "PATCH" ? { body: {} } : {}),
      });

      expect(status).toBe(403);
      expect(json).toMatchObject({
        error: { message: "Admin access required" },
      });
    }
  );

  it("lets an administrator through", async () => {
    const { accessToken } = await signIn(ADMIN_EMAIL);

    const { status } = await call("GET", "/api/admin/users", {
      token: accessToken,
    });

    expect(status).toBe(200);
  });
});

describe("an administrator who is not a Super Administrator", () => {
  /*
   * Two tiers: a Super Administrator holds every power, any other
   * administrator only the powers given to them. Checked against every
   * administrator route in the table, both ways, so a route added without a
   * power behind it - or a power that does not reach its route - fails here.
   */
  const givePowers = (powers: string[]) =>
    prisma.user.update({ where: { email: LIMITED_EMAIL }, data: { adminPowers: powers } });

  const callAsLimited = async (method: Method, path: string) => {
    const { accessToken } = await signIn(LIMITED_EMAIL);
    return call(method, path, {
      token: accessToken,
      ...(method === "POST" || method === "PATCH" || method === "PUT" ? { body: {} } : {}),
    });
  };

  it.each(ADMIN_ONLY)("is refused %s %s without the power for it", async (method, path) => {
    const { status, json } = await callAsLimited(method, path);

    expect(status).toBe(403);
    expect(json).toMatchObject({ error: { code: "POWER_REQUIRED" } });
  });

  it.each(ADMIN_ONLY)("gets through %s %s with the power for it, unless it is a Super Administrator's alone", async (method, path) => {
    const needed = capabilityForRequest(method, path);
    expect(needed, `${method} ${path} has no power behind it`).not.toBeNull();
    await givePowers([needed!]);

    const { json } = await callAsLimited(method, path);
    const code = (json as { error?: { code?: string } } | null)?.error?.code;

    if (SUPER_ADMIN_ONLY.includes(needed!)) {
      expect(code).toBe("POWER_REQUIRED");
    } else {
      expect(code).not.toBe("POWER_REQUIRED");
    }
  });
});

describe("an administrator given an area to see but not change", () => {
  /*
   * `<power>:view` opens the reading routes of that power and none of the
   * routes that change something. Walked across every route of every power
   * that can be given this way, so a write that slipped in as a GET - or a
   * read the view does not reach - fails here.
   */
  const viewable = ADMIN_ONLY.filter(([method, path]) => {
    const needed = capabilityForRequest(method, path);
    return needed !== null && VIEWABLE_POWERS.includes(needed);
  });

  it.each(viewable)("%s %s", async (method, path) => {
    const needed = capabilityForRequest(method, path)!;
    await prisma.user.update({
      where: { email: LIMITED_EMAIL },
      data: { adminPowers: [viewPower(needed)] },
    });

    const { accessToken } = await signIn(LIMITED_EMAIL);
    const { json } = await call(method, path, {
      token: accessToken,
      ...(method === "POST" || method === "PATCH" || method === "PUT" ? { body: {} } : {}),
    });
    const code = (json as { error?: { code?: string } } | null)?.error?.code;

    if (method === "GET") {
      expect(code).not.toBe("POWER_REQUIRED");
    } else {
      expect(code).toBe("POWER_REQUIRED");
    }
  });
});

describe("a signed-in request", () => {
  it("reaches the service and comes back with its answer", async () => {
    const { accessToken } = await signIn(USER_EMAIL);

    const { status, json } = await call("GET", "/api/documents/", {
      token: accessToken,
    });

    expect(status).toBe(200);
    // The list now answers with the page envelope every list endpoint uses:
    // the rows, how many match in total, and how many came back. `documents`
    // is still there and still first, which is all the frontend reads.
    expect(json).toEqual({ documents: [], total: 0, returned: 0 });
  });

  it("identifies the caller from the token, not the body", async () => {
    const { accessToken } = await signIn(USER_EMAIL);

    const { json } = await call("GET", "/api/auth/me", { token: accessToken });

    expect(json).toMatchObject({ email: USER_EMAIL });
  });
});

describe("what an error looks like to a client", () => {
  it("renders a validation failure as a 400 with the schema's message", async () => {
    const { status, json } = await call("POST", "/api/auth/login", {
      body: { email: "not-an-email", password: "short" },
    });

    expect(status).toBe(400);
    expect(json).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    expect((json as { error: { message: string } }).error.message).toContain(
      "Invalid email address"
    );
  });

  it("passes a service's status and message straight through", async () => {
    const { accessToken } = await signIn(USER_EMAIL);

    const { status, json } = await call("GET", `/api/documents/${missingId()}`, {
      token: accessToken,
    });

    expect(status).toBe(404);
    expect(json).toMatchObject({ error: { message: "Document not found" } });
  });

  it("answers an unknown path with a 404 rather than an empty socket", async () => {
    const { status, json } = await call("GET", "/api/nothing-here");

    expect(status).toBe(404);
    expect(json).toEqual({ error: "Route not found" });
  });

  it("refuses a body larger than the parser accepts", async () => {
    const { status, json } = await call("POST", "/api/auth/login", {
      body: { email: "a@b.com", password: "x".repeat(6 * 1024 * 1024) },
    });

    expect(status).toBe(413);
    expect(json).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });
});

describe("security headers", () => {
  it("sends the ones helmet adds", async () => {
    // The API sent none at all before helmet was added, so this is worth a
    // test rather than an assumption about a dependency's defaults.
    const { headers } = await call("GET", "/api/health");

    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(headers.get("x-powered-by")).toBeNull();
  });
});

describe("the sign-in attempt cap", () => {
  // Last in the file on purpose: the limiter counts per address and its state
  // is in memory for the life of the process, so these failures are spent.
  it("stops guessing at one account after eight tries", async () => {
    const attempt = () =>
      call("POST", "/api/auth/login", {
        // Long enough to get past the schema: a five-character password is
        // refused as invalid input, which is a 400 and a different test.
        body: { email: ADMIN_EMAIL, password: "wrong password" },
      });

    const codes: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      codes.push((await attempt()).status);
    }

    expect(codes.slice(0, 8)).toEqual(Array(8).fill(401));
    expect(codes[8]).toBe(429);

    const { json } = await attempt();
    expect(json).toMatchObject({ error: { code: "TOO_MANY_REQUESTS" } });
  });
});

/**
 * The Access Control screen recites this matrix to an administrator deciding
 * what a role buys. That makes it a claim about the system, and a claim about
 * the system is worth exactly what checks it.
 *
 * `capabilities.test.ts` proves the matrix is internally consistent. This
 * proves it against the guards: every route a capability names must be a route
 * this file already exercises, and a capability held only by administrators
 * must name only routes an ordinary user is actually refused. A capability
 * that quietly grew a route nobody guards fails here rather than on screen.
 */
describe("the access-control matrix describes these routes", () => {
  const key = ([method, path]: [Method, string]) => `${method} ${path}`;
  // `:id` in the matrix stands for whatever identifier a route takes; the
  // lists above use one concrete id everywhere.
  const concrete = (route: string) => route.replace(/:id/g, ID);

  const guarded = new Set(PROTECTED.map(key));
  const adminOnly = new Set(ADMIN_ONLY.map(key));

  it("names only routes this file exercises", () => {
    for (const capability of CAPABILITIES) {
      for (const route of capability.routes) {
        expect(
          guarded.has(concrete(route)),
          `${capability.id} names ${route}, which no test here covers`
        ).toBe(true);
      }
    }
  });

  it("claims administrator-only for routes an ordinary user is refused", () => {
    for (const capability of CAPABILITIES) {
      if (capability.roles.includes(LoginRole.USER)) continue;

      for (const route of capability.routes) {
        expect(
          adminOnly.has(concrete(route)),
          `${capability.id} is described as administrator-only, but ${route} is not`
        ).toBe(true);
      }
    }
  });

  it("describes every administrator-only route", () => {
    /*
     * The other direction, and the one that decays quietly.
     *
     * The checks above prove the matrix does not *lie*. This proves it is not
     * *incomplete*: an administrator-only route that no capability mentions is
     * a privilege the Access control screen does not show, so somebody reading
     * that screen to decide who should be an administrator is deciding on a
     * partial list - and nothing else would ever tell them.
     *
     * It is asserted for administrator-only routes rather than for all of
     * them, because that is where the claim is load-bearing. The two scoping
     * capabilities deliberately name no routes at all: they describe how every
     * document route filters its contents, which is not a property of any one
     * endpoint.
     */
    const described = new Set(
      CAPABILITIES.flatMap((capability) =>
        capability.routes.map((route) => route.replace(/:id/g, ID))
      )
    );

    const undescribed = ADMIN_ONLY.map(key).filter((route) => !described.has(route));

    expect(
      undescribed,
      "administrator-only, but nothing on the Access control screen says so"
    ).toEqual([]);
  });

  it("does not describe an administrator-only route as open to everybody", () => {
    for (const capability of CAPABILITIES) {
      if (!capability.roles.includes(LoginRole.USER)) continue;

      for (const route of capability.routes) {
        expect(
          adminOnly.has(concrete(route)),
          `${capability.id} is offered to ordinary users, but ${route} refuses them`
        ).toBe(false);
      }
    }
  });
});

// --------------------------------------------- where sign-in comes back to

/**
 * The sign-on callback must return the browser to the origin it is already
 * on, which is the origin of the registered redirect URI.
 *
 * It used the mail app URL instead. Those agree in production and disagree on
 * every developer machine, and on this one the mail setting pointed at a host
 * that does not resolve until go-live - so a successful Microsoft sign-in
 * ended on a dead page, with the handover code that is exchangeable for a
 * session sitting in the query string of an origin that had never started the
 * sign-in.
 *
 * Two different origins below, neither of them the `appUrl()` fallback of
 * `http://localhost:5173`: a test that asserted that one could pass while
 * reading nothing at all.
 */
describe("the origin a sign-in returns to", () => {
  async function registerRedirect(redirectUri: string) {
    await prisma.ssoSetting.upsert({
      where: { id: "singleton" },
      update: { redirectUri },
      create: {
        id: "singleton",
        enabled: true,
        tenantId: "a-tenant",
        clientId: "a-client",
        redirectUri,
      },
    });
  }

  /*
   * No `code` and no `state`, so this is the refusal path - which is the point:
   * it reaches the redirect without needing Microsoft, and the `back()` helper
   * that builds it is the same one the success path uses.
   */
  async function returnsTo(): Promise<string> {
    const response = await call("GET", "/api/auth/sso/callback");

    expect(response.status).toBe(302);

    return new URL(response.headers.get("location") ?? "").origin;
  }

  it("follows the redirect URI, not the address email links use", async () => {
    await registerRedirect("http://localhost:4173/api/auth/sso/callback");

    expect(await returnsTo()).toBe("http://localhost:4173");
  });

  it("moves when the registered redirect URI moves", async () => {
    // The same assertion against a second, unrelated origin. One origin alone
    // cannot tell "reads the setting" from "happens to match a constant".
    await registerRedirect("https://sso.example.org/api/auth/sso/callback");

    expect(await returnsTo()).toBe("https://sso.example.org");
  });

  it("falls back to the application address when nothing is registered", async () => {
    // Nothing stored at all: there is genuinely nothing better to say, and a
    // throw here would strand somebody mid-sign-in.
    expect(await prisma.ssoSetting.count()).toBe(0);

    expect(await returnsTo()).toBe("http://localhost:5173");
  });
});
