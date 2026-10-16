import { useCallback, useEffect, useState } from 'react'
import { fetchAssignableUsers } from '../services/usersApi'
import type { AssignableUser } from '../types/submitDocument'
import { formatFullName } from '../utils/user'

/**
 * The whole assignable list in one go, for the places that still render a flat
 * select — currently the workflow designer's node panel.
 *
 * The submission screen no longer uses this: it searches server-side through
 * `ApproverCombobox`, because a flat list stops working somewhere well below a
 * real directory's size. `total` is exposed so a caller can at least say when
 * it is showing a truncated view.
 */
const FLAT_LIST_LIMIT = 100

export function useAssignableUsers() {
  const [users, setUsers] = useState<AssignableUser[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const page = await fetchAssignableUsers({ limit: FLAT_LIST_LIMIT })
      setUsers(page.users)
      setTotal(page.total)
    } catch (err) {
      setUsers([])
      setError(err instanceof Error ? err.message : 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Not `load()`: that sets state synchronously inside the effect. `loading`
    // already starts true, so the mount fetch only has to report its result —
    // and the guard stops a late response writing to an unmounted component.
    let cancelled = false

    fetchAssignableUsers({ limit: FLAT_LIST_LIMIT })
      .then(page => {
        if (cancelled) return
        setUsers(page.users)
        setTotal(page.total)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setUsers([])
        setError(err instanceof Error ? err.message : 'Failed to load users')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  return { users, total, loading, error, refetch: load }
}

export function formatUserOptionLabel(user: AssignableUser): string {
  const name = formatFullName(user.firstName, user.lastName)
  const department = user.department?.name
  return department ? `${name} — ${department}` : name
}
