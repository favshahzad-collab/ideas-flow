import type { DashboardDocument } from '../types/document'
import { getWaitingSeverity } from './format'

/**
 * Pure queue logic for My queue: which tab a document belongs to, how
 * the list is searched, and how it is ordered.
 *
 * The tabs are cuts of one queue rather than separate fetches — every document
 * in "Overdue" is also in "All". That keeps the counts truthful (they always
 * sum to more than the total, and that is correct) and means switching tabs
 * costs nothing.
 */

export type QueueTab = 'all' | 'overdue' | 'review' | 'approval'

/**
 * The one list of tabs. `QueueList` kept a second copy of these labels, so a
 * tab added here would not have appeared on screen and a label changed there
 * would not have matched `matchesTab`.
 *
 * The design calls the second one "Breaching". It is named for age because
 * that is what it measures — there is no due date in the schema, so nothing is
 * being breached. "Overdue" is already the word the rest of the app uses for
 * the same seven-day threshold.
 */
export const QUEUE_TABS: { id: QueueTab; label: string; hint: string }[] = [
  { id: 'all', label: 'All', hint: 'Everything waiting on you' },
  { id: 'overdue', label: 'Overdue', hint: 'Waiting more than a week' },
  { id: 'review', label: 'Review', hint: 'Reviewer steps' },
  { id: 'approval', label: 'Approval', hint: 'Approver and final approver steps' },
]

export type QueueSort = 'oldest' | 'newest' | 'title'

export function matchesTab(
  document: DashboardDocument,
  tab: QueueTab,
  now: number = Date.now(),
): boolean {
  switch (tab) {
    case 'all':
      return true
    case 'overdue': {
      const severity = getWaitingSeverity(document.updatedAt, now)
      return severity === 'overdue' || severity === 'critical'
    }
    case 'review':
      return document.approvalType === 'REVIEWER'
    case 'approval':
      return (
        document.approvalType === 'APPROVER' ||
        document.approvalType === 'FINAL_APPROVER'
      )
  }
}

export function countByTab(
  documents: DashboardDocument[],
  now: number = Date.now(),
): Record<QueueTab, number> {
  return {
    all: documents.length,
    overdue: documents.filter(d => matchesTab(d, 'overdue', now)).length,
    review: documents.filter(d => matchesTab(d, 'review', now)).length,
    approval: documents.filter(d => matchesTab(d, 'approval', now)).length,
  }
}

/** Title, preparer and the short document id people actually quote to each other. */
export function matchesSearch(document: DashboardDocument, search: string): boolean {
  const term = search.trim().toLowerCase()
  if (!term) return true

  // Every word has to appear somewhere, so "vendor chen" narrows rather than
  // widening — the same rule the approver search uses server-side.
  return term
    .split(/\s+/)
    .every(
      token =>
        document.title.toLowerCase().includes(token) ||
        document.submittedBy.toLowerCase().includes(token) ||
        document.id.toLowerCase().includes(token),
    )
}

export function sortQueue(
  documents: DashboardDocument[],
  sort: QueueSort,
): DashboardDocument[] {
  const copy = [...documents]
  switch (sort) {
    case 'oldest':
      return copy.sort(
        (a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(),
      )
    case 'newest':
      return copy.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
    case 'title':
      return copy.sort((a, b) => a.title.localeCompare(b.title))
  }
}

export function buildQueue(
  documents: DashboardDocument[],
  options: { tab: QueueTab; search: string; sort: QueueSort; now?: number },
): DashboardDocument[] {
  const now = options.now ?? Date.now()
  return sortQueue(
    documents.filter(d => matchesTab(d, options.tab, now) && matchesSearch(d, options.search)),
    options.sort,
  )
}

/** What the empty panel should say, which depends on why it is empty. */
export function describeEmptyQueue(options: {
  tab: QueueTab
  search: string
  totalPending: number
}): { title: string; description: string } {
  if (options.totalPending === 0) {
    return {
      title: "You're all caught up",
      description: 'There are no documents waiting for your action.',
    }
  }
  if (options.search.trim()) {
    return {
      title: 'No matches',
      description: `Nothing in this tab matches “${options.search.trim()}”.`,
    }
  }
  if (options.tab === 'overdue') {
    return {
      title: 'Nothing overdue',
      description: 'Everything waiting on you has arrived within the last week.',
    }
  }
  return {
    title: 'Nothing in this tab',
    description: 'Switch to All to see everything waiting on you.',
  }
}
