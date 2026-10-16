import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchPendingApprovalCountCached } from '../services/documentsApi'

export function usePendingApprovalCount() {
  const [count, setCount] = useState(0)

  /**
   * Which request is allowed to write the badge.
   *
   * Approve two documents quickly and two forced refreshes overlap; whichever
   * the network happened to finish *last* used to set the count, so the badge
   * could climb back to a number that was no longer true. The request cache
   * underneath already treats the last request STARTED as authoritative - its
   * own comment says reverting to an older response is the bug - and this
   * hook did not. Only the newest one counts.
   */
  const latest = useRef(0)

  const load = useCallback(async (force = false) => {
    const ticket = ++latest.current
    try {
      const { count: pendingCount } = await fetchPendingApprovalCountCached(force)
      if (ticket === latest.current) setCount(pendingCount)
    } catch {
      if (ticket === latest.current) setCount(0)
    }
  }, [])

  /**
   * Resolved in a callback rather than awaited in the effect body, and
   * guarded so a slow response cannot write state after unmount — the
   * awaited version did, which is what `set-state-in-effect` was flagging.
   */
  useEffect(() => {
    let cancelled = false
    const ticket = ++latest.current

    fetchPendingApprovalCountCached()
      .then(({ count: pendingCount }) => {
        if (!cancelled && ticket === latest.current) setCount(pendingCount)
      })
      .catch(() => {
        if (!cancelled && ticket === latest.current) setCount(0)
      })

    return () => {
      cancelled = true
    }
  }, [])

  /** Bypasses the cache. For after an action that changes the queue. */
  const refetch = useCallback(() => load(true), [load])

  /**
   * Re-reads through the cache rather than around it. The shell calls this
   * on every navigation so the badge cannot go stale after an approval, and
   * the 4s TTL in `documentsApi` still collapses the burst of calls that a
   * single page load makes.
   */
  const reload = useCallback(() => load(false), [load])

  return { count, refetch, reload }
}
