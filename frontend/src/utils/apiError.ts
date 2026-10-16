/**
 * Reads the backend error shape `{ error: { message } }` (and a few fallbacks)
 * into a plain string suitable for `throw new Error(...)` / UI display.
 * Avoids the classic `[object Object]` when `error` is an object.
 */

/**
 * Last-resort wording, used only when the response carried no message of its
 * own — a gateway error, a proxy failure, an HTML error page. A bare
 * "Request failed (502)" tells the user nothing they can act on.
 */
function messageForStatus(status: number): string {
  if (status === 0 || status === 502 || status === 503 || status === 504) {
    return 'We could not reach the server. Check your connection and try again.'
  }
  if (status === 401) {
    return 'Your session has expired. Please sign in again.'
  }
  if (status === 403) {
    return 'You do not have permission to do that.'
  }
  if (status === 404) {
    return 'We could not find what you were looking for.'
  }
  if (status === 408) {
    return 'The server took too long to respond. Please try again.'
  }
  if (status === 413) {
    return 'That file is too large to upload.'
  }
  if (status === 429) {
    return 'Too many requests. Wait a moment and try again.'
  }
  if (status >= 500) {
    return 'Something went wrong on our end. Please try again.'
  }
  if (status >= 400) {
    return 'That request could not be completed. Please check your details and try again.'
  }
  return 'Something went wrong. Please try again.'
}

export async function parseApiError(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({} as Record<string, unknown>))
  const errorField = body?.error

  if (
    errorField &&
    typeof errorField === 'object' &&
    typeof (errorField as { message?: unknown }).message === 'string'
  ) {
    return (errorField as { message: string }).message
  }

  if (typeof body?.message === 'string') {
    return body.message
  }

  if (typeof errorField === 'string') {
    return errorField
  }

  return messageForStatus(res.status)
}
