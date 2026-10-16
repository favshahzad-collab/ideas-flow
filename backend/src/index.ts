import { configuredSeal } from "./lib/pdfSeal";
import app from "./app";
import { logger } from "./lib/logger";
import { env } from "./lib/env";
import { startLedgerSealer, stopLedgerSealer } from "./lib/ledgerQueue";
import { startSlaSweeper, stopSlaSweeper } from "./lib/slaQueue";
import { workflowSettingsService } from "./services/workflowSettings.service";
import { calendarService } from "./services/calendar.service";
import { startMailQueue, stopMailQueue } from "./lib/mailQueue";
import { closeMailTransport, mailSettings } from "./lib/mailer";
import { mailSettingsService } from "./services/mailSettings.service";
import { prisma } from "./prisma";
import type { Server } from "node:http";
import { assertAppUrlConfigured, assertEnvironment } from "./lib/config";
import {
  createShutdown,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  SHUTDOWN_SIGNALS,
} from "./lib/shutdown";

/** Kept so that stopping can close it. It used to be thrown away. */
let server: Server | null = null;

/**
 * Starting the server, and stopping it. The API itself is in `app.ts` - the
 * split is what lets the route tests bind an ephemeral port instead of this
 * one.
 */
async function main() {
  // Before anything else: a bad value should stop the API here, named, not
  // surface as behaviour weeks later. See `lib/config.ts`.
  assertEnvironment();

  // Said once, at start-up: whether approved memos will carry the seal.
  const seal = configuredSeal();
  if (seal) logger.info("seal.ready", { signer: seal.signerName });

  await prisma.$connect();
  logger.info("database.connected");

  /*
   * Before anything can send. Mail configured from the administration screens
   * lives in a table, and the mailer reads it from a module variable so that
   * `sendMail` and `appUrl` can stay synchronous - so somebody has to put it
   * there, and the only safe moment is before the queue starts looking for
   * work. Started after `listen` it would send the first sweep through the
   * environment's configuration, or through none.
   */
  await mailSettingsService.applyStoredMailSettings();

  /*
   * And the workflow policy, for the same reason: `slaDaysFor` is called on
   * every queue row and cannot read a database, so the row is pushed into
   * `lib/workflowPolicy` before anything can ask. Started after the sweeper
   * and the first sweep would chase people by the environment's policy.
   */
  await workflowSettingsService.applyStoredWorkflowPolicy();

  // And the office calendar - time zone and holidays - for the same reason.
  await calendarService.applyStoredCalendar();

  // Only now can this be asked: APP_URL may be stored rather than set.
  assertAppUrlConfigured(mailSettings().appUrlIsDefault, env.NODE_ENV);

  const started = () => {
    logger.info("server.started", {
      port: env.PORT,
      host: env.HOST ?? "all interfaces",
      environment: env.NODE_ENV,
      logLevel: logger.level,
    });
  };

  /*
   * On one address when HOST says so. With the web server and the API on the
   * same machine, 127.0.0.1 keeps the API off the network entirely: nobody
   * can reach it except through the web server, so nobody can hand it a
   * made-up X-Forwarded-For and pass for somebody else.
   */
  server = env.HOST
    ? app.listen(Number(env.PORT), env.HOST, started)
    : app.listen(env.PORT, started);

  // Started here rather than in `app.ts`: the route tests build the app and
  // must not inherit a timer that goes on delivering mail after them.
  startMailQueue();
  startLedgerSealer();
  startSlaSweeper();
}

main().catch((error) => {
  logger.error("server.start.failed", { err: error });
  process.exit(1);
});

/*
 * The two ways this process can die without saying anything useful.
 *
 * Node prints an uncaught exception and exits; an unhandled rejection does
 * the same from Node 15 on. Both arrived as unstructured text, which meant
 * the one event most worth finding in a log was the one event not in the
 * log's format. These do not attempt to keep the process alive - after an
 * uncaught exception its state is unknown, and carrying on with a half-built
 * approval is worse than stopping - they make sure it leaves a record on the
 * way out, and let the supervisor restart it.
 */
process.on("uncaughtException", (error) => {
  logger.error("process.uncaught_exception", { err: error });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("process.unhandled_rejection", {
    err: reason instanceof Error ? reason : new Error(String(reason)),
  });
  process.exit(1);
});

/**
 * Stopping: see `lib/shutdown.ts`. SIGINT and SIGBREAK as well as SIGTERM,
 * because PM2 and NSSM stop a process with Ctrl+C, and on Windows that is the
 * only signal there is.
 *
 * Node never awaits a signal listener, so the handler's promise is held here
 * and anything it throws is logged rather than left unhandled - which would
 * hit the unhandledRejection handler above and exit 1 without the database
 * ever being closed.
 */
const shutdown = createShutdown({
  server: () => server,
  drain: [
    { name: "mail", run: stopMailQueue },
    { name: "ledger", run: stopLedgerSealer },
    { name: "deadlines", run: stopSlaSweeper },
  ],
  release: [
    { name: "mail-transport", run: closeMailTransport },
    { name: "database", run: () => prisma.$disconnect() },
  ],
  timeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
  exit: (code) => process.exit(code),
});

for (const signal of SHUTDOWN_SIGNALS) {
  process.on(signal, () => {
    shutdown(signal).catch((error: unknown) => {
      logger.error("server.stop.failed", { err: error });
      process.exit(1);
    });
  });
}
