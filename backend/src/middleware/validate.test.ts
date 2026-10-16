import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { AppError } from "../lib/errors";
import { validate } from "./validate";

/**
 * Everything a client sends passes through here on its way to a route, so two
 * things have to hold: what reaches the handler is the parsed value rather
 * than the raw one, and a validation failure arrives as a 400 the error
 * handler can render - never as a ZodError leaking its internal shape.
 */

type Parts = { body?: unknown; query?: unknown; params?: unknown };

function run(schema: z.ZodType, parts: Parts) {
  const req = {
    body: parts.body,
    query: parts.query ?? {},
    params: parts.params ?? {},
  } as unknown as Request;

  let passed: unknown;
  const next: NextFunction = (error?: unknown) => {
    passed = error;
  };

  validate(schema)(req, {} as Response, next);

  return { req, error: passed };
}

const bodySchema = z.object({
  body: z.object({
    title: z.string().trim().min(1, "Title is required"),
  }),
});

describe("validate", () => {
  it("calls next with nothing when the input parses", () => {
    const { error } = run(bodySchema, { body: { title: "ok" } });
    expect(error).toBeUndefined();
  });

  it("replaces the body with the parsed value", () => {
    // Without this the handler receives the untrimmed original and every
    // `.trim()` and coercion in the schema is decoration.
    const { req } = run(bodySchema, { body: { title: "  padded  " } });
    expect(req.body).toEqual({ title: "padded" });
  });

  it("leaves the body alone when the schema does not describe one", () => {
    const paramsOnly = z.object({ params: z.object({ id: z.string() }) });
    const { req, error } = run(paramsOnly, {
      body: { untouched: true },
      params: { id: "abc" },
    });

    expect(error).toBeUndefined();
    expect(req.body).toEqual({ untouched: true });
  });

  it("treats a missing body as an empty object", () => {
    // express only populates req.body when a body parser matched the request,
    // so a schema with all-optional fields has to survive `undefined`.
    const optional = z.object({ body: z.object({ note: z.string().optional() }) });
    const { error } = run(optional, { body: undefined });

    expect(error).toBeUndefined();
  });

  it("turns a validation failure into a 400", () => {
    const { error } = run(bodySchema, { body: { title: "" } });

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "Title is required",
    });
  });

  it("joins several messages into one sentence", () => {
    const two = z.object({
      body: z.object({
        title: z.string().min(1, "Title is required"),
        email: z.string().min(1, "Email is required"),
      }),
    });

    const { error } = run(two, { body: { title: "", email: "" } });

    expect((error as AppError).message).toBe(
      "Title is required. Email is required"
    );
  });

  it("says a repeated message once", () => {
    // Ten chain steps with the same defect should not produce the same
    // sentence ten times over.
    const repeated = z.object({
      body: z.object({
        ids: z.array(z.uuid("Invalid user ID")),
      }),
    });

    const { error } = run(repeated, { body: { ids: ["a", "b", "c"] } });

    expect((error as AppError).message).toBe("Invalid user ID");
  });

  it("passes a non-validation error through untouched", () => {
    // A schema that throws for its own reasons is a bug in the schema, not
    // bad input, and reporting it as a 400 would send the client chasing it.
    const boom = new Error("transform exploded");
    const throwing = z.object({ body: z.unknown() }).transform(() => {
      throw boom;
    });

    const { error } = run(throwing, { body: {} });

    expect(error).toBe(boom);
  });
});
