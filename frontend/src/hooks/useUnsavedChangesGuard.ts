import { useCallback, useEffect, useState } from 'react'

/**
 * Warns before work in progress is thrown away.
 *
 * Two exits have to be covered and they need different mechanisms. A browser
 * navigation — reload, back, closing the tab — can only be intercepted with
 * `beforeunload`, which shows the browser's own wording. An in-app navigation
 * is ours to intercept, so it gets the app's confirm dialog.
 *
 * The router here is a `BrowserRouter`, not a data router, so `useBlocker` is
 * unavailable; navigation is instead routed through `requestNavigation` at the
 * call sites that leave the screen. That is the same approach the workflow
 * designer already takes.
 */
export function useUnsavedChangesGuard(dirty: boolean) {
  const [pendingHref, setPendingHref] = useState<string | null>(null)

  useEffect(() => {
    if (!dirty) return

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Assigning returnValue is what actually arms the prompt in Chrome.
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  /**
   * Ask to leave. Returns true when the caller may navigate immediately;
   * false means the confirmation is now open and will navigate if accepted.
   */
  const requestNavigation = useCallback(
    (href: string): boolean => {
      if (!dirty) return true
      setPendingHref(href)
      return false
    },
    [dirty],
  )

  const confirmNavigation = useCallback(() => {
    const href = pendingHref
    setPendingHref(null)
    return href
  }, [pendingHref])

  const cancelNavigation = useCallback(() => setPendingHref(null), [])

  return {
    /** The destination waiting on a confirmation, or null. */
    pendingHref,
    requestNavigation,
    confirmNavigation,
    cancelNavigation,
  }
}
