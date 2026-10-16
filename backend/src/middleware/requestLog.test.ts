import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { errors } from "../lib/errors";
import { refreshLogLevel, setLogSink } from "../lib/logger";
import { errorHandler } from "./errorHandler";
import { requestLog } from "./requestLog";

/**
 * The request id, over real HTTP.
 *
 * Built on a small app rather than the real one because what is being tested
 * is the contract between these two middlewares, and the real app cannot be
 * asked to fail on demand without breaking something a person depends on. The
 * routes below exist to succeed, to refuse, and to explode.
 */

const lines: string[] = [];
let server: Server;
let base: string;

const app = express();
app.use(requestLog);
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});
app.get("/fine", (_req, res) => {
  res.json({ ok: true });
});
app.get("/refused", (_req, _res, next) => {
  next(errors.unauthorized("No token provided"));
});
app.get("/boom", () => {
  throw new TypeError("cannot read approvalChain of undefined");
});
app.use(errorHandler);

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

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

type Line = Record<string, unknown>;
const parsed = () => lines.map((l) => JSON.parse(l) as Line);
const eventsOf = (event: string) => parsed().filter((l) => l.event === event);

describe("the id on the way out", () => {
  it("puts one on every response, whether or not it went well", async () => {
    const fine = await fetch(`${base}/fine`);
    const boom = await fetch(`${base}/boom`);

    expect(fine.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(boom.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(fine.headers.get("x-request-id")).not.toBe(boom.headers.get("x-request-id"));
  });

  it("gives the same id to the person and to the log", async () => {
    // The whole point. "It failed and it said 6f8ee119" has to be a search.
    const response = await fetch(`${base}/boom`);
    const body = (await response.json()) as { error: { requestId?: string } };
    const header = response.headers.get("x-request-id");

    expect(body.error.requestId).toBe(header);
    expect(eventsOf("unhandled")[0].requestId).toBe(header);
    expect(eventsOf("http")[0].requestId).toBe(header);
  });

  it("leaves the message and code the frontend reads alone", async () => {
    // `requestId` is additive. Anything that renamed these would break every
    // error surface in the application.
    const body = (await (await fetch(`${base}/boom`)).json()) as {
      error: { message: string; code: string };
    };

    expect(body.error.message).toBe("Internal server error");
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});

describe("an id somebody else supplied", () => {
  it("carries a proxy's id through, so one trace spans both", async () => {
    const response = await fetch(`${base}/fine`, {
      headers: { "X-Request-Id": "edge-7f3a9c21" },
    });

    expect(response.headers.get("x-request-id")).toBe("edge-7f3a9c21");
    expect(eventsOf("http")[0].requestId).toBe("edge-7f3a9c21");
  });

  it("refuses one that could forge a second log line", async () => {
    /*
     * The attack this exists for: a header holding a newline and a plausible
     * JSON object writes an entry of the client's choosing into the log -
     * a "request succeeded" underneath the failure it actually caused, or an
     * entry blaming somebody else's actor id. The log is evidence in a dispute
     * over an approval, so a line nobody wrote must not be able to appear in
     * it.
     */
    const forged = 'x\n{"level":"info","event":"http","status":200}';
    const response = await fetch(`${base}/fine`, {
      // Node refuses an invalid header outright, so this is sent raw enough to
      // reach the middleware while still being a single header value.
      headers: { "X-Request-Id": encodeURIComponent(forged) },
    });

    const id = response.headers.get("x-request-id");
    expect(id).not.toContain("\n");
    expect(id).not.toContain("%0A");
    // Percent-encoding is not in the safe set either, so this is replaced with
    // a minted uuid rather than passed along.
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines).toHaveLength(1);
  });

  it("replaces one that is simply too long", async () => {
    const response = await fetch(`${base}/fine`, {
      headers: { "X-Request-Id": "a".repeat(400) },
    });

    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("what the line says", () => {
  it("records the route, the status and how long it took", async () => {
    await fetch(`${base}/fine`);

    const line = eventsOf("http")[0];
    expect(line.method).toBe("GET");
    expect(line.route).toBe("/fine");
    expect(line.status).toBe(200);
    expect(typeof line.ms).toBe("number");
    expect(line.level).toBe("info");
  });

  it("calls a refusal a warning and a crash an error", async () => {
    // A 401 is the system working. A 500 is not, and a log that rates them the
    // same is a log nobody can alert on.
    await fetch(`${base}/refused`);
    expect(eventsOf("http")[0].level).toBe("warn");
    expect(eventsOf("http")[0].status).toBe(401);

    lines.length = 0;
    await fetch(`${base}/boom`);
    expect(eventsOf("http")[0].level).toBe("error");
    expect(eventsOf("http")[0].status).toBe(500);
  });

  it("logs an expected refusal once, without a stack", async () => {
    // `errorHandler` deliberately does not log the 4xx cases: an approver
    // without a token is not an incident, and a stack for every one of them
    // is how a log stops being read.
    await fetch(`${base}/refused`);

    expect(eventsOf("unhandled")).toHaveLength(0);
    expect(lines).toHaveLength(1);
  });

  it("says nothing about a healthy health check", async () => {
    // A load balancer polls this every few seconds forever.
    await fetch(`${base}/api/health`);

    expect(lines).toEqual([]);
  });

  it("keeps the search terms out of it", async () => {
    // `?q=` on the documents route carries whatever was typed into the search
    // box, which in this application is usually a colleague's name. The query
    // string is dropped rather than redacted key by key.
    await fetch(`${base}/fine?q=Ayesha%20Khan&status=PENDING`);

    expect(lines.join("\n")).not.toContain("Ayesha");
    expect(eventsOf("http")[0].route).toBe("/fine");
  });
});
