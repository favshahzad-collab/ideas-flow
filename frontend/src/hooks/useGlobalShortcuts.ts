import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { ROUTES } from '../types/routes'
import { useCommandPalette } from '../contexts/commandPalette'

/** How long a `G` stays armed waiting for its second key. */
const PREFIX_WINDOW_MS = 1200

const GO_TO: Record<string, string> = {
  d: ROUTES.dashboard,
  q: ROUTES.pendingApprovals,
  c: ROUTES.controlRoom,
  l: ROUTES.auditLedger,
  s: ROUTES.submitDocument,
  i: ROUTES.inbox,
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function inDialog(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('[role="dialog"]'))
}

/**
 * App-wide keys: ⌘K / Ctrl+K opens the palette, and `G` then a letter jumps
 * to a screen.
 *
 * The `G` prefix is a ref, not state — it changes on a keystroke and nothing
 * renders differently while it is armed, so putting it in state would be a
 * re-render of the whole shell for every `G` anyone typed.
 */
export function useGlobalShortcuts() {
  const navigate = useNavigate()
  const { open, setOpen, toggle } = useCommandPalette()
  const prefix = useRef<number | null>(null)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const modifier = event.metaKey || event.ctrlKey

      if (modifier && event.key.toLowerCase() === 'k') {
        // The palette's own input is inside a dialog; let Escape close it
        // rather than having ⌘K toggle underneath a modal.
        if (inDialog(event.target) && !open) return
        event.preventDefault()
        toggle()
        return
      }

      if (event.altKey || modifier) return
      if (open || inDialog(event.target) || isTyping(event.target)) return

      const key = event.key.toLowerCase()
      const armed = prefix.current !== null && Date.now() - prefix.current < PREFIX_WINDOW_MS

      if (armed) {
        prefix.current = null
        const destination = GO_TO[key]
        if (destination) {
          event.preventDefault()
          navigate(destination)
        }
        return
      }

      if (key === 'g') {
        prefix.current = Date.now()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [navigate, open, setOpen, toggle])
}

export { GO_TO }
