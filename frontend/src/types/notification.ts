/**
 * Backend Prisma notification types.
 *
 * Kept in step with `NotificationType` in `schema.prisma`. Two were missing
 * here while the server was sending them: `APPROVAL_OVERDUE`, raised by the
 * deadline sweep, and `COMMENT_ADDED`. Neither broke the inbox - the row
 * falls back to a plain bell - but both arrived looking like nothing in
 * particular, which for an overdue approval is the wrong thing to look like.
 */
export type ApiNotificationType =
  | 'APPROVAL_NEEDED'
  | 'APPROVAL_OVERDUE'
  | 'APPROVAL_REMINDER'
  | 'COMMENT_ADDED'
  | 'REVISION_REQUESTED'
  | 'REJECTED'
  | 'APPROVED'
  | 'RESUBMITTED'
  | 'DOCUMENT_DELETED'
  | 'DELEGATION_STARTED'
  | 'DELEGATION_ENDED'
  | 'STEP_SKIPPED'
  | 'STEP_REASSIGNED'
  | 'SECURITY_ALERT'
  | 'SUBMITTED'
  | 'ESCALATED'

export interface ApiNotification {
  id: string
  type: ApiNotificationType
  title: string
  message: string
  documentId: string | null
  workflowRunId: string | null
  isRead: boolean
  readAt: string | null
  createdAt: string
  /**
   * Whether the memo is still waiting on the reader, worked out by the server
   * from the memo as it stands. An approval notice for a step already
   * decided, moved to somebody else, or on a deleted memo is false.
   */
  needsAction: boolean
}

export interface NotificationsListResponse {
  notifications: ApiNotification[]
}

/** UI category used for icon and badge styling */
export type NotificationUiCategory =
  | 'action'
  | 'overdue'
  | 'comment'
  | 'approved'
  | 'revision'
  | 'rejected'
  | 'submitted'
  | 'deleted'
  | 'delegation'
  | 'skipped'
  | 'reassigned'
  | 'security'
  | 'escalated'

export interface NotificationItem {
  id: string
  category: NotificationUiCategory
  title: string
  message: string
  documentId: string | null
  createdAt: string
  relativeTime: string
  displayDate: string
  isRead: boolean
  /** See `ApiNotification.needsAction`. */
  needsAction: boolean
}
