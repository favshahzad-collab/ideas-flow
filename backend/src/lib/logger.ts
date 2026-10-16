/**
 * What happened, in a form something can search.
 *
 * Until this existed the only record of a failed request was
 * `console.error("Unhandled error:", error)` — a stack with no request behind
 * it. Nobody could answer the question that actually gets asked, which is
 * never "what was the stack" but "Bilal says approving the increment memo
 * failed at about four o'clock; what happened?" There was no request id to
 * quote, no route, no actor, no duration, and no way to tell one person's
 * failure from another's.
 *
 * One JSON object per line on stdout. That is deliberately the least
 * fashionable choice available: it needs no dependency, no agent and no
 * network, and every log shipper ever written reads it. A process that must
 * reach a collector to record that something went wrong has a second thing
 * that can go wrong.
 *
 * WHAT MUST NEVER APPEAR HERE
 *
 * This is an HR system. The memos are salary increments, disciplinary letters
 * and terminations, and a log file is copied to places the database never
 * goes — a laptop, a support ticket, a chat message. So the rule is that logs
 * carry identifiers and never content: a document id, never its title; an
 * actor id, never their email; the fact of a search, never what was searched
 * for. `redact()` below enforces the part that can be enforced, and the rest
 * is a matter of not passing content in.
 */

import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/**
 * Silent under test by default.
 *
 * The integration suite drives the real app over real HTTP several hundred
 * times; at `info` every one of those prints a line and the output that
 * matters — which test failed — is somewhere in the middle of it. Set
 * LOG_LEVEL explicitly when a test is what you are debugging.
 */
function configuredLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (raw && raw in ORDER) return raw as LogLevel;
  return process.env.NODE_ENV === "test" ? "silent" : "info";
}

let level: LogLevel = configuredLevel();

/** Re-read LOG_LEVEL. Only a test needs this; nothing in the app calls it. */
export function refreshLogLevel(): void {
  level = configuredLevel();
}

/** Test seam, so a test can capture lines without patching global console. */
let sink: (line: string) => void = (line) => process.stdout.write(line + "\n");

export function setLogSink(next: ((line: string) => void) | null): void {
  sink = next ?? ((line) => process.stdout.write(line + "\n"));
}

/**
 * Keys whose values never reach the log whatever they hold.
 *
 * Matched on the key rather than the value: a heuristic that tries to
 * recognise a secret by shape will one day meet one it does not recognise,
 * and the failure mode is a credential in a log file forever. Matching names
 * fails the other way — something harmless is hidden — which costs a debugging
 * session rather than a person's password.
 */
const SECRET = [
  "password",
  "token",
  "authorization",
  "cookie",
  "secret",
  "jwt",
  "signature",
  "refresh",
  "hash",
  "key",
];

/**
 * Keys that identify a person or carry the contents of a memo. Present in the
 * log as a marker that there was a value, never as the value itself.
 */
const PRIVATE = [
  "email",
  "title",
  "description",
  "comment",
  "reason",
  "body",
  "query",
  "search",
  "filename",
  "firstname",
  "lastname",
  "name",
];

/**
 * Private keys too short to match as substrings.
 *
 * `q` is the documents search parameter and genuinely must not be logged - it
 * is usually a colleague's name. As a substring it also matched `seq`, which
 * is the audit chain's position and the single most useful number in that
 * subsystem, so the ledger's own logs would have read `"seq": "[private]"`.
 *
 * This is the failure this file's comment predicts: matching on names fails by
 * hiding something harmless. It is the right direction to fail in, and it is
 * still worth not failing.
 */
const PRIVATE_EXACT = new Set(["q"]);

const MAX_STRING = 512;
const MAX_DEPTH = 4;

function classify(key: string): "secret" | "private" | "keep" {
  const k = key.toLowerCase();
  if (SECRET.some((s) => k.includes(s))) return "secret";
  if (PRIVATE_EXACT.has(k)) return "private";
  // `id` must survive: documentId, actorId and requestId are the whole point.
  if (k === "id" || k.endsWith("id") || k.endsWith("ids")) return "keep";
  if (PRIVATE.some((p) => k.includes(p))) return "private";
  return "keep";
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();

  if (depth >= MAX_DEPTH) return "[deep]";

  if (Array.isArray(value)) {
    // The length is usually the interesting part, and a 4,000-element array
    // in a log line helps nobody.
    if (value.length > 20) return `[${value.length} items]`;
    return value.map((entry) => redact(entry, depth + 1));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack?.split("\n").slice(0, 12).join("\n"),
    };
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const kind = classify(key);
      if (kind === "secret") {
        out[key] = "[redacted]";
      } else if (kind === "private") {
        // That there WAS a title matters when reading a log; what it said does
        // not, and it is not this file's to disclose.
        out[key] = entry === null || entry === undefined ? entry : "[private]";
      } else {
        out[key] = redact(entry, depth + 1);
      }
    }
    return out;
  }

  // Everything with a useful string form is handled above. What can still
  // arrive is a symbol or a function, neither of which belongs in a log line
  // as anything but a note that it was there.
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "[function]";
  return "[unprintable]";
}

export type LogFields = Record<string, unknown>;

function write(at: LogLevel, event: string, fields: LogFields = {}): void {
  if (ORDER[at] < ORDER[level]) return;

  const line = {
    time: new Date().toISOString(),
    level: at,
    event,
    ...(redact(fields) as LogFields),
  };

  try {
    sink(JSON.stringify(line));
  } catch {
    // A logger that can throw is a logger that can take down a request it was
    // only meant to describe. If the object will not serialise, say so and
    // carry on.
    sink(JSON.stringify({ time: line.time, level: at, event, note: "unserialisable fields" }));
  }
}

export const logger = {
  debug: (event: string, fields?: LogFields) => write("debug", event, fields),
  info: (event: string, fields?: LogFields) => write("info", event, fields),
  warn: (event: string, fields?: LogFields) => write("warn", event, fields),
  error: (event: string, fields?: LogFields) => write("error", event, fields),
  get level(): LogLevel {
    return level;
  },
};

/** A new correlation id. Public because the request middleware mints them. */
export function newRequestId(): string {
  return randomUUID();
}
