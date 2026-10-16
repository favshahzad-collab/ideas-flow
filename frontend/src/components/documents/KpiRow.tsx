import { Link } from 'react-router-dom'
import type { Tone } from '../ui/Card'
import { ROUTES } from '../../types/routes'
import type { DocumentKpis } from '../../utils/documentInsights'
import type { DocumentStatusFilter } from '../../utils/documentFilters'

const DOTS: Record<Tone, string> = {
  accent: 'bg-accent-mark',
  info: 'bg-info-mark',
  warning: 'bg-warning-mark',
  danger: 'bg-danger-mark',
  revision: 'bg-revision-mark',
  neutral: 'bg-neutral-mark',
}

const RULES: Record<Tone, string> = {
  accent: 'border-t-accent-mark',
  info: 'border-t-info-mark',
  warning: 'border-t-warning-mark',
  danger: 'border-t-danger-mark',
  revision: 'border-t-revision-mark',
  neutral: 'border-t-neutral-mark',
}

type Tile = {
  key: string
  label: string
  value: string
  tone: Tone
  /** Pressing the tile applies this filter, when it maps to one. */
  filter?: DocumentStatusFilter
  /** Or goes to the screen where that work is done. */
  to?: string
  /** Spelled out for assistive tech and on hover. */
  hint: string
}

/** Whether a tile shows something worth a pulse: not 0, not "—". */
function hasFigure(value: string): boolean {
  return value !== '0' && value !== '0d' && value !== '—'
}

function buildTiles(kpis: DocumentKpis): Tile[] {
  return [
    {
      key: 'in-flight',
      label: 'In progress',
      value: String(kpis.inFlight),
      tone: 'accent',
      filter: 'pending',
      hint: 'Submitted and not yet approved, rejected or withdrawn',
    },
    {
      key: 'awaiting',
      label: 'Awaiting you',
      value: String(kpis.awaitingYou),
      tone: 'warning',
      /* Not a filter on this list: what is waiting on you is My queue,
         which is where it gets signed. The tile used to show the count and
         go nowhere. */
      to: ROUTES.pendingApprovals,
      hint: 'Waiting on your review or approval. Opens My queue',
    },
    {
      key: 'waiting',
      label: 'Waiting 7+ days',
      value: String(kpis.waitingOverWeek),
      tone: 'danger',
      /* Deliberately not "Breaching SLA": there is no due date in the
         schema, so this is how long a document has sat untouched, not a
         missed commitment. */
      hint: 'In progress and untouched for more than a week. Age, not a missed deadline — no SLA is configured',
    },
    {
      key: 'cycle',
      label: 'Typical time to approve',
      value: kpis.medianCycleDays === null ? '—' : `${kpis.medianCycleDays}d`,
      tone: 'info',
      hint: 'Median time from submission to approval, across approved documents',
    },
    {
      key: 'approved',
      label: 'Approved this month',
      value: String(kpis.approvedThisMonth),
      tone: 'neutral',
      filter: 'approved',
      hint: 'Approved since the first of the current month',
    },
  ]
}

/**
 * The five figures above the table.
 *
 * The design shows a delta beside each value (+12, −0.6d). Those need a
 * previous period to compare against, which `GET /api/documents/summary`
 * would supply; there is no way to compute one from a single list response,
 * so the row carries the figure alone rather than a made-up trend.
 */
export default function KpiRow({
  kpis,
  activeFilter,
  onFilter,
}: {
  kpis: DocumentKpis
  activeFilter: DocumentStatusFilter
  onFilter: (filter: DocumentStatusFilter) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
      {buildTiles(kpis).map(tile => {
        const isActive = tile.filter !== undefined && activeFilter === tile.filter
        const shared = `rounded-card border border-line ${RULES[tile.tone]} border-t-2 bg-surface px-3.5 py-3 text-left`

        const body = (
          <>
            <span className="flex items-center gap-1.5">
              {/* Keyed on the figure, so a changed number pulses again. A
                  zero sits still: nothing to draw the eye to. */}
              <span
                key={tile.value}
                aria-hidden="true"
                className={`h-1.5 w-1.5 flex-shrink-0 rounded-pill ${DOTS[tile.tone]} ${
                  hasFigure(tile.value) ? 'figure-pulse' : ''
                }`}
              />
              <span className="truncate text-2xs text-content-subtle">{tile.label}</span>
            </span>
            {/* Colour is reserved for a count that exists: a zero rendered in
                danger red reads as an alarm when nothing is wrong. */}
            <span
              className={`mt-1 block text-kpi font-semibold tabular-nums tracking-tight ${
                tile.value === '0' || tile.value === '—'
                  ? 'text-content-subtle'
                  : 'text-content'
              }`}
            >
              {tile.value}
            </span>
          </>
        )

        if (tile.to) {
          return (
            <Link
              key={tile.key}
              to={tile.to}
              title={tile.hint}
              className={`${shared} block transition-colors hover:bg-canvas`}
            >
              {body}
              <span className="sr-only">. {tile.hint}</span>
            </Link>
          )
        }

        if (!tile.filter) {
          return (
            <div key={tile.key} className={shared} title={tile.hint}>
              {body}
              <span className="sr-only">. {tile.hint}</span>
            </div>
          )
        }

        return (
          <button
            key={tile.key}
            type="button"
            onClick={() => onFilter(isActive ? 'all' : tile.filter!)}
            aria-pressed={isActive}
            title={tile.hint}
            className={`${shared} transition-colors ${
              isActive
                ? 'ring-1 ring-accent-line'
                : 'hover:bg-canvas'
            }`}
          >
            {body}
            <span className="sr-only">. {tile.hint}</span>
          </button>
        )
      })}
    </div>
  )
}
