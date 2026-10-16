import type { DashboardDocument } from '../types/document'
import { WAITING_THRESHOLDS } from './format'

/**
 * The five figures on the documents header.
 *
 * Every one is derived from documents the API has actually returned. The
 * design asks for org-wide totals and period-over-period deltas ("214",
 * "+12"), which want `GET /api/documents/summary`; until that exists there is
 * no honest way to produce them, so the row states what it counted instead of
 * implying a number it cannot see.
 */
export interface DocumentKpis {
  /** Live workflows — submitted, not yet in a terminal state. */
  inFlight: number
  /** Waiting on the signed-in user specifically. */
  awaitingYou: number
  /**
   * In flight and untouched for longer than a week. Named for what it
   * measures: the schema has no due date, so this is age, not a breach.
   */
  waitingOverWeek: number
  /** Median submitted-to-resolved time, in days. Null until something closes. */
  medianCycleDays: number | null
  /** Resolved as approved within the current calendar month. */
  approvedThisMonth: number
}

const DAY = 24 * 60 * 60 * 1000

const IN_FLIGHT = new Set(['pending_review', 'pending_approval', 'revision_requested'])

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function computeDocumentKpis(
  documents: DashboardDocument[],
  now: number = Date.now(),
): DocumentKpis {
  const inFlight = documents.filter(doc => IN_FLIGHT.has(doc.status))

  const cycles = documents
    .filter(doc => doc.status === 'approved' && doc.submittedAt && doc.updatedAt)
    .map(doc => new Date(doc.updatedAt).getTime() - new Date(doc.submittedAt).getTime())
    .filter(ms => Number.isFinite(ms) && ms >= 0)

  const medianMs = median(cycles)

  const startOfMonth = new Date(now)
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  return {
    inFlight: inFlight.length,
    awaitingYou: documents.filter(doc => doc.isAwaitingMyAction).length,
    waitingOverWeek: inFlight.filter(
      doc => now - new Date(doc.updatedAt).getTime() >= WAITING_THRESHOLDS.overdue,
    ).length,
    medianCycleDays:
      medianMs === null ? null : Math.round((medianMs / DAY) * 10) / 10,
    approvedThisMonth: documents.filter(
      doc =>
        doc.status === 'approved' &&
        new Date(doc.updatedAt).getTime() >= startOfMonth.getTime(),
    ).length,
  }
}
