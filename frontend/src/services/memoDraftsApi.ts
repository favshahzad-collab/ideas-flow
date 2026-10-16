import type { MemoBody } from '../types/memo'
import type { ApprovalChainStepInput } from '../types/submitDocument'
import { apiJson, apiVoid, jsonBody } from './apiClient'

/**
 * Memos being written, kept on the server.
 *
 * The local draft in `useSubmitDraft` keeps a closed tab from costing somebody
 * their afternoon on the machine they closed it on. This is the other half:
 * a memo started on a laptop and finished on a desk, and one that survives a
 * cleared browser. It holds no file — a `File` cannot be serialised, and an
 * uploaded memo's content IS the file — so it is the typed memo that is
 * saved here.
 *
 * A draft is private to its author. The server scopes every query by
 * preparer, so there is nothing to pass here saying whose it is.
 */

export interface MemoDraft {
  id: string
  memoType: string | null
  /** The memo type's own name, so a list can be read without a second call. */
  memoTypeLabel: string | null
  title: string | null
  memoTo: string | null
  memoFrom: string | null
  /** The date the memo will bear, as `2026-08-06`. */
  memoDate: string | null
  body: MemoBody | null
  chain: ApprovalChainStepInput[] | null
  templateId: string | null
  createdAt: string
  updatedAt: string
}

/** Everything a draft may carry. Every field optional: it is unfinished. */
export interface MemoDraftInput {
  memoType?: string
  title?: string
  memoTo?: string
  memoFrom?: string
  memoDate?: string
  body?: MemoBody
  chain?: ApprovalChainStepInput[]
  templateId?: string | null
}

export async function listMemoDrafts(): Promise<MemoDraft[]> {
  const response = await apiJson<{ drafts: MemoDraft[] }>('/api/memo-drafts')
  return response.drafts
}

export function createMemoDraft(input: MemoDraftInput): Promise<MemoDraft> {
  return apiJson<MemoDraft>('/api/memo-drafts', {
    method: 'POST',
    ...jsonBody(input),
  })
}

/**
 * PATCH, not PUT: the client sends what changed, and a request that leaves
 * the chain out must not be read as "the preparer cleared it".
 */
export function updateMemoDraft(
  id: string,
  input: MemoDraftInput,
): Promise<MemoDraft> {
  return apiJson<MemoDraft>(`/api/memo-drafts/${id}`, {
    method: 'PATCH',
    ...jsonBody(input),
  })
}

export function deleteMemoDraft(id: string): Promise<void> {
  return apiVoid(`/api/memo-drafts/${id}`, { method: 'DELETE' })
}
