import type { NextFunction, Request, Response } from "express";
import { MulterError } from "multer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errors } from "../lib/errors";
import { refreshLogLevel, setLogSink } from "../lib/logger";
import { errorHandler } from "./errorHandler";

/**
 * The last thing between a thrown error and the person who caused it.
 *
 * What matters here is which failures are the caller's and which are ours. A
 * caller's mistake answered as 500 "Internal server error" sends somebody to
 * support over a file they could have replaced themselves; ours leaked to the
 * client as a message is a different problem in the other direction.
 */

function capture() {
  const json = vi.fn();
  const res = {
    status: vi.fn().mockReturnValue({ json }),
  } as unknown as Response;

  return {
    res,
    json,
    // An arrow, not a method: it closes over `res` and never reads `this`,
    // and callers pull it off the object (`const { handle } = capture()`).
    handle: (error: Error) => {
      const req = { requestId: "req-1", method: "POST", path: "/api/x" } as Request;
      errorHandler(error, req, res, (() => {}) as NextFunction);
      return {
        status: (res.status as unknown as { mock: { calls: number[][] } }).mock
          .calls[0][0],
        body: json.mock.calls[0][0],
      };
    },
  };
}

describe("an error the application raised on purpose", () => {
  it("keeps its status and its message", () => {
    const { handle } = capture();

    const { status, body } = handle(errors.badRequest("Attach the document PDF."));

    expect(status).toBe(400);
    expect(body.error.message).toBe("Attach the document PDF.");
  });

  it("carries a code when one was given, and omits it when not", () => {
    // `code` is optional on AppError and none of the `errors.*` helpers
    // supply a default, so most of the API answers with a message alone.
    // Stated rather than assumed: a client keying off `code` gets undefined
    // nearly everywhere.
    expect(
      capture().handle(errors.badRequest("No", "CHAIN_INVALID")).body.error.code
    ).toBe("CHAIN_INVALID");
    expect(capture().handle(errors.badRequest("No")).body.error.code).toBeUndefined();
  });

  it.each([
    [errors.notFound("Document not found"), 404],
    [errors.forbidden("Access denied"), 403],
    [errors.conflict("Object already exists"), 409],
  ])("carries %s through as %i", (error, expected) => {
    expect(capture().handle(error).status).toBe(expected);
  });
});

describe("a limit multer enforces itself", () => {
  /*
   * multer's `fileFilter`s raise AppErrors and always arrived correctly. The
   * `limits` are different: multer throws a MulterError, which is a plain
   * Error, so every one of them used to fall through to 500 "Internal server
   * error". Choosing a 25 MB PDF is not a server fault.
   */
  it("answers a file over the size limit with 413, not 500", () => {
    const { status, body } = capture().handle(
      new MulterError("LIMIT_FILE_SIZE", "file")
    );

    expect(status).toBe(413);
    expect(body.error.message).toMatch(/too large/i);
    expect(body.error.message).not.toMatch(/internal server error/i);
  });

  it("names the limit in the code, so the client can tell them apart", () => {
    expect(
      capture().handle(new MulterError("LIMIT_FILE_SIZE", "file")).body.error.code
    ).toBe("LIMIT_FILE_SIZE");
  });

  it.each([
    ["LIMIT_FILE_COUNT", 400],
    ["LIMIT_UNEXPECTED_FILE", 400],
    ["LIMIT_PART_COUNT", 400],
    ["LIMIT_FIELD_COUNT", 400],
    ["LIMIT_FIELD_KEY", 400],
    ["LIMIT_FIELD_VALUE", 400],
  ] as const)("answers %s with %i", (code, expected) => {
    const { status, body } = capture().handle(new MulterError(code, "file"));

    expect(status).toBe(expected);
    expect(body.error.message).not.toMatch(/internal server error/i);
  });

  it("still answers 400 for a multer code it has no wording for", () => {
    // Better a plain "that upload was refused" at the right status than a
    // 500 that says the server broke.
    const { status, body } = capture().handle(
      new MulterError("LIMIT_SOMETHING_NEW" as "LIMIT_FILE_SIZE", "file")
    );

    expect(status).toBe(400);
    expect(body.error.message).toMatch(/refused/i);
  });
});

describe("a body Express itself refused", () => {
  it("answers an oversized JSON payload with 413", () => {
    const tooLarge = Object.assign(new Error("request entity too large"), {
      type: "entity.too.large",
    });

    expect(capture().handle(tooLarge).status).toBe(413);
  });
});

describe("anything else", () => {
  const lines: string[] = [];

  beforeEach(() => {
    lines.length = 0;
    setLogSink((line) => lines.push(line));
    process.env.LOG_LEVEL = "debug";
    refreshLogLevel();
  });

  afterEach(() => {
    setLogSink(null);
    delete process.env.LOG_LEVEL;
    refreshLogLevel();
  });

  it("answers 500 and says nothing about what went wrong", () => {
    // The message could name a table, a path or a column. The log gets it;
    // the client gets a number.
    const { status, body } = capture().handle(
      new Error('relation "users" does not exist at character 42')
    );

    expect(status).toBe(500);
    expect(body.error.message).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toMatch(/users/);
  });

  it("logs it, because that is the only place it now exists", () => {
    // This used to assert `console.error` was called, which was all there was
    // to assert: an unstructured stack with no request attached. What it can
    // assert now is the thing that makes the line usable.
    capture().handle(new Error("boom"));

    const line = JSON.parse(lines[0]) as {
      level: string;
      event: string;
      requestId: string;
      err: { message: string };
    };

    expect(line.level).toBe("error");
    expect(line.event).toBe("unhandled");
    expect(line.requestId).toBe("req-1");
    expect(line.err.message).toBe("boom");
  });

  it("hands the caller the id the log line is filed under", () => {
    // Without this the person on the phone has nothing to quote, and two
    // people failing in the same minute are indistinguishable.
    const { body } = capture().handle(new Error("boom"));
    const line = JSON.parse(lines[0]) as { requestId: string };

    expect(body.error.requestId).toBe(line.requestId);
  });

  it("still keeps the detail out of the response", () => {
    // The log gets the stack. The client gets a number and an id.
    const { body } = capture().handle(
      new Error('relation "users" does not exist at character 42')
    );

    const error = body.error as Record<string, unknown>;
    expect(Object.keys(error).sort()).toEqual(["code", "message", "requestId"]);
  });
});
