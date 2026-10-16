import { apiJson, jsonBody } from './apiClient'

/**
 * Changing your own password.
 *
 * Until this existed the only route was `PATCH /api/admin/users/:id`, which
 * only an administrator can call — so every account kept whatever password the
 * spreadsheet import gave it, and the person who wrote that spreadsheet knew
 * the credentials of everybody whose signature carries approval authority.
 */
export async function changeMyPassword(input: {
  currentPassword: string
  newPassword: string
}): Promise<{ message: string }> {
  return apiJson<{ message: string }>('/api/users/me/password', {
    method: 'PATCH',
    ...jsonBody(input),
  })
}
