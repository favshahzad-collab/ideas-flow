import type { DashboardDocument, DocumentStatus } from '../types/document'

export type DocumentStatusFilter =
  | 'all'
  | 'pending'
  | 'pending_review'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'revision_requested'

function matchesStatusFilter(
  status: DocumentStatus,
  filter: DocumentStatusFilter,
): boolean {
  if (filter === 'all') return true
  if (filter === 'pending') {
    return status === 'pending_review' || status === 'pending_approval'
  }
  return status === filter
}

export function filterMyQueue(
  documents: DashboardDocument[],
): DashboardDocument[] {
  return documents.filter(
    doc =>
      doc.isAwaitingMyAction &&
      (doc.status === 'pending_review' || doc.status === 'pending_approval'),
  )
}

export function filterDocuments(
  documents: DashboardDocument[],
  search: string,
  statusFilter: DocumentStatusFilter,
): DashboardDocument[] {
  const query = search.trim().toLowerCase()

  return documents.filter(doc => {
    const matchesSearch =
      !query ||
      doc.title.toLowerCase().includes(query) ||
      // The reference is what people quote ("MEMO-2026-0043"), and the
      // description is where the detail is.
      (doc.referenceNumber ?? '').toLowerCase().includes(query) ||
      doc.description.toLowerCase().includes(query) ||
      doc.id.toLowerCase().includes(query) ||
      doc.submittedBy.toLowerCase().includes(query) ||
      doc.currentHolder.toLowerCase().includes(query)

    const matchesStatus = matchesStatusFilter(doc.status, statusFilter)

    return matchesSearch && matchesStatus
  })
}
