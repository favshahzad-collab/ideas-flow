import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { getMe } from '../services/authApi'
import { CurrentUserContext, type CurrentUser } from './currentUser'

/**
 * Fetches the current user once per session and shares it across the app,
 * instead of every page/hook independently calling `getMe()`.
 */
export function CurrentUserProvider({
  initialUser = null,
  children,
}: {
  initialUser?: CurrentUser | null
  children: ReactNode
}) {
  const [user, setUser] = useState<CurrentUser | null>(initialUser)
  const [loading, setLoading] = useState(!initialUser)
  const [error, setError] = useState<string | null>(null)

  /** For `refetch`, which is called from event handlers. */
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const me = await getMe()
      setUser(me)
    } catch (err) {
      setUser(null)
      setError(err instanceof Error ? err.message : 'Failed to load current user')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Deliberately not `load()`: that sets state synchronously inside the
    // effect. `loading` already starts true when there is no initial user, so
    // the first fetch only has to report its result — and the guard stops it
    // writing to a provider that has since unmounted.
    if (initialUser) return

    let cancelled = false

    getMe()
      .then(me => {
        if (cancelled) return
        setUser(me)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setUser(null)
        setError(err instanceof Error ? err.message : 'Failed to load current user')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // Only run once on mount; `initialUser` is a snapshot from login/session restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <CurrentUserContext.Provider value={{ user, loading, error, refetch: load }}>
      {children}
    </CurrentUserContext.Provider>
  )
}
