/**
 * The memo's headings, under the toolbar, each one a jump.
 *
 * Unlike the lists that open under the caret, this one takes the keyboard:
 * it was asked for, so the arrows move through it, Enter jumps and Escape
 * hands the focus back to the text. A sub-heading sits in from its heading,
 * which is the whole of what an outline shows.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

import type { OutlineEntry } from '../../utils/memoOutline'

export function OutlinePopover({
  entries,
  onJump,
  onClose,
}: {
  entries: OutlineEntry[]
  onJump: (entry: OutlineEntry) => void
  onClose: () => void
}) {
  const [active, setActive] = useState(0)
  const listId = useId()
  const listRef = useRef<HTMLUListElement | null>(null)

  useEffect(() => {
    // Takes the focus as it opens, so the arrows work at once.
    listRef.current?.focus()
  }, [])

  // Kept inside the list as it stands now: a heading deleted while the
  // outline is open takes the highlight to the last one left.
  const current = Math.min(active, Math.max(0, entries.length - 1))

  const onKey = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (entries.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActive((current + delta + entries.length) % entries.length)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const entry = entries[current]
      if (entry) onJump(entry)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const optionId = (index: number) => `${listId}-${index}`

  return (
    <div
      className="absolute left-0 top-0 z-20 w-80 max-w-full rounded-control border border-line bg-surface p-1 shadow-card"
      onMouseDown={event => event.preventDefault()}
    >
      <p className="px-2 py-1 text-2xs uppercase tracking-wide text-content-subtle">Outline</p>
      {entries.length === 0 ? (
        <p className="px-2 pb-2 text-meta text-content-muted">
          No headings yet. Use Heading on the toolbar, or type # and a space at the start of a line.
        </p>
      ) : null}
      <ul
        ref={listRef}
        role="listbox"
        aria-label="Outline"
        id={listId}
        tabIndex={0}
        aria-activedescendant={entries.length > 0 ? optionId(current) : undefined}
        onKeyDown={onKey}
        className="max-h-72 space-y-0.5 overflow-y-auto outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {entries.map((entry, index) => (
          <li key={index} role="presentation">
            <button
              type="button"
              role="option"
              id={optionId(index)}
              aria-selected={index === current}
              tabIndex={-1}
              onMouseMove={() => setActive(index)}
              onClick={() => onJump(entry)}
              className={`block w-full truncate rounded-chip py-1 text-left text-ui transition-colors ${
                entry.level === 2 ? 'pl-6 pr-2' : 'px-2 font-medium'
              } ${index === current ? 'bg-accent-soft text-accent-ink' : 'text-content hover:bg-sunken'}`}
            >
              {entry.text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
