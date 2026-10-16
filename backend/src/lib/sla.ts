/**
 * Deadlines on an approval step.
 *
 * The redesign asked for an SLA countdown and it stayed switched off for a
 * long time, for a good reason: there was no due date anywhere in the product,
 * so a countdown would have been a number invented on the screen - and an
 * invented deadline on an approval queue is worse than no column, because
 * people reorder their day around it.
 *
 * The answer is the same one the step-skip took: a deadline is a policy an
 * organisation owns, not a constant this code can pick. Nothing here has a
 * deadline unless somebody sets one, either on the step (`slaDays` on a chain
 * step or a template's approval node) or as `SLA_DEFAULT_DAYS` for the whole
 * deployment. Set neither and every function here answers "no deadline", the
 * queue shows the age it always showed, and nothing is chased.
 *
 * Everything is pure so the arithmetic can be argued with in a test rather
 * than discovered on a Monday morning.
 */

import { storedWorkflowPolicy } from "./workflowPolicy";
import { instantOf, officeCalendar, wallClock } from "./officeCalendar";

/** A deadline in the office sense: whole working days, ending at end of day. */
const WORKING_DAYS = [1, 2, 3, 4, 5];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * What the environment alone says, ignoring any stored policy.
 *
 * Exported so the settings screen can show an administrator what handing the
 * policy back to the environment would actually give them, rather than
 * asking them to find out by doing it.
 */
export function environmentSlaDays(): number | null {
  const raw = process.env.SLA_DEFAULT_DAYS?.trim();
  if (!raw) return null;

  const days = Number(raw);
  return Number.isInteger(days) && days > 0 ? days : null;
}

/**
 * The deployment-wide default, for chains that name no deadline of their own.
 *
 * Read at the point of use rather than frozen at import, so an administrator
 * can change it without a restart and the tests can prove every answer in one
 * process - the same reason `stepSkipAllowed` is a function.
 *
 * The policy row wins over the environment, and wins when its deadline is
 * null too: somebody who cleared the deadline on the screen has said "no
 * deadline", and an `SLA_DEFAULT_DAYS` left in a file from last year must not
 * quietly reinstate one. With no row at all the environment answers, which is
 * what a deployment that has always managed it that way keeps.
 */
export function defaultSlaDays(): number | null {
  const policy = storedWorkflowPolicy();

  if (policy) {
    const days = policy.slaDefaultDays;
    // Guarded rather than trusted: the column is a plain nullable integer, and
    // a zero or a negative in it would otherwise become a deadline already
    // past for every memo in the building.
    return typeof days === "number" && Number.isInteger(days) && days > 0
      ? days
      : null;
  }

  return environmentSlaDays();
}

const wholeDays = (days: number | null | undefined): number | null =>
  typeof days === "number" && Number.isInteger(days) && days > 0 ? days : null;

/**
 * What a step's deadline is, given what the step says and what the default is.
 *
 * `runDefault` is the default the memo's approval cycle was started with
 * (`lib/runPolicy`): a memo keeps the rules it began under, so a deadline
 * changed on the policy screen does not make memos already in flight overdue
 * overnight. Left out, the current default answers - which is what a cycle
 * started before defaults were recorded on it still gets.
 */
export function slaDaysFor(
  stepSlaDays: number | null | undefined,
  runDefault?: number | null
): number | null {
  const own = wholeDays(stepSlaDays);
  if (own !== null) return own;

  return runDefault === undefined ? defaultSlaDays() : wholeDays(runDefault);
}

/**
 * A weekday that is not a public holiday. `date` is a wall-clock reading in
 * the office's zone (see `officeCalendar.wallClock`), so its UTC fields are
 * the office's date.
 */
function isWorkingDay(date: Date): boolean {
  return (
    WORKING_DAYS.includes(date.getUTCDay()) &&
    !officeCalendar().holidays.has(date.toISOString().slice(0, 10))
  );
}

/** How many working days after the deadline a late step is escalated. */
export const ESCALATE_AFTER_WORKING_DAYS = 2;

/**
 * Add whole working days, counting from the day after the step arrived.
 *
 * A memo that lands at four on Friday afternoon with two days to run is due at
 * the end of Tuesday, not at four on Sunday. Saturdays, Sundays and the
 * public holidays an administrator keeps on the Workflow policy screen are
 * skipped - nothing here can know Eid, so somebody tells it.
 *
 * Counted in the office's time zone: the answer is a wall-clock reading
 * there (its UTC fields are the office's date), which `endOfDay` turns back
 * into a real instant. With the zone left at UTC the two are the same thing,
 * which is how it always worked.
 */
export function addWorkingDays(from: Date, days: number): Date {
  const result = wallClock(from, officeCalendar().timeZone);
  let remaining = Math.max(0, Math.trunc(days));

  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    if (isWorkingDay(result)) remaining -= 1;
  }

  // If the count lands on a weekend - which it can only do when days is 0 -
  // walk forward to the next working day rather than expiring on one.
  while (!isWorkingDay(result)) {
    result.setUTCDate(result.getUTCDate() + 1);
  }

  return result;
}

/**
 * The last instant of a day, so a deadline is never early.
 *
 * `date` is an office wall-clock reading, as `addWorkingDays` answers; the
 * result is the real instant midnight strikes in the office.
 */
export function endOfDay(date: Date): Date {
  const end = new Date(date.getTime());
  end.setUTCHours(23, 59, 59, 999);
  return instantOf(end, officeCalendar().timeZone);
}

/**
 * When this step is due, or null when nothing has set a deadline.
 *
 * Deadlines are whole working days ending at the last instant of the day in
 * the office's time zone.
 */
export function dueAtFor(
  stepStartedAt: Date,
  stepSlaDays: number | null | undefined,
  /** The default the cycle started with; see `slaDaysFor`. */
  runDefault?: number | null
): Date | null {
  const days = slaDaysFor(stepSlaDays, runDefault);
  if (days === null) return null;

  return endOfDay(addWorkingDays(stepStartedAt, days));
}

/**
 * When a late step is escalated: the end of the second working day after
 * its deadline. Null where there is no deadline.
 */
export function escalateAtFor(
  stepStartedAt: Date,
  stepSlaDays: number | null | undefined,
  runDefault?: number | null
): Date | null {
  const days = slaDaysFor(stepSlaDays, runDefault);
  if (days === null) return null;

  return endOfDay(addWorkingDays(stepStartedAt, days + ESCALATE_AFTER_WORKING_DAYS));
}

/**
 * How a deadline reads, which is not the same question as how far away it is.
 *
 * `none` no deadline is set · `ahead` more than a day to run ·
 * `soon` due today or tomorrow · `overdue` the day has passed.
 */
export type SlaStatus = "none" | "ahead" | "soon" | "overdue";

export function slaStatus(dueAt: Date | null, now: Date = new Date()): SlaStatus {
  if (!dueAt) return "none";
  if (now.getTime() > dueAt.getTime()) return "overdue";

  // Calendar days apart, not hours apart. Somebody looking at a queue at
  // eleven at night wants to know the memo is due tomorrow; measured in
  // elapsed hours that is twenty-five hours away and would read as "ahead",
  // which is a warning arriving after the evening it was useful.
  return calendarDaysBetween(now, dueAt) <= 1 ? "soon" : "ahead";
}

/** Whole days between two moments, counted as dates rather than durations. */
function calendarDaysBetween(from: Date, to: Date): number {
  const startOfDay = (date: Date) =>
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

  return Math.round((startOfDay(to) - startOfDay(from)) / MS_PER_DAY);
}

/** Whole days between now and the deadline; negative once it has passed. */
export function daysUntil(dueAt: Date, now: Date = new Date()): number {
  return Math.ceil((dueAt.getTime() - now.getTime()) / MS_PER_DAY);
}
