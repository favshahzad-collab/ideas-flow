import type {
  ApiApprovalActionType,
  ApiAuditEntry,
  AuditActionLabel,
  AuditRecord,
} from '../types/audit'
import { formatDisplayDate, formatMemoReference } from './format'
import { formatFullName, getInitials } from './user'

const ACTION_LABELS: Record<ApiApprovalActionType, AuditActionLabel> = {
  APPROVE: 'Approved',
  REJECT: 'Rejected',
  REQUEST_REVISION: 'Revision Requested',
  SKIP: 'Step Skipped',
  DOCUMENT_UPLOADED: 'Document Uploaded',
  DOCUMENT_RESUBMITTED: 'Document Resubmitted',
  DOCUMENT_DELETED: 'Document Withdrawn',
  DOCUMENT_WITHDRAWN: 'Document Withdrawn',
  DOCUMENT_CANCELLED: 'Document Cancelled',
  REJECTION_CLOSED: 'Left as Rejected',
  DOCUMENT_DOWNLOADED: 'Downloaded',
  DOCUMENT_VIEWED: 'Viewed',
  DOCUMENT_PRINTED: 'Printed',
  WORKFLOW_STEP_REASSIGNED: 'Step Reassigned',
  APPROVAL_REMINDER_SENT: 'Reminder Sent',
}

const ROLE_LABELS: Record<string, string> = {
  REVIEWER: 'Reviewer',
  APPROVER: 'Approver',
  FINAL_APPROVER: 'Final Approver',
  Preparer: 'Preparer',
  Viewer: 'Viewer',
  // The capacity somebody moved a step or chased one in. Neither is an
  // approval, so neither carries an approval type to be named by.
  Administrator: 'Administrator',
}

function formatTime(isoDate: string): string {
  return new Date(isoDate).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

export function mapAuditActionLabel(action: string): AuditActionLabel {
  if (action in ACTION_LABELS) {
    return ACTION_LABELS[action as ApiApprovalActionType]
  }

  return 'Unrecognised action'
}

export function mapAuditRoleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role
}

export function mapApiAuditEntryToRecord(entry: ApiAuditEntry): AuditRecord {
  const actionRaw = entry.action as ApiApprovalActionType

  return {
    id: entry.id,
    occurredAt: entry.date,
    date: formatDisplayDate(entry.date),
    time: formatTime(entry.date),
    document: entry.documentTitle,
    documentId: entry.documentId,
    documentReference: formatMemoReference(entry.documentReference, entry.documentId),
    documentStatus: entry.documentStatus,
    user: formatFullName(entry.user.firstName, entry.user.lastName),
    initials: getInitials(entry.user.firstName, entry.user.lastName),
    // The initials stay the signer's: the avatar is who put their name to it.
    onBehalfOf: entry.onBehalfOf
      ? formatFullName(entry.onBehalfOf.firstName, entry.onBehalfOf.lastName)
      : null,
    role: mapAuditRoleLabel(entry.role),
    action: mapAuditActionLabel(entry.action),
    actionRaw,
    comments: entry.comments?.trim() || '—',
  }
}

export function getAuditActionFilterOptions(
  records: AuditRecord[],
): string[] {
  const labels = new Set(records.map(record => record.action))
  return ['All Actions', ...Array.from(labels).sort()]
}
