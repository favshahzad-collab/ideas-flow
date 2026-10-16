import { describe, expect, it } from 'vitest'
import type { OversightItem } from '../types/document'
import { computeApproverLoad, computeOversightStats, sortByWait } from './oversight'

const NOW = new Date('2026-09-04T12:00:00Z').getTime()
const DAY = 86_400_000
const ago = (ms: number) => new Date(NOW - ms).toISOString()

let seq = 0

function item(over: Partial<OversightItem> = {}): OversightItem {
  seq += 1
  return {
    id: `d${seq}`,
    title: `Document ${seq}`,
    versionNumber: 1,
    submittedAt: ago(10 * DAY),
    updatedAt: ago(DAY),
    heldSince: ago(DAY),
    preparer: { id: 'p1', firstName: 'Tom', lastName: 'Becker', department: 'HR' },
    holder: {
      id: 'u1',
      firstName: 'Priya',
      lastName: 'Nair',
      department: 'Procurement',
      approvalType: 'APPROVER',
    },
    currentStepOrder: 1,
    totalSteps: 3,
    dueAt: null,
    chasedAt: null,
    ...over,
  } as OversightItem
}

describe('computeOversightStats', () => {
  it('counts only waits past a week as stalled', () => {
    const stats = computeOversightStats(
      [
        item({ heldSince: ago(6 * DAY) }),
        item({ heldSince: ago(8 * DAY) }),
        item({ heldSince: ago(40 * DAY) }),
      ],
      NOW,
    )

    expect(stats.inFlight).toBe(3)
    expect(stats.stalled).toBe(2)
  })

  it('counts distinct holders, not rows', () => {
    const holder = (id: string) => ({
      id,
      firstName: 'A',
      lastName: 'B',
      department: null,
      approvalType: 'APPROVER' as const,
    })

    const stats = computeOversightStats(
      [
        item({ holder: holder('u1') }),
        item({ holder: holder('u1') }),
        item({ holder: holder('u2') }),
        item({ holder: null }),
      ],
      NOW,
    )

    expect(stats.holders).toBe(2)
  })

  it('reports the longest wait in whole days', () => {
    const stats = computeOversightStats(
      [item({ heldSince: ago(2 * DAY) }), item({ heldSince: ago(11.5 * DAY) })],
      NOW,
    )

    expect(stats.longestWaitDays).toBe(11)
  })

  it('returns zeroes for an empty board rather than NaN', () => {
    expect(computeOversightStats([], NOW)).toEqual({
      inFlight: 0,
      stalled: 0,
      holders: 0,
      longestWaitDays: 0,
      // Null, not zero: no item carried a deadline, so there is nothing to be
      // inside or outside of. Zero here would read as "nothing is late".
      breaching: null,
      chasedToday: null,
    })
  })

  it('counts a breach only against a deadline that was actually set', () => {
    const stats = computeOversightStats(
      [
        item({ heldSince: ago(10 * DAY), dueAt: ago(3 * DAY) }),
        item({ heldSince: ago(10 * DAY), dueAt: ago(-3 * DAY) }),
        item({ heldSince: ago(40 * DAY) }),
      ],
      NOW,
    )

    // The third has sat for forty days and is not breaching anything, because
    // nobody gave that step a number of days to be measured against.
    expect(stats.breaching).toBe(1)
  })

  it('counts only the chases sent today', () => {
    const stats = computeOversightStats(
      [
        item({ dueAt: ago(3 * DAY), chasedAt: ago(0.1 * DAY) }),
        item({ dueAt: ago(3 * DAY), chasedAt: ago(9 * DAY) }),
        item({ dueAt: ago(-3 * DAY) }),
      ],
      NOW,
    )

    expect(stats.chasedToday).toBe(1)
  })
})

describe('computeApproverLoad', () => {
  const holder = (id: string, first: string) => ({
    id,
    firstName: first,
    lastName: 'Doe',
    department: 'Finance',
    approvalType: 'APPROVER' as const,
  })

  it('ranks by count and scales against the busiest person', () => {
    const rows = computeApproverLoad(
      [
        item({ holder: holder('u1', 'Ann') }),
        item({ holder: holder('u1', 'Ann') }),
        item({ holder: holder('u1', 'Ann') }),
        item({ holder: holder('u2', 'Ben') }),
        item({ holder: holder('u3', 'Cal') }),
        item({ holder: holder('u3', 'Cal') }),
      ],
      NOW,
    )

    expect(rows.map(r => [r.name, r.count, r.percent])).toEqual([
      ['Ann Doe', 3, 100],
      ['Cal Doe', 2, 67],
      ['Ben Doe', 1, 33],
    ])
  })

  it('tones on the same thresholds the design names', () => {
    const rows = computeApproverLoad(
      [
        item({ holder: holder('u1', 'Ann') }),
        item({ holder: holder('u1', 'Ann') }),
        item({ holder: holder('u1', 'Ann') }),
        item({ holder: holder('u1', 'Ann') }),
        item({ holder: holder('u2', 'Ben') }),
        item({ holder: holder('u2', 'Ben') }),
        item({ holder: holder('u3', 'Cal') }),
      ],
      NOW,
    )

    // 100% → danger, 50% → warning, 25% → accent
    expect(rows.map(r => r.tone)).toEqual(['danger', 'warning', 'accent'])
  })

  it('counts stalled items per person', () => {
    const rows = computeApproverLoad(
      [
        item({ holder: holder('u1', 'Ann'), heldSince: ago(9 * DAY) }),
        item({ holder: holder('u1', 'Ann'), heldSince: ago(1 * DAY) }),
      ],
      NOW,
    )

    expect(rows[0]).toMatchObject({ count: 2, stalled: 1 })
  })

  it('skips unassigned work rather than inventing a holder', () => {
    expect(computeApproverLoad([item({ holder: null })], NOW)).toEqual([])
  })
})

describe('sortByWait', () => {
  it('puts the longest wait first and does not mutate its input', () => {
    const input = [
      item({ id: 'new', heldSince: ago(1 * DAY) }),
      item({ id: 'old', heldSince: ago(20 * DAY) }),
    ]
    const sorted = sortByWait(input)

    expect(sorted.map(i => i.id)).toEqual(['old', 'new'])
    expect(input.map(i => i.id)).toEqual(['new', 'old'])
  })
})
