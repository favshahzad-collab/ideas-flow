/** Backend Prisma enums as returned by the API */
export type ApiDocumentStatus =
  | 'DRAFT'
  | 'PENDING_REVIEW'
  | 'REVISION_REQUESTED'
  | 'REJECTED'
  | 'APPROVED'
  | 'DELETED'

export type ApiApprovalType = 'REVIEWER' | 'APPROVER' | 'FINAL_APPROVER'

export interface ApiUserRef {
  id: string
  firstName: string
  lastName: string
}

export interface ApiDocumentCurrentStep {
  id: string
  stepOrder: number
  approvalType: ApiApprovalType
  assignedUser: ApiUserRef
}

export interface ApiDocumentWorkflow {
  currentStepOrder: number
  totalSteps: number
}

export interface ApiDocumentNextStep {
  stepOrder: number
  approvalType: ApiApprovalType
  assignedUser: ApiUserRef
}

export interface ApiDocument {
  id: string
  /** The quotable memo reference. Null for anything submitted before it existed. */
  referenceNumber: string | null
  /**
   * SHA-256 of the approved copy, fixed when the last approver signed. Null
   * until then, and for memos approved before digests were recorded.
   */
  finalSignedChecksum?: string | null
  /** Whose digital seal the approved copy carries; null when it is not sealed. */
  sealedBy?: string | null
  title: string
  description: string | null
  status: ApiDocumentStatus
  preparerId: string
  currentVersionNumber: number
  createdAt: string
  updatedAt: string
  submittedAt: string | null
  preparer: ApiUserRef
  currentStep: ApiDocumentCurrentStep | null
  nextStep?: ApiDocumentNextStep | null
  workflow: ApiDocumentWorkflow | null
  /** When the current step is due. Null when no deadline has been set for it. */
  dueAt?: string | null
  /**
   * The memo is at a step the viewer must act on now: their own, or one they
   * are covering for somebody. What My queue and its badge are both built on.
   */
  awaitingMyAction: boolean
}

export interface DocumentsListResponse {
  documents: ApiDocument[]
}

/** Normalized status values used by UI components */
export type DocumentStatus =
  | 'draft'
  | 'pending_review'
  | 'pending_approval'
  | 'revision_requested'
  | 'approved'
  | 'rejected'
  | 'deleted'

export type FileType = 'pdf'

/** View model consumed by dashboard and document list pages */
export interface DashboardDocument {
  id: string
  /** The quotable memo reference, or null for one issued before they existed. */
  referenceNumber: string | null
  title: string
  description: string
  status: DocumentStatus
  preparerId: string
  submittedBy: string
  submittedByInitials: string
  currentHolder: string
  /**
   * Initials for `currentHolder`, or null when the holder is not a
   * person — a finished document reads "Completed", and an avatar
   * beside that word is meaningless. Distinct from
   * `submittedByInitials`: the holder and the submitter are usually
   * different people, and showing one against the other's name is how
   * a table quietly lies.
   */
  currentHolderInitials: string | null
  currentStep: number
  totalSteps: number
  lastUpdated: string
  submittedDate: string
  submittedAt: string
  updatedAt: string
  versionNumber: number
  approvalType: ApiApprovalType | null
  actionLabel: string
  /** Who receives it after the current holder acts; null when this is the last step. */
  nextHolder: string | null
  fileType: FileType
  isAwaitingMyAction: boolean
  /**
   * When the step this is sitting on is due, or null when nothing has set a
   * deadline for it. Null is the delivered default and is not a gap in the
   * data: a deadline is a commitment an organisation makes, so the API
   * answers null rather than a date nobody agreed to, and the table shows age
   * instead of a countdown.
   */
  dueAt: string | null
}

/** Administrator oversight: one row per workflow currently in flight. */
export interface OversightPerson {
  id: string
  firstName: string
  lastName: string
  department: string | null
}

export interface OversightItem {
  id: string
  /** The quotable memo reference, or null for one issued before they existed. */
  referenceNumber: string | null
  title: string
  versionNumber: number
  submittedAt: string
  updatedAt: string
  /** When it reached the current holder, which is the number being chased. */
  heldSince: string
  preparer: OversightPerson
  holder: (OversightPerson & { approvalType: ApiApprovalType }) | null
  currentStepOrder: number
  totalSteps: number
  /** When the current step is due; null when no deadline is set. */
  dueAt: string | null
  /** When the holder was chased about it running over; null if they have not been. */
  chasedAt: string | null
}

export interface OversightResponse {
  items: OversightItem[]
  total: number
}
