import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../app";
import { LoginRole } from "../generated/prisma/client";
import { hashPassword } from "../lib/password";
import { issueStepUpToken, verifyToken } from "../lib/tokens";
import { prisma } from "../prisma";
import { ssoService } from "../services/sso.service";
import { chainOf, makeDepartment, submitDocument, useCleanDatabase } from "../test/db";

/**
 * "Confirm it's you" reaches every decision, not only a signature.
 *
 * Agreed after the fit-gap review: rejecting a memo, sending it back and
 * skipping a step ask for the same five-minute confirmation signing does,
 * and so do the administration changes that move who signs - the workflow
 * policy, cover arranged for somebody else, and handing a step to another
 * approver. Arranging one's own cover does not.
 *
 * Over HTTP, because the checks live on the routes.
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

type Person = { id: string; token: string };

async function makePerson(
  firstName: string,
  departmentId: string,
  loginRole: LoginRole = LoginRole.USER
): Promise<Person> {
  const user = await prisma.user.create({
    data: {
      firstName,
      lastName: "Khan",
      email: `${firstName.toLowerCase()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      departmentId,
      loginRole,
      isSuperAdmin: loginRole === LoginRole.ADMINISTRATOR,
    },
  });
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: PASSWORD }),
  });
  const { accessToken } = (await response.json()) as { accessToken: string };
  return { id: user.id, token: accessToken };
}

async function call(
  person: Person,
  method: string,
  path: string,
  body: unknown,
  confirmed = false
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${person.token}`,
      ...(confirmed ? { "x-step-up": await issueStepUpToken(person.id) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as {
    error?: { code?: string };
  };
  return { status: response.status, code: json.error?.code, json };
}

let preparer: Person;
let reviewer: Person;
let finalApprover: Person;
let admin: Person;
let documentId: string;

beforeEach(async () => {
  const department = await makeDepartment();
  preparer = await makePerson("Preparer", department.id);
  reviewer = await makePerson("Reviewer", department.id);
  finalApprover = await makePerson("Final", department.id);
  admin = await makePerson("Admin", department.id, LoginRole.ADMINISTRATOR);

  documentId = (
    await submitDocument({
      preparerId: preparer.id,
      approvalChain: chainOf(reviewer, finalApprover),
    })
  ).id;
});

describe("a decision on a memo", () => {
  it.each([
    ["reject", { comment: "Wrong figures" }],
    ["request-revision", { comment: "Fix the dates" }],
  ])("refuses to %s without a confirmation, and changes nothing", async (route, body) => {
    const { status, code } = await call(
      reviewer,
      "POST",
      `/api/documents/${documentId}/${route}`,
      body
    );

    expect(status).toBe(403);
    expect(code).toBe("STEP_UP_REQUIRED_TO_DECIDE");
    expect(
      (await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).status
    ).toBe("PENDING_REVIEW");
  });

  it("records when the person confirmed it was them against a rejection", async () => {
    const { status } = await call(
      reviewer,
      "POST",
      `/api/documents/${documentId}/reject`,
      { comment: "Wrong figures" },
      true
    );

    expect(status).toBe(200);
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: documentId, action: "WORKFLOW_REJECTED" },
    });
    expect((row.newValue as { identityConfirmedAt?: string }).identityConfirmedAt).toEqual(
      expect.any(String)
    );
  });

  it("records it against a return too", async () => {
    const { status } = await call(
      reviewer,
      "POST",
      `/api/documents/${documentId}/request-revision`,
      { comment: "Fix the dates" },
      true
    );

    expect(status).toBe(200);
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: documentId, action: "WORKFLOW_REVISION_REQUESTED" },
    });
    expect((row.newValue as { identityConfirmedAt?: string }).identityConfirmedAt).toEqual(
      expect.any(String)
    );
  });

  it("asks before a step is skipped", async () => {
    const { status, code } = await call(
      preparer,
      "POST",
      `/api/documents/${documentId}/skip-step`,
      { reason: "Away" }
    );

    expect(status).toBe(403);
    expect(code).toBe("STEP_UP_REQUIRED_TO_DECIDE");
  });
});

describe("administration that moves who signs", () => {
  it("asks before a step is handed to another approver", async () => {
    const { status, code } = await call(
      admin,
      "POST",
      `/api/documents/${documentId}/reassign-step`,
      { toUserId: finalApprover.id, reason: "Away" }
    );

    expect(status).toBe(403);
    expect(code).toBe("STEP_UP_REQUIRED");
  });

  it("asks before the workflow policy changes or is handed back", async () => {
    const put = await call(admin, "PUT", "/api/admin/workflow/settings", {
      allowStepSkip: true,
    });
    const del = await call(admin, "DELETE", "/api/admin/workflow/settings", undefined);

    expect([put.status, put.code]).toEqual([403, "STEP_UP_REQUIRED"]);
    expect([del.status, del.code]).toEqual([403, "STEP_UP_REQUIRED"]);
  });

  it("asks before cover is arranged for somebody else", async () => {
    const { status, code } = await call(admin, "POST", "/api/delegations", {
      delegatorId: reviewer.id,
      delegateId: finalApprover.id,
    });

    expect(status).toBe(403);
    expect(code).toBe("STEP_UP_REQUIRED");
    expect(await prisma.delegation.count()).toBe(0);
  });

  it("does not ask somebody arranging their own cover", async () => {
    const { status } = await call(reviewer, "POST", "/api/delegations", {
      delegateId: finalApprover.id,
    });

    expect(status).toBe(201);
  });

  it("asks before somebody else's cover is ended, and not before one's own", async () => {
    const own = await call(reviewer, "POST", "/api/delegations", {
      delegateId: finalApprover.id,
    });
    const { id } = (own.json as unknown as { delegation: { id: string } }).delegation;

    const byAdmin = await call(admin, "DELETE", `/api/delegations/${id}`, undefined);
    expect([byAdmin.status, byAdmin.code]).toEqual([403, "STEP_UP_REQUIRED"]);

    const byOwner = await call(reviewer, "DELETE", `/api/delegations/${id}`, undefined);
    expect(byOwner.status).toBe(200);
  });
});

describe("confirming with Microsoft", () => {
  /** A finished confirmation round trip, as the callback leaves it. */
  async function handoverFor(forUserId: string, userId: string, purpose = "step-up") {
    const code = `handover-${Math.random().toString(36).slice(2)}`;
    const { createHash } = await import("node:crypto");
    await prisma.ssoLogin.create({
      data: {
        state: `state-${Math.random().toString(36).slice(2)}`,
        nonce: "n",
        codeVerifier: "",
        purpose,
        forUserId,
        userId,
        codeHash: createHash("sha256").update(code).digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return code;
  }

  it("turns a fresh Microsoft sign-in into the usual five-minute confirmation", async () => {
    const code = await handoverFor(reviewer.id, reviewer.id);

    const result = await ssoService.confirmStepUp(code, reviewer.id);

    expect(result.stepUpToken).toEqual(expect.any(String));
    // Marked as a Microsoft confirmation, so a certificate never calls it a password.
    expect((await verifyToken(result.stepUpToken, "step-up"))?.how).toBe("MICROSOFT");
  });

  it("spends it once", async () => {
    const code = await handoverFor(reviewer.id, reviewer.id);
    await ssoService.confirmStepUp(code, reviewer.id);

    await expect(ssoService.confirmStepUp(code, reviewer.id)).rejects.toMatchObject({
      code: "STEP_UP_REFUSED",
    });
  });

  it("refuses somebody spending another person's confirmation", async () => {
    const code = await handoverFor(reviewer.id, reviewer.id);

    await expect(ssoService.confirmStepUp(code, preparer.id)).rejects.toMatchObject({
      code: "STEP_UP_REFUSED",
    });
  });

  it("never turns a confirmation into a session", async () => {
    const code = await handoverFor(reviewer.id, reviewer.id);

    await expect(ssoService.exchange(code)).rejects.toMatchObject({
      code: "SSO_CODE_INVALID",
    });
  });

  it("never turns a sign-in into a confirmation", async () => {
    const code = await handoverFor(reviewer.id, reviewer.id, "sign-in");

    await expect(ssoService.confirmStepUp(code, reviewer.id)).rejects.toMatchObject({
      code: "STEP_UP_REFUSED",
    });
  });
});
