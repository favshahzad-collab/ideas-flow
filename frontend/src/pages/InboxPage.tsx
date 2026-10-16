import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, CheckCircle2, Loader2, Trash2 } from 'lucide-react'
import { useNotifications } from '../hooks/useNotifications'
import { ROUTES } from '../types/routes'
import { Page, PageHeader, EmptyState } from '../components/ui/Page'
import Button from '../components/ui/Button'
import ConfirmDialog from '../components/ui/ConfirmDialog'
import {
  LoadingAnnouncer,
  Skeleton,
  SkeletonPageHeader,
} from '../components/ui/Skeleton'
import NotificationRow from '../components/inbox/NotificationRow'
import Eyebrow from '../components/ui/Eyebrow'
import { groupNotifications, summariseInbox } from '../utils/inboxGroups'

/**
 * The mono label with a hairline running out to the right of it. It is the
 * only thing separating one group from the next — the groups themselves are
 * plain cards, so the rule is what makes the break read as structural rather
 * than as another row.
 */
function GroupRule({ label, count }: { label: string; count: number }) {
  return (
    <div className="mb-2 flex items-center gap-3">
      <Eyebrow as="h2">{label}</Eyebrow>
      <span className="font-mono text-eyebrow tabular-nums text-content-faint">
        {count}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
    </div>
  )
}

export default function InboxPage() {
  const navigate = useNavigate()
  const {
    notifications,
    unreadCount,
    loading,
    error,
    actionLoading,
    refetch,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    deleteAllNotifications,
  } = useNotifications()

  const [actionError, setActionError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)

  const groups = groupNotifications(notifications)

  const handleMarkAllAsRead = async () => {
    setActionError(null)
    try {
      await markAllAsRead()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to mark all as read')
    }
  }

  const handleMarkAsRead = async (id: string) => {
    setActionError(null)
    try {
      await markAsRead(id)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to mark as read')
    }
  }

  const handleDelete = async (id: string) => {
    setActionError(null)
    setDeletingId(id)
    try {
      await deleteNotification(id)
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Failed to delete notification',
      )
    } finally {
      setDeletingId(null)
    }
  }

  const handleDeleteAll = async () => {
    setActionError(null)
    setDeletingAll(true)
    try {
      await deleteAllNotifications()
      setConfirmDeleteAll(false)
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Failed to delete all notifications',
      )
      // Close on failure too — the message belongs on the page behind, where
      // the notifications the user still has are visible.
      setConfirmDeleteAll(false)
    } finally {
      setDeletingAll(false)
    }
  }

  const handleOpenDocument = (documentId: string, options?: { toSign: boolean }) => {
    // Straight into signing for a request that is still open; the memo page
    // checks it is still this person's turn before it opens anything.
    navigate(`${ROUTES.document(documentId)}${options?.toSign ? '?sign=1' : ''}`)
  }

  if (loading) {
    // Two grouped cards behind their mono rules — the shape the page below
    // actually renders, so nothing moves when the data lands.
    return (
      <Page width="narrow">
        <SkeletonPageHeader titleWidth="7rem" description={false} />

        <div aria-hidden="true" className="space-y-5">
          {[3, 2].map((rows, group) => (
            <div key={group}>
              <div className="mb-2 flex items-center gap-3">
                <Skeleton className="h-2.5 w-24" />
                <span className="h-px flex-1 bg-line" />
              </div>
              <div className="card overflow-hidden">
                {Array.from({ length: rows }, (_, i) => (
                  <div
                    key={i}
                    className="flex gap-3 border-b border-line-soft px-3.75 py-3.25 last:border-b-0"
                  >
                    <Skeleton className="h-7.5 w-7.5 flex-shrink-0 rounded-control" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3 w-52" />
                      <Skeleton className="h-2.5 w-full" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <LoadingAnnouncer loading label="Loading your inbox" />
      </Page>
    )
  }

  if (error) {
    return (
      <Page width="narrow">
        <div className="card flex flex-col items-center gap-3 px-6 py-16 text-center">
          <p className="text-ui text-danger-ink">{error}</p>
          <Button variant="secondary" size="sm" onClick={refetch}>
            Try again
          </Button>
        </div>
      </Page>
    )
  }

  return (
    <Page width="narrow">
      <PageHeader
        title="Inbox"
        eyebrow={summariseInbox(notifications)}
        actions={
          <>
            <Button
              variant="secondary"
              icon={
                actionLoading ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Check size={15} />
                )
              }
              onClick={handleMarkAllAsRead}
              disabled={unreadCount === 0 || actionLoading}
            >
              Mark all read
            </Button>
            <Button
              variant="danger"
              icon={<Trash2 size={15} />}
              onClick={() => setConfirmDeleteAll(true)}
              disabled={notifications.length === 0 || actionLoading}
            >
              Delete all
            </Button>
          </>
        }
      />

      {actionError && (
        <p role="alert" className="mb-3 text-ui text-danger-ink">
          {actionError}
        </p>
      )}

      {groups.length > 0 ? (
        <div className="space-y-5">
          {groups.map(group => (
            <section key={group.key} aria-label={group.label}>
              <GroupRule label={group.label} count={group.items.length} />
              <div className="card overflow-hidden">
                {group.items.map(notification => (
                  <NotificationRow
                    key={notification.id}
                    notification={notification}
                    onOpen={handleOpenDocument}
                    onMarkRead={handleMarkAsRead}
                    onDelete={handleDelete}
                    deleting={deletingId === notification.id}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="card">
          <EmptyState
            icon={CheckCircle2}
            title="Your inbox is empty"
            description="Updates on memos you prepared or sign land here as they happen. Memos waiting for your signature are in My queue."
          />
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteAll}
        title="Delete all notifications?"
        confirmLabel="Delete all"
        destructive
        pending={deletingAll}
        onConfirm={handleDeleteAll}
        onCancel={() => setConfirmDeleteAll(false)}
      >
        This removes{' '}
        <span className="font-medium text-content">
          {notifications.length} notification
          {notifications.length === 1 ? '' : 's'}
        </span>{' '}
        and cannot be undone. The documents they refer to are not affected.
      </ConfirmDialog>
    </Page>
  )
}
