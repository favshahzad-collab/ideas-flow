import { useEffect } from 'react'

/**
 * Is the keystroke going somewhere that owns it already?
 *
 * A single-letter shortcut on a page with a search field is a trap: typing
 * "a" into the filter must not approve a document. Anything editable, and
 * anything inside an open dialog, keeps its own keys.
 */
function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target.closest('[role="dialog"]')) return true

  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export interface QueueKeyHandlers {
  onPrevious: () => void
  onNext: () => void
  onApprove: () => void
  onRevision: () => void
  onReject: () => void
  onFocusDetail: () => void
}

/**
 * The queue's keyboard model: J/K (and the arrows) move the cursor, A/R/X
 * open the matching confirm dialog, Enter moves focus into the right pane.
 *
 * Every action goes through the same dialog a click would open. A shortcut
 * that fires an approval directly would make a mistyped key an irreversible
 * signature.
 */
export function useQueueKeyboard(enabled: boolean, handlers: QueueKeyHandlers) {
  useEffect(() => {
    if (!enabled) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (typingTarget(event.target)) return

      switch (event.key) {
        case 'j':
        case 'J':
        case 'ArrowDown':
          event.preventDefault()
          handlers.onNext()
          break
        case 'k':
        case 'K':
        case 'ArrowUp':
          event.preventDefault()
          handlers.onPrevious()
          break
        case 'a':
        case 'A':
          event.preventDefault()
          handlers.onApprove()
          break
        case 'r':
        case 'R':
          event.preventDefault()
          handlers.onRevision()
          break
        case 'x':
        case 'X':
          event.preventDefault()
          handlers.onReject()
          break
        case 'Enter':
          event.preventDefault()
          handlers.onFocusDetail()
          break
        default:
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [enabled, handlers])
}

/**
 * Keeps the cursor row visible inside its own scroller.
 *
 * Deliberately arithmetic on `scrollTop` rather than `scrollIntoView`: that
 * API scrolls every scrollable ancestor, so on this split view it also drags
 * the page and the right pane around, and its `block: 'nearest'` still jumps
 * when the row is only partly clipped.
 */
export function scrollRowIntoView(
  container: HTMLElement | null,
  row: HTMLElement | null,
) {
  if (!container || !row) return

  const rowTop = row.offsetTop
  const rowBottom = rowTop + row.offsetHeight
  const viewTop = container.scrollTop
  const viewBottom = viewTop + container.clientHeight

  if (rowTop < viewTop) {
    container.scrollTop = rowTop
  } else if (rowBottom > viewBottom) {
    container.scrollTop = rowBottom - container.clientHeight
  }
}
