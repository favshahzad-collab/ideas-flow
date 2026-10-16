import { FEATURES } from '../../config/features'
import type { OversightStats } from '../../utils/oversight'

type Tone = 'accent' | 'danger' | 'info' | 'warning'

const DOTS: Record<Tone, string> = {
  accent: 'bg-dark-accent',
  danger: 'bg-dark-danger',
  info: 'bg-dark-info',
  warning: 'bg-dark-warning',
}

const VALUES: Record<Tone, string> = {
  accent: 'text-dark-content',
  danger: 'text-dark-danger',
  info: 'text-dark-content',
  warning: 'text-dark-warning',
}

const RULES: Record<Tone, string> = {
  accent: 'bg-dark-accent',
  danger: 'bg-dark-danger',
  info: 'bg-dark-info',
  warning: 'bg-dark-warning',
}

function StatCard({
  label,
  value,
  unit,
  tone,
  percent,
  hint,
}: {
  label: string
  value: number | string
  unit?: string
  tone: Tone
  /** Fill of the 3px rule along the bottom, 0-100. */
  percent: number
  hint?: string
}) {
  return (
    <div
      className="overflow-hidden rounded-card border border-dark-line bg-dark-surface"
      title={hint}
    >
      <div className="px-4 py-3.5">
        <p className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 flex-shrink-0 rounded-pill ${DOTS[tone]}`}
          />
          <span className="text-2xs font-medium text-dark-content-subtle">{label}</span>
        </p>
        <p className={`mt-2 text-kpi font-semibold tabular-nums leading-none ${VALUES[tone]}`}>
          {value}
          {unit && (
            <span className="ml-1.5 font-mono text-meta font-normal text-dark-content-subtle">
              {unit}
            </span>
          )}
        </p>
      </div>
      <div aria-hidden="true" className="h-0.75 w-full bg-dark-line">
        <div
          className={`h-full ${RULES[tone]}`}
          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </div>
    </div>
  )
}

/**
 * Four numbers, each one measured rather than assumed.
 *
 * The design's set had "Breaching SLA" and "Median cycle" in it. Neither is
 * available: there is no due date on a step, so nothing can breach, and the
 * oversight payload carries only what is still in flight, so a completed
 * cycle time cannot be derived from it. What replaces them is what is true —
 * how many have sat over a week where they are, and how many people are
 * holding the board.
 */
export default function OversightStats({ stats }: { stats: OversightStats }) {
  return (
    <div className="mb-3 grid grid-cols-2 gap-3 xl:grid-cols-4">
      <StatCard
        label="In progress"
        value={stats.inFlight}
        tone="accent"
        percent={100}
        hint="Memos awaiting an approval action right now."
      />
      <StatCard
        label="Stalled over a week"
        value={stats.stalled}
        tone={stats.stalled > 0 ? 'danger' : 'accent'}
        percent={stats.inFlight ? (stats.stalled / stats.inFlight) * 100 : 0}
        hint="Held in the same place for more than seven days. No SLA is configured, so this is age — not a missed deadline."
      />
      <StatCard
        label="People holding work"
        value={stats.holders}
        tone="info"
        percent={stats.inFlight ? (stats.holders / stats.inFlight) * 100 : 0}
        hint="Distinct approvers with at least one document waiting on them."
      />
      <StatCard
        label="Longest wait"
        value={stats.longestWaitDays}
        unit={stats.longestWaitDays === 1 ? 'day' : 'days'}
        tone={stats.longestWaitDays >= 7 ? 'warning' : 'accent'}
        percent={Math.min(100, (stats.longestWaitDays / 30) * 100)}
        hint="The oldest item on the board, measured from when it reached its current holder."
      />

      {/* Shown only where deadlines exist. `breaching` is null, not zero, on a
          board where nothing has one - and a card reading "0 breaching" would
          be a compliance claim nobody has earned. */}
      {FEATURES.sla && stats.breaching !== null && (
        <StatCard
          label="Breaching SLA"
          value={stats.breaching}
          unit={stats.breaching === 1 ? 'memo' : 'memos'}
          tone={stats.breaching > 0 ? 'danger' : 'accent'}
          percent={
            stats.inFlight === 0 ? 0 : Math.min(100, (stats.breaching / stats.inFlight) * 100)
          }
          hint="Past the working days its current approver was given. Counted live, whether or not anybody has been told yet."
        />
      )}
    </div>
  )
}
