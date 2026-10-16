import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'

/**
 * The trailing overflow menu on a dense table row.
 *
 * The redesign takes rows down to 34px, which leaves no room for a strip of
 * inline icon buttons — and a row of unlabelled 24px squares was never very
 * readable anyway. Everything secondary moves in here behind one trigger.
 *
 * `children` is a render prop so an item can close the menu after acting;
 * a plain node cannot, and a menu that stays open over the row it just
 * changed hides the result of the thing you pressed.
 *
 * `role="menu"` is not decoration: it switches a screen reader into
 * application mode, where Up and Down are handed to this widget instead of
 * being used to read the page. Claiming the role without handling the keys
 * leaves that person with no way through the menu at all, so the arrow keys,
 * Home and End are implemented here rather than the role being dropped.
 */
export default function RowMenu({
  label,
  width = 'w-44',
  children,
}: {
  /** Names the trigger AND the menu — "Actions for Priya Nair". */
  label: string
  width?: string
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  /**
   * Whether the menu was open a moment ago, and how it stopped being.
   *
   * Both are written only from inside effects, which is what keeps `close`
   * free of any ref access at all - see the comment on it below.
   */
  const wasOpenRef = useRef(false)
  const closedByPointerRef = useRef(false)

  /** The items a keyboard can reach, in the order they are drawn. */
  const items = (): HTMLButtonElement[] =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not([disabled])',
      ) ?? [],
    )

  /**
   * Handed to the render prop, so an item can close the menu after acting.
   *
   * It does nothing but set state, deliberately. `close` is created during
   * render and passed into a call made during render, and a function in that
   * position that touches a ref is refused - reasonably, since nothing at
   * that point can prove it will only be invoked from a click later. Where
   * focus goes afterwards is decided by the effect below, which is somewhere
   * refs are unambiguously safe.
   */
  const close = useCallback(() => setOpen(false), [])

  /**
   * Put focus back on the trigger when the menu closes - unless a pointer
   * closed it.
   *
   * The item somebody chose unmounts under the caret, so without this focus
   * falls to `<body>` and the next Tab restarts from the top of the page,
   * which is the same loss Escape was already careful to avoid. A pointer
   * user is excluded because they are already looking somewhere else, and
   * pulling focus back would fight whatever they just clicked.
   */
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true
      return
    }

    if (!wasOpenRef.current) return
    wasOpenRef.current = false

    if (closedByPointerRef.current) {
      closedByPointerRef.current = false
      return
    }

    triggerRef.current?.focus()
  }, [open])

  // Focus the first item when the menu opens. Without it a screen reader
  // announces "expanded" and then nothing, leaving the person on a trigger
  // with no indication of what appeared.
  useEffect(() => {
    if (!open) return
    items()[0]?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        // The effect above puts focus back; nothing to do here but close.
        setOpen(false)
        return
      }

      if (!menuRef.current?.contains(document.activeElement)) return

      const reachable = items()
      if (reachable.length === 0) return

      const index = reachable.indexOf(document.activeElement as HTMLButtonElement)

      const move = (to: number) => {
        event.preventDefault()
        // Wraps at both ends: a menu of three where Down stops on the third
        // makes somebody Shift-Tab back out to reach the first.
        reachable[(to + reachable.length) % reachable.length]?.focus()
      }

      if (event.key === 'ArrowDown') move(index + 1)
      else if (event.key === 'ArrowUp') move(index - 1)
      else if (event.key === 'Home') move(0)
      else if (event.key === 'End') move(reachable.length - 1)
    }

    function onPointerDown(event: MouseEvent) {
      if (wrapRef.current?.contains(event.target as Node)) return
      closedByPointerRef.current = true
      setOpen(false)
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open])

  return (
    <div className="relative flex justify-end" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={event => {
          event.stopPropagation()
          setOpen(value => !value)
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        className="inline-flex h-6.5 w-6.5 items-center justify-center rounded-control text-content-subtle transition-colors hover:bg-sunken hover:text-content"
      >
        <MoreHorizontal size={15} aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          className={`absolute right-0 top-full z-20 mt-1 rounded-card border border-line bg-surface py-1 text-left shadow-overlay ${width}`}
          onClick={event => event.stopPropagation()}
        >
          {children(close)}
        </div>
      )}
    </div>
  )
}

/**
 * One row inside a `RowMenu`. `tone="danger"` is for the genuinely
 * destructive entry, which still confirms before it does anything.
 */
export function MenuItem({
  onSelect,
  tone = 'neutral',
  disabled = false,
  title,
  children,
}: {
  onSelect: () => void
  tone?: 'neutral' | 'danger'
  disabled?: boolean
  /** Say why, whenever `disabled` is set. */
  title?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onSelect}
      className={`block w-full px-3 py-1.5 text-left text-ui transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        tone === 'danger'
          ? 'text-danger-ink hover:bg-danger-soft'
          : 'text-content-muted hover:bg-sunken hover:text-content'
      }`}
    >
      {children}
    </button>
  )
}
