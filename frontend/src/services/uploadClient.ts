import { getAuthToken } from './authTokens'
import { askForStepUp, currentStepUp, STEP_UP_CODES } from './stepUp'
import { apiFetch } from './apiClient'

/**
 * A multipart upload that reports progress and can be cancelled.
 *
 * Everything else in the app goes through `apiFetch`, and should. But `fetch`
 * cannot report *upload* progress — only download — and a submission here can
 * carry the main PDF plus five attachments at 20 MB each. Watching a disabled
 * button for two minutes with no signal is not an acceptable answer to "is
 * this working?", so this one call uses XMLHttpRequest, which does emit
 * `upload.onprogress`.
 *
 * The 401-refresh behaviour still comes from `apiFetch`: on a 401 we hand off
 * to it once so the shared single-flight refresh runs, then replay here.
 */

export interface UploadProgress {
  /** Bytes sent so far. */
  loaded: number
  /** Total bytes, or 0 when the browser cannot say. */
  total: number
  /** 0–1, or null while the total is unknown. */
  fraction: number | null
}

export class UploadCancelledError extends Error {
  constructor() {
    super('Upload cancelled')
    this.name = 'UploadCancelledError'
  }
}

function messageFromResponse(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string }
    const message = parsed.error?.message ?? parsed.message
    if (message) return message
  } catch {
    // Not JSON — fall through to the status-based message.
  }
  if (status === 413) return 'The upload is larger than the server accepts.'
  if (status === 0) return 'The connection dropped before the upload finished.'
  return `Request failed with status ${status}`
}

function sendOnce(
  url: string,
  body: FormData,
  options: {
    method: string
    signal?: AbortSignal
    onProgress?: (progress: UploadProgress) => void
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(options.method, url, true)

    const token = getAuthToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    // The same confirmation `apiFetch` sends: an upload that carries a
    // signature is refused without one.
    const stepUp = currentStepUp()
    if (stepUp) xhr.setRequestHeader('X-Step-Up', stepUp)

    // No Content-Type: the browser sets its own multipart boundary.

    if (options.onProgress) {
      xhr.upload.onprogress = event => {
        options.onProgress?.({
          loaded: event.loaded,
          total: event.lengthComputable ? event.total : 0,
          fraction: event.lengthComputable && event.total > 0
            ? event.loaded / event.total
            : null,
        })
      }
    }

    const onAbort = () => xhr.abort()
    options.signal?.addEventListener('abort', onAbort)

    const cleanup = () => options.signal?.removeEventListener('abort', onAbort)

    xhr.onload = () => {
      cleanup()
      resolve({ status: xhr.status, body: xhr.responseText })
    }
    xhr.onerror = () => {
      cleanup()
      reject(new Error('The connection dropped before the upload finished.'))
    }
    xhr.onabort = () => {
      cleanup()
      reject(new UploadCancelledError())
    }

    xhr.send(body)
  })
}

export async function uploadMultipart<T>(
  url: string,
  body: FormData,
  options: {
    method?: string
    signal?: AbortSignal
    onProgress?: (progress: UploadProgress) => void
  } = {},
): Promise<T> {
  const method = options.method ?? 'POST'

  let result = await sendOnce(url, body, { ...options, method })

  if (result.status === 401) {
    // Let the shared client run its single-flight refresh, then replay. A
    // cheap authenticated GET is enough to trigger it.
    await apiFetch('/api/auth/me').catch(() => undefined)
    result = await sendOnce(url, body, { ...options, method })
  }

  // Asked to confirm it is them, as `apiFetch` would be: ask once and resend.
  const purpose = result.status === 403 ? STEP_UP_CODES[errorCodeOf(result.body) ?? ''] : undefined
  if (purpose && (await askForStepUp(purpose))) {
    result = await sendOnce(url, body, { ...options, method })
  }

  if (result.status < 200 || result.status >= 300) {
    throw new Error(messageFromResponse(result.status, result.body))
  }

  if (!result.body) return undefined as T
  try {
    return JSON.parse(result.body) as T
  } catch {
    return undefined as T
  }
}

/** The machine-readable code on an error answer, if it has one. */
function errorCodeOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null || !('error' in parsed)) return null
    const error = parsed.error
    if (typeof error !== 'object' || error === null || !('code' in error)) return null
    return typeof error.code === 'string' ? error.code : null
  } catch {
    return null
  }
}
