import type { DocumentsListResponse, OversightResponse } from '../types/document'
import type { CreateDocumentInput, PreparerSignatureInput } from '../types/submitDocument'
import { apiJson, jsonBody } from './apiClient'
import { uploadMultipart, type UploadProgress } from './uploadClient'
import { confirmedToSign, SIGNING_NOT_CONFIRMED } from './stepUp'
import { createCachedRequest } from '../utils/requestCache'

export async function fetchDocuments(): Promise<DocumentsListResponse> {
  return apiJson<DocumentsListResponse>('/api/documents')
}

export async function fetchPendingApprovalCount(): Promise<{ count: number }> {
  return apiJson<{ count: number }>('/api/documents/pending-count')
}

/** Every workflow in flight across the organisation. Administrators only. */
export async function fetchApprovalOversight(): Promise<OversightResponse> {
  return apiJson<OversightResponse>('/api/documents/oversight')
}

// Documents, My queue and the app shell's badge counts
// all read the same document list on a typical page load. Cache briefly and
// dedupe concurrent requests so that navigation triggers one network call
// instead of several.
const documentsCache = createCachedRequest(fetchDocuments, 4000)
const pendingCountCache = createCachedRequest(fetchPendingApprovalCount, 4000)

export function fetchDocumentsCached(force = false): Promise<DocumentsListResponse> {
  return documentsCache.get(force)
}

export function invalidateDocumentsCache(): void {
  documentsCache.invalidate()
  pendingCountCache.invalidate()
}

export function fetchPendingApprovalCountCached(force = false): Promise<{ count: number }> {
  return pendingCountCache.get(force)
}

export async function createDocument(
  input: CreateDocumentInput,
  options: {
    onProgress?: (progress: UploadProgress) => void
    signal?: AbortSignal
  } = {},
) {
  const formData = new FormData()
  formData.append('title', input.title.trim())

  if (input.description?.trim()) {
    formData.append('description', input.description.trim())
  }

  /*
   * One of the two, never both.
   *
   * An attached PDF is sent as a file, as it always has been. A memo written
   * in the portal is sent as its body and header fields, and the server draws
   * the PDF at exactly the point the uploaded one would have arrived - so
   * everything downstream of that line is the same code either way.
   */
  if (input.file) {
    formData.append('file', input.file)
  } else if (input.body) {
    formData.append('body', JSON.stringify(input.body))
    if (input.memoType) formData.append('memoType', input.memoType)
    if (input.memoTo) formData.append('memoTo', input.memoTo)
    if (input.memoFrom) formData.append('memoFrom', input.memoFrom)
    if (input.memoDate) formData.append('memoDate', input.memoDate)

    /* As JSON in a multipart field, the way the body and the chain already
       travel: the route parses these back before validating them. */
    if (input.notes?.length) {
      formData.append('notes', JSON.stringify(input.notes))
    }
  }

  // Exactly one of the two — the API rejects both together and neither alone.
  // A template is compiled into a chain server-side at submit time.
  if (input.templateId) {
    formData.append('templateId', input.templateId)
  } else {
    formData.append('approvalChain', JSON.stringify(input.approvalChain ?? []))
  }

  /*
   * The draft this was written in, so the server can delete it in the same
   * transaction that files the memo. Left out for a memo that was never a
   * draft, which is most uploads.
   */
  if (input.draftId) formData.append('draftId', input.draftId)

  /* Only when there is one. An absent signature has to be an absent field,
     not the string "undefined": the server reads this part as JSON and
     refuses a signature offered on a document nobody signs at submission. */
  if (input.signature) {
    formData.append('signature', JSON.stringify(input.signature))
  }

  /* Confirmed before the upload starts, not after the server refuses it: the
     PDF is sent once. Cancelling leaves the dialog open with its signature. */
  if (input.signature && !(await confirmedToSign())) {
    throw new Error(SIGNING_NOT_CONFIRMED)
  }


  for (const supporting of input.supportingFiles ?? []) {
    formData.append('supportingFiles', supporting)
  }

  // Sent over XHR rather than fetch so the upload can report progress and be
  // cancelled; a submission can carry up to 120 MB.
  const result = await uploadMultipart<unknown>('/api/documents', formData, {
    onProgress: options.onProgress,
    signal: options.signal,
  })

  invalidateDocumentsCache()
  return result
}

/**
 * Withdraw a memo, with a reason. It stays on record and can be resubmitted.
 * Replaces deleting (fit-gap decision 3).
 */
export async function withdrawDocument(documentId: string, reason: string) {
  const result = await apiJson<{ message: string }>(`/api/documents/${documentId}/withdraw`, {
    method: 'POST',
    ...jsonBody({ reason }),
  })

  invalidateDocumentsCache()
  return result
}

/** Cancel an abandoned memo, by an administrator with the power to. */
export async function cancelDocument(documentId: string, reason: string) {
  const result = await apiJson<{ message: string }>(`/api/documents/${documentId}/cancel`, {
    method: 'POST',
    ...jsonBody({ reason }),
  })

  invalidateDocumentsCache()
  return result
}

/**
 * Leave a rejected memo as rejected: its preparer decides not to send it round
 * again. Final; the memo stays on record as rejected.
 */
export async function leaveRejected(documentId: string) {
  const result = await apiJson<{ id: string; rejectionClosedAt: string }>(
    `/api/documents/${documentId}/leave-rejected`,
    { method: 'POST' },
  )

  invalidateDocumentsCache()
  return result
}

export type { PreparerSignatureInput }
