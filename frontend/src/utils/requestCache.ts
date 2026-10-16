/**
 * Small helper to dedupe concurrent calls to the same fetcher and briefly
 * cache the resolved value. Used so that multiple components mounted on the
 * same page navigation (e.g. a page's own data hook plus the app shell's
 * badge counters) collapse into a single network request instead of firing
 * one each.
 */
export function createCachedRequest<T>(fetcher: () => Promise<T>, ttlMs: number) {
  let inFlight: Promise<T> | null = null
  let cached: { value: T; fetchedAt: number } | null = null

  /**
   * Which request is the current one. A forced refresh starts a second
   * request alongside one already running, and the two can land in either
   * order - so whichever STARTED last owns the cache, not whichever finished
   * last. Without this, hitting refresh mid-load showed the new data and then
   * silently reverted to the older response when it arrived.
   */
  let generation = 0

  async function get(force = false): Promise<T> {
    if (!force && cached && Date.now() - cached.fetchedAt < ttlMs) {
      return cached.value
    }

    if (!force && inFlight) {
      return inFlight
    }

    const mine = ++generation

    const request: Promise<T> = fetcher()
      .then(value => {
        if (mine === generation) {
          cached = { value, fetchedAt: Date.now() }
        }
        return value
      })
      .finally(() => {
        // Only clear the slot if it is still ours: an older request settling
        // must not deregister the newer one and send the next caller off to
        // fetch what is already on its way.
        if (inFlight === request) {
          inFlight = null
        }
      })

    inFlight = request
    return request
  }

  function invalidate() {
    cached = null
  }

  return { get, invalidate }
}
