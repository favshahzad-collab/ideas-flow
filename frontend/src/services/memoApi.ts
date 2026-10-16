import type {
  MemoBody,
  MemoNote,
  MemoPageGeometry,
  MemoPreviewResponse,
  MemoTypeDefinition,
} from '../types/memo'
import type { ApprovalChainStepInput } from '../types/submitDocument'
import { apiJson, jsonBody } from './apiClient'

export async function fetchMemoTypes(): Promise<{
  memoTypes: MemoTypeDefinition[]
  page: MemoPageGeometry
}> {
  return apiJson<{ memoTypes: MemoTypeDefinition[]; page: MemoPageGeometry }>(
    '/api/memo-types',
  )
}

export interface MemoPreviewRequest {
  title?: string
  memoTo?: string
  memoFrom?: string
  /** `2026-08-06`. Absent means today, or the date the memo already bears. */
  memoDate?: string
  /** Which kind of memo, which decides whether the preparer gets a line. */
  memoType?: string
  /** Notes placed on the page, drawn on the preview as filing will draw them. */
  notes?: MemoNote[]
  body: MemoBody
  chain?: ApprovalChainStepInput[]
  /**
   * The memo being rewritten, when this is a preview of a revision.
   *
   * The server then takes the chain - and any header field left out here -
   * off that document. Sending a chain reassembled on this side would risk
   * drawing a strip with a different number of columns from the one the
   * resubmission files, which moves the very line the preparer is about to
   * sign on.
   */
  documentId?: string
}

/**
 * The memo as it will be filed, drawn now.
 *
 * Nothing is saved by this call. It exists because the preparer's signature is
 * placed by dragging a box onto a page and a typed memo has no page until the
 * server draws one - so this is what they sign on.
 *
 * Which is also why it must be asked for again at the moment of signing rather
 * than cached from an earlier look: the signature strip sits under the text, so
 * editing the memo moves the lines the signatures go on.
 */
export async function previewMemo(
  request: MemoPreviewRequest,
  options: { signal?: AbortSignal } = {},
): Promise<MemoPreviewResponse> {
  return apiJson<MemoPreviewResponse>('/api/memo-drafts/preview', {
    /*
     * `jsonBody` sets the header and the body and nothing else, so without
     * this the request went out as a GET carrying a body - which the fetch
     * API refuses outright. The preview never fired, and the signing dialog
     * it feeds never opened.
     */
    method: 'POST',
    ...jsonBody(request),
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

/**
 * The preview as a file the PDF viewer can open.
 *
 * Named for the memo rather than "preview.pdf": this is the name the browser
 * uses if somebody saves it out of the viewer, and a folder of files all
 * called preview.pdf helps nobody.
 */
export function previewToFile(pdfBase64: string, title: string): File {
  const binary = atob(pdfBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  const safeTitle = title.trim().replace(/[^\w\-. ]+/g, '').slice(0, 80)

  return new File([bytes], `${safeTitle || 'memo'}.pdf`, {
    type: 'application/pdf',
  })
}
