import type {
  ApiComment,
  ApiDocumentAuditEntry,
  ApiDocumentDetail,
  ApiWorkflowResponse,
} from '../types/documentDetail.ts'
import type { MemoBody, MemoNote } from '../types/memo'
import type { ApiMemoChanges } from '../types/memoChanges'
import { apiBlob, apiFetch, apiJson, apiVoid, jsonBody } from './apiClient'
import { parseApiError } from '../utils/apiError'
import { confirmedToSign, SIGNING_NOT_CONFIRMED } from './stepUp'

/** See utils/downloadDocument.ts, which holds the same URL for the same span. */
const REVOKE_AFTER_CLICK_MS = 10_000

export async function fetchDocumentById(
  documentId: string,
): Promise<ApiDocumentDetail> {
  return apiJson<ApiDocumentDetail>(`/api/documents/${documentId}`)
}

export async function fetchDocumentWorkflow(
  documentId: string,
): Promise<ApiWorkflowResponse> {
  return apiJson<ApiWorkflowResponse>(`/api/documents/${documentId}/workflow`)
}

export async function fetchDocumentComments(
  documentId: string,
): Promise<ApiComment[]> {
  const data = await apiJson<{ comments: ApiComment[] }>(
    `/api/documents/${documentId}/comments`,
  )
  return data.comments
}

export async function createDocumentComment(
  documentId: string,
  comment: string,
): Promise<ApiComment> {
  const data = await apiJson<{ comment: ApiComment }>(
    `/api/documents/${documentId}/comments`,
    { method: 'POST', ...jsonBody({ comment }) },
  )
  return data.comment
}

export async function fetchDocumentAuditHistory(
  documentId: string,
): Promise<ApiDocumentAuditEntry[]> {
  const data = await apiJson<{ auditHistory: ApiDocumentAuditEntry[] }>(
    `/api/documents/${documentId}/audit`,
  )
  return data.auditHistory
}

/** What changed between the version in flight and the one before it. */
export async function fetchDocumentChanges(
  documentId: string,
): Promise<ApiMemoChanges> {
  return apiJson<ApiMemoChanges>(`/api/documents/${documentId}/changes`)
}

/**
 * Why a caller wants the bytes. The server writes a different audit row for
 * each: reading a memo on screen is not taking a copy of it away, and the
 * trail is the only place that distinction can be kept.
 */
export type FileReason = 'view' | 'download'

/**
 * The in-flight request for a document's file, shared while it is in flight.
 *
 * The preview and the page thumbnails both need the same PDF and both mount
 * at once, so opening a memo fetched it twice: two round trips for the same
 * bytes, and two audit rows for one person opening one memo once. The sign
 * dialog makes it a third.
 *
 * Only the promise is shared, never a resolved blob. The moment it settles
 * the entry is dropped, so a later visit asks the server again - which is
 * what keeps a newly uploaded version, or a freshly signed one, from being
 * served out of a stale cache. That is the one bug a cache in front of a
 * document must not have.
 *
 * Only views are shared. A download is an event the record has to contain,
 * so it always makes its own request: handed a view's promise instead, the
 * bytes would still arrive and the row saying a copy left the system would
 * not be written - the sharing would be silently destroying evidence.
 */
const inFlightViews = new Map<string, Promise<Blob>>()

export async function fetchDocumentFile(
  documentId: string,
  reason: FileReason = 'download',
): Promise<Blob> {
  const url = `/api/documents/${documentId}/file?reason=${reason}`

  if (reason !== 'view') return apiBlob(url)

  const existing = inFlightViews.get(documentId)
  if (existing) return existing

  const request = apiBlob(url).finally(() => {
    inFlightViews.delete(documentId)
  })

  inFlightViews.set(documentId, request)
  return request
}

/**
 * Records that somebody put the final signed memo on paper. 204, no body.
 *
 * Separate from fetching the file because a printed copy leaves the system:
 * once it is in a folder nobody can tell from the app who took it out, and the
 * audit row is the only trace. The server refuses this unless the memo is
 * approved and its signed copy is fixed, so a 409 here means the caller
 * offered to print something that is still half-signed.
 */
export async function recordDocumentPrint(documentId: string): Promise<void> {
  await apiVoid(`/api/documents/${documentId}/print`, { method: 'POST' })
}

export async function fetchSupportingDocumentFile(
  documentId: string,
  attachmentId: string,
): Promise<{ blob: Blob; contentType: string }> {
  // Not `apiBlob`: the caller needs the Content-Type header to decide how to
  // render the attachment.
  const res = await apiFetch(
    `/api/documents/${documentId}/supporting/${attachmentId}/file`,
  )

  if (!res.ok) {
    throw new Error(await parseApiError(res))
  }

  const blob = await res.blob()
  const contentType =
    res.headers.get('Content-Type') || blob.type || 'application/octet-stream'

  return { blob, contentType }
}

export async function downloadSupportingDocument(
  documentId: string,
  attachmentId: string,
  fileName: string,
): Promise<void> {
  const { blob } = await fetchSupportingDocumentFile(documentId, attachmentId)
  const url = window.URL.createObjectURL(blob)
  const link = window.document.createElement('a')
  link.href = url
  link.download = fileName
  // Attached, and released a beat later, for the two reasons spelled out over
  // `downloadDocumentFile` in utils/downloadDocument.ts: Firefox drops a click
  // on a detached anchor, and Firefox and Safari are still reading the blob
  // after the click returns. Both failures are silent - the person gets no
  // file and no error.
  window.document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => window.URL.revokeObjectURL(url), REVOKE_AFTER_CLICK_MS)
}

/**
 * What replaces the current version: a new PDF, or the memo rewritten.
 *
 * Exactly one, never both - the server refuses both together rather than
 * silently preferring one and discarding an afternoon's editing.
 */
export type ResubmitReplacement =
  | { file: File }
  | {
      body: MemoBody
      memoTo?: string
      memoFrom?: string
      memoDate?: string
      title?: string
      /**
       * The notes placed on the page. The server reads a resubmission without
       * them as "every note removed", so a rewrite that leaves them where they
       * were has to send them back.
       */
      notes?: MemoNote[]
    }

export async function resubmitDocument(
  documentId: string,
  replacement: ResubmitReplacement | File,
  /**
   * The preparer's signature, where correcting a document means signing it.
   *
   * Undefined for a memo whose author is not a signatory. The server refuses
   * both mismatches, so this is never a free choice made here.
   */
  signature:
    | {
        useSavedSignature?: boolean
        signatureImage?: string
        signaturePage: number
        signatureX: number
        signatureY: number
        signatureWidth: number
        signatureHeight: number
      }
    | undefined,
  supportingFiles: File[] = [],
  /** Supporting files the current version carries that the new one should not. */
  removeSupportingIds: string[] = [],
): Promise<void> {
  // A bare File is how every existing caller asks for an upload, and there is
  // no reason for them to change.
  const replacing: ResubmitReplacement =
    replacement instanceof File ? { file: replacement } : replacement

  const formData = new FormData()

  if ('file' in replacing) {
    formData.append('file', replacing.file)
  } else {
    /*
     * As JSON in a multipart field, which is how the approval chain and the
     * signature already travel: the route parses these fields back before
     * validating them. Sent as a bare string it would reach the schema as a
     * string, and be refused with "expected object, received string".
     */
    formData.append('body', JSON.stringify(replacing.body))
    if (replacing.title !== undefined) formData.append('title', replacing.title)
    if (replacing.memoTo !== undefined) formData.append('memoTo', replacing.memoTo)
    if (replacing.memoFrom !== undefined) {
      formData.append('memoFrom', replacing.memoFrom)
    }
    if (replacing.memoDate !== undefined) {
      formData.append('memoDate', replacing.memoDate)
    }
    if (replacing.notes !== undefined) {
      formData.append('notes', JSON.stringify(replacing.notes))
    }
  }

  /* Only when there is one: an absent signature has to be an absent field,
     not the string "undefined". */
  if (signature) formData.append('signature', JSON.stringify(signature))

  /* Confirmed before the upload starts, not after the server refuses it: the
     PDF is sent once. Cancelling leaves the dialog open with its signature. */
  if (signature && !(await confirmedToSign())) {
    throw new Error(SIGNING_NOT_CONFIRMED)
  }

  for (const supporting of supportingFiles) {
    formData.append('supportingFiles', supporting)
  }
  if (removeSupportingIds.length > 0) {
    formData.append('removeSupportingIds', JSON.stringify(removeSupportingIds))
  }

  await apiVoid(`/api/documents/${documentId}`, { method: 'PATCH', body: formData })
}
