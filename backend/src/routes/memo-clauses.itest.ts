import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import app from "../app";
import { LoginRole } from "../generated/prisma/client";
import { hashPassword } from "../lib/password";
import { prisma } from "../prisma";
import { makeDepartment, missingId, useCleanDatabase } from "../test/db";

/**
 * Standard wording over real HTTP: who may keep it, who may read it, and
 * that every change leaves a row in the trail.
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
  const json = (await response.json()) as { accessToken?: string; token?: string };
  return json.accessToken ?? json.token ?? "";
}

async function call(token: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as never };
}

const wording = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

type ClauseResponse = { clause: { id: string; title: string; archivedAt: string | null } };
type ListResponse = { clauses: { id: string; title: string }[] };

describe("who may keep the wording", () => {
  it("keeps the library to administrators", async () => {
    const user = await tokenFor(LoginRole.USER);

    expect((await call(user, "GET", "/api/admin/memo-clauses")).status).toBe(403);
    expect(
      (
        await call(user, "POST", "/api/admin/memo-clauses", {
          title: "Mine",
          body: wording("x"),
        })
      ).status
    ).toBe(403);
    expect(
      (await call(user, "PUT", `/api/admin/memo-clauses/${missingId()}`, { archived: true }))
        .status
    ).toBe(403);
  });

  it("offers the current wording to anybody signed in, and only the current", async () => {
    const admin = await tokenFor(LoginRole.ADMINISTRATOR);
    const user = await tokenFor(LoginRole.USER);

    const created = await call(admin, "POST", "/api/admin/memo-clauses", {
      title: "Recommendation",
      body: wording("Approval is solicited."),
    });
    expect(created.status).toBe(201);
    const { clause } = created.json as ClauseResponse;

    const offered = await call(user, "GET", "/api/memo-clauses");
    expect(offered.status).toBe(200);
    expect((offered.json as ListResponse).clauses.map((entry) => entry.title)).toEqual([
      "Recommendation",
    ]);

    await call(admin, "PUT", `/api/admin/memo-clauses/${clause.id}`, { archived: true });

    expect((await call(user, "GET", "/api/memo-clauses")).json).toEqual({ clauses: [] });
    // The administrator still sees it, so it can be put back.
    expect(
      ((await call(admin, "GET", "/api/admin/memo-clauses")).json as ListResponse).clauses
    ).toHaveLength(1);
  });
});

describe("the trail", () => {
  it("records each thing that happens to a clause, by what it was", async () => {
    const admin = await tokenFor(LoginRole.ADMINISTRATOR);

    const { clause } = (
      await call(admin, "POST", "/api/admin/memo-clauses", {
        title: "Condition",
        body: wording("Subject to budget."),
      })
    ).json as ClauseResponse;

    await call(admin, "PUT", `/api/admin/memo-clauses/${clause.id}`, { title: "Budget condition" });
    await call(admin, "PUT", `/api/admin/memo-clauses/${clause.id}`, { archived: true });
    await call(admin, "PUT", `/api/admin/memo-clauses/${clause.id}`, { archived: false });

    const rows = await prisma.auditLog.findMany({
      where: { entityId: clause.id },
      orderBy: { createdAt: "asc" },
      select: { action: true, entityType: true, newValue: true },
    });

    expect(rows.map((row) => row.action)).toEqual([
      "MEMO_CLAUSE_CREATED",
      "MEMO_CLAUSE_UPDATED",
      "MEMO_CLAUSE_ARCHIVED",
      "MEMO_CLAUSE_RESTORED",
    ]);
    expect(rows.every((row) => row.entityType === "MemoClause")).toBe(true);
    expect(rows[1]?.newValue).toMatchObject({ title: "Budget condition" });
  });
});

describe("what is refused", () => {
  it("refuses wording with no title, saying so", async () => {
    const admin = await tokenFor(LoginRole.ADMINISTRATOR);

    const response = await call(admin, "POST", "/api/admin/memo-clauses", {
      title: " ",
      body: wording("x"),
    });

    expect(response.status).toBe(400);
    expect((response.json as { error: { message: string } }).error.message).toContain(
      "Give the wording a title"
    );
  });

  it("refuses a body the memo could not draw", async () => {
    const admin = await tokenFor(LoginRole.ADMINISTRATOR);

    const response = await call(admin, "POST", "/api/admin/memo-clauses", {
      title: "Picture",
      body: { type: "doc", content: [{ type: "image", src: "x" }] },
    });

    expect(response.status).toBe(400);
  });

  it("answers 404 for wording that does not exist", async () => {
    const admin = await tokenFor(LoginRole.ADMINISTRATOR);

    const response = await call(admin, "PUT", `/api/admin/memo-clauses/${missingId()}`, {
      archived: true,
    });

    expect(response.status).toBe(404);
  });
});
