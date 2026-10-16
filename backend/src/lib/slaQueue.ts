import { slaService } from "../services/sla.service";
import { logger } from "./logger";
import { registerJob, reportJob } from "./heartbeat";
import { defaultSlaDays } from "./sla";

/**
 * The sweep that chases a memo nobody has acted on.
 *
 * Started by `index.ts`, never by `app.ts` - the route tests build the app and
 * must not inherit a timer that goes on writing notices after them.
 *
 * Fifteen minutes by default, which is far more often than it needs to be:
 * deadlines are whole days, so any interval under a few hours produces the
 * same notices at nearly the same time. It is short because the cost of a pass
 * with nothing to do is one indexed query, and because a deployment that
 * restarts at nine every morning should not wait until noon to chase.
 */

const DEFAULT_INTERVAL_MINUTES = 15;

let timer: NodeJS.Timeout | null = null;
let sweeping = false;
/**
 * The pass under way, if there is one, so that stopping can wait for it. A
 * sweep cut off by the process exiting has claimed rows it never finishes -
 * a reminder half-written, picked up again only on the next start.
 */
let inFlight: Promise<void> | null = null;

function tick(): Promise<void> {
  inFlight ??= sweep().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function intervalMs(): number {
  const configured = Number(process.env.SLA_SWEEP_MINUTES?.trim());
  const minutes =
    Number.isFinite(configured) && configured >= 1
      ? configured
      : DEFAULT_INTERVAL_MINUTES;

  return minutes * 60 * 1000;
}

async function sweep(): Promise<void> {
  if (sweeping) return;

  sweeping = true;
  try {
    const { chased } = await slaService.chaseOverdue();
    // Then what was chased and is still sitting there, two working days on.
    const { escalated } = await slaService.escalateOverdue();

    if (chased > 0 || escalated > 0) {
      logger.info("deadlines.sweep", { chased, escalated });
    }

    reportJob("deadlines", true);
  } catch (error) {
    reportJob("deadlines", false);
    // Never take the process down. An un-chased memo is still visible in
    // everyone's queue; a crashed API is an approval nobody can give.
    logger.error("deadlines.sweep.failed", { err: error });
  } finally {
    sweeping = false;
  }
}

export function startSlaSweeper(): void {
  if (timer) return;

  // Nothing to sweep for unless somebody has set a deadline somewhere. A
  // deployment with no default may still have chains that name their own, so
  // this only reports what it is doing rather than refusing to start.
  const fallback = defaultSlaDays();
  logger.info("deadlines.started", {
    defaultWorkingDays: fallback,
    everySeconds: intervalMs() / 1000,
    note:
      fallback === null
        ? "No SLA_DEFAULT_DAYS set; only steps that name their own deadline are chased."
        : undefined,
  });

  registerJob("deadlines", intervalMs());

  timer = setInterval(() => void tick(), intervalMs());
  timer.unref?.();

  void tick();
}

/** Stops the timer, then waits for a pass already under way to finish. */
export async function stopSlaSweeper(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await inFlight;
}
