import { apiJson, jsonBody } from './apiClient'
import { invalidateDocumentsCache } from './documentsApi'

export async function rejectDocument(documentId: string, comment?: string) {
  const result = await apiJson<unknown>(`/api/documents/${documentId}/reject`, {
    method: 'POST',
    ...jsonBody({ comment: comment?.trim() || undefined }),
  })

  invalidateDocumentsCache()
  return result
}

export async function requestRevision(documentId: string, comment: string) {
  const result = await apiJson<unknown>(`/api/documents/${documentId}/request-revision`, {
    method: 'POST',
    ...jsonBody({ comment: comment.trim() }),
  })

  invalidateDocumentsCache()
  return result
}

export async function skipWorkflowStep(documentId: string, reason: string) {
  const result = await apiJson<unknown>(`/api/documents/${documentId}/skip-step`, {
    method: 'POST',
    ...jsonBody({ reason: reason.trim() }),
  })

  invalidateDocumentsCache()
  return result
}

export interface ReassignStepResult {
  message: string
  /** Where the memo is, which moving a step ahead of it does not change. */
  currentStepOrder: number
  /** The step that actually moved. The same number, for the current step. */
  stepOrder: number
  movedFrom: { id: string; firstName: string; lastName: string }
  movedTo: { id: string; firstName: string; lastName: string }
}

/**
 * Hand a step to a different approver.
 *
 * `stepOrder` left out means the step the memo is sitting on, which is what
 * this could do to begin with. Naming one moves a step still ahead of the
 * memo - the approver who has left but is not holding it yet, whose memo
 * stops just as completely when it gets to them.
 *
 * Every list shows who a memo is with, so the caches do have to go: this is
 * the one action that changes that answer without changing the memo's status
 * or moving it on a step.
 */
export async function reassignStep(
  documentId: string,
  userId: string,
  reason: string,
  stepOrder?: number,
) {
  const result = await apiJson<ReassignStepResult>(
    `/api/documents/${documentId}/reassign-step`,
    {
      method: 'POST',
      ...jsonBody({
        userId,
        reason: reason.trim(),
        ...(stepOrder === undefined ? {} : { stepOrder }),
      }),
    },
  )

  invalidateDocumentsCache()
  return result
}

/**
 * Ask whoever is holding the memo to look at it.
 *
 * No `invalidateDocumentsCache`: nothing about the memo changes. A reminder
 * moves no step, alters no status, and the only trace it leaves is a notice
 * in somebody else's inbox - so refetching every list would be a page of work
 * to redraw exactly what is already on screen.
 */
export async function remindApprover(documentId: string) {
  return apiJson<{ message: string; remindedUserId: string; recipients: number }>(
    `/api/documents/${documentId}/remind`,
    { method: 'POST' },
  )
}

export interface ApproveDocumentPayload {
  /** The signer ticked "this is my signature". The server refuses without it. */
  consent: true
  useSavedSignature?: boolean
  signatureImage?: string
  signaturePage: number
  signatureX: number
  signatureY: number
  signatureWidth: number
  signatureHeight: number
}

export async function approveDocument(
  documentId: string,
  payload: ApproveDocumentPayload,
) {
  const result = await apiJson<unknown>(`/api/documents/${documentId}/approve`, {
    method: 'POST',
    ...jsonBody(payload),
  })

  invalidateDocumentsCache()
  return result
}
