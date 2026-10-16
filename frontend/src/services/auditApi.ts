import type { AuditHistoryResponse } from '../types/audit'
import { apiBlob, apiJson } from './apiClient'

/** How far the seal on the audit trail has reached. */
export type LedgerSummary = {
  /** Records that hold a position in the chain. */
  sealed: number
  /** Written, not sealed yet. A sweep behind, normally zero. */
  unsealed: number
  /** Where the chain ends, and the digest that closes it. */
  tip: { seq: string; hash: string; sealedAt: string | null } | null
  /** How many times the end of the chain was written down separately. */
  witnesses: number
}

export type LedgerBreak = {
  /** `missing` a record is gone · `link` the order changed · `content` a record was edited. */
  kind: 'missing' | 'link' | 'content'
  seq: string
  recordId: string | null
  detail: string
}

export type LedgerReport = LedgerSummary & {
  checked: number
  intact: boolean
  break: LedgerBreak | null
  checkedAt: string
  durationMs: number
}

/** Counts and one digest. No record contents, so anyone signed in may ask. */
export async function fetchLedgerSummary(): Promise<LedgerSummary> {
  return apiJson<LedgerSummary>('/api/audit/ledger')
}

/**
 * Read the whole chain back and recompute it.
 *
 * A POST because it seals whatever is outstanding first - so the answer covers
 * everything written up to the moment it was asked - and because on a long
 * trail it is real work. Administrators only.
 */
export async function verifyLedger(): Promise<LedgerReport> {
  return apiJson<LedgerReport>('/api/audit/ledger/verify', { method: 'POST' })
}

export async function fetchAuditHistory(limit = 100): Promise<AuditHistoryResponse> {
  const params = new URLSearchParams({ limit: String(limit) })
  return apiJson<AuditHistoryResponse>(`/api/audit/documents?${params.toString()}`)
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  window.URL.revokeObjectURL(url)
}

/**
 * The whole sealed ledger, as the file an auditor checks with
 * `verify-ledger-export.mjs`, outside this application. The server asks the
 * administrator to confirm it is them first; the client asks and retries.
 */
export async function downloadLedgerExport(): Promise<void> {
  const day = new Date().toISOString().slice(0, 10)
  saveBlob(await apiBlob('/api/audit/ledger/export'), `ideas-flow-ledger-${day}.jsonl`)
}

export async function downloadAuditCsv(): Promise<void> {
  saveBlob(await apiBlob('/api/audit/documents/export'), 'documents-audit.csv')
}

export async function downloadDocumentAuditCsv(documentId: string): Promise<void> {
  saveBlob(
    await apiBlob(`/api/documents/${documentId}/audit/export`),
    `document-audit-${documentId}.csv`,
  )
}

/** One change to the system itself, rather than to any memo. */
export interface AdministrationChange {
  field: string
  /** Null where the value is not one the trail prints — see the service. */
  from: string | null
  to: string | null
}

export interface AdministrationEntry {
  id: string
  at: string
  /** Null where the account that did it has since been deleted. */
  actor: { id: string; firstName: string; lastName: string } | null
  action: string
  area: string
  entityType: string
  entityId: string
  subject: string | null
  changes: AdministrationChange[]
  ipAddress: string | null
}

export interface AdministrationActivity {
  entries: AdministrationEntry[]
  /** Everything that matched, not everything that came back. */
  total: number
  returned: number
  /** The areas the server knows, so the filter is drawn from the answer. */
  areas: string[]
}

export async function fetchAdministrationActivity(options?: {
  limit?: number
  offset?: number
  area?: string
}): Promise<AdministrationActivity> {
  const params = new URLSearchParams()
  if (options?.limit !== undefined) params.set('limit', String(options.limit))
  if (options?.offset !== undefined) params.set('offset', String(options.offset))
  if (options?.area) params.set('area', options.area)

  const query = params.toString()
  return apiJson<AdministrationActivity>(
    `/api/audit/administration${query ? `?${query}` : ''}`,
  )
}
