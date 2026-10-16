export function formatDisplayDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function formatDocumentId(id: string): string {
  return id.slice(0, 8).toUpperCase()
}

/**
 * What to call a memo on screen.
 *
 * The reference is what somebody writes on a file cover and quotes in a
 * reply, so it wins wherever it exists. The eight characters of the uuid are
 * a fallback for memos submitted before references were issued - they are not
 * unique by construction and cannot be pasted back into search, which is why
 * they are second choice rather than the label.
 */
export function formatMemoReference(
  referenceNumber: string | null | undefined,
  id: string,
): string {
  return referenceNumber?.trim() || `#${formatDocumentId(id)}`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How long something has been waiting, as a duration a person can act on.
 * Anything under a day used to read "Today", which is a date, not a duration —
 * it made a two-hour-old document indistinguishable from a twenty-hour-old one.
 */
export function formatWaitingDuration(isoDate: string, now: number = Date.now()): string {
  const diffMs = now - new Date(isoDate).getTime()

  if (diffMs < MINUTE) return 'Just now'
  if (diffMs < HOUR) {
    const minutes = Math.floor(diffMs / MINUTE)
    return `${minutes} minute${minutes === 1 ? '' : 's'}`
  }
  if (diffMs < DAY) {
    const hours = Math.floor(diffMs / HOUR)
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  const days = Math.floor(diffMs / DAY)
  if (days < 14) return `${days} day${days === 1 ? '' : 's'}`

  const weeks = Math.floor(days / 7)
  if (days < 60) return `${weeks} weeks`
  return `${Math.floor(days / 30)} months`
}

const STILL_MOVING = new Set(['pending_review', 'pending_approval', 'revision_requested'])

/**
 * A row's age in words: "Waiting 3 days" while the memo is still moving,
 * "Updated 3 days ago" once it has finished. It used to read "3 days in
 * state", which is how the code thinks about it, not how anybody talks.
 */
export function describeAge(status: string, isoDate: string, now: number = Date.now()): string {
  const duration = formatWaitingDuration(isoDate, now)
  if (STILL_MOVING.has(status)) {
    return duration === 'Just now' ? 'Just arrived' : `Waiting ${duration}`
  }
  return duration === 'Just now' ? 'Updated just now' : `Updated ${duration} ago`
}

/**
 * How much attention the age deserves. Thresholds are derived from age alone —
 * the schema carries no due date or SLA, and inventing one here would be
 * pretending to a policy the organisation has not set.
 */
export type WaitingSeverity = 'fresh' | 'ageing' | 'overdue' | 'critical'

export const WAITING_THRESHOLDS = {
  ageing: 3 * DAY,
  overdue: 7 * DAY,
  critical: 30 * DAY,
} as const

export function getWaitingSeverity(
  isoDate: string,
  now: number = Date.now(),
): WaitingSeverity {
  const diffMs = now - new Date(isoDate).getTime()
  if (diffMs >= WAITING_THRESHOLDS.critical) return 'critical'
  if (diffMs >= WAITING_THRESHOLDS.overdue) return 'overdue'
  if (diffMs >= WAITING_THRESHOLDS.ageing) return 'ageing'
  return 'fresh'
}

/**
 * The same duration as `formatWaitingDuration`, compressed to fit a keycap:
 * `45m`, `15h`, `4d`, `3w`, `2mo`. Used where the row has no room for a
 * sentence — never as the only statement of the value, because the letter
 * suffixes are terse enough to be misread on their own.
 */
export function formatWaitingShort(isoDate: string, now: number = Date.now()): string {
  const diffMs = now - new Date(isoDate).getTime()

  if (diffMs < MINUTE) return 'now'
  if (diffMs < HOUR) return `${Math.floor(diffMs / MINUTE)}m`
  if (diffMs < DAY) return `${Math.floor(diffMs / HOUR)}h`

  const days = Math.floor(diffMs / DAY)
  if (days < 14) return `${days}d`
  if (days < 60) return `${Math.floor(days / 7)}w`
  return `${Math.floor(days / 30)}mo`
}

/**
 * How far along the age is towards "overdue", as 0-100.
 *
 * Lives here beside the thresholds it measures against, and takes `now` the
 * same way its two neighbours do — a component that called `Date.now()` in
 * its own body would be doing impure work during render.
 */
export function getWaitingPercent(isoDate: string, now: number = Date.now()): number {
  const elapsed = now - new Date(isoDate).getTime()
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0
  return Math.min(100, (elapsed / WAITING_THRESHOLDS.overdue) * 100)
}

export function formatRelativeTime(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime()
  const minutes = Math.floor(diffMs / (1000 * 60))
  const hours = Math.floor(diffMs / (1000 * 60 * 60))
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days === 1) return '1d ago'
  return `${days}d ago`
}

/**
 * A real deadline, when one has been set.
 *
 * These three are the counterpart to the `getWaiting*` trio above and exist
 * because the two answer different questions. Age is how long a memo has sat
 * and is always true; a deadline is a commitment somebody made, and is only
 * true where they made one. Everything here therefore starts from a `dueAt`
 * that the API may perfectly well answer as null — the caller shows age
 * instead, rather than a countdown to a date nobody agreed.
 *
 * The thresholds mirror `lib/sla.ts` on the server, deliberately: a row that
 * reads "due tomorrow" while the sweep that chases it disagrees is worse than
 * either alone.
 */
export type DueSeverity = 'ahead' | 'soon' | 'overdue'

function calendarDaysBetween(from: number, to: number): number {
  const startOfDay = (ms: number) => {
    const date = new Date(ms)
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  }

  return Math.round((startOfDay(to) - startOfDay(from)) / DAY)
}

export function getDueSeverity(isoDue: string, now: number = Date.now()): DueSeverity {
  const due = new Date(isoDue).getTime()
  if (!Number.isFinite(due)) return 'ahead'
  if (now > due) return 'overdue'

  return calendarDaysBetween(now, due) <= 1 ? 'soon' : 'ahead'
}

/**
 * The countdown as it fits in a table cell: `4d left`, `due today`, `2d over`.
 *
 * Words rather than a bare number, because a column that shows `2` next to
 * another column showing `2` is two numbers nobody can tell apart at a glance.
 */
export function formatDueShort(isoDue: string, now: number = Date.now()): string {
  const due = new Date(isoDue).getTime()
  if (!Number.isFinite(due)) return '—'

  const days = calendarDaysBetween(now, due)

  if (days < 0) return `${Math.abs(days)}d over`
  if (days === 0) return now > due ? 'overdue' : 'due today'
  if (days === 1) return 'due tomorrow'
  return `${days}d left`
}

/**
 * How much of the allowance is gone, as 0-100, given when the step arrived.
 *
 * Clamped at 100 rather than running past it: a bar that overflows its track
 * says nothing that the "3d over" beside it does not already say.
 */
export function getDuePercent(
  isoHeldSince: string,
  isoDue: string,
  now: number = Date.now(),
): number {
  const start = new Date(isoHeldSince).getTime()
  const due = new Date(isoDue).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(due) || due <= start) return 100

  return Math.max(0, Math.min(100, ((now - start) / (due - start)) * 100))
}

/**
 * Today, spelled the way a `<input type="date">` wants it.
 *
 * Built from the local parts rather than `toISOString().slice(0, 10)`, which
 * answers in UTC: for somebody in Karachi at nine in the morning that is
 * still yesterday, and the memo they are writing today would be dated the
 * day before.
 */
export function todayAsDateInput(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * A stored memo date as the date input wants it.
 *
 * The API sends a date-only column as a full ISO timestamp at midnight UTC,
 * so the first ten characters are the date and nothing has to be parsed.
 * Parsing it into a `Date` and formatting it back would apply the viewer's
 * timezone and could shift the memo a day.
 */
export function memoDateInputValue(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : ''
}
