import { Check, ChevronDown, Loader2, Search, UserPlus, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { fetchAssignableUsers } from '../../services/usersApi'
import type { AssignableUser } from '../../types/submitDocument'
import { formatFullName } from '../../utils/user'
import { Avatar } from '../ui/Card'

/**
 * Picks one approver by name, email or department.
 *
 * Replaces a native `<select>` that listed every user in the organisation with
 * the department appended to the option text. That reads fine against seeded
 * data and is unusable against a real directory: no search, no grouping, and
 * every row a single run-on string. Search runs on the server, so the size of
 * the directory stops being the browser's problem.
 */

interface Props {
  id: string
  value: string
  /** Users already used by other steps, shown but not selectable. */
  takenIds: Set<string>
  /**
   * Users who must not appear at all — the preparer, who signs before the
   * document enters the chain and is barred from acting on it afterwards. The
   * server refuses such a chain; hiding them keeps the form from offering it.
   */
  excludeIds?: Set<string>
  /** Resolved user for the current value, so the closed state can show a name. */
  selected: AssignableUser | null
  invalid?: boolean
  describedBy?: string
  onChange: (user: AssignableUser) => void
  onResolved: (user: AssignableUser) => void
  /**
   * Whether this person may add somebody to the directory.
   *
   * Only an administrator can: `admin.routes.ts` is
   * `router.use(authenticate, requireAdmin)`. When false the control is not
   * rendered at all rather than rendered and refused - offering a button whose
   * only possible answer is 403 is worse than offering nothing.
   */
  canAddPerson?: boolean
  /** Asks the parent to open the add-a-person dialog for this search. */
  onAddPerson?: (query: string) => void
}

const PAGE_SIZE = 25

export default function ApproverCombobox({
  id,
  value,
  takenIds,
  excludeIds,
  selected,
  invalid,
  describedBy,
  onChange,
  onResolved,
  canAddPerson = false,
  onAddPerson,
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AssignableUser[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  /**
   * The term the last answer came back for, or null before any has.
   *
   * "No people are available to assign." used to be drawn whenever there were
   * no results and nothing in flight - which includes the whole 220ms the
   * search waits before it asks anybody. Every open therefore began with a
   * fifth of a second of the panel stating, confidently, that the
   * organisation has no staff.
   *
   * Held as the answered term rather than a boolean so it needs no resetting:
   * typing another character makes `asked` false by making the two differ,
   * without a setState in an effect body to cascade a render.
   */
  const [answeredFor, setAnsweredFor] = useState<string | null>(null)
  const asked = answeredFor === query

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const optionId = useId()

  // Search whenever the panel is open and the term settles.
  useEffect(() => {
    if (!open) return

    let cancelled = false
    const handle = setTimeout(() => {
      setLoading(true)
      fetchAssignableUsers({ q: query, limit: PAGE_SIZE })
        .then(page => {
          if (cancelled) return
          const visible = excludeIds
            ? page.users.filter(user => !excludeIds.has(user.id))
            : page.users
          setResults(visible)
          setTotal(page.total - (page.users.length - visible.length))
          setError(null)
          setActiveIndex(0)
          // Keep the parent's cache of resolved users warm so the closed state
          // and the routing preview can name people without another request.
          for (const user of visible) onResolved(user)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          setResults([])
          setError(err instanceof Error ? err.message : 'Could not load people')
        })
        .finally(() => {
          if (cancelled) return
          setLoading(false)
          setAnsweredFor(query)
        })
    }, 220)

    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [open, query, onResolved, excludeIds])

  // Close on an outside click or Escape.
  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      // No focus restore here: a pointer user is already looking somewhere
      // else, and yanking focus back to the trigger would fight the thing
      // they just clicked.
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  const grouped = useMemo(() => {
    const groups = new Map<string, AssignableUser[]>()
    for (const user of results) {
      const key = user.department?.name ?? 'No department'
      const list = groups.get(key) ?? []
      list.push(user)
      groups.set(key, list)
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [results])

  /**
   * The rows the arrow keys walk, in the order they are drawn.
   *
   * Derived from `grouped` rather than from `results`, and that is the whole
   * fix: the list is drawn grouped by department while the highlight used to
   * walk the order the server sent. Against a page that came back
   * Finance/Legal/Finance, pressing ArrowDown once tinted the second row on
   * screen and Enter committed somebody else entirely.
   */
  const selectable = useMemo(
    () =>
      grouped
        .flatMap(([, people]) => people)
        .filter(user => !takenIds.has(user.id)),
    [grouped, takenIds],
  )

  /**
   * Close, and put focus back on the control that opened this.
   *
   * Closing drops the search field out of the DOM, so without this focus
   * lands on `body` and a keyboard user is returned to the top of the
   * document - having to tab through the whole form again to get back to the
   * step they were filling in.
   */
  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const commit = (user: AssignableUser) => {
    if (takenIds.has(user.id)) return
    onChange(user)
    close()
    setQuery('')
  }

  const onTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setOpen(true)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  const onSearchKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(index => Math.min(index + 1, selectable.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(index => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const user = selectable[activeIndex]
      if (user) commit(user)
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        id={id}
        onClick={() => {
          setOpen(value => !value)
          requestAnimationFrame(() => inputRef.current?.focus())
        }}
        ref={triggerRef}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-required="true"
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        className={`field flex h-10 w-full items-center justify-between gap-2 text-left ${
          invalid ? 'border-danger-line' : ''
        }`}
      >
        {selected ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-content">
              {formatFullName(selected.firstName, selected.lastName)}
            </span>
            {selected.department?.name && (
              <span className="hidden truncate text-2xs text-content-subtle sm:inline">
                {selected.department.name}
              </span>
            )}
          </span>
        ) : (
          /*
           * Three states, not two.
           *
           * A step can carry a `value` the parent has not resolved a name for
           * yet - the "reuse that chain" path sets ids first - and the control
           * then fell back to the same words an empty step shows. A filled
           * step read as empty, and re-picking silently reassigned it to
           * somebody else.
           */
          <span className="text-content-subtle">
            {value ? 'Assigned — loading their name…' : 'Search for a person…'}
          </span>
        )}
        <ChevronDown
          size={14}
          aria-hidden="true"
          className="flex-shrink-0 text-content-subtle"
        />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-card border border-line bg-surface shadow-card">
          <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
            <Search size={14} aria-hidden="true" className="text-content-subtle" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Name, email or department"
              aria-label="Search for a person"
              aria-controls={listId}
              /* The highlight was a background tint and nothing else, so a
                 screen-reader user pressing ArrowDown heard silence and then
                 committed somebody they had never been told about. */
              aria-activedescendant={
                selectable[activeIndex]
                  ? `${optionId}-${selectable[activeIndex].id}`
                  : undefined
              }
              className="h-7 w-full bg-transparent text-ui text-content outline-none placeholder:text-content-subtle"
            />
            {loading && (
              <Loader2
                size={14}
                aria-hidden="true"
                className="animate-spin text-content-subtle"
              />
            )}
            {query && !loading && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="text-content-subtle hover:text-content"
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </div>

          {/* Results arrived silently: the spinner is aria-hidden and the list
              had no live region, so a screen-reader user had no signal that
              the panel had changed under them. */}
          <p role="status" aria-live="polite" className="sr-only">
            {loading
              ? 'Searching…'
              : error
                ? error
                : asked
                  ? `${results.length} of ${total} people found`
                  : ''}
          </p>

          <ul
            id={listId}
            role="listbox"
            aria-label="People"
            className="max-h-64 overflow-y-auto py-1"
          >
            {error && (
              <li className="px-3 py-3 text-meta text-danger-ink" role="alert">
                {error}
              </li>
            )}

            {!error && results.length === 0 && !loading && asked && (
              <li className="px-3 py-4 text-center">
                <p className="text-meta text-content-subtle">
                  {query
                    ? `Nobody matches “${query}”.`
                    : 'No people are available to assign.'}
                </p>

                {/*
                  * Where this used to stop.
                  *
                  * The approver who is not in the directory is the one case
                  * this control could not help with, and getting past it meant
                  * leaving the wizard for the People screen - which keeps the
                  * typed draft but NOT the attached PDF. One missing person
                  * cost the whole upload.
                  */}
                {canAddPerson && onAddPerson && (
                  <button
                    type="button"
                    onClick={() => onAddPerson(query)}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-meta font-medium text-accent-ink transition-colors hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <UserPlus size={13} aria-hidden="true" />
                    {query ? `Add “${query}” as a new person` : 'Add a new person'}
                  </button>
                )}

                {!canAddPerson && query && (
                  <p className="mt-1.5 text-meta text-content-subtle">
                    Only an administrator can add someone new.
                  </p>
                )}
              </li>
            )}

            {grouped.map(([department, people]) => (
              <li key={department}>
                <p className="px-3 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                  {department}
                </p>
                <ul>
                  {people.map(user => {
                    const taken = takenIds.has(user.id)
                    const isSelected = user.id === value
                    const active = selectable[activeIndex]?.id === user.id
                    return (
                      <li key={user.id}>
                        <button
                          type="button"
                          id={`${optionId}-${user.id}`}
                          role="option"
                          aria-selected={isSelected}
                          disabled={taken}
                          onClick={() => commit(user)}
                          className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                            taken
                              ? 'cursor-not-allowed opacity-45'
                              : active
                                ? 'bg-accent-soft'
                                : 'hover:bg-sunken'
                          }`}
                        >
                          <Avatar firstName={user.firstName} lastName={user.lastName} />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="truncate text-ui text-content">
                                {formatFullName(user.firstName, user.lastName)}
                              </span>
                              {user.loginRole === 'ADMINISTRATOR' && (
                                <span className="flex-shrink-0 rounded-pill bg-line-soft px-1.5 text-2xs text-content-subtle">
                                  Admin
                                </span>
                              )}
                            </span>
                            <span className="block truncate text-2xs text-content-subtle">
                              {taken ? 'Already in this approval chain · ' : ''}
                              {user.email}
                            </span>
                          </span>
                          {isSelected && (
                            <Check
                              size={14}
                              aria-hidden="true"
                              className="flex-shrink-0 text-accent"
                            />
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
          </ul>

          {total > results.length && (
            <p className="border-t border-line-soft px-3 py-2 text-2xs text-content-subtle">
              Showing {results.length} of {total} people — keep typing to narrow it down.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
