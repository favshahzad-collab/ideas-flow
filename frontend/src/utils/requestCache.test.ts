import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCachedRequest } from './requestCache'

/**
 * The helper that stops a page navigation firing the same request from four
 * components at once. Two things it has to get right: while a request is in
 * flight, later callers wait on it rather than starting another; and once it
 * resolves, callers inside the TTL get the value without a request at all.
 */

/** A fetcher whose promise resolves when the test says so. */
function deferredFetcher<T>() {
  const calls: { resolve: (value: T) => void; reject: (error: unknown) => void }[] =
    []

  const fetcher = vi.fn(
    () =>
      new Promise<T>((resolve, reject) => {
        calls.push({ resolve, reject })
      }),
  )

  return { fetcher, calls }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-05T12:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('while a request is in flight', () => {
  it('collapses concurrent callers into one request', async () => {
    const { fetcher, calls } = deferredFetcher<string>()
    const cache = createCachedRequest(fetcher, 30_000)

    const waiting = [cache.get(), cache.get(), cache.get()]
    calls[0].resolve('the answer')

    expect(await Promise.all(waiting)).toEqual([
      'the answer',
      'the answer',
      'the answer',
    ])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects every waiting caller when the request fails', async () => {
    const { fetcher, calls } = deferredFetcher<string>()
    const cache = createCachedRequest(fetcher, 30_000)

    const first = cache.get()
    const second = cache.get()
    calls[0].reject(new Error('offline'))

    await expect(first).rejects.toThrow('offline')
    await expect(second).rejects.toThrow('offline')
  })

  it('starts a fresh request after a failure rather than caching it', async () => {
    const { fetcher, calls } = deferredFetcher<string>()
    const cache = createCachedRequest(fetcher, 30_000)

    const failing = cache.get().catch(() => null)
    calls[0].reject(new Error('offline'))
    await failing

    void cache.get()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('once it has an answer', () => {
  it('serves it without asking again, inside the ttl', async () => {
    const { fetcher, calls } = deferredFetcher<string>()
    const cache = createCachedRequest(fetcher, 30_000)

    const first = cache.get()
    calls[0].resolve('cached')
    await first

    vi.setSystemTime(new Date('2026-09-05T12:00:29Z'))
    expect(await cache.get()).toBe('cached')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('asks again once the ttl is past', async () => {
    const { fetcher, calls } = deferredFetcher<string>()
    const cache = createCachedRequest(fetcher, 30_000)

    const first = cache.get()
    calls[0].resolve('stale')
    await first

    vi.setSystemTime(new Date('2026-09-05T12:00:31Z'))
    const second = cache.get()
    calls[1].resolve('fresh')

    expect(await second).toBe('fresh')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('asks again when told to, ttl or not', async () => {
    const { fetcher, calls } = deferredFetcher<string>()
    const cache = createCachedRequest(fetcher, 30_000)

    const first = cache.get()
    calls[0].resolve('one')
    await first

    const forced = cache.get(true)
    calls[1].resolve('two')

    expect(await forced).toBe('two')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('forgets the value when invalidated', async () => {
    const { fetcher, calls } = deferredFetcher<string>()
    const cache = createCachedRequest(fetcher, 30_000)

    const first = cache.get()
    calls[0].resolve('one')
    await first

    cache.invalidate()
    const second = cache.get()
    calls[1].resolve('two')

    expect(await second).toBe('two')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('a forced refresh racing an in-flight request', () => {
  it('keeps the newer answer, not whichever finishes last', async () => {
    /*
     * A page loads (request A) and the user hits refresh before it lands
     * (request B, forced). B answers first with current data; A answers
     * afterwards with data fetched earlier. Whatever is cached at the end has
     * to be B's - the user asked for the newer one.
     */
    const { fetcher, calls } = deferredFetcher<string>()
    const cache = createCachedRequest(fetcher, 30_000)

    const slowFirst = cache.get()
    const forced = cache.get(true)

    calls[1].resolve('newer')
    await forced
    calls[0].resolve('older')
    await slowFirst

    expect(await cache.get()).toBe('newer')
  })

  it('does not lose track of the request still running', async () => {
    // The older request clearing the shared in-flight slot when it settles
    // would leave a later caller starting a third request for data already
    // on its way.
    const { fetcher, calls } = deferredFetcher<string>()
    const cache = createCachedRequest(fetcher, 30_000)

    void cache.get()
    void cache.get(true)
    calls[0].resolve('older')
    await Promise.resolve()
    await Promise.resolve()

    // A has settled and B has not. A caller arriving now must join B - not
    // be handed A's older value, and not start a third request.
    const later = cache.get()
    calls[1].resolve('newer')

    expect(await later).toBe('newer')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
