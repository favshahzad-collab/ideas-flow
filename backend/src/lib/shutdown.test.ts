import { describe, expect, it, vi } from "vitest";
import { createShutdown, type ShutdownOptions } from "./shutdown";

/**
 * The order things stop in, which is the whole point: nothing that is still
 * in use is closed under it. Each fake records when it was called and when
 * it finished, and the tests read that record back whole.
 */

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function harness(overrides: Partial<ShutdownOptions> = {}) {
  const events: string[] = [];
  const request = deferred();
  const sweep = deferred();
  let closeCallback: (() => void) | null = null;

  const server = {
    close: vi.fn((callback: () => void) => {
      events.push("http: stop accepting");
      closeCallback = () => {
        events.push("http: last request ended");
        callback();
      };
      void request.promise.then(() => closeCallback?.());
      return server;
    }),
    closeIdleConnections: vi.fn(() => events.push("http: idle sockets closed")),
    closeAllConnections: vi.fn(() => events.push("http: every socket cut")),
  };

  const exit = vi.fn((code: number) => events.push(`exit ${code}`));

  const options: ShutdownOptions = {
    server: () => server as never,
    drain: [
      {
        name: "mail",
        run: async () => {
          events.push("mail: stop timer");
          await sweep.promise;
          events.push("mail: sweep finished");
        },
      },
    ],
    release: [
      { name: "mail-transport", run: () => void events.push("mail transport closed") },
      { name: "database", run: () => Promise.resolve(void events.push("database disconnected")) },
    ],
    timeoutMs: 5_000,
    exit,
    ...overrides,
  };

  return { events, request, sweep, server, exit, shutdown: createShutdown(options) };
}

describe("createShutdown", () => {
  it("lets requests and sweeps finish before closing what they use, then exits 0", async () => {
    const h = harness();
    const done = h.shutdown("SIGTERM");

    await Promise.resolve();
    expect(h.events).toEqual([
      "http: stop accepting",
      "http: idle sockets closed",
      "mail: stop timer",
    ]);

    h.sweep.resolve();
    h.request.resolve();
    await done;

    expect(h.events).toEqual([
      "http: stop accepting",
      "http: idle sockets closed",
      "mail: stop timer",
      "mail: sweep finished",
      "http: last request ended",
      "mail transport closed",
      "database disconnected",
      "exit 0",
    ]);
  });

  it("does not close the database while a request is still running", async () => {
    const h = harness();
    h.sweep.resolve();
    const done = h.shutdown("SIGINT");

    await new Promise((r) => setTimeout(r, 20));
    expect(h.events).not.toContain("database disconnected");

    h.request.resolve();
    await done;
    expect(h.events.at(-2)).toBe("database disconnected");
  });

  it("carries on closing the rest when one part fails, and exits 1", async () => {
    const h = harness({
      release: [
        { name: "mail-transport", run: () => { throw new Error("already closed"); } },
        { name: "database", run: () => { /* closes */ } },
      ],
    });
    h.sweep.resolve();
    h.request.resolve();

    await h.shutdown("SIGTERM");

    expect(h.exit.mock.calls).toEqual([[1]]);
  });

  it("gives up after the timeout, cuts every socket, and exits 1", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ timeoutMs: 1_000 });
      void h.shutdown("SIGTERM");

      await vi.advanceTimersByTimeAsync(1_000);

      expect(h.events.slice(-2)).toEqual(["http: every socket cut", "exit 1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exits at once on a second signal", async () => {
    const h = harness();
    void h.shutdown("SIGTERM");

    await h.shutdown("SIGINT");

    expect(h.exit.mock.calls).toEqual([[1]]);
  });

  it("stops cleanly before the server was ever listening", async () => {
    const h = harness({ server: () => null });
    h.sweep.resolve();

    await h.shutdown("SIGTERM");

    expect(h.events).toEqual([
      "mail: stop timer",
      "mail: sweep finished",
      "mail transport closed",
      "database disconnected",
      "exit 0",
    ]);
  });
});
