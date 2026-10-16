import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  CircleCheck,
  FileText,
  RotateCcw,
  Search,
} from 'lucide-react'
import Keycap from './ui/Keycap'
import Eyebrow from './ui/Eyebrow'
import { useDialogA11y } from '../hooks/useDialogA11y'
import { useDocuments } from '../hooks/useDocuments'
import { useCurrentUser } from '../contexts/currentUser'
import {
  getCommandsSnapshot,
  subscribeToCommands,
  useCommandPalette,
  type Command,
  type CommandGroup,
} from '../contexts/commandPalette'
import { GO_TO } from '../hooks/useGlobalShortcuts'
import { NAV_PATHS, PAGE_LABELS, ROUTES, isAdminPage, type AppPage } from '../types/routes'
import { formatMemoReference } from '../utils/format'

const GROUP_LABELS: Record<CommandGroup, string> = {
  actions: 'Actions',
  documents: 'Documents',
  goto: 'Go to',
}

const GROUP_ORDER: CommandGroup[] = ['actions', 'documents', 'goto']

const GROUP_TILES: Record<CommandGroup, string> = {
  actions: 'bg-accent-soft text-accent-ink',
  documents: 'bg-sunken text-content-muted',
  goto: 'bg-info-soft text-info-ink',
}

const GROUP_ICONS = {
  actions: CircleCheck,
  documents: FileText,
  goto: ArrowRight,
} as const

/** The letter that jumps to each screen, derived from the same map the keys use. */
const SHORTCUT_FOR = Object.fromEntries(
  Object.entries(GO_TO).map(([letter, path]) => [path, `G ${letter.toUpperCase()}`]),
)

function matches(query: string, ...fields: string[]): boolean {
  if (!query) return true
  const needle = query.toLowerCase()
  return fields.some(field => field.toLowerCase().includes(needle))
}

export default function CommandPalette() {
  const { setOpen } = useCommandPalette()
  /* Subscribed rather than passed down, so registering an action on a
     screen does not re-render the shell that contains it. */
  const contextual = useSyncExternalStore(subscribeToCommands, getCommandsSnapshot)
  const navigate = useNavigate()
  const { user } = useCurrentUser()
  const { documents, loading: documentsLoading, error: documentsError } =
    useDocuments()

  const [query, setQuery] = useState('')
  const [deferred, setDeferred] = useState('')
  const [highlighted, setHighlighted] = useState(0)

  const inputId = useId()
  const listId = useId()
  const close = useCallback(() => setOpen(false), [setOpen])
  const panelRef = useDialogA11y(true, close)
  const listRef = useRef<HTMLDivElement>(null)

  // 120ms, so filtering a few hundred rows does not run on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDeferred(query), 120)
    return () => clearTimeout(timer)
  }, [query])

  const commands = useMemo<Command[]>(() => {
    const isAdmin = user?.role === 'ADMINISTRATOR'

    const goTo: Command[] = (Object.keys(NAV_PATHS) as (keyof typeof NAV_PATHS)[])
      .filter(page => !isAdminPage(page as AppPage) || isAdmin)
      .map(page => ({
        id: `goto:${page}`,
        group: 'goto' as const,
        label: PAGE_LABELS[page as AppPage],
        hint: NAV_PATHS[page],
        shortcut: SHORTCUT_FOR[NAV_PATHS[page]],
        run: () => navigate(NAV_PATHS[page]),
      }))

    /*
     * Every document, not the first forty.
     *
     * The cap used to be applied here, before the query - so searching for
     * the forty-first document told a person it did not exist, while it sat
     * on the dashboard behind them. The list is capped after filtering
     * instead, where a cap is a display decision rather than an answer.
     */
    const docs: Command[] = documents.map(doc => ({
      id: `doc:${doc.id}`,
      group: 'documents' as const,
      label: doc.title,
      hint: `${formatMemoReference(doc.referenceNumber, doc.id)} · ${doc.currentHolder}`,
      run: () => navigate(ROUTES.document(doc.id)),
    }))

    return [...contextual, ...docs, ...goTo]
  }, [contextual, documents, navigate, user])

  const matching = useMemo(
    () => commands.filter(command => matches(deferred, command.label, command.hint ?? '')),
    [commands, deferred],
  )

  /** How many rows are drawn at once, however many matched. */
  const RESULT_LIMIT = 40

  const filtered = useMemo(() => matching.slice(0, RESULT_LIMIT), [matching])
  const hidden = matching.length - filtered.length

  /* The highlight is stored as an index but clamped on read, so a query that
     shortens the list cannot leave it pointing past the end — which would run
     nothing on Enter and look like a dead key. */
  const index = Math.min(highlighted, Math.max(0, filtered.length - 1))
  const active = filtered[index]

  const grouped = useMemo(
    () =>
      GROUP_ORDER.map(group => ({
        group,
        items: filtered.filter(command => command.group === group),
      })).filter(section => section.items.length > 0),
    [filtered],
  )

  const run = useCallback(
    (command: Command | undefined) => {
      if (!command) return
      close()
      command.run()
    },
    [close],
  )

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlighted(Math.min(index + 1, filtered.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlighted(Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      run(active)
    }
  }

  // Keep the highlighted row inside its own scroller, without dragging the
  // page around the way scrollIntoView would.
  useEffect(() => {
    const container = listRef.current
    const row = container?.querySelector<HTMLElement>('[data-active="true"]')
    if (!container || !row) return
    const top = row.offsetTop
    const bottom = top + row.offsetHeight
    if (top < container.scrollTop) container.scrollTop = top
    else if (bottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = bottom - container.clientHeight
    }
  }, [index, filtered.length])

  return (
    <div className="fixed inset-0 z-100">
      <div
        className="absolute inset-0 bg-scrim/55"
        onClick={close}
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        className="absolute left-1/2 top-[12vh] w-[calc(100%-2rem)] max-w-140 -translate-x-1/2 overflow-hidden rounded-card border border-line bg-surface shadow-overlay outline-none"
      >
        <div className="flex items-center gap-2.5 border-b border-line-soft px-4 py-3.5">
          <Search size={17} className="flex-shrink-0 text-content-subtle" aria-hidden="true" />
          <label htmlFor={inputId} className="sr-only">
            Search documents, people and actions
          </label>
          {/* No `autoFocus`. It runs during the commit, before
              `useDialogA11y`'s effect reads `document.activeElement` - so the
              dialog memorised its own search box as the thing to restore
              focus to, and on close restored it to a node that had just been
              unmounted, dropping the keyboard user at the top of the
              document. The hook focuses the first control itself. */}
          <input
            id={inputId}
            value={query}
            onChange={event => {
              setQuery(event.target.value)
              setHighlighted(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="Search documents, people, actions…"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={active ? `cmd-${active.id}` : undefined}
            className="min-w-0 flex-1 bg-transparent text-ui text-content caret-accent outline-none placeholder:text-content-subtle"
          />
          <Keycap className="flex-shrink-0">ESC</Keycap>
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="max-h-85 overflow-y-auto py-1">
          {/* Three states that used to be one.
              The palette mounts when it opens, so its documents are always
              still in flight for the first moment somebody types - and
              "Nothing matches" during that moment is the palette telling
              somebody a document they can see on the dashboard does not
              exist. A request that failed outright said the same thing, with
              the same wrong conclusion available: that the documents are
              gone, rather than that asking for them failed. */}
          {documentsLoading && grouped.length === 0 ? (
            <p className="px-4 py-6 text-center text-ui text-content-subtle">
              Still loading documents…
            </p>
          ) : documentsError && grouped.length === 0 ? (
            <p role="alert" className="px-4 py-6 text-center text-ui text-danger-ink">
              Documents could not be loaded, so only screens are searchable.
              Close this and try again.
            </p>
          ) : grouped.length === 0 ? (
            <p className="px-4 py-6 text-center text-ui text-content-subtle">
              Nothing matches &ldquo;{query}&rdquo;.
            </p>
          ) : (
            grouped.map(section => {
              const Icon = GROUP_ICONS[section.group]
              return (
                <div key={section.group} role="group" aria-label={GROUP_LABELS[section.group]}>
                  <Eyebrow className="px-4 pb-1.5 pt-2.5">
                    {GROUP_LABELS[section.group]}
                  </Eyebrow>
                  {section.items.map(command => {
                    const isActive = command.id === active?.id
                    return (
                      <div
                        key={command.id}
                        id={`cmd-${command.id}`}
                        role="option"
                        aria-selected={isActive}
                        data-active={isActive}
                        onMouseEnter={() =>
                          setHighlighted(filtered.findIndex(c => c.id === command.id))
                        }
                        onClick={() => run(command)}
                        className={`flex cursor-pointer items-center gap-2.75 px-4 py-2.25 ${
                          isActive ? 'bg-accent-soft/50' : ''
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`flex h-6.5 w-6.5 flex-shrink-0 items-center justify-center rounded-chip ${GROUP_TILES[section.group]}`}
                        >
                          {command.group === 'actions' && command.id.includes('revision') ? (
                            <RotateCcw size={13} />
                          ) : (
                            <Icon size={13} />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-section font-medium text-content">
                            {command.label}
                          </span>
                          {command.hint && (
                            <span className="block truncate text-2xs text-content-subtle">
                              {command.hint}
                            </span>
                          )}
                        </span>
                        {command.shortcut && (
                          <span className="flex-shrink-0 font-mono text-data text-content-subtle">
                            {command.shortcut}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>

        {hidden > 0 && (
          <p className="border-t border-line-soft px-4 py-2 text-center text-meta text-content-subtle">
            {hidden} more match. Type a little more to narrow them.
          </p>
        )}

        <p aria-live="polite" className="sr-only">
          {documentsLoading
            ? 'Still loading documents'
            : documentsError
              ? 'Documents could not be loaded'
              : `${matching.length} result${matching.length === 1 ? '' : 's'}`}
        </p>

        <div className="flex items-center justify-between gap-3 border-t border-line-soft bg-canvas px-4 py-2.25">
          <span className="flex items-center gap-3 text-2xs text-content-subtle">
            <span className="flex items-center gap-1">
              <Keycap>↑</Keycap>
              <Keycap>↓</Keycap>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <Keycap>↵</Keycap>
              run
            </span>
          </span>
          <span className="text-2xs text-content-subtle">Ideas Flow command bar</span>
        </div>
      </div>
    </div>
  )
}
