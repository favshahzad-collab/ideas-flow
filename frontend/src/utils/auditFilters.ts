import type { AuditDocumentGroup, AuditRecord } from '../types/audit'
import { formatDocumentId } from './format'

export function filterAuditRecords(
  records: AuditRecord[],
  search: string,
  actionFilter: string,
): AuditRecord[] {
  const query = search.toLowerCase().trim()

  return records.filter(record => {
    const matchesSearch =
      !query ||
      record.document.toLowerCase().includes(query) ||
      record.documentId.toLowerCase().includes(query) ||
      formatDocumentId(record.documentId).toLowerCase().includes(query) ||
      (record.documentReference ?? '').toLowerCase().includes(query) ||
      record.user.toLowerCase().includes(query)

    const matchesAction =
      actionFilter === 'All Actions' || record.action === actionFilter

    return matchesSearch && matchesAction
  })
}

function sortRecordsNewestFirst(records: AuditRecord[]): AuditRecord[] {
  return [...records].sort(
    (a, b) =>
      new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  )
}

export function groupAuditRecordsByDocument(
  records: AuditRecord[],
): AuditDocumentGroup[] {
  const grouped = new Map<string, AuditRecord[]>()

  for (const record of records) {
    const existing = grouped.get(record.documentId) ?? []
    existing.push(record)
    grouped.set(record.documentId, existing)
  }

  return Array.from(grouped.entries())
    .map(([documentId, actions]) => {
      const sortedActions = sortRecordsNewestFirst(actions)

      return {
        documentId,
        document: sortedActions[0].document,
        documentStatus: sortedActions[0].documentStatus,
        actions: sortedActions,
        latestAction: sortedActions[0],
      }
    })
    .sort(
      (a, b) =>
        new Date(b.latestAction.occurredAt).getTime() -
        new Date(a.latestAction.occurredAt).getTime(),
    )
}
