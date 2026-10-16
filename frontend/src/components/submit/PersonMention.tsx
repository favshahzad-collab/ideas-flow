/**
 * The people who match what is being typed after `@`.
 *
 * A small list under the caret, searched from the directory as the letters
 * arrive. The editor keeps the keyboard - the region stays focused and the
 * person keeps typing - so this component is driven from outside: the editor
 * tells it the query, asks it to move the highlight, and asks it to pick.
 * What it hands back is the person; writing them into the memo is the
 * editor's job, and it writes text (see `utils/memoMention`).
 */
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type MouseEvent,
} from 'react'

import { fetchAssignableUsers } from '../../services/usersApi'
import type { AssignableUser } from '../../types/submitDocument'
import { personLine, rankByName } from '../../utils/memoMention'
import { formatFullName } from '../../utils/user'
import { Avatar } from '../ui/Card'

/**
 * How many to ask for, before ranking.
 *
 * The directory search matches a term anywhere - name, email or department
 * - and answers in alphabetical order. Typed after an `@`, the letters are
 * the start of a NAME, so "ina" must find Inayat before it finds everybody
 * in Finance. Asking for more than is shown leaves room to put the names
 * first (`rankByName`).
 */
const FETCH_LIMIT = 25

/** Long enough to let a burst of letters settle, short enough to feel instant. */
const SETTLE_MS = 150

export type PersonMentionHandle = {
  /** Move the highlight by this many rows, wrapping at either end. */
  move(delta: number): void
  /** Hand back the highlighted person, or null when there is nobody to pick. */
  pick(): AssignableUser | null
}

export const PersonMention = forwardRef<
  PersonMentionHandle,
  {
    query: string
    /** Where to sit, relative to the editor shell. */
    anchor: { top: number; left: number }
    onPick: (person: AssignableUser) => void
    /** The id of the highlighted option, for `aria-activedescendant` on the region. */
    onActiveChange: (optionId: string | null) => void
  }
>(function PersonMention({ query, anchor, onPick, onActiveChange }, ref) {
  const [results, setResults] = useState<AssignableUser[]>([])
  const [answeredFor, setAnsweredFor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const listId = useId()
  /** Where the pointer was last seen, so only a real move highlights a row. */
  const pointer = useRef<{ x: number; y: number } | null>(null)

  const asked = answeredFor === query
  const optionId = (person: AssignableUser) => `${listId}-${person.id}`

  /*
   * A list that opens under a pointer that has not moved gets a hover event
   * from the browser re-checking what is under it - and the row under the
   * mouse would quietly become the one Enter picks, over the top match. So
   * the first position seen is only remembered; a row is highlighted by a
   * move away from it.
   */
  const hover = (index: number, event: MouseEvent<HTMLButtonElement>) => {
    const last = pointer.current
    pointer.current = { x: event.clientX, y: event.clientY }
    if (!last || (last.x === event.clientX && last.y === event.clientY)) return
    setActive(index)
  }

  useEffect(() => {
    let cancelled = false
    const handle = setTimeout(() => {
      fetchAssignableUsers({ q: query, limit: FETCH_LIMIT })
        .then(page => {
          if (cancelled) return
          setResults(rankByName(query, page.users))
          setError(null)
          setActive(0)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          setResults([])
          setError(err instanceof Error ? err.message : 'Could not search the directory')
        })
        .finally(() => {
          if (!cancelled) setAnsweredFor(query)
        })
    }, SETTLE_MS)

    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [query])

  const highlighted = results[active] ?? null

  useEffect(() => {
    onActiveChange(highlighted ? `${listId}-${highlighted.id}` : null)
  }, [highlighted, listId, onActiveChange])

  useImperativeHandle(
    ref,
    () => ({
      move(delta) {
        if (results.length === 0) return
        setActive(current => (current + delta + results.length) % results.length)
      },
      pick() {
        return highlighted
      },
    }),
    [results.length, highlighted],
  )

  const status = !asked
    ? 'Searching the directory'
    : error
      ? error
      : results.length === 0
        ? query
          ? `No one matches “${query}”`
          : 'Nobody to show'
        : `${results.length} ${results.length === 1 ? 'person matches' : 'people match'}. Up and down to choose, Enter to insert.`

  return (
    <div
      className="absolute z-20 w-80 max-w-full overflow-hidden rounded-control border border-line bg-surface shadow-card"
      style={{ top: anchor.top, left: anchor.left }}
    >
      <p role="status" className="sr-only">
        {status}
      </p>

      {asked && (error || results.length === 0) ? (
        <p className={`px-3 py-2.5 text-meta ${error ? 'text-danger-ink' : 'text-content-muted'}`}>
          {error ?? (query ? `No one matches “${query}”` : 'Type a name to search the directory')}
        </p>
      ) : (
        <ul id={listId} role="listbox" aria-label="People" className="max-h-72 overflow-y-auto py-1">
          {results.map((person, index) => {
            const isActive = index === active
            return (
              <li key={person.id}>
                <button
                  type="button"
                  id={optionId(person)}
                  role="option"
                  aria-selected={isActive}
                  /* Keep the caret where it is: a press here must not take
                     the region's focus, or there is nowhere to write. */
                  onMouseDown={event => event.preventDefault()}
                  onMouseMove={event => hover(index, event)}
                  onClick={() => onPick(person)}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                    isActive ? 'bg-accent-soft' : 'hover:bg-sunken'
                  }`}
                >
                  <Avatar firstName={person.firstName} lastName={person.lastName} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui font-medium text-content">
                      {formatFullName(person.firstName, person.lastName)}
                    </span>
                    <span className="block truncate text-meta text-content-muted">
                      {personLine({ ...person, firstName: '', lastName: '' }) ||
                        person.email}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
          {!asked && results.length === 0 && (
            <li className="px-3 py-2.5 text-meta text-content-muted" aria-hidden="true">
              Searching…
            </li>
          )}
        </ul>
      )}
    </div>
  )
})
