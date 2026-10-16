import { AlertCircle, Users } from 'lucide-react'
import { FEATURES } from '../../config/features'
import type { ApproverLoad } from '../../utils/oversight'

const FILLS = {
  accent: 'bg-dark-accent',
  warning: 'bg-dark-warning',
  danger: 'bg-dark-danger',
} as const

const COUNTS = {
  accent: 'text-dark-content-muted',
  warning: 'text-dark-warning',
  danger: 'text-dark-danger',
} as const

/**
 * Who the board is currently sitting on.
 *
 * The bar is a share of the busiest person's load, not of a capacity — no
 * capacity is recorded anywhere, so a "78% full" reading would be invented.
 * The count beside it is the real number, and it is the count the label
 * announces; the bar is `aria-hidden` because it repeats it.
 */
export default function LoadByPerson({
  rows,
  chasedToday,
}: {
  rows: ApproverLoad[]
  /**
   * Holders told about an overdue step today. Null - not zero - when nothing
   * on the board has a deadline, which is what keeps the card out rather than
   * showing a reassuring nought about a policy nobody set.
   */
  chasedToday?: number | null
}) {
  return (
    <aside className="space-y-3" aria-label="Approver load and escalations">
      <section className="overflow-hidden rounded-card border border-dark-line bg-dark-surface">
        <div className="flex items-center justify-between gap-3 border-b border-dark-line px-3.5 py-3">
          <h2 className="flex items-center gap-2 text-section font-semibold text-dark-content">
            <Users size={14} aria-hidden="true" className="text-dark-content-subtle" />
            Load by person
          </h2>
          <span className="font-mono text-data uppercase tracking-eyebrow text-dark-content-subtle">
            Share of busiest
          </span>
        </div>

        {rows.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-meta text-dark-content-subtle">
            Nobody is holding work right now.
          </p>
        ) : (
          <ul className="divide-y divide-dark-line">
            {rows.map(row => (
              <li key={row.id} className="px-3.5 py-2.75">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-ui text-dark-content-muted">
                    {row.name}
                  </span>
                  <span
                    className={`flex-shrink-0 font-mono text-data font-medium tabular-nums ${COUNTS[row.tone]}`}
                  >
                    {row.count}
                    {row.stalled > 0 && (
                      <span className="text-dark-danger"> · {row.stalled} stalled</span>
                    )}
                  </span>
                </div>
                <span
                  aria-hidden="true"
                  className="mt-1.5 block h-1.25 w-full overflow-hidden rounded-pill bg-dark-line"
                >
                  <span
                    className={`block h-full rounded-pill transition-[width] duration-300 ease-out ${FILLS[row.tone]}`}
                    style={{ width: `${Math.max(4, row.percent)}%` }}
                  />
                </span>
                {row.department && (
                  <span className="mt-1 block font-mono text-data text-dark-content-subtle">
                    {row.department}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

{/* Only where deadlines exist. A quiet day and a deployment that has set
          no deadline both produce nothing to report, and they are not the same
          thing to an administrator - so one says "none today" and the other
          says nothing at all. */}
      {FEATURES.sla && chasedToday !== null && chasedToday !== undefined && (
        <section
          className={`rounded-card border px-3.5 py-3 ${
            chasedToday > 0
              ? 'border-dark-danger/30 bg-dark-danger/8'
              : 'border-dark-line bg-dark-surface'
          }`}
        >
          <h2
            className={`flex items-center gap-2 text-section font-semibold ${
              chasedToday > 0 ? 'text-dark-danger' : 'text-dark-content'
            }`}
          >
            <AlertCircle size={14} aria-hidden="true" />
            Chased today
          </h2>
          <p
            className={`mt-1.5 text-meta leading-relaxed ${
              chasedToday > 0 ? 'text-dark-danger' : 'text-dark-content-subtle'
            }`}
          >
            {chasedToday === 0
              ? 'Nobody has been chased today. Nothing on the board has run past its deadline.'
              : `${chasedToday} ${chasedToday === 1 ? 'memo' : 'memos'} ran past the days its approver was given. They and the preparer have each been told once.`}
          </p>
        </section>
      )}
    </aside>
  )
}
