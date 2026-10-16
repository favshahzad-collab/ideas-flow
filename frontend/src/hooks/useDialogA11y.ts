import { useEffect, useRef } from 'react'

/**
 * Which dialogs are open, innermost last.
 *
 * Every instance of the hook binds its own capture listener on `document`,
 * and `stopPropagation` does not stop listeners already bound to the same
 * node - so one Escape used to close a confirm prompt *and* the dialog it was
 * asked from, discarding a form somebody was halfway through. A module-level
 * stack is the smallest thing that fixes it: only the dialog on top answers.
 *
 * `stopImmediatePropagation` would silence the others, but only if the
 * listeners happened to run in the right order, and their order is mount
 * order rather than stack order. Asking "am I on top?" does not care.
 */
const stack: symbol[] = []

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Everything a dialog owes a keyboard user, in one place:
 * Escape closes, Tab is trapped inside, focus moves in on open and
 * returns to the trigger on close, and the page behind stops scrolling.
 *
 * Attach the returned ref to the dialog panel.
 */
export function useDialogA11y(open: boolean, onClose: () => void) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef(onClose)
  const idRef = useRef<symbol>(Symbol('dialog'))

  // Keep the latest onClose without re-running the effect on every render.
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return

    restoreRef.current = document.activeElement as HTMLElement | null

    const id = idRef.current
    stack.push(id)

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    /*
     * Focus what the dialog asks for, else its first control, else the panel.
     *
     * `autoFocus` cannot be used for the first of those: React applies it
     * during the commit and this effect runs afterwards, so the hook simply
     * moved focus somewhere else and the attribute did nothing. A dialog
     * whose entire content is one textarea - a rejection reason, which it
     * refuses to proceed without - made a keyboard user Tab past two
     * controls to reach it.
     */
    const panel = panelRef.current
    const requested = panel?.querySelector<HTMLElement>('[data-autofocus]')
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE)
    ;(requested ?? first ?? panel)?.focus()

    function onKeyDown(event: KeyboardEvent) {
      // Only the innermost dialog reacts. Backing out of a confirm prompt
      // must leave the form underneath exactly where it was.
      if (stack[stack.length - 1] !== id) return

      if (event.key === 'Escape') {
        event.stopPropagation()
        closeRef.current()
        return
      }

      if (event.key !== 'Tab' || !panelRef.current) return

      const focusables = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)
      ).filter(el => el.offsetParent !== null || el === document.activeElement)

      if (focusables.length === 0) {
        event.preventDefault()
        return
      }

      const firstEl = focusables[0]
      const lastEl = focusables[focusables.length - 1]
      const active = document.activeElement

      if (event.shiftKey && (active === firstEl || active === panelRef.current)) {
        event.preventDefault()
        lastEl.focus()
      } else if (!event.shiftKey && active === lastEl) {
        event.preventDefault()
        firstEl.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      document.removeEventListener('keydown', onKeyDown, true)

      const position = stack.lastIndexOf(id)
      if (position !== -1) stack.splice(position, 1)

      // Only the last dialog out puts the page back: unsetting it while
      // another is still open would let the page behind scroll under it.
      if (stack.length === 0) document.body.style.overflow = previousOverflow

      // Only if it is still on the page. A dialog whose trigger was itself
      // removed - a row menu item, a card that has since re-rendered - would
      // otherwise call focus() on a detached node, which does nothing and
      // leaves the caret on <body> with no sign that anything went wrong.
      const restore = restoreRef.current
      if (restore?.isConnected) restore.focus()
    }
  }, [open])

  return panelRef
}
