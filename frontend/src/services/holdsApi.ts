import { apiJson } from './apiClient'
import type { MemosHeld } from '../types/holds'

/**
 * Every memo in the organisation that stops at one named person.
 *
 * Administrators only, and it says so by answering 403: it crosses every memo
 * there is, which no other read on this screen does.
 */
export async function fetchMemosHeldBy(userId: string): Promise<MemosHeld> {
  return apiJson<MemosHeld>(`/api/admin/users/${encodeURIComponent(userId)}/holds`)
}
