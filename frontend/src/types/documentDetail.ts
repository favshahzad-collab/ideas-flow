import type { AuditActionLabel } from './audit'
import type { PdfPlacement } from '../utils/pdfCoordinates'
import type { MemoBody, MemoNote } from './memo'
import type {
  ApiApprovalType,
  ApiDocument,
  ApiDocumentStatus,
  DocumentStatus,
} from './document'

export interface ApiDocumentVersion {
  id: string
  versionNumber: number
  storagePath: string
  uploadedAt: string
  /**
   * What this version's PDF was drawn from, for a memo typed in the portal.
   * Null for an uploaded one, and for every version written before in-app
   * authoring existed.
   */
  bodyJson?: MemoBody | null
  /** Notes placed on the page of this version, as it was drawn. */
  pageNotesJson?: MemoNote[] | null
}

export interface ApiSupportingDocument {
  id: string
  fileName: string
  contentType: string
  sizeBytes: number
  uploadedAt: string
  /** The version it was first attached to. */
  addedInVersion?: number
  /** The version it was taken off, or null while it is still attached. */
  removedInVersion?: number | null
}

export interface ApiDocumentDetail extends Omit<ApiDocument, 'currentStep' | 'workflow' | 'awaitingMyAction'> {
  versions: ApiDocumentVersion[]
  supportingDocuments?: ApiSupportingDocument[]
  /** Every attachment the memo has had, current and taken off. */
  supportingHistory?: ApiSupportingDocument[]
  /** Whether resubmitting this memo needs the preparer's signature (server's rule). */
  resubmissionSigned?: boolean
  /** Why it was withdrawn or cancelled, for a memo that was. */
  withdrawalReason?: string | null
  withdrawnById?: string | null
  /** When its preparer left it as rejected. */
  rejectionClosedAt?: string | null
  approvalChain: {
    steps: {
      id: string
      stepOrder: number
      approvalType: ApiApprovalType
      assignedUser: { id: string; firstName: string; lastName: string }
    }[]
  } | null
  currentWorkflowRun: {
    id: string
    status: string
    currentStepOrder: number
  } | null
  currentStep?: {
    id: string
    stepOrder: number
    approvalType: ApiApprovalType
    assignedUser: { id: string; firstName: string; lastName: string }
  } | null
  /**
   * Which template drew this memo, and the two address lines it prints.
   * Null together for an uploaded memo, which has no template and no header
   * of its own - the PDF is the document.
   */
  memoType?: string | null
  memoTo?: string | null
  memoFrom?: string | null
  /** A date-only column, so the API sends midnight UTC on that day. */
  memoDate?: string | null
  /**
   * Where THIS reader's signature belongs on the version in flight, when the
   * memo prints a ruled line with their name under it.
   *
   * Optional on the wire, so a client left open across a deploy of the older
   * server keeps working - it simply gets no line offered, which is how
   * signing worked before.
   */
  mySignatureSlot?: {
    key?: string
    name: string
    page: number
    x: number
    y: number
    width: number
    height: number
  } | null
}

export interface ApiWorkflowStep {
  stepOrder: number
  approvalType: ApiApprovalType
  assignedUser: { id: string; firstName: string; lastName: string }
  status: string
  actedAt: string | null
  comment: string | null
}

export interface ApiWorkflowResponse {
  documentId: string
  documentStatus: ApiDocumentStatus
  workflowStatus: string | null
  currentStepOrder: number | null
  workflow: ApiWorkflowStep[] | undefined
  /**
   * What the server says this reader may do with the step the memo is sitting
   * at, and whose step it is if it is not their own.
   *
   * Optional on the wire so a client open across a deploy of the older server
   * keeps working; the hook falls back to reading the chain, which is what it
   * used to do for everybody.
   */
  viewer?: {
    canAct: boolean
    onBehalfOf: { id: string; firstName: string; lastName: string } | null
  }
  /**
   * The rules this memo's approval cycle runs under: the ones it started
   * with, not whatever the policy screen says today. Null with no cycle;
   * absent from an older server, when the deployment-wide answer stands in.
   */
  policy?: { allowStepSkip: boolean } | null
}

export interface ApiComment {
  id: string
  comment: string
  createdAt: string
  author: { id: string; firstName: string; lastName: string }
}

export interface ApiDocumentAuditEntry {
  id: string
  date: string
  time: string
  user: { id: string; firstName: string; lastName: string }
  role: string
  action: string
  comments: string | null
}

export type WorkflowStepStatus = 'completed' | 'current' | 'pending' | 'skipped'

export interface DocumentDetailView {
  id: string
  /** Why it was withdrawn or cancelled; null for a memo that was not. */
  withdrawalReason?: string | null
  /** Who withdrew or cancelled it: the preparer, or an administrator. */
  withdrawnById?: string | null
  /** When its preparer left it as rejected, closing it; null while still theirs to decide. */
  rejectionClosedAt?: string | null
  /** The quotable memo reference, or null for one issued before they existed. */
  referenceNumber: string | null
  /**
   * The digest of the approved copy, for anyone who needs to prove the file
   * in their hand is the one that was signed. Null until it is approved.
   */
  checksum: string | null
  /** Whose digital seal the approved copy carries; null when it is not sealed. */
  sealedBy: string | null
  title: string
  description: string
  status: DocumentStatus
  preparerId: string
  preparerName: string
  submittedDate: string
  lastUpdated: string
  currentHolder: string
  /**
   * Who that is, where it is a person on the chain rather than a word.
   *
   * Null on a finished memo - "Completed" is not somebody - and null while it
   * is back with the preparer for a revision. Read by the controls that need
   * to say something about the holder rather than merely print their name.
   */
  currentHolderId: string | null
  fileName: string
  versionNumber: number
  /**
   * Which template draws this memo, or null where it was uploaded as a PDF.
   *
   * What it decides on this screen: an uploaded memo is revised by uploading
   * a new PDF, and a typed one by rewriting the text. Offering the wrong one
   * of those is offering a control the server will refuse.
   */
  memoType: string | null
  /** The two lines its header prints. Null for an uploaded memo. */
  memoTo: string | null
  memoFrom: string | null
  /**
   * The date the memo bears, as `2026-08-06` - not the date it was
   * submitted. Null for an uploaded memo, and for a typed one filed before
   * the date was the preparer's to set.
   */
  memoDate: string | null
  /**
   * The body of the version in flight, for the preparer to pick up and
   * rewrite. Null for an uploaded memo, and for a typed one submitted before
   * the body was recorded.
   */
  memoBody: MemoBody | null
  /** Notes placed on the page of the version in flight. Empty when there are none. */
  memoNotes: MemoNote[]
  /**
   * Whether a resubmission must carry the preparer's signature, as the server
   * decides it from the memo's type. Null from a server too old to say.
   */
  resubmissionSigned: boolean | null
  /**
   * Where this reader's own signature belongs on the memo, already in the
   * coordinates the signing dialog works in. Null where the memo prints no
   * line for them.
   */
  mySignatureSlot: PdfPlacement | null
}

export interface WorkflowStepView {
  id: string
  step: number
  type: string
  user: string
  /**
   * Whose step it is. The preparer's row carries their id too, so a control
   * that has to know "everybody already on this memo" gets the whole list
   * from one place rather than the chain plus a separate field for the one
   * person who is on it without being on it.
   */
  userId: string
  initials: string
  date?: string
  status: WorkflowStepStatus
  comment?: string | null
}

export interface CommentView {
  id: string
  user: string
  initials: string
  comment: string
  date: string
}

export interface DocumentAuditView {
  id: string
  date: string
  time: string
  user: string
  role: string
  /* `buildDocumentAuditViews` already runs this through
     `mapAuditActionLabel`, so the union is what it holds — typing it
     `string` was what let the badge below it ignore which action it was. */
  action: AuditActionLabel
  comment: string
}

/**
 * Why a memo came back, for the person who has to act on it.
 *
 * Both dialogs refuse to send without a comment - on a revision request the
 * comment is the entire actionable content of the state the preparer lands in
 * - and it was only ever readable two tabs away under Comments.
 */
export interface ActionReasonView {
  /** Who wrote it. */
  user: string
  /** Their words, verbatim. */
  comment: string
  date: string
}

export interface SupportingDocumentView {
  id: string
  fileName: string
  contentType: string
  sizeLabel: string
  uploadedAt: string
  /** Which versions carried it: "Since version 2", "Versions 1–2". */
  versionsLabel?: string
}

export interface DocumentDetailData {
  document: DocumentDetailView
  workflowSteps: WorkflowStepView[]
  completedSteps: number
  totalSteps: number
  reviewers: number
  approvers: number
  workflowSummary: string
  comments: CommentView[]
  auditRecords: DocumentAuditView[]
  /** The reason behind a revision request or a rejection, if there is one. */
  returnedReason: ActionReasonView | null
  supportingDocuments: SupportingDocumentView[]
  /** Files an earlier version carried and the current one does not. */
  earlierSupportingDocuments?: SupportingDocumentView[]
  canApprove: boolean
  pendingActionType: ApiApprovalType | null
  canResubmit: boolean
  canSkipStep: boolean
  /**
   * Whose approval this reader would be giving, when it is not their own.
   *
   * Null in the ordinary case. Set only while covering somebody's approvals,
   * and said out loud before they sign: the page they sign will read "Signed
   * for Tom Becker", and that is not a thing to discover afterwards.
   */
  actingFor: { id: string; firstName: string; lastName: string } | null
}

/** Document detail without user-specific action flags (set in useDocumentDetail). */
export type AssembledDocumentDetailData = Omit<
  DocumentDetailData,
  | 'canApprove'
  | 'pendingActionType'
  | 'canResubmit'
  | 'canSkipStep'
  | 'actingFor'
>
