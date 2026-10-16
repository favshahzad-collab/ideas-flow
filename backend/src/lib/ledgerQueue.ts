import { ledgerService } from "../services/ledger.service";
import { logger } from "./logger";
import { registerJob, reportJob } from "./heartbeat";

/**
 * The sweep that seals the audit trail.
 *
 * Started by `index.ts`, never by `app.ts`, for the same reason the mail sweep
 * is: the route tests build the app and bind an ephemeral port, and a timer
 * started there would go on writing to the database after the test that made
 * it had finished.
 *
 * Frequent and small. The interval is the window in which a record could be
 * removed without leaving a trace, so shorter is better - but each pass takes
 * a lock that every other sealer waits on, so it is not free either. Thirty
 * seconds is the compromise; `LEDGER_SEAL_SECONDS` moves it.
 */

const DEFAULT_INTERVAL_SECONDS = 30;

let timer: NodeJS.Timeout | null = null;
let sealing = false;
/**
 * The pass under way, if there is one, so that stopping can wait for it. A
 * sweep cut off by the process exiting has claimed rows it never finishes -
 * a seal half-written, picked up again only on the next start.
 */
let inFlight: Promise<void> | null = null;

function tick(): Promise<void> {
  inFlight ??= sweep().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function intervalMs(): number {
  const configured = Number(process.env.LEDGER_SEAL_SECONDS?.trim());
  const seconds =
    Number.isFinite(configured) && configured >= 5
      ? configured
      : DEFAULT_INTERVAL_SECONDS;

  return seconds * 1000;
}

async function sweep(): Promise<void> {
  // A slow pass must not stack on the next tick: the second sealer would only
  // sit on the advisory lock waiting for the first, holding a connection.
  if (sealing) return;

  sealing = true;
  try {
    const { sealed } = await ledgerService.seal();

    if (sealed > 0) {
      logger.info("ledger.sweep", { sealed });
    }

    reportJob("ledger", true);
  } catch (error) {
    reportJob("ledger", false);
    // Never take the process with it. An unsealed record is a record that has
    // still been written, and the next sweep will pick it up; a crashed API is
    // an approval nobody can give.
    logger.error("ledger.sweep.failed", { err: error });
  } finally {
    sealing = false;
  }
}

export function startLedgerSealer(): void {
  if (timer) return;

  registerJob("ledger", intervalMs());

  timer = setInterval(() => void tick(), intervalMs());
  // Not a reason to keep the process alive on its own.
  timer.unref?.();

  logger.info("ledger.started", { everySeconds: intervalMs() / 1000 });

  // One immediately, so a restart picks up whatever the last process wrote
  // and did not live long enough to seal - and so a deployment that has never
  // run this seals its existing trail on first boot rather than reporting
  // every historical record as unsealed.
  void tick();
}

/** Stops the timer, then waits for a pass already under way to finish. */
export async function stopLedgerSealer(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await inFlight;
}
