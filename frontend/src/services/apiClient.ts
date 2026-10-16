import { parseApiError } from '../utils/apiError'
import {
  emitSessionExpired,
  getAuthToken,
  getRefreshToken,
  setAuthToken,
  setRefreshToken,
} from './authTokens'
import { askForStepUp, currentStepUp, STEP_UP_CODES } from './stepUp'

/**
 * The single door every API call goes through.
 *
 * Access tokens live two hours. Before this existed, hour three of a working
 * day turned every click into an inline "your session has expired" message on
 * whatever page you happened to be on — no redirect, no way back, and a
 * perfectly good 30-day refresh token sitting unused in the login response.
 *
 * Now a 401 is handled where it happens: refresh once, replay the request, and
 * only if that fails does the session end — cleanly, at the sign-in screen,
 * with the page you were on kept as the return target.
 */

/**
 * `/refresh` must not recurse, and `/login` returns 401 for a wrong password —
 * refreshing there would swallow a normal validation failure. Both call
 * `fetch` directly rather than going through `apiFetch`; this list is the
 * belt-and-braces for anything routed here by mistake.
 */
const NO_REFRESH_PATHS = ['/api/auth/login', '/api/auth/refresh', '/api/auth/sign-up']

function skipsRefresh(url: string): boolean {
  return NO_REFRESH_PATHS.some(path => url.startsWith(path))
}

let refreshInFlight: Promise<boolean> | null = null

async function requestNewTokens(): Promise<boolean> {
  const refreshToken = getRefreshToken()
  if (!refreshToken) {
    return false
  }

  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  }).catch(() => null)

  if (!res?.ok) {
    return false
  }

  const payload = await res.json().catch(() => null)
  if (typeof payload?.accessToken !== 'string') {
    return false
  }

  setAuthToken(payload.accessToken)
  // The server rotates both halves, so the new refresh token has to replace
  // the old one or the 30-day window stops sliding.
  if (typeof payload.refreshToken === 'string') {
    setRefreshToken(payload.refreshToken)
  }
  return true
}

/**
 * A page load fires several requests at once, so an expired token produces a
 * burst of 401s. They share one refresh rather than racing — the last writer
 * would otherwise win and the losers would replay with a token already
 * replaced.
 */
function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = requestNewTokens().finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

/**
 * `fetch` with the bearer token attached and a 401 retried once behind a
 * refresh. Returns the `Response` untouched — callers that need the status
 * (a 404 that means "no signature yet", a blob body) read it themselves.
 *
 * The retry re-sends `init` as given. Every caller passes a string or a
 * `FormData` body, both re-readable; a `ReadableStream` body would be spent
 * by the first attempt and must not be sent through here.
 */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await sendWithSessionRetry(url, init)

  /*
   * A sensitive change the server wants confirmed. Ask the person once - the
   * dialog is shared by every request refused at the same moment - and send
   * it again with the confirmation. If they cancel, the refusal goes back to
   * the screen as it came, and says what it wanted.
   */
  const purpose = res.status === 403 ? STEP_UP_CODES[(await errorCode(res)) ?? ''] : undefined
  if (purpose) {
    if (await askForStepUp(purpose)) {
      return sendWithSessionRetry(url, init)
    }
  }

  return res
}

/** The machine-readable code on an error answer, without spending its body. */
async function errorCode(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.clone().json()
    if (typeof body !== 'object' || body === null || !('error' in body)) return null
    const error = body.error
    if (typeof error !== 'object' || error === null || !('code' in error)) return null
    return typeof error.code === 'string' ? error.code : null
  } catch {
    return null
  }
}

async function sendWithSessionRetry(url: string, init: RequestInit): Promise<Response> {
  // Rebuilt per attempt so the replay picks up the token the refresh wrote,
  // and a confirmation made since the first attempt.
  const send = () => {
    const headers = new Headers(init.headers)
    const token = getAuthToken()
    if (token) {
      headers.set('Authorization', `Bearer ${token}`)
    }
    const stepUp = currentStepUp()
    if (stepUp) {
      headers.set('X-Step-Up', stepUp)
    }
    return fetch(url, { ...init, headers })
  }

  const res = await send()

  if (res.status !== 401 || skipsRefresh(url) || !getRefreshToken()) {
    return res
  }

  if (!(await refreshSession())) {
    emitSessionExpired()
    return res
  }

  const retried = await send()
  if (retried.status === 401) {
    // A fresh token rejected on the same request means the account itself is
    // no longer valid — deleted, or its role revoked mid-session.
    emitSessionExpired()
  }
  return retried
}

/** `apiFetch` for the common case: throw the backend's message, return JSON. */
export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, init)

  if (!res.ok) {
    throw new Error(await parseApiError(res))
  }

  return res.json() as Promise<T>
}

/** `apiJson` for endpoints that answer with a body we don't read. */
export async function apiVoid(url: string, init?: RequestInit): Promise<void> {
  const res = await apiFetch(url, init)

  if (!res.ok) {
    throw new Error(await parseApiError(res))
  }
}

/** `apiJson` for file downloads and previews. */
export async function apiBlob(url: string, init?: RequestInit): Promise<Blob> {
  const res = await apiFetch(url, init)

  if (!res.ok) {
    throw new Error(await parseApiError(res))
  }

  return res.blob()
}

/** JSON request bodies, so no caller has to remember the header. */
export function jsonBody(payload: unknown): RequestInit {
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }
}
