import type { ApiApprovalType } from './document'
import type { MemoBody, MemoNote } from './memo'

export interface AssignableUser {
  id: string
  email: string
  firstName: string
  lastName: string
  /** Shown in the picker so a service or admin account is recognisable. */
  loginRole?: 'ADMINISTRATOR' | 'USER'
  /** Job title, as the directory holds it. Absent on older servers. */
  designation?: string | null
  department: { name: string } | null
}

export interface ApprovalChainStepInput {
  userId: string
  approvalType: ApiApprovalType
}

export interface PreparerSignatureInput {
  /** The preparer ticked "this is my signature". The server refuses without it. */
  consent: true
  useSavedSignature?: boolean
  signatureImage?: string
  signaturePage: number
  signatureX: number
  signatureY: number
  signatureWidth: number
  signatureHeight: number
}

export interface CreateDocumentInput {
  title: string
  description?: string
  /**
   * The attached PDF, for a memo written elsewhere.
   *
   * Exactly one of `file` and `body` is sent. The server refuses a submission
   * carrying both, because it would have no honest answer to which of them
   * the document is.
   */
  file?: File
  /** The memo, for one written in the portal. The server draws the PDF. */
  body?: MemoBody
  memoType?: string
  memoTo?: string
  memoFrom?: string
  /** The date the memo bears, as `2026-08-06`. Absent means today. */
  memoDate?: string
  /** Notes placed on the page. Absent or empty means the memo carries none. */
  notes?: MemoNote[]
  /** Exactly one of these two. A template is compiled into a chain server-side. */
  approvalChain?: ApprovalChainStepInput[]
  templateId?: string
  /**
   * The submitter's signature, where submitting means signing.
   *
   * Absent for a document whose author does not sign it — a memo type that
   * says so, or an organisation whose policy says so. The server refuses the
   * mismatch in both directions, so this is never a free choice made here.
   */
  signature?: PreparerSignatureInput
  supportingFiles?: File[]
  /**
   * The server-side draft this memo was written in, if there was one. The
   * submission deletes it in the same transaction that creates the document,
   * so an unfinished memo stops being offered the moment it is filed.
   */
  draftId?: string
}
