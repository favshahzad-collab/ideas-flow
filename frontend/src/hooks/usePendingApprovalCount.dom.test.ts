import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchPendingApprovalCountCached } from '../services/documentsApi'
import { usePendingApprovalCount } from './usePendingApprovalCount'

/**
 * The number on the "My queue" badge in the sidebar.
 *
 * It is the only thing in the shell that says work is waiting, and it is read
 * as a promise: a badge that is absent means "nothing needs you today", which
 * is exactly the belief on which somebody closes the tab and goes home. So
 * the number being wrong is not a cosmetic bug - it is a document sitting
 * unapproved because nobody was told it was there.
 *
 * The service is mocked rather than fetch, so these tests are about what the
 * hook does with an answer, not about the request cache underneath it.
 */

vi.mock('../services/documentsApi', () => ({
  fetchPendingApprovalCountCached: vi.fn(),
}))

const fetchCount = vi.mocked(fetchPendingApprovalCountCached)

/** A count the test decides the timing of. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // Nothing here may surface as an unhandled rejection before the hook has
  // had a chance to attach its own handler.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/** Lets every queued promise callback run, inside act, with nothing left over. */
const settle = () => act(async () => void (await new Promise(done => setTimeout(done, 0))))

beforeEach(() => {
  // `restoreMocks` restores spies, not the call log of a module mock.
  fetchCount.mockReset()
  fetchCount.mockResolvedValue({ count: 0 })
})

describe('the count it reports', () => {
  it('shows what the server says is waiting', async () => {
    fetchCount.mockResolvedValue({ count: 5 })

    const { result } = renderHook(() => usePendingApprovalCount())

    await waitFor(() => expect(result.current.count).toBe(5))
  })

  it('reads through the cache on mount', async () => {
    // Four things on a single page load ask for this. Forcing here would turn
    // one navigation into four requests for the same integer.
    renderHook(() => usePendingApprovalCount())

    await settle()
    expect(fetchCount).toHaveBeenCalledTimes(1)
    expect(fetchCount.mock.calls[0]).toEqual([])
  })

  it('comes down as soon as the queue is worked through', async () => {
    fetchCount.mockResolvedValue({ count: 5 })
    const { result } = renderHook(() => usePendingApprovalCount())
    await waitFor(() => expect(result.current.count).toBe(5))

    fetchCount.mockResolvedValue({ count: 4 })
    await act(async () => {
      await result.current.refetch()
    })

    expect(result.current.count).toBe(4)
  })

  it('shows no badge rather than a guess while the first request is in flight', async () => {
    // The badge is hidden at zero. Any other starting value is a number on
    // the sidebar that nothing has verified - and it would be read as work
    // waiting before the server has said whether any is.
    const pending = deferred<{ count: number }>()
    fetchCount.mockReturnValue(pending.promise)

    const { result } = renderHook(() => usePendingApprovalCount())

    expect(result.current.count).toBe(0)

    // Still nothing after a turn of the loop - it may not settle early on its
    // own and then correct itself.
    await settle()
    expect(result.current.count).toBe(0)

    pending.resolve({ count: 3 })
    await settle()
    expect(result.current.count).toBe(3)
  })

  it('can report a genuinely empty queue', async () => {
    fetchCount.mockResolvedValue({ count: 0 })

    const { result } = renderHook(() => usePendingApprovalCount())

    await settle()
    expect(result.current.count).toBe(0)
  })
})

describe('which of the two refreshes goes around the cache', () => {
  it('forces a fresh read after an action that changes the queue', async () => {
    // Approving something and then being shown the count from four seconds
    // ago means the badge still counts the document just signed off.
    const { result } = renderHook(() => usePendingApprovalCount())
    await settle()

    await act(async () => {
      await result.current.refetch()
    })

    expect(fetchCount).toHaveBeenLastCalledWith(true)
  })

  it('goes back through the cache on an ordinary navigation', async () => {
    // The shell calls this on every route change. Forcing there would put a
    // request on the wire for every click in the sidebar.
    fetchCount.mockResolvedValue({ count: 5 })
    const { result } = renderHook(() => usePendingApprovalCount())
    await waitFor(() => expect(result.current.count).toBe(5))

    fetchCount.mockResolvedValue({ count: 2 })
    await act(async () => {
      await result.current.reload()
    })

    expect(fetchCount).toHaveBeenLastCalledWith(false)
    // Which argument it passed is only half of it. The reason the shell calls
    // this on every navigation is so the badge cannot go stale, so the number
    // has to actually move - a `reload` that requests correctly and then drops
    // the answer would satisfy the assertion above and change nothing on
    // screen.
    expect(result.current.count).toBe(2)
  })
})

describe('when the count cannot be fetched', () => {
  it('shows nothing waiting - which is the same thing it shows when nothing is waiting', async () => {
    // Reported defect. A failed request and an empty queue are rendered
    // identically, and the hook exposes no third state for "unknown", so the
    // shell has nothing it could say instead. This test pins the behaviour
    // that exists rather than the behaviour that is wanted.
    fetchCount.mockRejectedValue(new Error('Network request failed'))

    const { result } = renderHook(() => usePendingApprovalCount())

    await settle()
    expect(result.current.count).toBe(0)
    expect(result.current).not.toHaveProperty('error')
  })

  it('throws away a count it already had rather than keeping it', async () => {
    // Reported defect, and the worse half of it: the badge was correctly
    // showing 5, one refresh failed, and the sidebar now says the queue is
    // empty. Keeping the last known number would have been both truer and
    // less alarming.
    fetchCount.mockResolvedValue({ count: 5 })
    const { result } = renderHook(() => usePendingApprovalCount())
    await waitFor(() => expect(result.current.count).toBe(5))

    fetchCount.mockRejectedValue(new Error('Network request failed'))
    await act(async () => {
      await result.current.refetch()
    })

    expect(result.current.count).toBe(0)
  })

  it('does not let the failure escape to the caller', async () => {
    // The shell calls `reload()` from a navigation effect and does not await
    // it. A rejection there is an unhandled promise rejection in the console
    // on every navigation while the API is down.
    fetchCount.mockRejectedValue(new Error('Network request failed'))
    const { result } = renderHook(() => usePendingApprovalCount())
    await settle()

    await act(async () => {
      await expect(result.current.reload()).resolves.toBeUndefined()
    })
  })
})

describe('responses that arrive late', () => {
  it('is harmless when one lands after the shell has gone', async () => {
    // Signing out unmounts the whole shell. The count that was in flight when
    // that happened must not come back and write to a tree that is no longer
    // there. React drops such a write silently, so what this can still catch
    // is the loud version of the same bug: a throw on the way past, or the
    // "update was not wrapped in act" warning that appears when a response
    // lands in a tree that is somehow still mounted.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const late = deferred<{ count: number }>()
    fetchCount.mockReturnValue(late.promise)
    const { unmount } = renderHook(() => usePendingApprovalCount())

    unmount()
    late.resolve({ count: 7 })
    await settle()

    expect(consoleError).not.toHaveBeenCalled()
  })

  it('lets the newest request win when two are in flight', async () => {
    // Reported defect. Approve two documents quickly and two forced refreshes
    // overlap; whichever the network happens to finish last is the one that
    // sets the badge, so the count can go back up to a number that is no
    // longer true. The request cache underneath this hook already treats the
    // last request STARTED as the authoritative one - its own comment says
    // reverting to an older response is the bug - and the hook does not.
    fetchCount.mockResolvedValue({ count: 9 })
    const { result } = renderHook(() => usePendingApprovalCount())
    await waitFor(() => expect(result.current.count).toBe(9))

    const slowFirst = deferred<{ count: number }>()
    const quickSecond = deferred<{ count: number }>()
    fetchCount.mockReturnValueOnce(slowFirst.promise)
    fetchCount.mockReturnValueOnce(quickSecond.promise)

    act(() => void result.current.refetch())
    act(() => void result.current.refetch())

    quickSecond.resolve({ count: 4 })
    await settle()
    expect(result.current.count).toBe(4)

    slowFirst.resolve({ count: 9 })
    await settle()
    expect(result.current.count).toBe(4)
  })
})
