import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle, Search, X } from 'lucide-react'
import { fetchApprovalOversight } from '../services/documentsApi'
import type { OversightItem } from '../types/document'
import { LoadingAnnouncer } from '../components/ui/Skeleton'
import Eyebrow from '../components/ui/Eyebrow'
import Button from '../components/ui/Button'
import OversightStats from '../components/oversight/OversightStats'
import InFlightTable from '../components/oversight/InFlightTable'
import LoadByPerson from '../components/oversight/LoadByPerson'
import { computeApproverLoad, computeOversightStats, sortByWait } from '../utils/oversight'
import { getWaitingSeverity } from '../utils/format'

/**
 * Organisation-wide view of everything in flight, for administrators.
 *
 * My queue shows one person's own queue, and an administrator is just
 * another person with a queue — so the role with the authority to unblock a
 * stalled workflow previously had no way to find one. This is that view: what
 * is waiting, on whom, and for how long.
 *
 * It reports; it does not act. Overriding an approver is a governance decision
 * rather than a UI one, so nothing here reaches the backend's skip capability
 * and there is no Nudge or Escalate button pretending otherwise.
 *
 * One of two screens that stay dark in BOTH themes — a monitoring surface
 * where the signal colours have to carry across a room. Every value here is
 * an explicit `dark-*` token rather than the theme's own, because the theme
 * can flip underneath this page and the ground must not.
 */

type Bucket = 'all' | 'stalled'

/** Reads as a page header eyebrow: "AS OF 14:40 PKT · ALL DEPARTMENTS". */
function formatAsOf(asOf: number): string {
  const time = new Date(asOf).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })
  return `As of ${time} · all departments`
}

export default function ControlRoomPage() {
  const [items, setItems] = useState<OversightItem[] | null>(null)
  // One reference time captured when the data lands, rather than reading the
  // clock during render — every age on the page is then measured against the
  // same instant, which is also what makes the numbers agree with each other.
  const [asOf, setAsOf] = useState(() => Date.now())
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [bucket, setBucket] = useState<Bucket>('all')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await fetchApprovalOversight()
        if (!cancelled) {
          setItems(data.items)
          setAsOf(Date.now())
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setItems([])
          setError(err instanceof Error ? err.message : 'Could not load oversight data.')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  const stats = useMemo(
    () => computeOversightStats(items ?? [], asOf),
    [items, asOf],
  )

  const load = useMemo(() => computeApproverLoad(items ?? [], asOf), [items, asOf])

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase()
    const filtered = (items ?? []).filter(item => {
      if (bucket === 'stalled') {
        const severity = getWaitingSeverity(item.heldSince, asOf)
        if (severity !== 'overdue' && severity !== 'critical') return false
      }
      if (!term) return true
      const holder = item.holder
        ? `${item.holder.firstName} ${item.holder.lastName} ${item.holder.department ?? ''}`
        : ''
      const preparer = `${item.preparer.firstName} ${item.preparer.lastName}`
      return term
        .split(/\s+/)
        .every(t =>
          `${item.title} ${holder} ${preparer} ${item.id}`.toLowerCase().includes(t),
        )
    })
    return sortByWait(filtered)
  }, [items, search, bucket, asOf])

  if (items === null) {
    return (
      <Screen>
        <Header eyebrow="Loading" />
        <div aria-hidden="true" className="mb-3 grid grid-cols-2 gap-3 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-22 animate-pulse rounded-card bg-dark-surface" />
          ))}
        </div>
        <div
          aria-hidden="true"
          className="h-96 animate-pulse rounded-card bg-dark-surface"
        />
        <LoadingAnnouncer loading label="Loading the control room" />
      </Screen>
    )
  }

  if (error) {
    return (
      <Screen>
        <Header eyebrow="Unavailable" />
        <div className="flex flex-col items-center gap-3 rounded-card border border-dark-line bg-dark-surface px-6 py-16 text-center">
          <AlertCircle size={22} aria-hidden="true" className="text-dark-danger" />
          <p className="text-ui text-dark-content">Could not load the control room</p>
          <p className="max-w-md text-meta text-dark-content-muted">{error}</p>
          <Button className="mt-1" onClick={() => setReloadKey(k => k + 1)}>
            Try again
          </Button>
        </div>
      </Screen>
    )
  }

  return (
    <Screen>
      <Header eyebrow={formatAsOf(asOf)} />

      <OversightStats stats={stats} />

      <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="overflow-hidden rounded-card border border-dark-line bg-dark-surface">
          <div className="flex flex-col gap-2.5 border-b border-dark-line px-3.5 py-3 lg:flex-row lg:items-center">
            <h2 className="flex-shrink-0 text-section font-semibold text-dark-content">
              Memos in flight
            </h2>

            <div
              role="tablist"
              aria-label="Filter memos in flight"
              className="flex flex-shrink-0 gap-1 rounded-control border border-dark-line bg-dark-canvas p-0.75"
            >
              {(
                [
                  { id: 'all' as const, label: 'All', count: stats.inFlight },
                  { id: 'stalled' as const, label: 'Stalled', count: stats.stalled },
                ]
              ).map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={bucket === tab.id}
                  onClick={() => setBucket(tab.id)}
                  className={`flex items-center gap-1.5 rounded-chip px-2.5 py-1 text-meta font-medium transition-colors ${
                    bucket === tab.id
                      ? 'bg-dark-line text-dark-content'
                      : 'text-dark-content-subtle hover:text-dark-content-muted'
                  }`}
                >
                  {tab.label}
                  <span className="font-mono text-data tabular-nums">{tab.count}</span>
                </button>
              ))}
            </div>

            <div className="relative min-w-0 flex-1">
              <label htmlFor="oversight-search" className="sr-only">
                Search memos in flight
              </label>
              <Search
                size={14}
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dark-content-subtle"
              />
              <input
                id="oversight-search"
                type="search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search document, holder or department…"
                className="dark-field h-8.5 pl-8.5 pr-8"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-control text-dark-content-subtle hover:bg-dark-line hover:text-dark-content"
                >
                  <X size={13} aria-hidden="true" />
                </button>
              )}
            </div>

            <span className="flex-shrink-0 whitespace-nowrap font-mono text-data uppercase tracking-eyebrow text-dark-content-subtle">
              Sorted by wait
            </span>
          </div>

          {visible.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
              <CheckCircle size={22} aria-hidden="true" className="text-dark-accent" />
              <p className="text-ui font-medium text-dark-content">
                {stats.inFlight === 0 ? 'Nothing in flight' : 'No matches'}
              </p>
              <p className="max-w-sm text-meta text-dark-content-muted">
                {stats.inFlight === 0
                  ? 'No memo is currently awaiting an approval action.'
                  : 'No memo matches the current filter.'}
              </p>
            </div>
          ) : (
            <InFlightTable items={visible} asOf={asOf} />
          )}
        </section>

        <LoadByPerson rows={load} chasedToday={stats.chasedToday} />
      </div>

      <p aria-live="polite" className="sr-only">
        {`${visible.length} of ${stats.inFlight} memos shown`}
      </p>
    </Screen>
  )
}

/**
 * The dark ground. It fills the scroll container rather than sitting inside
 * `Page`, so the colour reaches the viewport edges instead of stopping at a
 * card boundary with the light canvas showing around it.
 */
function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full bg-dark-canvas">
      <div className="mx-auto w-full max-w-350 px-4 pb-10 pt-5.5 sm:px-6">{children}</div>
    </div>
  )
}

function Header({ eyebrow }: { eyebrow: string }) {
  return (
    <div className="mb-5">
      <Eyebrow tone="dark" className="mb-1.5">
        {eyebrow}
      </Eyebrow>
      <h1 className="text-title font-semibold tracking-[-0.02em] text-dark-content">
        Control room
      </h1>
    </div>
  )
}
