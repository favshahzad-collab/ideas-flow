import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard'

/**
 * The last thing standing between a half-written submission and an empty
 * form. It has to get both halves of one judgement right.
 *
 * It must fire when there is something to lose: a reload, a back button or a
 * mis-clicked sidebar link, on a screen that holds a title, a description and
 * an approval chain the preparer typed by hand.
 *
 * And it must stay silent when there is not. A guard that asks "are you sure?"
 * on a form nobody has touched is a guard people learn to dismiss without
 * reading, and by the time it has something real to say they are already
 * clicking through it. That is the failure mode this file exists to catch.
 */

/**
 * Fires the event a browser sends on reload, back or tab close, and reports
 * whether the guard cancelled it. A cancelled `beforeunload` is the only
 * thing that makes a browser show its "Leave site?" prompt - an uncancelled
 * one means the page is gone and the typing with it.
 */
function browserTriedToLeave(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

/**
 * The same departure, but reporting whether `returnValue` was *assigned* as
 * well as whether the event was cancelled.
 *
 * These are two separate requirements and jsdom cannot tell them apart on its
 * own: it implements `returnValue` as the spec's boolean, so `preventDefault()`
 * alone already flips it to false and `defaultPrevented` alone already answers
 * true. Chrome is not so forgiving - a `beforeunload` handler that only calls
 * `preventDefault()` does not reliably arm the prompt, which is exactly why
 * the hook assigns `returnValue` too. Watching the setter is the only way to
 * hold that line from jsdom.
 */
function browserTriedToLeaveWatchingReturnValue(): {
  cancelled: boolean
  assignedReturnValue: boolean
} {
  const event = new Event('beforeunload', { cancelable: true })
  let assigned = false
  Object.defineProperty(event, 'returnValue', {
    configurable: true,
    get: () => '',
    set: () => {
      assigned = true
    },
  })

  window.dispatchEvent(event)

  return { cancelled: event.defaultPrevented, assignedReturnValue: assigned }
}

const renderGuard = (dirty = false) =>
  renderHook(({ dirty: isDirty }) => useUnsavedChangesGuard(isDirty), {
    initialProps: { dirty },
  })

describe('the browser prompt', () => {
  it('stays out of the way while there is nothing to lose', () => {
    // An untouched form has no unsaved work in it. Prompting here is what
    // trains people to click through the prompt that matters.
    renderGuard(false)

    expect(browserTriedToLeave()).toBe(false)
  })

  it('arms once there are unsaved changes', () => {
    renderGuard(true)

    expect(browserTriedToLeave()).toBe(true)
  })

  it('sets returnValue, which is the half Chrome actually reads', () => {
    // Cancelling the event is the standard; assigning `returnValue` is what
    // Chrome has always required on top of it. Dropping the assignment leaves
    // a guard that passes every "did it preventDefault?" test in this file and
    // shows no prompt at all in the browser people use.
    renderGuard(true)

    const departure = browserTriedToLeaveWatchingReturnValue()

    expect(departure.cancelled).toBe(true)
    expect(departure.assignedReturnValue).toBe(true)
  })

  it('touches neither half of the event while the form is clean', () => {
    renderGuard(false)

    const departure = browserTriedToLeaveWatchingReturnValue()

    expect(departure.cancelled).toBe(false)
    expect(departure.assignedReturnValue).toBe(false)
  })

  it('arms when a clean form is typed into', () => {
    const { rerender } = renderGuard(false)

    rerender({ dirty: true })

    expect(browserTriedToLeave()).toBe(true)
  })

  it('disarms again once the changes are gone', () => {
    // A successful submit clears the form and navigates by itself. Asking to
    // confirm that navigation would be asking about work that no longer
    // exists, on the one exit the person definitely meant to take.
    const { rerender } = renderGuard(true)

    rerender({ dirty: false })

    expect(browserTriedToLeave()).toBe(false)
  })

  it('stops listening when the screen goes away', () => {
    // The listener is on `window`, not on the page. One left behind would go
    // on prompting on every other screen in the app, about a form that was
    // unmounted an hour ago.
    const { unmount } = renderGuard(true)

    unmount()

    expect(browserTriedToLeave()).toBe(false)
  })
})

describe('an in-app navigation', () => {
  it('is waved straight through when nothing has been typed', () => {
    // The call site reads `if (guard.requestNavigation(href)) navigate(href)`.
    // Anything but true here strands a person on a form they never edited.
    const { result } = renderGuard(false)

    let allowed!: boolean
    act(() => {
      allowed = result.current.requestNavigation('/documents')
    })

    expect(allowed).toBe(true)
    expect(result.current.pendingHref).toBeNull()
  })

  it('is held back for a confirmation when there are unsaved changes', () => {
    const { result } = renderGuard(true)

    let allowed!: boolean
    act(() => {
      allowed = result.current.requestNavigation('/documents')
    })

    expect(allowed).toBe(false)
    expect(result.current.pendingHref).toBe('/documents')
  })

  it('hands back the destination that was actually clicked', () => {
    // The dialog is generic - "Leave without submitting?" names no page - so
    // the href it confirms has to be the link the person pressed, not the
    // last one the guard happened to see.
    const { result } = renderGuard(true)
    act(() => {
      result.current.requestNavigation('/documents/3f2a9b1c')
    })

    let confirmed!: string | null
    act(() => {
      confirmed = result.current.confirmNavigation()
    })

    expect(confirmed).toBe('/documents/3f2a9b1c')
  })

  it('closes the confirmation once it has been accepted', () => {
    // The dialog is open while `pendingHref !== null`. Leaving it set would
    // leave a modal over the top of the page just navigated to.
    const { result } = renderGuard(true)
    act(() => {
      result.current.requestNavigation('/documents')
    })

    act(() => {
      result.current.confirmNavigation()
    })

    expect(result.current.pendingHref).toBeNull()
  })

  it('confirms nothing when nothing is pending', () => {
    // The call site navigates only `if (href)`. A stray truthy value here is
    // a navigation to a URL nobody asked for.
    const { result } = renderGuard(true)

    let confirmed!: string | null
    act(() => {
      confirmed = result.current.confirmNavigation()
    })

    expect(confirmed).toBeNull()
  })

  it('keeps the person where they are when they cancel', () => {
    const { result } = renderGuard(true)
    act(() => {
      result.current.requestNavigation('/documents')
    })

    act(() => {
      result.current.cancelNavigation()
    })

    expect(result.current.pendingHref).toBeNull()
  })

  it('cannot be made to navigate to a destination that was declined', () => {
    // Asserting `pendingHref` went null is not enough on its own: the value
    // `confirmNavigation` hands back comes from its own closure. One that
    // still held the cancelled href would send the person to the page they
    // just pressed "Keep editing" to stay off, the next time anything
    // confirms.
    const { result } = renderGuard(true)
    act(() => {
      result.current.requestNavigation('/documents/3f2a9b1c')
    })
    act(() => {
      result.current.cancelNavigation()
    })

    let confirmed!: string | null
    act(() => {
      confirmed = result.current.confirmNavigation()
    })

    expect(confirmed).toBeNull()
  })

  it('confirms the last link pressed, not the first', () => {
    // The dialog does not name the page, so nothing on screen contradicts a
    // stale destination. Pressing a second link while it is open has to move
    // the target, or answering "Leave" sends the person somewhere they asked
    // about once and then changed their mind about.
    const { result } = renderGuard(true)
    act(() => {
      result.current.requestNavigation('/documents')
    })
    act(() => {
      result.current.requestNavigation('/settings/templates')
    })

    expect(result.current.pendingHref).toBe('/settings/templates')

    let confirmed!: string | null
    act(() => {
      confirmed = result.current.confirmNavigation()
    })

    expect(confirmed).toBe('/settings/templates')
  })

  it('still guards the next attempt after a cancel', () => {
    // "Keep editing" declines one navigation. It must not be a way to switch
    // the guard off for the rest of the session.
    const { result } = renderGuard(true)
    act(() => {
      result.current.requestNavigation('/documents')
    })
    act(() => {
      result.current.cancelNavigation()
    })

    let allowed!: boolean
    act(() => {
      allowed = result.current.requestNavigation('/inbox')
    })

    expect(allowed).toBe(false)
    expect(result.current.pendingHref).toBe('/inbox')
  })

  it('still guards the next attempt after one has been confirmed', () => {
    // Confirming discards one navigation's worth of work, not the guard. If
    // the form is still dirty afterwards - the caller may not have navigated
    // at all - the second exit needs the same question asked.
    const { result } = renderGuard(true)
    act(() => {
      result.current.requestNavigation('/documents')
    })
    act(() => {
      result.current.confirmNavigation()
    })

    let allowed!: boolean
    act(() => {
      allowed = result.current.requestNavigation('/inbox')
    })

    expect(allowed).toBe(false)
  })

  it('leaves the browser prompt armed while the app dialog is open', () => {
    // Two exits, two mechanisms. Someone who reloads the tab rather than
    // answering the dialog must still be caught.
    const { result } = renderGuard(true)
    act(() => {
      result.current.requestNavigation('/documents')
    })

    expect(browserTriedToLeave()).toBe(true)
  })
})
