import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import app from "../app";
import { LoginRole } from "../generated/prisma/client";
import { hashPassword } from "../lib/password";
import { prisma } from "../prisma";
import { wordsInName } from "../services/memoDictionary.service";
import { makeDepartment, missingId, useCleanDatabase } from "../test/db";

/**
 * The organisation's dictionary over real HTTP: who may keep it, what the
 * editor is handed, and that the directory's names are in it without
 * anybody adding them.
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

async function tokenFor(
  role: LoginRole,
  name = { firstName: "Test", lastName: "Person" },
  departmentName = `Dept ${Math.random().toString(36).slice(2, 7)}`
): Promise<string> {
  const department = await makeDepartment(departmentName);
  const email = `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

  await prisma.user.create({
    data: {
      ...name,
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

type WordResponse = { word: { id: string; word: string } };
type WordsResponse = { words: string[] };

describe("who may keep the dictionary", () => {
  it("keeps it to administrators", async () => {
    const user = await tokenFor(LoginRole.USER);

    expect((await call(user, "GET", "/api/admin/memo-dictionary")).status).toBe(403);
    expect(
      (await call(user, "POST", "/api/admin/memo-dictionary", { word: "Somrow" })).status
    ).toBe(403);
    expect(
      (await call(user, "DELETE", `/api/admin/memo-dictionary/${missingId()}`)).status
    ).toBe(403);
  });
});

describe("what the editor is handed", () => {
  it("has the kept words, and every word of every name and department, once", async () => {
    const admin = await tokenFor(
      LoginRole.ADMINISTRATOR,
      { firstName: "Moiz", lastName: "Somrow" },
      "Security & Loss Prevention"
    );
    const user = await tokenFor(LoginRole.USER, { firstName: "Inayat", lastName: "Hussain" });

    const added = await call(admin, "POST", "/api/admin/memo-dictionary", { word: "Bahria" });
    expect(added.status).toBe(201);

    const handed = await call(user, "GET", "/api/memo-dictionary");
    expect(handed.status).toBe(200);
    const { words } = handed.json as WordsResponse;

    for (const word of ["Bahria", "Moiz", "Somrow", "Security", "Loss", "Prevention", "Inayat", "Hussain"]) {
      expect(words).toContain(word);
    }
    expect(words).not.toContain("&");
    expect(new Set(words.map((word) => word.toLowerCase())).size).toBe(words.length);
  });

  it("refuses the same word twice, by whatever case", async () => {
    const admin = await tokenFor(LoginRole.ADMINISTRATOR);

    await call(admin, "POST", "/api/admin/memo-dictionary", { word: "Somrow" });
    const again = await call(admin, "POST", "/api/admin/memo-dictionary", { word: "somrow" });

    expect(again.status).toBe(409);
    expect((again.json as { error: { message: string } }).error.message).toContain(
      "“Somrow” is already in the dictionary."
    );
  });
});

describe("the trail", () => {
  it("records a word added and a word removed", async () => {
    const admin = await tokenFor(LoginRole.ADMINISTRATOR);

    const { word } = (
      await call(admin, "POST", "/api/admin/memo-dictionary", { word: "Gymkhana" })
    ).json as WordResponse;
    const removed = await call(admin, "DELETE", `/api/admin/memo-dictionary/${word.id}`);
    expect(removed.status).toBe(200);

    const rows = await prisma.auditLog.findMany({
      where: { entityId: word.id },
      orderBy: { createdAt: "asc" },
      select: { action: true, entityType: true, oldValue: true, newValue: true },
    });

    expect(rows.map((row) => row.action)).toEqual([
      "MEMO_DICTIONARY_WORD_ADDED",
      "MEMO_DICTIONARY_WORD_REMOVED",
    ]);
    expect(rows[0]?.newValue).toMatchObject({ word: "Gymkhana" });
    expect(rows[1]?.oldValue).toMatchObject({ word: "Gymkhana" });
    expect((await call(admin, "GET", "/api/admin/memo-dictionary")).json).toEqual({ words: [] });
  });

  it("answers 404 for a word that is not there", async () => {
    const admin = await tokenFor(LoginRole.ADMINISTRATOR);

    expect(
      (await call(admin, "DELETE", `/api/admin/memo-dictionary/${missingId()}`)).status
    ).toBe(404);
  });
});

describe("the words in a name", () => {
  it("takes the words and leaves the punctuation", () => {
    expect(wordsInName("Security & Loss Prevention")).toEqual(["Security", "Loss", "Prevention"]);
    expect(wordsInName("O'Brien-Khan")).toEqual(["O'Brien", "Khan"]);
    expect(wordsInName("A B")).toEqual([]);
  });
});
