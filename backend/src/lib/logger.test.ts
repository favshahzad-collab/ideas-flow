import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logger, redact, refreshLogLevel, setLogSink } from "./logger";

/**
 * The logger, and mostly the part of it that decides what never gets written.
 *
 * This is an HR system: the memos are increments, warnings and terminations.
 * A log file is copied to places the database never goes - a support ticket, a
 * laptop, a chat message - so the rule is identifiers in, content out. These
 * tests are the enforcement of that rule, and they are the reason to prefer
 * matching on key names over trying to recognise a secret by its shape: a
 * shape-matcher fails by letting something through, and this one fails by
 * hiding something harmless.
 */

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

const lastLine = () => JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;

describe("what never reaches a log file", () => {
  it("blanks anything whose name suggests a credential", () => {
    logger.info("test", {
      password: "hunter2",
      accessToken: "eyJhbGciOi",
      authorization: "Bearer eyJhbGciOi",
      cookie: "session=abc",
      jwtSecret: "s3cr3t",
      refreshTokenHash: "9f86d081",
    });

    const line = lastLine();
    for (const key of [
      "password",
      "accessToken",
      "authorization",
      "cookie",
      "jwtSecret",
      "refreshTokenHash",
    ]) {
      expect(line[key]).toBe("[redacted]");
    }

    // And the value itself is nowhere in the serialised line, which is the
    // assertion that would catch a key being copied somewhere else en route.
    expect(lines.join("\n")).not.toContain("hunter2");
    expect(lines.join("\n")).not.toContain("eyJhbGciOi");
  });

  it("keeps that a value existed without saying what it was", () => {
    logger.info("test", {
      title: "Termination — A. Khan",
      email: "shahzad.ali@example.com",
      comment: "Recommended for approval on medical grounds.",
      q: "Ayesha",
    });

    const line = lastLine();
    expect(line.title).toBe("[private]");
    expect(line.email).toBe("[private]");
    expect(line.comment).toBe("[private]");
    expect(line.q).toBe("[private]");

    const all = lines.join("\n");
    expect(all).not.toContain("Termination");
    expect(all).not.toContain("A. Khan");
    expect(all).not.toContain("Ayesha");
    expect(all).not.toContain("medical");
  });

  it("distinguishes an absent private value from a hidden one", () => {
    // `title: null` is worth knowing - it can be the bug - and disclosing
    // that there was no title discloses nothing about anybody. An `undefined`
    // is dropped by JSON.stringify itself, which is the behaviour wanted:
    // fields nobody set do not clutter the line.
    logger.info("test", { title: null, comment: undefined });

    const line = lastLine();
    expect(line.title).toBeNull();
    expect("comment" in line).toBe(false);
  });

  it("keeps every identifier, which is the whole point of the line", () => {
    logger.info("test", {
      id: "doc-1",
      documentId: "doc-2",
      actorId: "user-3",
      requestId: "req-4",
      workflowRunIds: ["a", "b"],
    });

    const line = lastLine();
    expect(line.id).toBe("doc-1");
    expect(line.documentId).toBe("doc-2");
    expect(line.actorId).toBe("user-3");
    expect(line.requestId).toBe("req-4");
    expect(line.workflowRunIds).toEqual(["a", "b"]);
  });

  it("reaches private values nested inside an object", () => {
    // The realistic shape: somebody logs a whole row.
    logger.info("test", { document: { id: "doc-1", title: "Increment 2026" } });

    const line = lastLine();
    expect(line.document).toEqual({ id: "doc-1", title: "[private]" });
    expect(lines.join("\n")).not.toContain("Increment 2026");
  });
});

describe("the shape of a line", () => {
  it("is one JSON object with a time, a level and an event", () => {
    logger.warn("mail.gave_up", { mailId: "m-1" });

    const line = lastLine();
    expect(line.level).toBe("warn");
    expect(line.event).toBe("mail.gave_up");
    expect(line.mailId).toBe("m-1");
    expect(typeof line.time).toBe("string");
    expect(new Date(line.time as string).toString()).not.toBe("Invalid Date");
    expect(lines[lines.length - 1]).not.toContain("\n");
  });

  it("carries an error as a name, a message and a bounded stack", () => {
    logger.error("unhandled", { err: new TypeError("cannot read x of undefined") });

    const err = lastLine().err as Record<string, unknown>;
    expect(err.name).toBe("TypeError");
    expect(err.message).toBe("cannot read x of undefined");
    expect((err.stack as string).split("\n").length).toBeLessThanOrEqual(12);
  });

  it("truncates a string that would otherwise fill the file", () => {
    logger.info("test", { note: "x".repeat(5_000) });

    expect((lastLine().note as string).length).toBeLessThan(600);
  });

  it("counts a long array instead of printing it", () => {
    logger.info("test", { pageIds: Array.from({ length: 4_000 }, (_, i) => `d-${i}`) });

    expect(lastLine().pageIds).toBe("[4000 items]");
  });

  it("survives a circular object rather than taking the request down with it", () => {
    // A logger that can throw is a logger that can fail a request it was only
    // meant to describe.
    const circular: Record<string, unknown> = { id: "x" };
    circular.self = circular;

    expect(() => logger.info("test", { circular })).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});

describe("levels", () => {
  it("drops anything below the configured level", () => {
    process.env.LOG_LEVEL = "warn";
    refreshLogLevel();

    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");

    expect(lines.map(l => (JSON.parse(l) as { event: string }).event)).toEqual(["c", "d"]);
  });

  it("says nothing at all when silenced", () => {
    process.env.LOG_LEVEL = "silent";
    refreshLogLevel();

    logger.error("this is an emergency");

    expect(lines).toEqual([]);
  });

  it("is silent under test unless a level is asked for", () => {
    // Several hundred integration tests drive the real app over real HTTP. At
    // `info` the output that matters - which test failed - is buried.
    delete process.env.LOG_LEVEL;
    refreshLogLevel();

    logger.info("http");

    expect(process.env.NODE_ENV).toBe("test");
    expect(lines).toEqual([]);
  });
});

describe("redact, directly", () => {
  it("does not recurse for ever on a deep structure", () => {
    let deep: Record<string, unknown> = { id: "bottom" };
    for (let i = 0; i < 50; i += 1) deep = { nested: deep };

    expect(() => JSON.stringify(redact(deep))).not.toThrow();
    expect(JSON.stringify(redact(deep))).toContain("[deep]");
  });

  it("renders a bigint, which JSON.stringify refuses outright", () => {
    expect(redact({ seq: 42n })).toEqual({ seq: "42" });
  });

  it("does not treat the chain position as the search box", () => {
    /*
     * `q` is the documents search parameter and must never be logged - it is
     * usually somebody's name. Matched as a substring it also caught `seq`,
     * the audit chain's position, so the ledger's own logging would have read
     * "[private]" where the single most useful number in that subsystem
     * belongs. Short keys match exactly for this reason.
     */
    expect(redact({ seq: 7, sequence: 7, q: "Ayesha" })).toEqual({
      seq: 7,
      sequence: 7,
      q: "[private]",
    });
  });
});
