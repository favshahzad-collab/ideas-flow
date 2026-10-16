/**
 * One line per request, and an id the person who hit the error can quote.
 *
 * The id is the point. A 500 used to be a stack in the server's output and a
 * generic sentence on the approver's screen, with nothing joining them: if two
 * people hit errors in the same minute there was no way to tell which stack
 * belonged to which of them. Now the response carries `X-Request-Id` and the
 * body carries `requestId`, both of which appear on the log line, so "it
 * failed and it said 6f8ee119" is a search rather than an investigation.
 *
 * What is logged is deliberately thin: who (by id), what route, what status,
 * how long. Never the body, never the query, never the memo. See `redact()`
 * in lib/logger.ts for the part of that which is enforced rather than trusted.
 */

import type { NextFunction, Request, Response } from "express";
import { logger, newRequestId } from "../lib/logger";

declare global {
  namespace Express {
    interface Request {
      /** Correlation id for this request. Present from the first middleware. */
      requestId?: string;
    }
  }
}

/**
 * An inbound id is accepted so a trace can span the proxy, but only if it
 * looks like one.
 *
 * Anything from a client ends up in a log file that a person will later read,
 * grep, and possibly paste into a shell. A header carrying a newline can forge
 * a second log line - a fake "request succeeded" beneath a real failure - so
 * the value is bounded and restricted to characters that cannot do that. An
 * id that fails this is replaced rather than rejected: the request is fine,
 * it is only its label that was not.
 */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function idFor(req: Request): string {
  const inbound = req.headers["x-request-id"];
  const value = Array.isArray(inbound) ? inbound[0] : inbound;
  return value && SAFE_ID.test(value) ? value : newRequestId();
}

/**
 * Health checks are excluded while they are healthy.
 *
 * A load balancer polls `/api/health` every few seconds forever. Logging that
 * buries everything else and costs real money in any hosted log product. A
 * health check that FAILS is exactly what somebody wants to find, so those
 * are kept.
 */
const QUIET_PATHS = new Set(["/api/health"]);

/**
 * The route pattern Express matched, where it knows one.
 *
 * The pattern is what makes a log searchable: `/api/documents/:id` groups,
 * `/api/documents/930d5bf1-…` groups nothing, because every request carries a
 * different id. Express only knows the pattern once a route has matched, so a
 * 404 falls back to the path.
 *
 * `req.route` is `any` in the Express types. Narrowed once here rather than at
 * each call site, so the `any` stops at this function.
 */
export function routeOf(req: Request): string {
  const route: unknown = req.route;
  const path =
    route !== null && typeof route === "object" && "path" in route
      ? (route as { path?: unknown }).path
      : undefined;

  return typeof path === "string" ? `${req.baseUrl}${path}` : req.path;
}

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const requestId = idFor(req);
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const quiet = QUIET_PATHS.has(req.path) && res.statusCode < 400;
    if (quiet) return;

    const ms = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    /*
     * The query string is dropped entirely rather than redacted key by key.
     * `?q=` on the documents route carries whatever somebody typed into the
     * search box, which in this application is usually a colleague's name.
     */
    const route = routeOf(req);

    const at = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";

    logger[at]("http", {
      requestId,
      method: req.method,
      route,
      status: res.statusCode,
      ms: Math.round(ms * 10) / 10,
      // `supabaseUserId` is the historical name for the authenticated user's
      // id; absent when the route is public or the token was refused.
      actorId: req.supabaseUserId,
      ip: req.ip,
    });
  });

  next();
}
