import { emailService } from "../services/email.service";
import { logger } from "./logger";
import { registerJob, reportJob } from "./heartbeat";
import { mailSettings, isMailConfigured } from "./mailer";

/**
 * The sweep that empties the outbox.
 *
 * Started by `index.ts`, never by `app.ts`: the route tests build the app and
 * bind an ephemeral port, and a timer started there would go on trying to
 * deliver mail after the test that created it had finished.
 *
 * One interval, one batch at a time. There is no queue server here and there
 * does not need to be one - the work is a handful of rows a minute, and the
 * outbox itself is what makes an unreachable mail server a delayed notice
 * rather than a lost one.
 */

const DEFAULT_INTERVAL_SECONDS = 60;

let timer: NodeJS.Timeout | null = null;
let sweeping = false;
/**
 * The pass under way, if there is one, so that stopping can wait for it. A
 * sweep cut off by the process exiting has claimed rows it never finishes -
 * a delivery half-written, picked up again only on the next start.
 */
let inFlight: Promise<void> | null = null;

function tick(): Promise<void> {
  inFlight ??= sweep().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function intervalMs(): number {
  const configured = Number(process.env.MAIL_SWEEP_SECONDS?.trim());
  const seconds =
    Number.isFinite(configured) && configured >= 5
      ? configured
      : DEFAULT_INTERVAL_SECONDS;

  return seconds * 1000;
}

async function sweep(): Promise<void> {
  // A slow mail server must not stack sweeps on top of each other; the next
  // tick simply does nothing while one is in flight.
  if (sweeping) return;

  sweeping = true;
  try {
    const { sent, failed } = await emailService.dispatchPending();

    if (sent > 0 || failed > 0) {
      logger.info("mail.sweep", { sent, failed });
    }

    reportJob("mail", true);
  } catch (error) {
    reportJob("mail", false);
    // The sweep must never take the process with it - the API is still
    // serving approvals, and mail is the least important thing it does.
    logger.error("mail.sweep.failed", { err: error });
  } finally {
    sweeping = false;
  }
}

export function startMailQueue(): void {
  if (timer) return;

  if (!isMailConfigured()) {
    // Said once, plainly. Notices are still queued and still visible in the
    // application; nothing is delivered, and nobody should have to discover
    // that from an approver who says they were never told.
    logger.warn("mail.not_configured", {
      note: "SMTP_HOST or MAIL_FROM is not set: notices are queued and visible in the application, but no email is sent.",
    });
    return;
  }

  /*
   * The one combination that produces perfectly delivered, useless mail.
   *
   * Every notice carries a link to the memo, built from APP_URL, which falls
   * back to the development UI. So a deployment that configures SMTP and
   * forgets APP_URL sends every approver in the organisation a link to
   * localhost - and nothing else in the product would ever say so, because
   * the mail was accepted and the queue reads clean.
   */
  const settings = mailSettings();
  if (settings.appUrlIsDefault) {
    logger.warn("mail.app_url_missing", {
      appUrl: settings.appUrl,
      note: "APP_URL is not set, so links in every notice point at the development UI. Set it to the address people actually use.",
    });
  }

  registerJob("mail", intervalMs());

  timer = setInterval(() => void tick(), intervalMs());
  // Not a reason to keep the process alive on its own.
  timer.unref?.();

  logger.info("mail.started", {
    everySeconds: intervalMs() / 1000,
    appUrl: settings.appUrl,
  });

  // One immediately, so a restart after an outage does not wait a full
  // interval before delivering what is already queued.
  void tick();
}

/** Stops the timer, then waits for a pass already under way to finish. */
export async function stopMailQueue(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await inFlight;
}
