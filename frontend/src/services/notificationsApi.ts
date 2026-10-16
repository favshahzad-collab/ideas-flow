import type { NotificationsListResponse } from '../types/notification'
import { apiJson } from './apiClient'
import { createCachedRequest } from '../utils/requestCache'

export async function fetchNotifications(
  isRead?: boolean,
): Promise<NotificationsListResponse> {
  const params = new URLSearchParams()
  if (isRead !== undefined) {
    params.set('isRead', String(isRead))
  }

  const query = params.toString()
  const url = query ? `/api/notifications?${query}` : '/api/notifications'

  return apiJson<NotificationsListResponse>(url)
}

/**
 * The number behind the sidebar badge.
 *
 * This used to download every unread notification and take `.length`, which
 * is a whole inbox over the wire to draw one digit — on every page load, and
 * again after every inbox action anywhere in the app. Nothing removes a
 * notification but the person deleting it, so that list has no upper bound.
 */
async function fetchUnreadCount(): Promise<{ count: number }> {
  return apiJson<{ count: number }>('/api/notifications/unread-count')
}

const unreadCountCache = createCachedRequest(fetchUnreadCount, 4000)

export function fetchUnreadNotificationCount(force = false): Promise<{ count: number }> {
  return unreadCountCache.get(force)
}

export function invalidateUnreadNotificationsCache(): void {
  unreadCountCache.invalidate()
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('daws:unread-notifications-changed'))
  }
}

export async function markNotificationAsRead(notificationId: string) {
  const result = await apiJson<unknown>(`/api/notifications/${notificationId}/read`, {
    method: 'PATCH',
  })

  invalidateUnreadNotificationsCache()
  return result
}

/**
 * One request, not one per unread row.
 *
 * The loop this replaces could half-succeed: some rows were marked read on
 * the server while the screen rolled the whole list back to unread, leaving a
 * disagreement no further pressing of the button could clear — the rows
 * already read were no longer in the set being retried.
 */
export async function markAllNotificationsAsRead() {
  const result = await apiJson<{ message: string; updatedCount: number }>(
    '/api/notifications/read-all',
    { method: 'PATCH' },
  )

  invalidateUnreadNotificationsCache()
  return result
}

export async function deleteNotification(notificationId: string) {
  const result = await apiJson<{ message: string }>(
    `/api/notifications/${notificationId}`,
    { method: 'DELETE' },
  )

  invalidateUnreadNotificationsCache()
  return result
}

export async function deleteAllNotifications() {
  const result = await apiJson<{ message: string; deletedCount: number }>(
    '/api/notifications',
    { method: 'DELETE' },
  )

  invalidateUnreadNotificationsCache()
  return result
}
