/**
 * Whether the background work is still happening.
 *
 * Three sweeps run behind this API - the mail outbox, the audit seal and the
 * deadline chase - and until now the only sign that one had stopped was a line
 * on stdout that nobody reads. A mail queue that has quietly stalled looks
 * exactly like a quiet week; an audit seal that has stopped leaves records
 * unchained with nothing saying so.
 *
 * Each sweep reports here when it finishes a pass. `/api/health` turns that
 * into `ok` or `stalled` per job, so an external monitor can alert on the
 * status alone without a token and without being told anything about the
 * memos inside.
 *
 * Deliberately in memory. A restart resets it, which is correct: a process
 * that has just started has not missed a sweep, and a monitor watching a
 * process that keeps restarting has the restart to look at.
 */

export type JobName = "mail" | "ledger" | "deadlines";

export type JobHealth = "ok" | "stalled" | "failing" | "off";

type Beat = {
  /** When a pass last finished, successfully or not. */
  at: number;
  /** How often it is meant to run. */
  everyMs: number;
  /** Consecutive failures. One is a blip; several is a fault. */
  failures: number;
  ok: boolean;
};

const beats = new Map<JobName, Beat>();

/**
 * How late a sweep has to be before it is called stalled.
 *
 * Three intervals rather than one: a pass that overruns its own interval is
 * ordinary under load, and a monitor that pages for it will be muted within
 * the week. A floor of a minute keeps a five-second interval from alerting
 * on one slow query.
 */
function tolerance(everyMs: number): number {
  return Math.max(60_000, everyMs * 3);
}

/** Called by a sweeper when it starts, so silence can be told from absence. */
export function registerJob(job: JobName, everyMs: number): void {
  beats.set(job, { at: Date.now(), everyMs, failures: 0, ok: true });
}

/** Called at the end of every pass. */
export function reportJob(job: JobName, ok: boolean): void {
  const beat = beats.get(job);
  if (!beat) return;

  beat.at = Date.now();
  beat.ok = ok;
  beat.failures = ok ? 0 : beat.failures + 1;
}

/**
 * What each job is doing, as one word each.
 *
 * `off` is not a fault: a deployment with no mail server configured is not
 * failing to send mail, and reporting it as a problem is how a monitor gets
 * ignored.
 */
export function jobHealth(now: number = Date.now()): Record<JobName, JobHealth> {
  const answer = {} as Record<JobName, JobHealth>;

  for (const job of ["mail", "ledger", "deadlines"] as const) {
    const beat = beats.get(job);

    if (!beat) {
      answer[job] = "off";
      continue;
    }

    if (beat.failures >= 3) {
      answer[job] = "failing";
      continue;
    }

    answer[job] = now - beat.at > tolerance(beat.everyMs) ? "stalled" : "ok";
  }

  return answer;
}

/** True when nothing needs anybody's attention. */
export function jobsHealthy(now: number = Date.now()): boolean {
  return Object.values(jobHealth(now)).every(
    (state) => state === "ok" || state === "off"
  );
}

/** Test seam. Nothing in the application calls this. */
export function resetJobs(): void {
  beats.clear();
}
