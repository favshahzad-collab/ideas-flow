/**
 * Token storage and the session-expiry channel.
 *
 * Split out of `authApi` to break a cycle: `apiClient` needs to read and
 * rewrite tokens, but every service — `authApi` included — is built on
 * `apiClient`. Nothing in here imports anything.
 */

import { forgetStepUp } from './stepUp'

const ACCESS_TOKEN_KEY = 'docflow_auth_token'
const REFRESH_TOKEN_KEY = 'docflow_refresh_token'

/**
 * Safari in private mode and browsers with site data blocked throw on both
 * reads and writes. Losing the session is survivable; a white screen at boot
 * is not, so every access is guarded.
 */
function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value) {
      localStorage.setItem(key, value)
    } else {
      localStorage.removeItem(key)
    }
  } catch {
    /* storage unavailable — the session lasts as long as the tab */
  }
}

export function getAuthToken(): string | null {
  return readStorage(ACCESS_TOKEN_KEY)
}

export function setAuthToken(token: string | null): void {
  writeStorage(ACCESS_TOKEN_KEY, token)
}

export function getRefreshToken(): string | null {
  return readStorage(REFRESH_TOKEN_KEY)
}

export function setRefreshToken(token: string | null): void {
  writeStorage(REFRESH_TOKEN_KEY, token)
}

export function clearTokens(): void {
  setAuthToken(null)
  setRefreshToken(null)
  // A confirmation belongs to the session it was made in.
  forgetStepUp()
}

/**
 * Broadcast when a request comes back 401 and the refresh token could not
 * buy a new session. `AuthContext` listens and tears the session down, which
 * sends the route guard to the sign-in screen with the current path kept as
 * the return target.
 */
type SessionExpiredListener = () => void

const listeners = new Set<SessionExpiredListener>()

export function onSessionExpired(listener: SessionExpiredListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitSessionExpired(): void {
  clearTokens()
  // Copy first: a listener that unsubscribes itself would otherwise mutate
  // the set mid-iteration.
  for (const listener of [...listeners]) {
    listener()
  }
}
