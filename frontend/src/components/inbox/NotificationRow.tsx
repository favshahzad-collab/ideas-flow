import { AlertCircle, ArrowLeftRight, Bell, CheckCircle2, Clock, FileText, Loader2, MessageSquare, RotateCcw, ShieldAlert, SkipForward, Trash2, UserCheck, XCircle } from 'lucide-react'
import type { ComponentType } from 'react'
import Button from '../ui/Button'
import { isActionable } from '../../utils/inboxGroups'
import type { NotificationItem, NotificationUiCategory } from '../../types/notification'

/**
 * The tinted 30px tile that opens each row. The tint is the type of event,
 * and it is never the only carrier of that: the icon shape differs per
 * category and the title spells the event out in words.
 */
/** The categories that ask for work on a memo, and so can be finished. */
const FINISHED_WORK = new Set<NotificationUiCategory>(['action', 'overdue', 'revision'])

/** What an unrecognised category reads as, rather than throwing. */
const UNKNOWN_CATEGORY = {
  icon: Bell,
  tile: 'bg-neutral-soft text-content-muted',
} as const

const CATEGORY: Record<
  NotificationUiCategory,
  { icon: ComponentType<{ size?: number; className?: string }>; tile: string }
> = {
  action: { icon: AlertCircle, tile: 'bg-danger-soft text-danger-ink' },
  // Warning rather than danger: it is late, not wrong, and colouring it the
  // same as a rejection would make a chased approval read as a refused one.
  overdue: { icon: Clock, tile: 'bg-warning-soft text-warning-ink' },
  comment: { icon: MessageSquare, tile: 'bg-info-soft text-info-ink' },
  revision: { icon: RotateCcw, tile: 'bg-revision-soft text-revision-ink' },
  approved: { icon: CheckCircle2, tile: 'bg-accent-soft text-accent-ink' },
  rejected: { icon: XCircle, tile: 'bg-danger-soft text-danger-ink' },
  submitted: { icon: FileText, tile: 'bg-sunken text-content-muted' },
  deleted: { icon: Trash2, tile: 'bg-sunken text-content-muted' },
  // Informational. The WORK that follows from covering somebody arrives
  // separately, as an ordinary approval request, and that one is red.
  delegation: { icon: UserCheck, tile: 'bg-info-soft text-info-ink' },
  // Muted, like the other rows that report rather than ask. Being passed
  // over is worth knowing and is not an emergency.
  skipped: { icon: SkipForward, tile: 'bg-sunken text-content-muted' },
  // Also muted, and a different icon on purpose: one arrow past a person
  // reads as "it went by you", two arrows as "it went to somebody else". The
  // title says which in words either way.
  reassigned: { icon: ArrowLeftRight, tile: 'bg-sunken text-content-muted' },
  // Danger, and meant literally: every one of these is either something the
  // reader did a moment ago and will recognise, or the first sign that
  // somebody else is in their account.
  security: { icon: ShieldAlert, tile: 'bg-danger-soft text-danger-ink' },
  // Late, like an overdue row, and for somebody who can chase rather than sign.
  escalated: { icon: Clock, tile: 'bg-warning-soft text-warning-ink' },
}

/**
 * What the inline button on an actionable row should say.
 *
 * Deliberately "Open to sign" rather than the design's "Sign & approve":
 * approving in this product means placing a signature on the rendered PDF,
 * so there is no approval that can complete from a list row. The button goes
 * to the place where the work actually happens, and says so.
 */
const OPEN_LABEL: Partial<Record<NotificationUiCategory, string>> = {
  action: 'Open to sign',
  overdue: 'Open to sign',
  comment: 'Open the thread',
  revision: 'Open revision',
  // Its preparer decides: resubmit it, or leave it as rejected.
  rejected: 'Open to decide',
}

export default function NotificationRow({
  notification,
  onOpen,
  onMarkRead,
  onDelete,
  deleting = false,
}: {
  notification: NotificationItem
  /** `toSign` when the row is an open request to sign, so signing opens with it. */
  onOpen: (documentId: string, options?: { toSign: boolean }) => void
  onMarkRead: (id: string) => void
  onDelete: (id: string) => void
  deleting?: boolean
}) {
  /*
   * A category this build has never heard of.
   *
   * `mapNotificationCategory` switches exhaustively over the types this build
   * knows, so one added by the API later maps to `undefined` - and destructuring
   * `CATEGORY[undefined]` threw during render, taking the entire inbox with it,
   * including the approvals waiting in it. `ActionBadge` guards exactly this
   * case; this row did not.
   */
  const { icon: Icon, tile: categoryTile } = CATEGORY[notification.category] ?? UNKNOWN_CATEGORY
  /*
   * Work that is finished. Its title and message were written when it was
   * sent - "Waiting for your approval", "is at your step" - and are kept as
   * the record of what was asked, so the row has to say in its own words that
   * the ask is over, and stop looking urgent.
   */
  const finished = FINISHED_WORK.has(notification.category) && !notification.needsAction
  const tile = finished ? 'bg-sunken text-content-muted' : categoryTile
  const documentId = notification.documentId
  const openLabel = OPEN_LABEL[notification.category] ?? 'Open document'
  const showOpenAction = Boolean(documentId) && isActionable(notification)

  const open = () => {
    if (!documentId) return
    if (!notification.isRead) onMarkRead(notification.id)
    onOpen(documentId, { toSign: openLabel === 'Open to sign' && Boolean(notification.needsAction) })
  }

  return (
    <article
      className={`flex gap-3 border-b border-line-soft px-3.75 py-3.25 transition-colors last:border-b-0 ${
        notification.isRead ? '' : 'bg-accent-soft/30'
      }`}
    >
      <span
        aria-hidden="true"
        className={`flex h-7.5 w-7.5 flex-shrink-0 items-center justify-center rounded-control ${tile}`}
      >
        <Icon size={15} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          {documentId ? (
            /* A real button, not a clickable row: the inline actions below
               live inside this same block and cannot be nested in one. */
            <button
              type="button"
              onClick={open}
              className="min-w-0 truncate text-left text-ui font-semibold text-content transition-colors hover:text-accent-ink"
              title={notification.title}
            >
              {notification.title}
            </button>
          ) : (
            <span className="min-w-0 truncate text-ui font-semibold text-content">
              {notification.title}
            </span>
          )}

          <span className="flex flex-shrink-0 items-center gap-2">
            <time
              dateTime={notification.createdAt}
              title={notification.displayDate}
              className="font-mono text-data text-content-subtle"
            >
              {notification.relativeTime}
            </time>
            {!notification.isRead && (
              <span
                className="h-1.75 w-1.75 flex-shrink-0 rounded-pill bg-accent-mark"
                aria-label="Unread"
                role="img"
              />
            )}
            <button
              type="button"
              onClick={() => onDelete(notification.id)}
              disabled={deleting}
              aria-label={`Delete notification: ${notification.title}`}
              title="Delete"
              className="inline-flex h-6 w-6 items-center justify-center rounded-control text-content-subtle transition-colors hover:bg-danger-soft hover:text-danger-ink disabled:opacity-50"
            >
              {deleting ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Trash2 size={13} />
              )}
            </button>
          </span>
        </div>

        <p className="mt-1 text-meta leading-relaxed text-content-muted">
          {notification.message}
        </p>

        {finished && (
          <p className="mt-1 text-meta font-medium text-content-subtle">
            {notification.category === 'revision'
              ? 'Done: this memo is no longer waiting on your revision.'
              : 'Done: this memo is no longer waiting on you.'}
          </p>
        )}

        {(showOpenAction || !notification.isRead) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {showOpenAction && (
              <Button size="sm" onClick={open}>
                {openLabel}
              </Button>
            )}
            {!notification.isRead && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onMarkRead(notification.id)}
              >
                Mark read
              </Button>
            )}
          </div>
        )}
      </div>
    </article>
  )
}
