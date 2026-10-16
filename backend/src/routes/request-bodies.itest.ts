import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../app";
import { LoginRole } from "../generated/prisma/client";
import { hashPassword } from "../lib/password";
import { prisma } from "../prisma";
import {
  chainOf,
  makeDepartment,
  makeUser,
  missingId,
  submitDocument,
  useCleanDatabase,
} from "../test/db";

/**
 * Requests that go all the way through, over real HTTP.
 *
 * `routes.itest.ts` asks whether a route is guarded; `memo-workflow.itest.ts`
 * walks the one journey the business asked for. Between them sat a whole class
 * of fault nothing looked at: a route that is guarded, reachable, mounted in
 * the right order, and still falls over on the first real body.
 *
 * Delegation did exactly that. `validate` parsed the body and wrote the
 * coerced value back onto the request; the handler parsed the same body a
 * second time, and the schema that had just produced two Date objects refused
 * them for not being strings. The ZodError was thrown inside the handler, past
 * the middleware that turns those into a 400, so it left as a 500 - and the
 * panel always sends an end date. Thirty-nine service tests passed throughout,
 * because none of them went through a route.
 *
 * So this file sends a body to every endpoint that takes one and is not
 * already driven somewhere else, and checks two things each time: that the
 * ordinary request succeeds, and that a bad one comes back as a refusal
 * somebody can read rather than as "Internal server error".
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

type Method = "GET" | "POST" | "PATCH" | "DELETE";

async function call(
  method: Method,
  path: string,
  options: { token?: string; body?: unknown } = {}
) {
  const response = await fetch(`${base}${path}`, {
    method,
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
    // An empty body. The status is the point.
  }

  return { status: response.status, json };
}

const PASSWORD = "correct horse battery";
const ADMIN_EMAIL = "bodies-admin@example.com";
const USER_EMAIL = "bodies-user@example.com";

let departmentId: string;

beforeEach(async () => {
  departmentId = (await makeDepartment()).id;
  const passwordHash = await hashPassword(PASSWORD);

  await prisma.user.createMany({
    data: [
      {
        firstName: "Bodies",
        lastName: "Admin",
        email: ADMIN_EMAIL,
        passwordHash,
        departmentId,
        loginRole: LoginRole.ADMINISTRATOR,
        isSuperAdmin: true,
      },
      {
        firstName: "Bodies",
        lastName: "User",
        email: USER_EMAIL,
        passwordHash,
        departmentId,
        loginRole: LoginRole.USER,
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

const idOf = async (email: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { email } })).id;

// ------------------------------------------------------------------ comments

describe("leaving a comment on a memo", () => {
  const memo = async () => {
    const preparer = await makeUser({ departmentId });
    const approver = await makeUser({ departmentId });
    const document = await submitDocument({
      preparerId: preparer.id,
      approvalChain: chainOf(approver),
    });

    return { document, preparer, approver };
  };

  it("accepts one from somebody on the chain", async () => {
    const { document, approver } = await memo();
    await prisma.user.update({
      where: { id: approver.id },
      data: { email: "chain-member@example.com", passwordHash: await hashPassword(PASSWORD) },
    });
    const { accessToken } = await signIn("chain-member@example.com");

    const { status, json } = await call(
      "POST",
      `/api/documents/${document.id}/comments`,
      { token: accessToken, body: { comment: "Checked against the increment policy." } }
    );

    expect(status).toBe(201);
    expect(json).toMatchObject({
      comment: { comment: "Checked against the increment policy." },
    });
  });

  it("refuses an empty one as a 400, with the reason", async () => {
    const { document } = await memo();
    const { accessToken } = await signIn(ADMIN_EMAIL);

    const { status, json } = await call(
      "POST",
      `/api/documents/${document.id}/comments`,
      { token: accessToken, body: { comment: "   " } }
    );

    expect(status).toBe(400);
    expect(json).toMatchObject({ error: { message: "Comment is required" } });
  });

  it("refuses a comment on a memo the caller cannot see", async () => {
    // Not a 500, and not a leak: somebody outside the chain is refused the
    // same way whether the memo exists or not.
    const { document } = await memo();
    const { accessToken } = await signIn(USER_EMAIL);

    const { status } = await call(
      "POST",
      `/api/documents/${document.id}/comments`,
      { token: accessToken, body: { comment: "Nothing to do with me." } }
    );

    expect(status).toBe(403);
  });
});

// ------------------------------------------------------------- notifications

describe("clearing the inbox", () => {
  const notify = async (recipientId: string, count = 1) =>
    prisma.notification.createManyAndReturn({
      data: Array.from({ length: count }, (_, index) => ({
        recipientId,
        type: "APPROVAL_NEEDED" as const,
        title: `Memo ${index + 1} needs you`,
        message: "It is waiting in your queue.",
      })),
    });

  it("marks one as read", async () => {
    const { accessToken } = await signIn(USER_EMAIL);
    const [notification] = await notify(await idOf(USER_EMAIL));

    const { status, json } = await call(
      "PATCH",
      `/api/notifications/${notification.id}/read`,
      { token: accessToken }
    );

    expect(status).toBe(200);
    expect(json).toMatchObject({ notification: { isRead: true } });
  });

  it("marks all of them, and says how many", async () => {
    const { accessToken } = await signIn(USER_EMAIL);
    await notify(await idOf(USER_EMAIL), 3);

    const { status } = await call("PATCH", "/api/notifications/read-all", {
      token: accessToken,
    });
    const { json } = await call("GET", "/api/notifications/unread-count", {
      token: accessToken,
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ count: 0 });
  });

  it("does not read 'read-all' as a notification id", async () => {
    // The literal path is registered before the `:id` one. Registered the
    // other way round, the button that clears the inbox answers a validation
    // error about a malformed uuid - which is a bug you only see over HTTP.
    const { accessToken } = await signIn(USER_EMAIL);
    await notify(await idOf(USER_EMAIL), 2);

    const { status, json } = await call("PATCH", "/api/notifications/read-all", {
      token: accessToken,
    });

    expect(status).toBe(200);
    expect(json).not.toMatchObject({ error: {} });
  });

  it("refuses somebody else's notification", async () => {
    // 403 rather than 404, which is the convention across this API: missing
    // and forbidden are kept apart because "not found" for something that
    // does exist tells a caller nothing they can act on. What it costs is
    // that a caller holding a notification id learns it is a real one, and a
    // uuid nobody gave them is not something they hold.
    const { accessToken } = await signIn(USER_EMAIL);
    const [theirs] = await notify(await idOf(ADMIN_EMAIL));

    const { status } = await call(
      "PATCH",
      `/api/notifications/${theirs.id}/read`,
      { token: accessToken }
    );

    expect(status).toBe(403);
  });

  it("answers a malformed id as a 400, not a driver error", async () => {
    const { accessToken } = await signIn(USER_EMAIL);

    const { status } = await call("PATCH", "/api/notifications/not-a-uuid/read", {
      token: accessToken,
    });

    expect(status).toBe(400);
  });
});

// -------------------------------------------------------------- the directory

describe("adding somebody to the directory", () => {
  const person = (overrides: Record<string, unknown> = {}) => ({
    email: `new.person.${Math.random().toString(36).slice(2, 8)}@example.com`,
    password: "a good enough password",
    firstName: "Ayesha",
    lastName: "Raza",
    departmentId,
    loginRole: "USER",
    ...overrides,
  });

  it("creates them", async () => {
    const { accessToken } = await signIn(ADMIN_EMAIL);

    const { status, json } = await call("POST", "/api/admin/users", {
      token: accessToken,
      body: person({ designation: "Assistant Director" }),
    });

    expect(status).toBe(201);
    expect(json).toMatchObject({ firstName: "Ayesha", designation: "Assistant Director" });
  });

  it("refuses a second account on the same address", async () => {
    const { accessToken } = await signIn(ADMIN_EMAIL);

    const { status, json } = await call("POST", "/api/admin/users", {
      token: accessToken,
      body: person({ email: USER_EMAIL }),
    });

    expect(status).toBe(409);
    expect(json).toMatchObject({ error: {} });
  });

  it("refuses a body with nothing usable in it as a 400", async () => {
    const { accessToken } = await signIn(ADMIN_EMAIL);

    const { status } = await call("POST", "/api/admin/users", {
      token: accessToken,
      body: { email: "not an address" },
    });

    expect(status).toBe(400);
  });

  it("edits one, and does not require every field to do it", async () => {
    const { accessToken } = await signIn(ADMIN_EMAIL);

    const { status, json } = await call(
      "PATCH",
      `/api/admin/users/${await idOf(USER_EMAIL)}`,
      { token: accessToken, body: { designation: "Deputy Director (Admin)" } }
    );

    expect(status).toBe(200);
    expect(json).toMatchObject({ designation: "Deputy Director (Admin)" });
  });

  it("refuses an edit that changes nothing", async () => {
    const { accessToken } = await signIn(ADMIN_EMAIL);

    const { status, json } = await call(
      "PATCH",
      `/api/admin/users/${await idOf(USER_EMAIL)}`,
      { token: accessToken, body: {} }
    );

    expect(status).toBe(400);
    expect(json).toMatchObject({
      error: { message: "At least one field is required" },
    });
  });

  it("answers a link that lost a character as a 400, not a driver error", async () => {
    const { accessToken } = await signIn(ADMIN_EMAIL);

    const { status } = await call("PATCH", "/api/admin/users/nearly-a-uuid", {
      token: accessToken,
      body: { firstName: "Ayesha" },
    });

    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------- templates

describe("drawing a workflow template", () => {
  const graph = (approverId: string) => ({
    nodes: [
      { id: "n1", type: "start", position: { x: 0, y: 0 }, data: { label: "Start" } },
      {
        id: "n2",
        type: "approval",
        position: { x: 200, y: 0 },
        data: { label: "Final approver", approverId, approvalType: "FINAL_APPROVER" },
      },
      { id: "n3", type: "end", position: { x: 400, y: 0 }, data: { label: "End" } },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "n3" },
    ],
  });

  it("saves one", async () => {
    const { accessToken } = await signIn(ADMIN_EMAIL);

    const { status, json } = await call("POST", "/api/admin/workflow-templates/", {
      token: accessToken,
      body: {
        name: "Annual increment",
        description: "One approval, for increments inside delegated powers.",
        graph: graph(await idOf(USER_EMAIL)),
      },
    });

    expect(status).toBe(201);
    expect(json).toMatchObject({ name: "Annual increment" });
  });

  it("previews the route it gives a memo, from the compiler submission uses", async () => {
    // The submit screen asks here rather than compiling a copy of its own,
    // which had drifted from the server's and could preview the wrong route.
    const admin = await signIn(ADMIN_EMAIL);
    const approverId = await idOf(USER_EMAIL);
    const created = await call("POST", "/api/admin/workflow-templates/", {
      token: admin.accessToken,
      body: { name: "Annual increment", graph: graph(approverId) },
    });
    const { id } = created.json as { id: string };

    const preparer = await signIn(USER_EMAIL);
    const { status, json } = await call("POST", `/api/workflow-templates/${id}/route`, {
      token: preparer.accessToken,
      body: { title: "Increment for Q4", description: "" },
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({
      steps: [{ assignedUserId: approverId, approvalType: "FINAL_APPROVER", order: 1 }],
    });
  });

  it("refuses to preview a template that does not exist", async () => {
    const preparer = await signIn(USER_EMAIL);
    const { status } = await call("POST", `/api/workflow-templates/${missingId()}/route`, {
      token: preparer.accessToken,
      body: { title: "Increment" },
    });

    expect(status).toBe(404);
  });

  it("renames one without being handed the whole graph again", async () => {
    const { accessToken } = await signIn(ADMIN_EMAIL);
    const created = await call("POST", "/api/admin/workflow-templates/", {
      token: accessToken,
      body: { name: "Annual increment", graph: graph(await idOf(USER_EMAIL)) },
    });
    const { id } = created.json as { id: string };

    const { status, json } = await call(
      "PATCH",
      `/api/admin/workflow-templates/${id}`,
      { token: accessToken, body: { name: "Annual increment (revised)" } }
    );

    expect(status).toBe(200);
    expect(json).toMatchObject({ name: "Annual increment (revised)" });
  });

  it("refuses a graph whose edge points at a node that is not there", async () => {
    // The kind of thing a designer bug produces. It has to come back as a
    // refusal naming the edge, not as a template saved in a state nothing can
    // run.
    const { accessToken } = await signIn(ADMIN_EMAIL);
    const broken = graph(await idOf(USER_EMAIL));
    broken.edges[1].target = "n9";

    const { status, json } = await call("POST", "/api/admin/workflow-templates/", {
      token: accessToken,
      body: { name: "Broken", graph: broken },
    });

    expect(status).toBe(400);
    expect(JSON.stringify(json)).toContain("n9");
  });

  it("answers a template that is gone as a 404", async () => {
    const { accessToken } = await signIn(ADMIN_EMAIL);

    const { status } = await call(
      "PATCH",
      `/api/admin/workflow-templates/${missingId()}`,
      { token: accessToken, body: { name: "Anything" } }
    );

    expect(status).toBe(404);
  });
});

// --------------------------------------------------------------------- auth

describe("the two credential endpoints nothing had sent a body to", () => {
  it("signs somebody up, when an administrator asks", async () => {
    const { accessToken } = await signIn(ADMIN_EMAIL);

    const { status } = await call("POST", "/api/auth/sign-up", {
      token: accessToken,
      body: {
        email: "signed.up@example.com",
        password: "a good enough password",
        firstName: "Nadia",
        lastName: "Iqbal",
        departmentId,
      },
    });

    expect(status).toBeLessThan(300);
  });

  it("exchanges a refresh token for a new pair", async () => {
    const { refreshToken } = await signIn(USER_EMAIL);

    const { status, json } = await call("POST", "/api/auth/refresh", {
      body: { refreshToken },
    });

    expect(status).toBe(200);

    // Not "a different string from the one sent" - these are stateless JWTs
    // with a whole-second issued-at, so a pair minted inside the same second
    // as the last one is byte-identical, and there is no store in which an
    // older one could be invalidated anyway. What matters is that the access
    // token it hands back actually opens a door.
    const pair = json as { accessToken?: string; refreshToken?: string };
    expect(typeof pair.refreshToken).toBe("string");

    const me = await call("GET", "/api/auth/me", { token: pair.accessToken });
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ email: USER_EMAIL });
  });

  it("refuses a refresh token that is not one, without a stack trace", async () => {
    const { status, json } = await call("POST", "/api/auth/refresh", {
      body: { refreshToken: "not.a.token" },
    });

    expect(status).toBe(401);
    expect(JSON.stringify(json)).not.toContain("at ");
  });
});

// --------------------------------------------------------------- delegation

/*
 * The endpoint that started this file. Two of these fail against the code as
 * it was: any delegation naming an end date came back as a 500.
 */
describe("handing approvals to a colleague", () => {
  /*
   * Dates relative to today, never written down.
   *
   * These bodies go to a live endpoint that compares them against the clock,
   * so a literal like "2026-09-12" is a test that passes until that morning
   * and fails every morning after. This block was written with three of them
   * and did exactly that: the first went red on 2026-09-12, and the second
   * would have gone red on the 13th.
   */
  const dayOffset = (days: number) =>
    new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const atOffset = (days: number) => `${dayOffset(days)}T00:00:00.000Z`;

  const userIds = async () => ({
    delegatorId: await idOf(ADMIN_EMAIL),
    delegateId: await idOf(USER_EMAIL),
  });

  it("creates one that names an end date", async () => {
    const { accessToken } = await signIn(ADMIN_EMAIL);

    const { status, json } = await call("POST", "/api/delegations/", {
      token: accessToken,
      body: {
        ...(await userIds()),
        startsAt: atOffset(-2),
        endsAt: atOffset(4),
        reason: "Away at the regional office",
      },
    });

    expect(status).toBe(201);
    expect(json).toMatchObject({
      delegation: { reason: "Away at the regional office" },
    });
  });

  it("creates one with no end date, which means until it is ended", async () => {
    const { accessToken } = await signIn(ADMIN_EMAIL);

    const { status } = await call("POST", "/api/delegations/", {
      token: accessToken,
      body: await userIds(),
    });

    expect(status).toBe(201);
  });

  it("reads a bare end date as the end of that day, over the wire", async () => {
    // The panel collects a day, not a moment. Arriving as midnight, the
    // delegate stops covering at one minute past midnight on the day they
    // were told they were covered.
    const { accessToken } = await signIn(ADMIN_EMAIL);

    const { status, json } = await call("POST", "/api/delegations/", {
      token: accessToken,
      body: { ...(await userIds()), endsAt: dayOffset(4) },
    });

    expect(status).toBe(201);
    expect((json as { delegation: { endsAt: string } }).delegation.endsAt).toBe(
      `${dayOffset(4)}T23:59:59.999Z`
    );
  });

  it("ends one, and says so", async () => {
    const { accessToken } = await signIn(ADMIN_EMAIL);
    const created = await call("POST", "/api/delegations/", {
      token: accessToken,
      body: await userIds(),
    });
    const { id } = (created.json as { delegation: { id: string } }).delegation;

    const { status, json } = await call("DELETE", `/api/delegations/${id}`, {
      token: accessToken,
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ message: "Delegation ended." });
  });

  it("refuses a body it cannot read as a 400, not a 500", async () => {
    // The distinction the bug erased. A caller who sends nonsense should be
    // told what is wrong with it; a 500 says the fault is ours.
    const { accessToken } = await signIn(ADMIN_EMAIL);

    const { status, json } = await call("POST", "/api/delegations/", {
      token: accessToken,
      body: { delegateId: "not-a-uuid" },
    });

    expect(status).toBe(400);
    expect(json).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("refuses one that ends before it starts", async () => {
    const { accessToken } = await signIn(ADMIN_EMAIL);

    const { status, json } = await call("POST", "/api/delegations/", {
      token: accessToken,
      body: {
        ...(await userIds()),
        startsAt: atOffset(4),
        endsAt: atOffset(-2),
      },
    });

    expect(status).toBe(400);
    expect(json).toMatchObject({
      error: { message: "The delegation cannot end before it starts." },
    });
  });
});
