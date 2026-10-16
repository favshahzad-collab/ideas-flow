import type {
  ApiNotification,
  ApiNotificationType,
  NotificationItem,
  NotificationUiCategory,
} from '../types/notification'
import { formatDisplayDate, formatRelativeTime } from './format'

export function mapNotificationCategory(
  type: ApiNotificationType,
): NotificationUiCategory {
  switch (type) {
    case 'APPROVAL_NEEDED':
      return 'action'
    // Its own category rather than folded into `action`: the difference
    // between "this needs you" and "this needed you three days ago" is the
    // whole reason the sweep exists.
    case 'APPROVAL_OVERDUE':
      return 'overdue'
    /*
     * "Needs you", not "Overdue". Somebody asked for it to be looked at; that
     * is not a statement that a deadline has passed, and most memos here have
     * no deadline set on them at all. Filing a nudge as overdue would put a
     * late-looking row in the inbox for a memo nothing ever said was late.
     */
    case 'APPROVAL_REMINDER':
      return 'action'
    case 'COMMENT_ADDED':
      return 'comment'
    case 'APPROVED':
      return 'approved'
    case 'REVISION_REQUESTED':
      return 'revision'
    case 'REJECTED':
      return 'rejected'
    case 'RESUBMITTED':
      return 'submitted'
    case 'DOCUMENT_DELETED':
      return 'deleted'
    /*
     * Somebody's approvals moved, in one direction or the other. One category
     * for both, because the two are opposites and the title is what says
     * which - a delegate reading a list needs "covering" and "no longer
     * covering" to look like the same kind of fact, not two unrelated ones.
     */
    case 'DELEGATION_STARTED':
    case 'DELEGATION_ENDED':
      return 'delegation'
    // The reader was passed over. News, not work: there is nothing left for
    // them to do on that memo. It used to arrive as APPROVAL_NEEDED, which
    // put it in "Needs you" behind a button reading "Open to sign".
    case 'STEP_SKIPPED':
      return 'skipped'
    /*
     * The step moved to somebody else. Its own category rather than
     * `skipped`, which means the opposite of the thing that happened: skipped
     * says the memo went on with that approval never given, this says the
     * approval is still required and is now another person's. One row is the
     * reader losing a job, the other is the reader's job being dropped.
     *
     * The reader here is the approver it was taken from, or the preparer
     * watching it - or, where the step moved is one the memo has not reached
     * yet, the approver put ON it: being added to a chain is news too, and
     * APPROVAL_NEEDED would file it under "Needs you" behind a button reading
     * "Open to sign" when there is nothing to sign until the memo arrives.
     * Only a step the memo is actually sitting on arrives as work.
     */
    case 'STEP_REASSIGNED':
      return 'reassigned'
    // The protection on the reader's own account changed. Its own category
    // because it is the only notification that is not about a memo at all -
    // it carries no documentId, so nothing in the row can link anywhere.
    case 'SECURITY_ALERT':
      return 'security'
    // The preparer's receipt: their memo went in. News, like a resubmission.
    case 'SUBMITTED':
      return 'submitted'
    /*
     * A memo that is well past its deadline, told to the approver's line
     * manager and to the administrators who watch the control room. They
     * cannot sign it - it is for them to chase - so it is not "Needs you".
     */
    case 'ESCALATED':
      return 'escalated'
  }
}

export function mapApiNotificationToItem(
  notification: ApiNotification,
): NotificationItem {
  return {
    id: notification.id,
    category: mapNotificationCategory(notification.type),
    title: notification.title,
    message: notification.message,
    documentId: notification.documentId,
    createdAt: notification.createdAt,
    relativeTime: formatRelativeTime(notification.createdAt),
    displayDate: formatDisplayDate(notification.createdAt),
    isRead: notification.isRead,
    needsAction: notification.needsAction,
  }
}
