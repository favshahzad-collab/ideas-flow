import { describe, expect, it } from 'vitest'
import {
  WAITING_THRESHOLDS,
  describeAge,
  formatDisplayDate,
  formatDocumentId,
  formatRelativeTime,
  formatWaitingDuration,
  formatWaitingShort,
  formatDueShort,
  getDuePercent,
  getDueSeverity,
  getWaitingPercent,
  getWaitingSeverity,
} from './format'

/**
 * How long a document has been waiting, in five different shapes, all read off
 * the same timestamp. They have to agree with each other: a row that says
 * "8 days" beside a chip that says "1w" and a bar that reads as fresh is three
 * statements about one number, and at most one of them can be right.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const NOW = Date.UTC(2026, 8, 5, 12, 0, 0)
/** An ISO timestamp `ms` before NOW. */
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('formatWaitingDuration', () => {
  it.each([
    ['under a minute', 30_000, 'Just now'],
    ['exactly a minute', MINUTE, '1 minute'],
    ['minutes', 45 * MINUTE, '45 minutes'],
    ['exactly an hour', HOUR, '1 hour'],
    ['hours', 15 * HOUR, '15 hours'],
    ['just under a day', DAY - 1, '23 hours'],
    ['exactly a day', DAY, '1 day'],
    ['days', 4 * DAY, '4 days'],
    ['the last day before weeks', 13 * DAY, '13 days'],
    ['the first week reading', 14 * DAY, '2 weeks'],
    ['weeks', 40 * DAY, '5 weeks'],
    ['the last week reading', 59 * DAY, '8 weeks'],
    ['the first month reading', 60 * DAY, '2 months'],
    ['months', 200 * DAY, '6 months'],
  ])('reads %s as %s', (_label, elapsed, expected) => {
    expect(formatWaitingDuration(ago(elapsed), NOW)).toBe(expected)
  })

  it('says minute, not minutes, for one', () => {
    // The singular cases are the ones nobody notices until a screenshot.
    expect(formatWaitingDuration(ago(MINUTE), NOW)).toBe('1 minute')
    expect(formatWaitingDuration(ago(HOUR), NOW)).toBe('1 hour')
    expect(formatWaitingDuration(ago(DAY), NOW)).toBe('1 day')
  })

  it('does not read a future timestamp as an age', () => {
    // Clock skew between a server and a browser is ordinary; "-3 minutes" is
    // not something to put on a screen.
    expect(formatWaitingDuration(ago(-5 * MINUTE), NOW)).toBe('Just now')
  })
})

describe('formatWaitingShort', () => {
  it.each([
    [30_000, 'now'],
    [45 * MINUTE, '45m'],
    [15 * HOUR, '15h'],
    [4 * DAY, '4d'],
    [13 * DAY, '13d'],
    [14 * DAY, '2w'],
    [59 * DAY, '8w'],
    [60 * DAY, '2mo'],
  ])('compresses %ims to %s', (elapsed, expected) => {
    expect(formatWaitingShort(ago(elapsed), NOW)).toBe(expected)
  })

  it('switches unit at exactly the same points as the long form', () => {
    // The two are shown on the same row in some places. If they disagreed
    // about where a week starts, one of them would be lying.
    for (const elapsed of [
      MINUTE - 1,
      MINUTE,
      HOUR - 1,
      HOUR,
      DAY - 1,
      DAY,
      13 * DAY,
      14 * DAY,
      59 * DAY,
      60 * DAY,
    ]) {
      const long = formatWaitingDuration(ago(elapsed), NOW)
      const short = formatWaitingShort(ago(elapsed), NOW)

      const unit = (text: string) =>
        /minute|^\d+m$|^now$|Just now/.test(text)
          ? 'minutes'
          : /hour|^\d+h$/.test(text)
            ? 'hours'
            : /day|^\d+d$/.test(text)
              ? 'days'
              : /week|^\d+w$/.test(text)
                ? 'weeks'
                : 'months'

      expect(unit(short), `at ${elapsed}ms: "${long}" vs "${short}"`).toBe(
        unit(long),
      )
    }
  })
})

describe('getWaitingSeverity', () => {
  it.each([
    [0, 'fresh'],
    [WAITING_THRESHOLDS.ageing - 1, 'fresh'],
    [WAITING_THRESHOLDS.ageing, 'ageing'],
    [WAITING_THRESHOLDS.overdue - 1, 'ageing'],
    [WAITING_THRESHOLDS.overdue, 'overdue'],
    [WAITING_THRESHOLDS.critical - 1, 'overdue'],
    [WAITING_THRESHOLDS.critical, 'critical'],
    [365 * DAY, 'critical'],
  ])('calls %ims old %s', (elapsed, expected) => {
    expect(getWaitingSeverity(ago(elapsed), NOW)).toBe(expected)
  })

  it('reads a future timestamp as fresh', () => {
    expect(getWaitingSeverity(ago(-DAY), NOW)).toBe('fresh')
  })
})

describe('getWaitingPercent', () => {
  it('is zero at the moment of submission', () => {
    expect(getWaitingPercent(ago(0), NOW)).toBe(0)
  })

  it('measures against the overdue threshold, not the critical one', () => {
    expect(getWaitingPercent(ago(WAITING_THRESHOLDS.overdue / 2), NOW)).toBe(50)
    expect(getWaitingPercent(ago(WAITING_THRESHOLDS.overdue), NOW)).toBe(100)
  })

  it('stops at a hundred rather than overflowing the bar', () => {
    expect(getWaitingPercent(ago(365 * DAY), NOW)).toBe(100)
  })

  it('returns zero for a future date and for an unparseable one', () => {
    expect(getWaitingPercent(ago(-DAY), NOW)).toBe(0)
    expect(getWaitingPercent('not a date', NOW)).toBe(0)
  })

  it('agrees with the severity it sits beside', () => {
    // The bar and the chip are rendered together; a full bar next to "fresh"
    // is the kind of thing people stop trusting the whole screen over.
    expect(getWaitingPercent(ago(WAITING_THRESHOLDS.overdue), NOW)).toBe(100)
    expect(getWaitingSeverity(ago(WAITING_THRESHOLDS.overdue), NOW)).toBe(
      'overdue',
    )
  })
})

describe('formatRelativeTime', () => {
  it('reads recent timestamps as an age with a suffix', () => {
    const now = Date.now()
    const at = (ms: number) => new Date(now - ms).toISOString()

    expect(formatRelativeTime(at(30_000))).toBe('Just now')
    expect(formatRelativeTime(at(5 * MINUTE))).toBe('5m ago')
    expect(formatRelativeTime(at(3 * HOUR))).toBe('3h ago')
    expect(formatRelativeTime(at(DAY))).toBe('1d ago')
    expect(formatRelativeTime(at(9 * DAY))).toBe('9d ago')
  })
})

describe('formatDisplayDate', () => {
  it('writes a date a person reads rather than an ISO string', () => {
    // Built in local time so the assertion does not depend on the machine's
    // timezone - which is exactly the bug this format is prone to.
    const local = new Date(2026, 8, 5, 12, 0, 0).toISOString()

    expect(formatDisplayDate(local)).toBe('Sep 5, 2026')
  })

  it('does not roll a date over near midnight', () => {
    const justBeforeMidnight = new Date(2026, 8, 5, 23, 30, 0).toISOString()
    const justAfterMidnight = new Date(2026, 8, 6, 0, 30, 0).toISOString()

    expect(formatDisplayDate(justBeforeMidnight)).toBe('Sep 5, 2026')
    expect(formatDisplayDate(justAfterMidnight)).toBe('Sep 6, 2026')
  })
})

describe('formatDocumentId', () => {
  it('takes the first eight characters, upper-cased', () => {
    expect(formatDocumentId('3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c')).toBe(
      '3F2A9B1C',
    )
  })

  it('returns a short id unchanged rather than padding it', () => {
    expect(formatDocumentId('abc')).toBe('ABC')
    expect(formatDocumentId('')).toBe('')
  })
})

/**
 * The countdown, which is a different claim from the age above it.
 *
 * Age is always true. A deadline is only true where somebody set one, so
 * everything here starts from a date the API may perfectly well not have —
 * and the thresholds match `backend/src/lib/sla.ts` on purpose, because a row
 * reading "due tomorrow" while the sweep that chases it disagrees is worse
 * than either on its own.
 */
describe('getDueSeverity', () => {
  const NOW = new Date('2026-09-09T09:00:00Z').getTime()
  const due = (iso: string) => getDueSeverity(iso, NOW)

  it('is ahead while there is more than a day to run', () => {
    expect(due('2026-09-12T23:59:59.999Z')).toBe('ahead')
  })

  it('is soon on the day it is due', () => {
    expect(due('2026-09-09T23:59:59.999Z')).toBe('soon')
  })

  it('is soon the day before, not only on the day', () => {
    // A warning that first appears on the morning it is due is a warning
    // nobody has time to act on.
    expect(due('2026-09-10T23:59:59.999Z')).toBe('soon')
  })

  it('is overdue only once the day has actually passed', () => {
    expect(due('2026-09-09T09:00:01.000Z')).toBe('soon')
    expect(due('2026-09-09T08:59:59.000Z')).toBe('overdue')
  })

  it('does not crash on a date it cannot read', () => {
    expect(due('not a date')).toBe('ahead')
  })
})

describe('formatDueShort', () => {
  const NOW = new Date('2026-09-09T09:00:00Z').getTime()
  const text = (iso: string) => formatDueShort(iso, NOW)

  it('counts the days left', () => {
    expect(text('2026-09-12T23:59:59.999Z')).toBe('3d left')
  })

  it('names today and tomorrow rather than counting them', () => {
    // "0d left" is read as "none left", which is the opposite of what it says.
    expect(text('2026-09-09T23:59:59.999Z')).toBe('due today')
    expect(text('2026-09-10T23:59:59.999Z')).toBe('due tomorrow')
  })

  it('counts how far past it has gone', () => {
    expect(text('2026-09-06T23:59:59.999Z')).toBe('3d over')
  })

  it('says overdue rather than "0d over" for a deadline that passed today', () => {
    expect(text('2026-09-09T08:00:00.000Z')).toBe('overdue')
  })

  it('shows a dash rather than NaN for a date it cannot read', () => {
    expect(text('not a date')).toBe('—')
  })
})

describe('getDuePercent', () => {
  const NOW = new Date('2026-09-09T12:00:00Z').getTime()

  it('is halfway through a two-day allowance after one day', () => {
    expect(
      Math.round(getDuePercent('2026-09-08T12:00:00Z', '2026-09-10T12:00:00Z', NOW)),
    ).toBe(50)
  })

  it('never runs past the end of its track', () => {
    // The "3d over" beside it already says how far past; a bar overflowing
    // its container says nothing and breaks the row.
    expect(getDuePercent('2026-09-01T12:00:00Z', '2026-09-02T12:00:00Z', NOW)).toBe(100)
  })

  it('never goes negative', () => {
    expect(getDuePercent('2026-09-20T12:00:00Z', '2026-09-25T12:00:00Z', NOW)).toBe(0)
  })

  it('is full rather than infinite when the dates make no sense', () => {
    expect(getDuePercent('2026-09-10T12:00:00Z', '2026-09-09T12:00:00Z', NOW)).toBe(100)
  })
})

describe('describeAge', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')
  const threeDaysAgo = '2026-10-06T12:00:00Z'

  it('says how long a memo still moving has been waiting', () => {
    expect(describeAge('pending_review', threeDaysAgo, now)).toBe('Waiting 3 days')
    expect(describeAge('revision_requested', threeDaysAgo, now)).toBe('Waiting 3 days')
  })

  it('says when a finished one last changed, rather than that it is waiting', () => {
    expect(describeAge('approved', threeDaysAgo, now)).toBe('Updated 3 days ago')
    expect(describeAge('rejected', threeDaysAgo, now)).toBe('Updated 3 days ago')
  })

  it('reads naturally for something that has only just happened', () => {
    expect(describeAge('pending_review', '2026-10-09T11:59:40Z', now)).toBe('Just arrived')
    expect(describeAge('approved', '2026-10-09T11:59:40Z', now)).toBe('Updated just now')
  })
})
