import { useCallback, useSyncExternalStore } from 'react'

/**
 * Reads a CSS media query as React state.
 *
 * `useSyncExternalStore` rather than an effect: the value exists before the
 * first paint, so a layout that branches on it does not render the wrong
 * variant and then correct itself. Returns false during SSR, where there is
 * no matchMedia to ask.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {}
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )

  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia(query).matches
  }, [query])

  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

/** The breakpoint at which the queue becomes a split view (Tailwind `lg`). */
export const SPLIT_VIEW_QUERY = '(min-width: 1024px)'

/** Below Tailwind's `sm`: a phone held upright. */
export const PHONE_QUERY = '(max-width: 639px)'
