import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  deleteAllNotifications as deleteAllNotificationsRequest,
  deleteNotification as deleteNotificationRequest,
  fetchNotifications,
  fetchUnreadNotificationCount,
  invalidateUnreadNotificationsCache,
  markAllNotificationsAsRead,
  markNotificationAsRead,
} from '../services/notificationsApi'
import type { NotificationItem } from '../types/notification'
import { mapApiNotificationToItem } from '../utils/notificationMapper'

export function useNotifications() {
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const { notifications: apiNotifications } = await fetchNotifications()
      setNotifications(apiNotifications.map(mapApiNotificationToItem))
    } catch (err) {
      setNotifications([])
      setError(err instanceof Error ? err.message : 'Failed to load notifications')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Not `load()`: that sets state synchronously inside the effect.
    // `loading` already starts true, so the mount fetch only reports its
    // result, and the guard keeps a late response off an unmounted hook.
    let cancelled = false

    fetchNotifications()
      .then(({ notifications: apiNotifications }) => {
        if (cancelled) return
        setNotifications(apiNotifications.map(mapApiNotificationToItem))
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setNotifications([])
        setError(err instanceof Error ? err.message : 'Failed to load notifications')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const unreadCount = useMemo(
    () => notifications.filter(notification => !notification.isRead).length,
    [notifications],
  )

  const markAsRead = useCallback(async (notificationId: string) => {
    const target = notifications.find(n => n.id === notificationId)
    if (!target || target.isRead) return

    setNotifications(prev =>
      prev.map(notification =>
        notification.id === notificationId
          ? { ...notification, isRead: true }
          : notification,
      ),
    )

    try {
      await markNotificationAsRead(notificationId)
    } catch {
      setNotifications(prev =>
        prev.map(notification =>
          notification.id === notificationId
            ? { ...notification, isRead: false }
            : notification,
        ),
      )
      throw new Error('Failed to mark notification as read')
    }
  }, [notifications])

  const markAllAsRead = useCallback(async () => {
    const hasUnread = notifications.some(notification => !notification.isRead)
    if (!hasUnread) return

    setActionLoading(true)

    const previous = notifications
    setNotifications(prev =>
      prev.map(notification => ({ ...notification, isRead: true })),
    )

    try {
      // One request. Rolling back is honest now: the server either marked
      // them all or marked none, so the screen cannot end up disagreeing
      // with it about which rows were done.
      await markAllNotificationsAsRead()
    } catch {
      setNotifications(previous)
      throw new Error('Failed to mark all notifications as read')
    } finally {
      setActionLoading(false)
    }
  }, [notifications])

  const deleteNotification = useCallback(async (notificationId: string) => {
    const previous = notifications
    setNotifications(prev => prev.filter(n => n.id !== notificationId))

    try {
      await deleteNotificationRequest(notificationId)
    } catch {
      setNotifications(previous)
      throw new Error('Failed to delete notification')
    }
  }, [notifications])

  const deleteAllNotifications = useCallback(async () => {
    if (notifications.length === 0) return

    setActionLoading(true)
    const previous = notifications
    setNotifications([])

    try {
      await deleteAllNotificationsRequest()
    } catch {
      setNotifications(previous)
      throw new Error('Failed to delete all notifications')
    } finally {
      setActionLoading(false)
    }
  }, [notifications])

  return {
    notifications,
    unreadCount,
    loading,
    error,
    actionLoading,
    refetch: load,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    deleteAllNotifications,
  }
}

export function useUnreadNotificationCount() {
  const [count, setCount] = useState(0)

  const load = useCallback(async (force = false) => {
    try {
      const { count: unread } = await fetchUnreadNotificationCount(force)
      setCount(unread)
    } catch {
      setCount(0)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    fetchUnreadNotificationCount()
      .then(({ count: unread }) => {
        if (!cancelled) setCount(unread)
      })
      .catch(() => {
        if (!cancelled) setCount(0)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onChanged = () => {
      void load(true)
    }
    window.addEventListener('daws:unread-notifications-changed', onChanged)
    return () => {
      window.removeEventListener('daws:unread-notifications-changed', onChanged)
    }
  }, [load])

  const refetch = useCallback(() => {
    invalidateUnreadNotificationsCache()
    return load(true)
  }, [load])

  return { unreadCount: count, refetch }
}
