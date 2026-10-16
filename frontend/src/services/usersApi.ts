import type { AssignableUser } from '../types/submitDocument'
import { apiJson } from './apiClient'

export interface AssignableUsersPage {
  users: AssignableUser[]
  /** How many match the query in total, so the UI can say "showing 25 of 312". */
  total: number
  returned: number
}

/**
 * Assignable approvers. The server filters and caps the page, so a large
 * directory never arrives as one response — pass `q` as the user types.
 */
export async function fetchAssignableUsers(
  options: { q?: string; limit?: number } = {},
): Promise<AssignableUsersPage> {
  const params = new URLSearchParams()
  if (options.q?.trim()) params.set('q', options.q.trim())
  if (options.limit) params.set('limit', String(options.limit))

  const query = params.toString()
  return apiJson<AssignableUsersPage>(`/api/users${query ? `?${query}` : ''}`)
}

/**
 * Resolve a known set of people by id — the approvers a workflow template
 * names, who no search term would reliably surface.
 */
export async function fetchUsersByIds(ids: string[]): Promise<AssignableUser[]> {
  if (ids.length === 0) return []
  const page = await apiJson<AssignableUsersPage>(
    `/api/users?ids=${encodeURIComponent(ids.join(','))}`,
  )
  return page.users
}
