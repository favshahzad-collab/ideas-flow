/**
 * Standard wording: kept by an administrator, inserted by preparers.
 *
 * Two views of one table. A preparer is offered what is current, with the
 * body, because the editor copies it into the memo at the caret. An
 * administrator sees everything, archived included, so that "put it back"
 * is a button.
 */
import type { MemoBody } from '../types/memo'
import { apiJson, jsonBody } from './apiClient'

/** A clause as the library screen holds it. */
export type MemoClause = {
  id: string
  title: string
  body: MemoBody
  /** Set when it has been taken off the preparer's list. */
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  updatedBy: { firstName: string; lastName: string } | null
}

/** A clause as the editor is handed it: enough to list and to insert. */
export type StandardWording = {
  id: string
  title: string
  body: MemoBody
}

/** What is on offer to whoever is writing a memo. */
export async function fetchStandardWording() {
  return apiJson<{ clauses: StandardWording[] }>('/api/memo-clauses')
}

export async function fetchMemoClauses() {
  return apiJson<{ clauses: MemoClause[] }>('/api/admin/memo-clauses')
}

export async function createMemoClause(input: { title: string; body: MemoBody }) {
  return apiJson<{ clause: MemoClause }>('/api/admin/memo-clauses', {
    method: 'POST',
    ...jsonBody(input),
  })
}

export async function updateMemoClause(
  id: string,
  input: { title?: string; body?: MemoBody; archived?: boolean },
) {
  return apiJson<{ clause: MemoClause }>(`/api/admin/memo-clauses/${id}`, {
    method: 'PUT',
    ...jsonBody(input),
  })
}
