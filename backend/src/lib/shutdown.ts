import type { Server } from "node:http";
import { logger } from "./logger";

/**
 * Stopping the API without cutting anything off halfway.
 *
 * The old handler cleared the job timers and disconnected the database, then
 * exited - while the HTTP server was still accepting requests and while a
 * sweep could be halfway through a batch. A signature arriving in that second
 * got a dropped connection, and a mail sweep that had claimed rows left them
 * claimed until the next start. It also answered only SIGTERM, and PM2 and
 * NSSM - two of the four process managers DEPLOY.md names - stop a process
 * with Ctrl+C, which Node sees as SIGINT, so on those nothing ran at all.
 *
 * In order: stop taking requests and let the ones in flight finish, while the
 * job queues finish any pass under way; then close mail and the database,
 * which those were still using; then exit. Bounded, because a supervisor's
 * patience is: past `timeoutMs` the process exits anyway, with a log line
 * saying so, rather than being killed without one.
 */

export type ShutdownStep = { name: string; run: () => Promise<void> | void };

export type ShutdownOptions = {
  /** Null until `listen` has returned one. */
  server: () => Pick<Server, "close" | "closeIdleConnections" | "closeAllConnections"> | null;
  /** Run alongside closing the server: the job queues. */
  drain: ShutdownStep[];
  /** Run after both, in order: what the requests and the queues were using. */
  release: ShutdownStep[];
  timeoutMs: number;
  exit: (code: number) => void;
};

/** Below Docker's 10 s stop grace; see DEPLOY.md for PM2, NSSM and systemd. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 9_000;

/** SIGBREAK is Ctrl+Break on Windows. */
export const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGBREAK"] as const;

async function attempt(step: ShutdownStep): Promise<boolean> {
  try {
    await step.run();
    return true;
  } catch (error) {
    // One part failing to close is no reason to leave the rest open.
    logger.error("server.stop.step_failed", { step: step.name, err: error });
    return false;
  }
}

function closeServer(options: ShutdownOptions): Promise<void> {
  const server = options.server();
  if (!server) return Promise.resolve();

  return new Promise((resolve) => {
    // Stops accepting; the callback fires once every open request has ended.
    server.close(() => resolve());
    // Keep-alive sockets with nothing in flight would otherwise hold `close`
    // open until the browser drops them, which can be minutes.
    server.closeIdleConnections();
  });
}

/**
 * Returns the signal handler. The first signal starts an orderly stop; a
 * second one, from somebody who is not prepared to wait, exits at once.
 */
export function createShutdown(options: ShutdownOptions): (signal: string) => Promise<void> {
  let stopping = false;

  return async (signal: string) => {
    if (stopping) {
      logger.warn("server.stop.forced", { signal });
      options.exit(1);
      return;
    }
    stopping = true;

    const startedAt = Date.now();
    logger.info("server.stopping", { signal });

    const deadline = setTimeout(() => {
      logger.error("server.stop.timeout", {
        timeoutMs: options.timeoutMs,
        note: "Something was still running when the time was up; exiting anyway.",
      });
      options.server()?.closeAllConnections();
      options.exit(1);
    }, options.timeoutMs);
    deadline.unref?.();

    const results = await Promise.all([
      attempt({ name: "http", run: () => closeServer(options) }),
      ...options.drain.map(attempt),
    ]);
    for (const step of options.release) {
      results.push(await attempt(step));
    }

    clearTimeout(deadline);
    const clean = results.every(Boolean);
    logger.info("server.stopped", { signal, clean, tookMs: Date.now() - startedAt });
    options.exit(clean ? 0 : 1);
  };
}
