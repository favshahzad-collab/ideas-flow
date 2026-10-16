import { describe, expect, it } from 'vitest'
import type { DashboardDocument } from '../types/document'
import {
  buildQueue,
  countByTab,
  describeEmptyQueue,
  matchesSearch,
  matchesTab,
  sortQueue,
} from './pendingQueue'
import { formatWaitingDuration, getWaitingSeverity } from './format'

const NOW = new Date('2026-09-03T12:00:00Z').getTime()
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const HOUR = 3600_000
const DAY = 24 * HOUR

function doc(over: Partial<DashboardDocument> = {}): DashboardDocument {
  return {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    title: 'Vendor Reconciliation',
    description: '',
    status: 'pending_review',
    preparerId: 'p1',
    submittedBy: 'Tom Becker',
    submittedByInitials: 'TB',
    currentHolder: 'Maria Chen',
    currentStep: 1,
    totalSteps: 2,
    lastUpdated: '',
    submittedDate: '',
    submittedAt: ago(2 * HOUR),
    updatedAt: ago(2 * HOUR),
    versionNumber: 1,
    approvalType: 'REVIEWER',
    actionLabel: 'Review Required',
    fileType: 'pdf',
    isAwaitingMyAction: true,
    ...over,
  } as DashboardDocument
}

describe('formatWaitingDuration', () => {
  it('gives a real duration under a day instead of "Today"', () => {
    expect(formatWaitingDuration(ago(30_000), NOW)).toBe('Just now')
    expect(formatWaitingDuration(ago(5 * 60_000), NOW)).toBe('5 minutes')
    expect(formatWaitingDuration(ago(60_000), NOW)).toBe('1 minute')
    expect(formatWaitingDuration(ago(2 * HOUR), NOW)).toBe('2 hours')
    expect(formatWaitingDuration(ago(1 * HOUR), NOW)).toBe('1 hour')
  })

  it('scales past a day', () => {
    expect(formatWaitingDuration(ago(1 * DAY), NOW)).toBe('1 day')
    expect(formatWaitingDuration(ago(3 * DAY), NOW)).toBe('3 days')
    expect(formatWaitingDuration(ago(21 * DAY), NOW)).toBe('3 weeks')
    expect(formatWaitingDuration(ago(90 * DAY), NOW)).toBe('3 months')
  })
})

describe('getWaitingSeverity', () => {
  it('escalates with age', () => {
    expect(getWaitingSeverity(ago(2 * HOUR), NOW)).toBe('fresh')
    expect(getWaitingSeverity(ago(4 * DAY), NOW)).toBe('ageing')
    expect(getWaitingSeverity(ago(8 * DAY), NOW)).toBe('overdue')
    expect(getWaitingSeverity(ago(45 * DAY), NOW)).toBe('critical')
  })
})

describe('matchesTab', () => {
  it('puts every document in All', () => {
    expect(matchesTab(doc(), 'all', NOW)).toBe(true)
  })

  it('counts overdue from a week, and critical is still overdue', () => {
    expect(matchesTab(doc({ updatedAt: ago(3 * DAY) }), 'overdue', NOW)).toBe(false)
    expect(matchesTab(doc({ updatedAt: ago(8 * DAY) }), 'overdue', NOW)).toBe(true)
    expect(matchesTab(doc({ updatedAt: ago(45 * DAY) }), 'overdue', NOW)).toBe(true)
  })

  it('splits reviewer steps from approver steps', () => {
    expect(matchesTab(doc({ approvalType: 'REVIEWER' }), 'review', NOW)).toBe(true)
    expect(matchesTab(doc({ approvalType: 'REVIEWER' }), 'approval', NOW)).toBe(false)
    expect(matchesTab(doc({ approvalType: 'APPROVER' }), 'approval', NOW)).toBe(true)
    expect(matchesTab(doc({ approvalType: 'FINAL_APPROVER' }), 'approval', NOW)).toBe(true)
  })
})

describe('countByTab', () => {
  it('overlaps deliberately — a document can be both overdue and approval', () => {
    const counts = countByTab(
      [
        doc({ updatedAt: ago(2 * HOUR), approvalType: 'REVIEWER' }),
        doc({ updatedAt: ago(40 * DAY), approvalType: 'FINAL_APPROVER' }),
      ],
      NOW,
    )
    expect(counts).toEqual({ all: 2, overdue: 1, review: 1, approval: 1 })
  })
})

describe('matchesSearch', () => {
  it('matches every word somewhere rather than the whole string in one field', () => {
    const d = doc({ title: 'Q3 Vendor Payment', submittedBy: 'Tom Becker' })
    expect(matchesSearch(d, 'vendor becker')).toBe(true)
    expect(matchesSearch(d, 'vendor nair')).toBe(false)
  })

  it('finds the short id people quote', () => {
    expect(matchesSearch(doc({ id: 'c7676e45-aaaa' }), 'C7676E45')).toBe(true)
  })

  it('an empty search matches everything', () => {
    expect(matchesSearch(doc(), '   ')).toBe(true)
  })
})

describe('sortQueue', () => {
  const fresh = doc({ title: 'Zebra', updatedAt: ago(1 * HOUR) })
  const stale = doc({ title: 'Apple', updatedAt: ago(40 * DAY) })

  it('puts the longest waiting first by default', () => {
    expect(sortQueue([fresh, stale], 'oldest').map(d => d.title)).toEqual(['Apple', 'Zebra'])
  })

  it('reverses for most recent', () => {
    expect(sortQueue([stale, fresh], 'newest').map(d => d.title)).toEqual(['Zebra', 'Apple'])
  })

  it('sorts by title', () => {
    expect(sortQueue([fresh, stale], 'title').map(d => d.title)).toEqual(['Apple', 'Zebra'])
  })

  it('does not mutate its input', () => {
    const input = [fresh, stale]
    sortQueue(input, 'title')
    expect(input[0]).toBe(fresh)
  })
})

describe('buildQueue', () => {
  it('applies tab, search and sort together', () => {
    const docs = [
      doc({ title: 'Travel Policy', updatedAt: ago(45 * DAY), approvalType: 'FINAL_APPROVER' }),
      doc({ title: 'Travel Receipts', updatedAt: ago(9 * DAY), approvalType: 'REVIEWER' }),
      doc({ title: 'Petty Cash', updatedAt: ago(1 * HOUR), approvalType: 'REVIEWER' }),
    ]
    const result = buildQueue(docs, { tab: 'overdue', search: 'travel', sort: 'oldest', now: NOW })
    expect(result.map(d => d.title)).toEqual(['Travel Policy', 'Travel Receipts'])
  })
})

describe('describeEmptyQueue', () => {
  it('distinguishes an empty queue from an empty filter', () => {
    expect(describeEmptyQueue({ tab: 'all', search: '', totalPending: 0 }).title).toBe(
      "You're all caught up",
    )
    expect(describeEmptyQueue({ tab: 'all', search: 'zzz', totalPending: 4 }).title).toBe(
      'No matches',
    )
    expect(describeEmptyQueue({ tab: 'overdue', search: '', totalPending: 4 }).title).toBe(
      'Nothing overdue',
    )
  })
})
