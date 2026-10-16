import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { getMe, signOut } from '../services/authApi'
import {
  clearTokens,
  getAuthToken,
  onSessionExpired,
} from '../services/authTokens'
import { AuthContext } from './auth'
import type { CurrentUser } from './currentUser'
import type { UserRole } from '../types/user'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loggedIn, setLoggedIn] = useState(false)
  // With no stored token there is nothing to check, so the answer is known
  // before the first render — deriving it here rather than setting it inside
  // the effect avoids a second render just to say "still not signed in".
  const [authChecked, setAuthChecked] = useState(() => !getAuthToken())
  const [sessionUser, setSessionUser] = useState<CurrentUser | null>(null)
  const [sessionKey, setSessionKey] = useState(0)
  const [sessionExpired, setSessionExpired] = useState(false)

  useEffect(() => {
    if (!getAuthToken()) return

    let cancelled = false

    // A stale access token is not the end of the session: `apiJson` spends the
    // refresh token first, so reopening the app after a long break resumes
    // rather than bouncing to sign-in.
    getMe()
      .then(user => {
        if (cancelled) return
        setLoggedIn(true)
        setSessionUser(user)
      })
      .catch(() => {
        if (!cancelled) clearTokens()
      })
      .finally(() => {
        if (!cancelled) setAuthChecked(true)
      })

    return () => {
      cancelled = true
    }
  }, [])

  /**
   * `apiClient` fires this when a 401 survives a token refresh. Dropping
   * `loggedIn` is all it takes to get the user somewhere useful: the route
   * guard redirects to sign-in and keeps the current path as the return
   * target, and the sign-in screen reads `sessionExpired` to say why.
   */
  useEffect(
    () =>
      onSessionExpired(() => {
        setLoggedIn(false)
        setSessionUser(null)
        setSessionExpired(true)
      }),
    [],
  )

  const login = useCallback((_role: UserRole) => {
    setLoggedIn(true)
    setSessionUser(null)
    setSessionExpired(false)
    setSessionKey(key => key + 1)
  }, [])

  const logout = useCallback((everywhere = false) => {
    /*
     * Told, then forgotten - and in that order.
     *
     * `signOut` reads the refresh token, so clearing first would leave the
     * server never hearing which session ended. It is not awaited: the screen
     * changes now, and a sign-out that waited on a slow network would look
     * broken at exactly the moment somebody wants to be gone.
     */
    void signOut(everywhere)

    clearTokens()
    setLoggedIn(false)
    setSessionUser(null)
    setSessionExpired(false)
  }, [])

  const value = useMemo(
    () => ({
      authChecked,
      loggedIn,
      sessionUser,
      sessionKey,
      sessionExpired,
      login,
      logout,
    }),
    [authChecked, loggedIn, sessionUser, sessionKey, sessionExpired, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
