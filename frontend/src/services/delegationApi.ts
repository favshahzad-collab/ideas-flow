import { apiJson, jsonBody } from './apiClient'
import type { Delegation, DelegationLists } from '../types/delegation'

/**
 * Handing one person's approvals to another while they are away.
 *
 * The API decides who may arrange what: your own always, anybody's if you are
 * an administrator. This is the people screen, which is administrators only,
 * so `userId` is normally somebody else's.
 */
export async function fetchDelegations(userId?: string): Promise<DelegationLists> {
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : ''

  return apiJson<DelegationLists>(`/api/delegations${query}`)
}

export async function createDelegation(payload: {
  delegatorId?: string
  delegateId: string
  /** A day (`2026-09-30`) means the end of that day, not its first moment. */
  endsAt?: string | null
  reason?: string
  /** The kinds of memo it covers; empty or absent is every memo. */
  memoTypes?: string[]
}): Promise<Delegation> {
  const result = await apiJson<{ delegation: Delegation }>('/api/delegations', {
    method: 'POST',
    ...jsonBody(payload),
  })

  return result.delegation
}

export async function revokeDelegation(id: string): Promise<Delegation> {
  const result = await apiJson<{ delegation: Delegation }>(
    `/api/delegations/${id}`,
    { method: 'DELETE' },
  )

  return result.delegation
}
