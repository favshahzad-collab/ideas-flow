import { describe, expect, it } from 'vitest'
import type { DashboardDocument } from '../types/document'
import { computeDocumentKpis } from './documentInsights'
import { WAITING_THRESHOLDS } from './format'

/**
 * The five figures across the top of the documents screen. Every one is
 * counted from documents the API actually returned - the row states what it
 * counted rather than implying an organisation-wide total it cannot see - so
 * what each one counts is worth being exact about.
 */

const DAY = 24 * 60 * 60 * 1000
/** Mid-month and mid-day, so neither a month boundary nor a timezone moves it. */
const NOW = new Date(2026, 8, 15, 12, 0, 0).getTime()
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const doc = (overrides: Partial<DashboardDocument>): DashboardDocument =>
  ({
    id: 'd1',
    title: 'A document',
    description: '',
    status: 'pending_review',
    preparerId: 'p1',
    submittedBy: 'Ayesha Khan',
    submittedByInitials: 'AK',
    currentHolder: 'Bilal Ahmed',
    currentHolderInitials: 'BA',
    currentStep: 1,
    totalSteps: 3,
    lastUpdated: '',
    submittedDate: '',
    submittedAt: ago(DAY),
    updatedAt: ago(DAY),
    versionNumber: 1,
    approvalType: null,
    actionLabel: '',
    nextHolder: null,
    fileType: 'pdf',
    isAwaitingMyAction: false,
    ...overrides,
  }) as DashboardDocument

describe('an empty list', () => {
  it('counts zero without dividing by it', () => {
    expect(computeDocumentKpis([], NOW)).toEqual({
      inFlight: 0,
      awaitingYou: 0,
      waitingOverWeek: 0,
      medianCycleDays: null,
      approvedThisMonth: 0,
    })
  })

  it('says null rather than zero for a median it cannot compute', () => {
    // Zero days would read as "we close everything instantly", which is the
    // opposite of "nothing has closed yet".
    expect(computeDocumentKpis([], NOW).medianCycleDays).toBeNull()
  })
})

describe('inFlight', () => {
  it('counts everything submitted and not yet decided', () => {
    const documents = [
      doc({ status: 'pending_review' }),
      doc({ status: 'pending_approval' }),
      doc({ status: 'revision_requested' }),
      doc({ status: 'approved' }),
      doc({ status: 'rejected' }),
    ]

    expect(computeDocumentKpis(documents, NOW).inFlight).toBe(3)
  })

  it('counts a document sent back for revision as still live', () => {
    // It is somebody's problem: the preparer's. Excluding it would make work
    // in progress disappear from the only place that counts it.
    expect(
      computeDocumentKpis([doc({ status: 'revision_requested' })], NOW).inFlight,
    ).toBe(1)
  })
})

describe('awaitingYou', () => {
  it('counts only what is flagged for the signed-in user', () => {
    const documents = [
      doc({ isAwaitingMyAction: true }),
      doc({ isAwaitingMyAction: true, status: 'pending_approval' }),
      doc({ isAwaitingMyAction: false }),
    ]

    expect(computeDocumentKpis(documents, NOW).awaitingYou).toBe(2)
  })
})

describe('waitingOverWeek', () => {
  it('counts live documents untouched for longer than the overdue threshold', () => {
    const documents = [
      doc({ updatedAt: ago(WAITING_THRESHOLDS.overdue + DAY) }),
      doc({ updatedAt: ago(WAITING_THRESHOLDS.overdue) }),
      doc({ updatedAt: ago(WAITING_THRESHOLDS.overdue - 1) }),
    ]

    expect(computeDocumentKpis(documents, NOW).waitingOverWeek).toBe(2)
  })

  it('does not count an old document that has already been decided', () => {
    // A document approved last year is not waiting for anything.
    const documents = [
      doc({ status: 'approved', updatedAt: ago(400 * DAY) }),
      doc({ status: 'rejected', updatedAt: ago(400 * DAY) }),
    ]

    expect(computeDocumentKpis(documents, NOW).waitingOverWeek).toBe(0)
  })
})

describe('medianCycleDays', () => {
  const approvedAfter = (days: number) =>
    doc({
      status: 'approved',
      submittedAt: ago(days * DAY),
      updatedAt: ago(0),
    })

  it('is the middle value for an odd count', () => {
    expect(
      computeDocumentKpis([approvedAfter(2), approvedAfter(10), approvedAfter(4)], NOW)
        .medianCycleDays,
    ).toBe(4)
  })

  it('is the mean of the middle two for an even count', () => {
    expect(
      computeDocumentKpis(
        [approvedAfter(2), approvedAfter(4), approvedAfter(6), approvedAfter(8)],
        NOW,
      ).medianCycleDays,
    ).toBe(5)
  })

  it('is a median, not a mean, so one slow document does not move it', () => {
    // Which is the whole reason it is a median: an outlier that sat for a
    // year should not make the typical case look like a year.
    const typical = [approvedAfter(2), approvedAfter(3), approvedAfter(4)]

    expect(computeDocumentKpis(typical, NOW).medianCycleDays).toBe(3)
    expect(
      computeDocumentKpis([...typical, approvedAfter(365)], NOW).medianCycleDays,
    ).toBe(3.5)
  })

  it('rounds to a tenth of a day', () => {
    expect(
      computeDocumentKpis([approvedAfter(1.25)], NOW).medianCycleDays,
    ).toBe(1.3)
  })

  it('ignores documents that never closed', () => {
    expect(
      computeDocumentKpis(
        [approvedAfter(4), doc({ status: 'pending_review' })],
        NOW,
      ).medianCycleDays,
    ).toBe(4)
  })

  it('ignores a negative cycle rather than reporting one', () => {
    // Clock skew between the server that stamped submittedAt and the one that
    // stamped updatedAt can produce this, and "-2 days to approve" is not a
    // number to put on a header.
    const backwards = doc({
      status: 'approved',
      submittedAt: ago(0),
      updatedAt: ago(2 * DAY),
    })

    expect(computeDocumentKpis([backwards], NOW).medianCycleDays).toBeNull()
  })
})

describe('approvedThisMonth', () => {
  it('counts from the first of the current month, not the last thirty days', () => {
    const startOfThisMonth = new Date(2026, 8, 1, 0, 0, 0).getTime()

    const documents = [
      doc({ status: 'approved', updatedAt: new Date(startOfThisMonth).toISOString() }),
      doc({ status: 'approved', updatedAt: new Date(2026, 8, 14).toISOString() }),
      doc({ status: 'approved', updatedAt: new Date(2026, 7, 31, 23, 59).toISOString() }),
    ]

    expect(computeDocumentKpis(documents, NOW).approvedThisMonth).toBe(2)
  })

  it('counts only approvals, not every document touched this month', () => {
    const documents = [
      doc({ status: 'approved', updatedAt: new Date(2026, 8, 10).toISOString() }),
      doc({ status: 'rejected', updatedAt: new Date(2026, 8, 10).toISOString() }),
      doc({ status: 'pending_review', updatedAt: new Date(2026, 8, 10).toISOString() }),
    ]

    expect(computeDocumentKpis(documents, NOW).approvedThisMonth).toBe(1)
  })
})
