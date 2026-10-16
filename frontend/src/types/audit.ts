/* `ApiApprovalType` and `ApiDocumentStatus` used to be declared here too,
   identically to `types/document.ts` — except this copy had never gained
   'DELETED'. Two spellings of one backend enum drift silently: every consumer
   imports the document.ts pair, so the stale copy narrowed audit rows to a set
   of states the API can outgrow. One declaration, imported. */
import type { ApiDocumentStatus } from './document'

export type ApiApprovalActionType =
  | 'APPROVE'
  | 'REJECT'
  | 'REQUEST_REVISION'
  | 'SKIP'
  | 'DOCUMENT_UPLOADED'
  | 'DOCUMENT_RESUBMITTED'
  | 'DOCUMENT_DELETED'
  /* Withdrawn by its preparer, or cancelled by an administrator, each with
     its reason as the row's comment. DOCUMENT_DELETED is the older rows. */
  | 'DOCUMENT_WITHDRAWN'
  | 'DOCUMENT_CANCELLED'
  | 'REJECTION_CLOSED'
  | 'DOCUMENT_DOWNLOADED'
  | 'DOCUMENT_VIEWED'
  | 'DOCUMENT_PRINTED'
  /* Two things that happen to a memo with nobody approving anything: the step
     changed hands, or somebody asked the person holding it to look at it. */
  | 'WORKFLOW_STEP_REASSIGNED'
  | 'APPROVAL_REMINDER_SENT'

export interface ApiAuditUser {
  id: string
  firstName: string
  lastName: string
}

export interface ApiAuditEntry {
  id: string
  date: string
  time: string
  user: ApiAuditUser
  /**
   * Whose approval it was, where somebody signed it under a delegation. Null
   * on every ordinary row - and separate from `user`, because the two answer
   * different questions: who signed, and whose authority they carried.
   */
  onBehalfOf?: ApiAuditUser | null
  role: string
  action: string
  comments: string | null
  documentId: string
  /** The memo reference, or null for one issued before they existed. */
  documentReference?: string | null
  documentTitle: string
  documentStatus: ApiDocumentStatus
}

export interface AuditHistoryResponse {
  auditHistory: ApiAuditEntry[]
}

export type AuditActionLabel =
  | 'Approved'
  | 'Rejected'
  | 'Revision Requested'
  | 'Step Skipped'
  | 'Document Uploaded'
  | 'Document Resubmitted'
  | 'Document Withdrawn'
  | 'Document Cancelled'
  | 'Left as Rejected'
  | 'Downloaded'
  /* Opened on screen. Distinct from Downloaded since a copy did not leave the
     system - the trail used to call both of them a download. */
  | 'Viewed'
  | 'Printed'
  /* Not "Step Skipped", which is the opposite: skipping moves the memo on
     without that approval, this asks somebody else for it. */
  | 'Step Reassigned'
  | 'Reminder Sent'
  /* An action the backend has that this build does not know about yet.
     The alternative was the old fallback — labelling it "Approved" — which
     reported a positive outcome for an event nobody had identified. */
  | 'Unrecognised action'

export interface AuditRecord {
  id: string
  occurredAt: string
  date: string
  time: string
  document: string
  documentId: string
  /** What people quote: the memo reference, or the short id for an old memo. */
  documentReference: string
  documentStatus: ApiDocumentStatus
  user: string
  initials: string
  /** "Priya Nair", when this approval was signed in their place. */
  onBehalfOf: string | null
  role: string
  action: AuditActionLabel
  actionRaw: ApiApprovalActionType
  comments: string
}

export interface AuditDocumentGroup {
  documentId: string
  document: string
  documentStatus: ApiDocumentStatus
  actions: AuditRecord[]
  latestAction: AuditRecord
}
