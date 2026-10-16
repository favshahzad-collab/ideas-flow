/**
 * The keys, listed. Every control on the toolbar has one, and the ones
 * everybody presses anyway - bold, undo, find - are here so nobody has to
 * wonder whether they work.
 */
import { X } from 'lucide-react'
import { useEffect, useRef, type KeyboardEvent } from 'react'

import Keycap from '../ui/Keycap'

const MOD = /Mac|iPhone|iPad/.test(typeof navigator === 'undefined' ? '' : navigator.platform)
  ? '⌘'
  : 'Ctrl'

type Shortcut = { keys: string[]; does: string }
type Group = { title: string; shortcuts: Shortcut[] }

const GROUPS: Group[] = [
  {
    title: 'Text',
    shortcuts: [
      { keys: [MOD, 'B'], does: 'Bold' },
      { keys: [MOD, 'I'], does: 'Italic' },
      { keys: [MOD, 'U'], does: 'Underline' },
      { keys: [MOD, 'Alt', '0'], does: 'Body text' },
      { keys: [MOD, 'Alt', '1'], does: 'Heading' },
      { keys: [MOD, 'Alt', '2'], does: 'Sub-heading' },
      { keys: [MOD, 'Shift', '8'], does: 'Bulleted list' },
      { keys: [MOD, 'Shift', '7'], does: 'Numbered list' },
    ],
  },
  {
    title: 'Insert',
    shortcuts: [
      { keys: [MOD, 'Alt', 'T'], does: 'Table' },
      { keys: [MOD, 'Alt', 'P'], does: 'Picture' },
      { keys: [MOD, 'Enter'], does: 'Page break' },
      { keys: ['@'], does: 'A colleague, from the directory' },
    ],
  },
  {
    title: 'Editing',
    shortcuts: [
      { keys: [MOD, 'Z'], does: 'Undo' },
      { keys: [MOD, 'Y'], does: 'Redo' },
      { keys: [MOD, 'F'], does: 'Find' },
      { keys: [MOD, 'H'], does: 'Find and replace' },
      { keys: ['F7'], does: 'Next misspelling' },
    ],
  },
  {
    title: 'View',
    shortcuts: [
      { keys: [MOD, 'Alt', 'O'], does: 'Outline' },
      { keys: [MOD, 'Shift', 'F'], does: 'Focus mode' },
      { keys: ['Esc'], does: 'Leave focus mode, or close what is open' },
      { keys: [MOD, '/'], does: 'This list' },
    ],
  },
  {
    title: 'As you type',
    shortcuts: [
      { keys: ['-', 'Space'], does: 'Starts a bulleted list' },
      { keys: ['1.', 'Space'], does: 'Starts a numbered list' },
      { keys: ['#', 'Space'], does: 'Makes the line a heading; ## a sub-heading' },
      { keys: ['"'], does: 'Becomes the curly quote the page is set in' },
      { keys: ['-', '-'], does: 'Becomes a dash' },
    ],
  },
]

export function ShortcutsPanel({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <section
      aria-label="Keyboard shortcuts"
      onKeyDown={onKey}
      onMouseDown={event => event.stopPropagation()}
      className="absolute left-0 top-0 z-20 w-full max-w-2xl rounded-control border border-line bg-surface p-4 shadow-card"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="text-ui font-semibold text-content">Keyboard shortcuts</h4>
        <button
          ref={closeRef}
          type="button"
          aria-label="Close keyboard shortcuts"
          onClick={onClose}
          className="flex h-7.5 w-7.5 items-center justify-center rounded-chip text-content-muted transition-colors hover:bg-sunken hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {GROUPS.map(group => (
          <div key={group.title}>
            <p className="mb-1 text-2xs uppercase tracking-wide text-content-subtle">{group.title}</p>
            <dl className="space-y-1">
              {group.shortcuts.map(shortcut => (
                <div key={shortcut.does} className="flex items-center justify-between gap-3">
                  <dt className="text-meta text-content">{shortcut.does}</dt>
                  <dd className="flex shrink-0 items-center gap-1">
                    {shortcut.keys.map((key, at) => (
                      <Keycap key={at}>{key}</Keycap>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </section>
  )
}
