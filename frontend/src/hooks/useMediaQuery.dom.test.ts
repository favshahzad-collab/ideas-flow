import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SPLIT_VIEW_QUERY, useMediaQuery } from './useMediaQuery'

/**
 * Whether the approval queue is one column or two.
 *
 * This is not decoration. On the wide layout the queue list and the document
 * it is pointing at are on screen together; on the narrow one the list and the
 * detail are separate screens with their own back behaviour. A hook that
 * answers "narrow" on a wide monitor renders the phone layout on a desktop,
 * and one that answers late renders the wrong one and then jumps.
 *
 * `matchMedia` is faked here rather than in setup, because jsdom has no
 * viewport to measure and the whole point of this hook is to notice one
 * changing.
 */

/**
 * A `matchMedia` that can be told what the viewport currently is, and can be
 * told it has changed afterwards - which is the only way to exercise the
 * subscription at all.
 */
function stubViewport(initial: Record<string, boolean> = {}) {
  const matching: Record<string, boolean> = { ...initial }
  const listeners = new Map<string, Set<() => void>>()

  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        media: query,
        // Read at call time: a resize must be visible to the next read.
        get matches() {
          return matching[query] ?? false
        },
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => {
          const set = listeners.get(query) ?? new Set()
          set.add(listener)
          listeners.set(query, set)
        },
        removeEventListener: (_type: string, listener: () => void) => {
          listeners.get(query)?.delete(listener)
        },
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  )

  return {
    /** The window was dragged across the breakpoint. */
    resize(query: string, matches: boolean) {
      matching[query] = matches
      act(() => {
        for (const listener of [...(listeners.get(query) ?? [])]) listener()
      })
    },
    listenerCount: (query: string) => listeners.get(query)?.size ?? 0,
  }
}

/** Removes `matchMedia` the way a server render or an ancient browser has it. */
function withoutMatchMedia(run: () => void) {
  const own = Object.getOwnPropertyDescriptor(window, 'matchMedia')
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: undefined,
  })
  try {
    run()
  } finally {
    if (own) Object.defineProperty(window, 'matchMedia', own)
    else delete (window as { matchMedia?: unknown }).matchMedia
  }
}

describe('the answer it gives', () => {
  it('knows the viewport on the very first render', () => {
    // Not after an effect. A layout that branches on this would otherwise
    // paint the single-column queue first and snap to the split view a frame
    // later, throwing away the scroll position of whatever was under it.
    //
    // Reading `result.current` cannot show this: effects have already run by
    // the time it is read, so `useState(false)` plus a `useEffect` that
    // corrects it - the implementation this hook exists to avoid - would look
    // identical. Every render's value is collected instead, and it is the
    // FIRST one that has to be right.
    stubViewport({ [SPLIT_VIEW_QUERY]: true })

    const everyRender: boolean[] = []
    const { result } = renderHook(() => {
      const matches = useMediaQuery(SPLIT_VIEW_QUERY)
      everyRender.push(matches)
      return matches
    })

    expect(everyRender[0]).toBe(true)
    // And it settles there rather than flickering through the wrong layout on
    // the way: no render in the sequence may disagree with the first.
    expect(everyRender).toEqual(everyRender.map(() => true))
    expect(result.current).toBe(true)
  })

  it('says no when the viewport is below the breakpoint', () => {
    stubViewport({ [SPLIT_VIEW_QUERY]: false })

    const { result } = renderHook(() => useMediaQuery(SPLIT_VIEW_QUERY))

    expect(result.current).toBe(false)
  })

  it('answers the query it was handed and not some other one', () => {
    // Two consumers on one page must not be answered from a single shared
    // media list - the print query saying "yes" would put the whole app into
    // its print layout.
    stubViewport({ [SPLIT_VIEW_QUERY]: true, print: false })

    const split = renderHook(() => useMediaQuery(SPLIT_VIEW_QUERY))
    const print = renderHook(() => useMediaQuery('print'))

    expect(split.result.current).toBe(true)
    expect(print.result.current).toBe(false)
  })
})

describe('keeping up with the window', () => {
  it('switches to the split view when the window is widened', () => {
    const viewport = stubViewport({ [SPLIT_VIEW_QUERY]: false })
    const { result } = renderHook(() => useMediaQuery(SPLIT_VIEW_QUERY))

    viewport.resize(SPLIT_VIEW_QUERY, true)

    expect(result.current).toBe(true)
  })

  it('switches back when it is narrowed again', () => {
    // The narrow layout is the one with its own back navigation. Staying on
    // the split view in a window too small for it leaves the detail pane
    // clipped with no way to return to the list.
    const viewport = stubViewport({ [SPLIT_VIEW_QUERY]: true })
    const { result } = renderHook(() => useMediaQuery(SPLIT_VIEW_QUERY))

    viewport.resize(SPLIT_VIEW_QUERY, false)

    expect(result.current).toBe(false)
  })

  it('follows the new query when the caller asks a different question', () => {
    const viewport = stubViewport({ [SPLIT_VIEW_QUERY]: false, print: true })
    const { result, rerender } = renderHook(({ query }) => useMediaQuery(query), {
      initialProps: { query: SPLIT_VIEW_QUERY },
    })

    rerender({ query: 'print' })

    expect(result.current).toBe(true)
    // And it is listening to the new one, not still to the old one: a stale
    // subscription would answer the new query but never notice it changing.
    expect(viewport.listenerCount(SPLIT_VIEW_QUERY)).toBe(0)
    expect(viewport.listenerCount('print')).toBe(1)
  })
})

describe('what it leaves behind', () => {
  it('subscribes once per consumer', () => {
    const viewport = stubViewport({ [SPLIT_VIEW_QUERY]: false })

    renderHook(() => useMediaQuery(SPLIT_VIEW_QUERY))

    expect(viewport.listenerCount(SPLIT_VIEW_QUERY)).toBe(1)
  })

  it('lets go of its listener on unmount', () => {
    // Every visit to the queue would otherwise leave one behind, each waking
    // a dead component on every resize for the rest of the session.
    const viewport = stubViewport({ [SPLIT_VIEW_QUERY]: false })
    const { unmount } = renderHook(() => useMediaQuery(SPLIT_VIEW_QUERY))

    unmount()

    expect(viewport.listenerCount(SPLIT_VIEW_QUERY)).toBe(0)
  })

  it('survives a browser with no matchMedia at all', () => {
    // A throw here is a blank page rather than a mislaid-out one, so the
    // fallback has to be an answer and not an exception.
    withoutMatchMedia(() => {
      const { result, unmount } = renderHook(() => useMediaQuery(SPLIT_VIEW_QUERY))

      expect(result.current).toBe(false)
      // And it has to come apart again. With nothing to subscribe to there is
      // still a subscription: React calls it regardless and tears down what it
      // returns, so the no-matchMedia path has to hand back a real function.
      // Returning nothing there throws on the way out instead of on the way
      // in, which is a blank page either way.
      expect(() => unmount()).not.toThrow()
    })
  })
})
