import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'

import Button from '../ui/Button'

/**
 * The find bar, as a word processor has one: under the toolbar, above the
 * text, and gone again on Escape.
 *
 * It holds no state of its own. The editor owns the query and the matches,
 * because the matches live in the editor's DOM and change as the memo is
 * typed; this is the row of controls that shows them and asks for things.
 * The count is announced politely, so a screen reader hears "3 of 7" as the
 * query is typed rather than being interrupted by it.
 */

export interface FindReplaceBarProps {
  query: string
  replacement: string
  matchCase: boolean
  wholeWord: boolean
  /** How many matches there are, and which is current (0-based; -1 for none). */
  count: number
  current: number
  /** Said once, in place of the count, after a replacement. */
  announcement: string | null
  /** Which field takes the focus, and a key that changes when it should again. */
  focusOn: 'find' | 'replace'
  focusKey: number
  disabled?: boolean
  onQueryChange: (query: string) => void
  onReplacementChange: (replacement: string) => void
  onMatchCaseChange: (matchCase: boolean) => void
  onWholeWordChange: (wholeWord: boolean) => void
  onNext: () => void
  onPrevious: () => void
  onReplace: () => void
  onReplaceAll: () => void
  onClose: () => void
}

const INPUT =
  'h-7.5 w-40 rounded-chip border border-line bg-surface px-2 text-meta text-content placeholder:text-content-subtle transition-colors hover:border-content-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50'

export function FindReplaceBar({
  query,
  replacement,
  matchCase,
  wholeWord,
  count,
  current,
  announcement,
  focusOn,
  focusKey,
  disabled = false,
  onQueryChange,
  onReplacementChange,
  onMatchCaseChange,
  onWholeWordChange,
  onNext,
  onPrevious,
  onReplace,
  onReplaceAll,
  onClose,
}: FindReplaceBarProps) {
  const findId = useId()
  const replaceId = useId()
  const caseId = useId()
  const wordId = useId()
  const findRef = useRef<HTMLInputElement | null>(null)
  const replaceRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const field = focusOn === 'replace' ? replaceRef.current : findRef.current
    field?.focus()
    field?.select()
  }, [focusOn, focusKey])

  const onFindKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) onPrevious()
      else onNext()
    }
  }

  const onReplaceKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      onReplace()
    }
  }

  const onBarKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const status = announcement
    ? announcement
    : !query
      ? ''
      : count === 0
        ? 'No matches'
        : `${current + 1} of ${count}`

  return (
    <div
      role="search"
      aria-label="Find and replace"
      onKeyDown={onBarKey}
      className="flex flex-wrap items-center gap-2 rounded-control border border-line bg-canvas p-1.5"
    >
      <div className="flex items-center gap-1">
        <label htmlFor={findId} className="sr-only">
          Find
        </label>
        <input
          ref={findRef}
          id={findId}
          type="text"
          value={query}
          placeholder="Find"
          disabled={disabled}
          onChange={event => onQueryChange(event.target.value)}
          onKeyDown={onFindKey}
          className={INPUT}
        />
        <IconButton label="Previous match" disabled={disabled || count === 0} onActivate={onPrevious}>
          <ChevronUp size={15} aria-hidden="true" />
        </IconButton>
        <IconButton label="Next match" disabled={disabled || count === 0} onActivate={onNext}>
          <ChevronDown size={15} aria-hidden="true" />
        </IconButton>
        <span
          role="status"
          className={`min-w-16 text-meta ${count === 0 && query && !announcement ? 'text-danger-ink' : 'text-content-muted'}`}
        >
          {status}
        </span>
      </div>

      <div className="flex items-center gap-1">
        <label htmlFor={replaceId} className="sr-only">
          Replace with
        </label>
        <input
          ref={replaceRef}
          id={replaceId}
          type="text"
          value={replacement}
          placeholder="Replace with"
          disabled={disabled}
          onChange={event => onReplacementChange(event.target.value)}
          onKeyDown={onReplaceKey}
          className={INPUT}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || count === 0}
          onClick={onReplace}
        >
          Replace
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || count === 0}
          onClick={onReplaceAll}
        >
          Replace all
        </Button>
      </div>

      <div className="flex items-center gap-3 text-meta text-content-muted">
        <label htmlFor={caseId} className="flex cursor-pointer items-center gap-1.5">
          <input
            id={caseId}
            type="checkbox"
            checked={matchCase}
            disabled={disabled}
            onChange={event => onMatchCaseChange(event.target.checked)}
          />
          Match case
        </label>
        <label htmlFor={wordId} className="flex cursor-pointer items-center gap-1.5">
          <input
            id={wordId}
            type="checkbox"
            checked={wholeWord}
            disabled={disabled}
            onChange={event => onWholeWordChange(event.target.checked)}
          />
          Whole word
        </label>
      </div>

      <div className="ml-auto">
        <IconButton label="Close find" disabled={false} onActivate={onClose}>
          <X size={15} aria-hidden="true" />
        </IconButton>
      </div>
    </div>
  )
}

function IconButton({
  label,
  disabled,
  onActivate,
  children,
}: {
  label: string
  disabled: boolean
  onActivate: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onActivate}
      className="flex h-7.5 w-7.5 items-center justify-center rounded-chip text-content-muted transition-colors hover:bg-sunken hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  )
}
