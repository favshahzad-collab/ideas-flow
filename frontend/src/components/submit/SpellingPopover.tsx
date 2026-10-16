/**
 * What a flagged word might have been, under the caret.
 *
 * Opened by the editor when the caret comes to rest in a word the
 * dictionary does not know, and driven from there: the region keeps the
 * keyboard, so the editor asks this to move and to pick. What it hands back
 * is a decision - a replacement, "ignore", or "add to the dictionary" -
 * and acting on it is the editor's job.
 */
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react'

export type SpellingChoice =
  | { kind: 'replace'; text: string }
  | { kind: 'ignore' }
  | { kind: 'add' }

export type SpellingPopoverHandle = {
  move(delta: number): void
  pick(): SpellingChoice | null
}

export const SpellingPopover = forwardRef<
  SpellingPopoverHandle,
  {
    word: string
    suggestions: string[]
    /** Where to sit, relative to the editor shell. */
    anchor: { top: number; left: number }
    /** Whether "add to the dictionary" is offered - an administrator's action. */
    canAdd: boolean
    onChoose: (choice: SpellingChoice) => void
    onActiveChange: (optionId: string | null) => void
  }
>(function SpellingPopover({ word, suggestions, anchor, canAdd, onChoose, onActiveChange }, ref) {
  const [active, setActive] = useState(0)
  const listId = useId()
  const pointer = useRef<{ x: number; y: number } | null>(null)

  const choices = useMemo(
    (): { id: string; label: string; choice: SpellingChoice; emphasis: boolean }[] => [
      ...suggestions.map((text, at) => ({
        id: `${listId}-s${at}`,
        label: text,
        choice: { kind: 'replace' as const, text },
        emphasis: true,
      })),
      { id: `${listId}-ignore`, label: `Ignore “${word}”`, choice: { kind: 'ignore' }, emphasis: false },
      ...(canAdd
        ? [
            {
              id: `${listId}-add`,
              label: `Add “${word}” to the dictionary`,
              choice: { kind: 'add' as const },
              emphasis: false,
            },
          ]
        : []),
    ],
    [canAdd, listId, suggestions, word],
  )

  useEffect(() => {
    setActive(0)
  }, [word, suggestions])

  useEffect(() => {
    onActiveChange(choices[active]?.id ?? null)
  }, [active, choices, onActiveChange])

  useImperativeHandle(
    ref,
    () => ({
      move(delta) {
        setActive(previous => (previous + delta + choices.length) % choices.length)
      },
      pick() {
        return choices[active]?.choice ?? null
      },
    }),
    [active, choices],
  )

  const hover = (index: number, event: MouseEvent<HTMLButtonElement>) => {
    const last = pointer.current
    pointer.current = { x: event.clientX, y: event.clientY }
    if (!last || (last.x === event.clientX && last.y === event.clientY)) return
    setActive(index)
  }

  return (
    <div
      className="absolute z-20 w-72 max-w-full rounded-control border border-line bg-surface p-1 shadow-card"
      style={{ top: anchor.top, left: anchor.left }}
      onMouseDown={event => event.preventDefault()}
    >
      <p className="px-2 py-1 text-2xs uppercase tracking-wide text-content-subtle">
        {suggestions.length > 0 ? 'Did you mean' : 'Not in the dictionary'}
      </p>
      <ul role="listbox" aria-label="Spelling" id={listId} className="space-y-0.5">
        {choices.map((entry, index) => (
          <li key={entry.id} role="presentation">
            <button
              type="button"
              role="option"
              id={entry.id}
              aria-selected={index === active}
              onMouseMove={event => hover(index, event)}
              onClick={() => onChoose(entry.choice)}
              className={`block w-full rounded-chip px-2 py-1 text-left text-ui transition-colors ${
                index === active ? 'bg-accent-soft text-accent-ink' : 'text-content hover:bg-sunken'
              } ${entry.emphasis ? 'font-medium' : 'text-content-muted'}`}
            >
              {entry.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
})
