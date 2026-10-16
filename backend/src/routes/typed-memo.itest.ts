import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import app from "../app";
import { ApprovalType, LoginRole } from "../generated/prisma/client";
import { FUEL_REQUEST_BODY } from "../lib/memoTemplate/fuelRequest.fixture";
import { hashPassword } from "../lib/password";
import { prisma } from "../prisma";
import {
  makeDepartment,
  makePdf,
  SIGNATURE_IMAGE,
  useCleanDatabase,
} from "../test/db";

/**
 * A memo typed in the portal, over real HTTP.
 *
 * The services are covered elsewhere and this is not a second copy of that.
 * What lives only in the routes is everything between the browser and the
 * schema - multipart parsing, validation, permissions, status codes - and
 * Phase 3 proved that is not a theoretical gap: the `body` field was never
 * parsed out of the form, so every typed submission through the real route
 * was refused with "expected object, received string" while every test that
 * called the service directly passed.
 *
 * So each block below asks one question a person could hit with a browser.
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

type Person = { id: string; email: string; token: string };

/*
 * Each person's "confirm it's you", made through the real endpoint with their
 * password when they sign in, and sent with every request they make - as the
 * app does once somebody has confirmed. Signing is refused without one; the
 * refusal itself is pinned in `signing-confirmation.itest.ts`.
 */
const stepUps = new Map<string, string>();
const authHeaders = (token: string): Record<string, string> => {
  const stepUp = stepUps.get(token);
  return {
    authorization: `Bearer ${token}`,
    ...(stepUp ? { "x-step-up": stepUp } : {}),
  };
};

async function makePerson(
  firstName: string,
  departmentId: string,
  loginRole: LoginRole = LoginRole.USER
): Promise<Person> {
  const email = `${firstName.toLowerCase()}-${Math.random()
    .toString(36)
    .slice(2, 8)}@example.com`;

  const user = await prisma.user.create({
    data: {
      firstName,
      lastName: "Khan",
      email,
      passwordHash: await hashPassword(PASSWORD),
      departmentId,
      loginRole,
      isSuperAdmin: loginRole === "ADMINISTRATOR",
      designation: "Officer",
    },
  });

  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = (await response.json()) as { accessToken?: string };
  if (!body.accessToken) {
    throw new Error(`Could not sign in as ${email}: ${response.status}`);
  }

  const confirmation = await fetch(`${base}/api/auth/step-up`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${body.accessToken}`,
    },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const { stepUpToken } = (await confirmation.json()) as { stepUpToken?: string };
  if (stepUpToken) stepUps.set(body.accessToken, stepUpToken);

  return { id: user.id, email, token: body.accessToken };
}

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {}
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.token ? authHeaders(options.token) : {}),
      ...(options.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

const message = (body: Record<string, unknown>): string =>
  String((body.error as { message?: string } | undefined)?.message ?? "");

let preparer: Person;
let reviewer: Person;
let stranger: Person;

beforeEach(async () => {
  const department = await makeDepartment(`Typed ${Math.random()}`);
  [preparer, reviewer, stranger] = await Promise.all([
    makePerson("Preparer", department.id),
    makePerson("Reviewer", department.id),
    makePerson("Stranger", department.id),
  ]);
});

const placement = () => ({
  consent: true,
  useSavedSignature: false,
  signatureImage: SIGNATURE_IMAGE,
  signaturePage: 1,
  signatureX: 100,
  signatureY: 200,
  signatureWidth: 120,
  signatureHeight: 40,
});

/**
 * A typed submission as the browser sends one: every field a form field, with
 * the structured ones carrying JSON. This shape is the point of the file.
 */
function typedForm(overrides: Record<string, unknown> = {}): FormData {
  const fields: Record<string, unknown> = {
    title: "Approval for Revision of Fuel Allowance",
    description: "Typed in the portal.",
    memoType: "APPROVAL_REQUEST",
    memoTo: "Sir BMD",
    memoFrom: "Human Resource Department",
    body: FUEL_REQUEST_BODY,
    approvalChain: [
      { userId: reviewer.id, approvalType: ApprovalType.FINAL_APPROVER },
    ],
    signature: placement(),
    ...overrides,
  };

  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    form.append(
      name,
      typeof value === "string" ? value : JSON.stringify(value)
    );
  }
  return form;
}

async function submitTyped(overrides: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/api/documents`, {
    method: "POST",
    headers: authHeaders(preparer.token),
    body: typedForm(overrides),
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

describe("submitting a memo with no file attached", () => {
  it("is accepted and comes back looking like any other memo", async () => {
    const response = await submitTyped();

    expect(response.status).toBe(201);
    const document = response.body.document as Record<string, unknown>;
    expect(document.status).toBe("PENDING_REVIEW");
    expect(String(document.referenceNumber)).toMatch(/^MEMO-\d{4}-\d{4}$/);
  });

  it("parses the body out of the form rather than taking it as a string", async () => {
    /*
     * The regression that this file exists for. Without `body` in the route's
     * list of JSON fields it reaches the schema as a string, and the preparer
     * is told "expected object, received string" about a memo they typed.
     */
    const response = await submitTyped();
    expect(response.status).toBe(201);

    const version = await prisma.documentVersion.findFirstOrThrow({
      where: {
        documentId: String(
          (response.body.document as Record<string, unknown>).id
        ),
      },
    });
    expect(JSON.stringify(version.bodyJson)).toContain("doc");
  });

  it("refuses a body carrying a node the memo template cannot draw", async () => {
    const response = await submitTyped({
      body: {
        type: "doc",
        content: [
          { type: "video", attrs: { src: "https://example.com/clip.mp4" } },
        ],
      },
    });

    expect(response.status).toBe(400);
    // And it says what a memo may contain, rather than naming a discriminator.
    expect(message(response.body)).toMatch(/paragraphs, headings/i);
  });

  it("refuses a picture the memo would have to fetch, saying it must be carried in the memo", async () => {
    const response = await submitTyped({
      body: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "See the picture." }] },
          { type: "image", attrs: { src: "https://example.com/logo.png" } },
        ],
      },
    });

    expect(response.status).toBe(400);
    expect(message(response.body)).toMatch(/carried in the memo itself/i);
  });

  it("refuses a memo with nothing written in it", async () => {
    const response = await submitTyped({
      body: { type: "doc", content: [{ type: "paragraph" }] },
    });

    expect(response.status).toBe(400);
    expect(message(response.body)).toMatch(/Write the memo/i);
  });

  it("refuses the typed fields arriving half-complete", async () => {
    const response = await submitTyped({ memoTo: undefined });

    expect(response.status).toBe(400);
    expect(message(response.body)).toMatch(/type, its addressee, its sender/i);
  });

  it("refuses characters the bundled fonts cannot draw, and writes nothing", async () => {
    const response = await submitTyped({
      body: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "السلام" }],
          },
        ],
      },
    });

    expect(response.status).toBe(400);
    expect(message(response.body)).toMatch(/empty boxes/i);

    // The render throws before a byte is written, so there is no orphaned
    // document, version or file to clean up afterwards.
    expect(await prisma.document.count()).toBe(0);
    expect(await prisma.documentVersion.count()).toBe(0);
  });

  it("refuses a chain that routes the memo back to its author", async () => {
    const response = await submitTyped({
      approvalChain: [
        { userId: preparer.id, approvalType: ApprovalType.FINAL_APPROVER },
      ],
    });

    expect(response.status).toBe(400);
    expect(await prisma.document.count()).toBe(0);
  });

  it("refuses a chain naming somebody who does not exist", async () => {
    const response = await submitTyped({
      approvalChain: [
        {
          userId: "00000000-0000-4000-8000-000000000000",
          approvalType: ApprovalType.FINAL_APPROVER,
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(await prisma.document.count()).toBe(0);
  });

  it("refuses a memo with neither a file nor a body", async () => {
    const form = typedForm({
      body: undefined,
      memoType: undefined,
      memoTo: undefined,
      memoFrom: undefined,
    });

    const response = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: authHeaders(preparer.token),
      body: form,
    });

    expect(response.status).toBe(400);
  });

  it("still accepts an uploaded PDF, with no typed fields at all", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(await makePdf(1))], {
        type: "application/pdf",
      }),
      "memo.pdf"
    );
    form.append("title", "An uploaded memo");
    form.append(
      "approvalChain",
      JSON.stringify([
        { userId: reviewer.id, approvalType: ApprovalType.FINAL_APPROVER },
      ])
    );
    form.append("signature", JSON.stringify(placement()));

    const response = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: authHeaders(preparer.token),
      body: form,
    });

    expect(response.status).toBe(201);

    const version = await prisma.documentVersion.findFirstOrThrow({});
    // Nothing about the uploaded path changed: no body, no printed strip.
    expect(version.bodyJson).toBeNull();
    expect(version.signatureSlots).toBeNull();
  });
});

describe("drawing the memo before it is submitted", () => {
  const preview = (token: string, body: unknown) =>
    call("POST", "/api/memo-drafts/preview", { token, body });

  it("needs somebody signed in", async () => {
    const response = await fetch(`${base}/api/memo-drafts/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: FUEL_REQUEST_BODY }),
    });

    expect(response.status).toBe(401);
  });

  it("draws the memo and says where every signature belongs", async () => {
    const response = await preview(preparer.token, {
      title: "Approval for Revision of Fuel Allowance",
      memoTo: "Sir BMD",
      memoFrom: "Human Resource Department",
      body: FUEL_REQUEST_BODY,
      chain: [
        { userId: reviewer.id, approvalType: ApprovalType.FINAL_APPROVER },
      ],
    });

    expect(response.status).toBe(200);
    expect(String(response.body.pdfBase64).length).toBeGreaterThan(1000);
    expect(response.body.slots).toHaveLength(2);
  });

  it("writes nothing down", async () => {
    await preview(preparer.token, { body: FUEL_REQUEST_BODY });

    expect(await prisma.document.count()).toBe(0);
    expect(await prisma.memoDraft.count()).toBe(0);
    // Signing the test's people in is recorded; drawing the memo is not.
    expect(
      await prisma.auditLog.count({ where: { action: { not: "SIGN_IN_SUCCEEDED" } } }),
    ).toBe(0);
  });

  it("refuses a field it does not recognise, rather than ignoring it", async () => {
    const response = await preview(preparer.token, {
      body: FUEL_REQUEST_BODY,
      signature: placement(),
    });

    expect(response.status).toBe(400);
  });

  it("refuses to redraw somebody else's memo", async () => {
    const submitted = await submitTyped();
    const documentId = String(
      (submitted.body.document as Record<string, unknown>).id
    );

    const response = await preview(stranger.token, {
      body: FUEL_REQUEST_BODY,
      documentId,
    });

    expect(response.status).toBe(403);
  });
});

describe("a draft belongs to the person who wrote it", () => {
  const draftBody = {
    title: "Half-written",
    memoType: "APPROVAL_REQUEST",
    body: FUEL_REQUEST_BODY,
  };

  it("does not appear in anybody else's list", async () => {
    const created = await call("POST", "/api/memo-drafts", {
      token: preparer.token,
      body: draftBody,
    });
    expect(created.status).toBe(201);

    const mine = await call("GET", "/api/memo-drafts", {
      token: preparer.token,
    });
    const theirs = await call("GET", "/api/memo-drafts", {
      token: stranger.token,
    });

    expect((mine.body.drafts as unknown[]).length).toBe(1);
    expect((theirs.body.drafts as unknown[]).length).toBe(0);
  });

  it("cannot be opened by its id by somebody else", async () => {
    const created = await call("POST", "/api/memo-drafts", {
      token: preparer.token,
      body: draftBody,
    });
    const id = String(created.body.id);

    const response = await call("GET", `/api/memo-drafts/${id}`, {
      token: stranger.token,
    });

    // Not found rather than forbidden: knowing a draft exists is already
    // more than a stranger is entitled to about something unfinished.
    expect([403, 404]).toContain(response.status);
  });

  it("cannot be edited or deleted by somebody else", async () => {
    const created = await call("POST", "/api/memo-drafts", {
      token: preparer.token,
      body: draftBody,
    });
    const id = String(created.body.id);

    const edited = await call("PATCH", `/api/memo-drafts/${id}`, {
      token: stranger.token,
      body: { title: "Mine now" },
    });
    const deleted = await call("DELETE", `/api/memo-drafts/${id}`, {
      token: stranger.token,
    });

    expect([403, 404]).toContain(edited.status);
    expect([403, 404]).toContain(deleted.status);
    expect(await prisma.memoDraft.count()).toBe(1);
  });
});

describe("the date in the header", () => {
  it("is accepted as the preparer typed it", async () => {
    const response = await submitTyped({ memoDate: "2026-08-06" });

    expect(response.status).toBe(201);
    const stored = await prisma.document.findFirstOrThrow({});
    expect(stored.memoDate?.toISOString().slice(0, 10)).toBe("2026-08-06");
  });

  it("refuses a date that is not one", async () => {
    const response = await submitTyped({ memoDate: "2026-02-31" });

    expect(response.status).toBe(400);
    expect(message(response.body)).toMatch(/not a date/i);
    expect(await prisma.document.count()).toBe(0);
  });

  it("refuses a date written the other way round", async () => {
    // 06/08/2026 is ambiguous between two continents, so only one spelling
    // is accepted and anything else is refused rather than guessed at.
    const response = await submitTyped({ memoDate: "06-08-2026" });

    expect(response.status).toBe(400);
    expect(message(response.body)).toMatch(/YYYY-MM-DD/);
  });

  it("refuses a date on a memo that was uploaded as a PDF", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(await makePdf(1))], { type: "application/pdf" }),
      "memo.pdf"
    );
    form.append("title", "An uploaded memo");
    form.append("memoDate", "2026-08-06");
    form.append(
      "approvalChain",
      JSON.stringify([
        { userId: reviewer.id, approvalType: ApprovalType.FINAL_APPROVER },
      ])
    );
    form.append("signature", JSON.stringify(placement()));

    const response = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: authHeaders(preparer.token),
      body: form,
    });

    // An uploaded PDF brings its own header, drawn by whoever made it. A date
    // accepted here would be recorded and never printed anywhere.
    expect(response.status).toBe(400);
  });

  it("is drawn on the previewed page too", async () => {
    const dated = await call("POST", "/api/memo-drafts/preview", {
      token: preparer.token,
      body: { body: FUEL_REQUEST_BODY, memoDate: "2026-01-02" },
    });
    const otherDate = await call("POST", "/api/memo-drafts/preview", {
      token: preparer.token,
      body: { body: FUEL_REQUEST_BODY, memoDate: "2026-11-30" },
    });

    expect(dated.status).toBe(200);
    // The preview has to be the drawing the submission files, date included -
    // it is the page the preparer places their signature against.
    expect(dated.body.pdfBase64).not.toBe(otherDate.body.pdfBase64);
  });
});
