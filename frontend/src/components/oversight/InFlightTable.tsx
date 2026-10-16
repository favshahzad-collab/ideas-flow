import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { ROUTES } from '../../types/routes'
import {
  formatMemoReference,
  formatWaitingDuration,
  getWaitingSeverity,
  type WaitingSeverity,
} from '../../utils/format'
import type { OversightItem } from '../../types/document'

const DOTS: Record<WaitingSeverity, string> = {
  fresh: 'bg-dark-accent',
  ageing: 'bg-dark-warning',
  overdue: 'bg-dark-danger',
  critical: 'bg-dark-danger',
}

/* The pill is tinted with the accent at low alpha rather than a flat fill,
   which is what keeps it legible against a near-black card without shouting
   over the four other pills in the same column. */
const PILLS: Record<WaitingSeverity, string> = {
  fresh: 'bg-dark-line text-dark-content-muted',
  ageing: 'bg-dark-warning/15 text-dark-warning',
  overdue: 'bg-dark-danger/15 text-dark-danger',
  critical: 'bg-dark-danger/25 text-dark-danger',
}

const PREFIX: Record<WaitingSeverity, string> = {
  fresh: 'Waiting',
  ageing: 'Waiting',
  overdue: 'Overdue',
  critical: 'Overdue',
}

function Initials({ first, last }: { first: string; last: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-5.5 w-5.5 flex-shrink-0 items-center justify-center rounded-pill bg-dark-line text-eyebrow font-semibold text-dark-content-muted"
    >
      {`${first.charAt(0)}${last.charAt(0)}`.toUpperCase()}
    </span>
  )
}

export default function InFlightTable({
  items,
  asOf,
}: {
  items: OversightItem[]
  /** One reference instant for every age on the page, so they agree. */
  asOf: number
}) {
  return (
    <div className="relative overflow-x-auto">
      {/* `relative` keeps the sr-only header cells from escaping this
          scroller and stretching the document — see PeopleTable. */}
      <table className="w-full min-w-175 border-collapse">
        <caption className="sr-only">
          Memos in flight across the organisation, longest waiting first
        </caption>
        <thead>
          <tr className="border-b border-dark-line">
            <th scope="col" className="dark-table-head pl-3.5">
              Document
            </th>
            <th scope="col" className="dark-table-head">
              Holder
            </th>
            <th scope="col" className="dark-table-head">
              Step
            </th>
            <th scope="col" className="dark-table-head">
              Waiting
            </th>
            <th scope="col" className="dark-table-head">
              Submitted by
            </th>
            <th scope="col" className="dark-table-head w-10">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>

        <tbody>
          {items.map(item => {
            const severity = getWaitingSeverity(item.heldSince, asOf)
            return (
              <tr
                key={item.id}
                className="border-b border-dark-line transition-colors last:border-0 hover:bg-dark-header/70"
              >
                <td className="max-w-75 py-2.5 pl-3.5 pr-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={`h-1.75 w-1.75 flex-shrink-0 rounded-pill ${DOTS[severity]}`}
                    />
                    <span className="min-w-0">
                      <Link
                        to={ROUTES.document(item.id)}
                        title={item.title}
                        className="block truncate text-ui font-medium text-dark-content hover:text-dark-accent"
                      >
                        {item.title}
                      </Link>
                      <span className="block font-mono text-data text-dark-content-subtle">
                        {formatMemoReference(item.referenceNumber, item.id)} &middot; v{item.versionNumber}
                      </span>
                    </span>
                  </span>
                </td>

                <td className="whitespace-nowrap px-3 py-2.5">
                  {item.holder ? (
                    <span className="flex items-center gap-2">
                      <Initials
                        first={item.holder.firstName}
                        last={item.holder.lastName}
                      />
                      <span className="min-w-0">
                        <span className="block text-ui text-dark-content-muted">
                          {item.holder.firstName} {item.holder.lastName}
                        </span>
                        <span className="block font-mono text-data text-dark-content-subtle">
                          {item.holder.department ?? 'No department'}
                        </span>
                      </span>
                    </span>
                  ) : (
                    <span className="text-ui text-dark-content-subtle">Unassigned</span>
                  )}
                </td>

                <td className="whitespace-nowrap px-3 py-2.5 font-mono text-data tabular-nums text-dark-content-subtle">
                  {item.currentStepOrder}/{item.totalSteps}
                </td>

                <td className="whitespace-nowrap px-3 py-2.5">
                  <span
                    className={`inline-block rounded-chip px-2 py-1 font-mono text-data font-medium tabular-nums ${PILLS[severity]}`}
                  >
                    {PREFIX[severity]} {formatWaitingDuration(item.heldSince, asOf)}
                  </span>
                </td>

                <td className="whitespace-nowrap px-3 py-2.5 text-ui text-dark-content-muted">
                  {item.preparer.firstName} {item.preparer.lastName}
                </td>

                <td className="px-3 py-2.5">
                  {/* The design puts `Escalate` and `Nudge` here. Neither
                      exists: there is no notify endpoint and no escalation
                      path, and this screen's whole premise is that
                      overriding an approver is a governance decision rather
                      than a button. Opening the document is the action that
                      is actually available from here. */}
                  <Link
                    to={ROUTES.document(item.id)}
                    aria-label={`Open ${item.title}`}
                    title={`Open ${item.title}`}
                    className="inline-flex h-6.5 w-6.5 items-center justify-center rounded-control text-dark-content-subtle transition-colors hover:bg-dark-line hover:text-dark-content"
                  >
                    <ArrowUpRight size={15} aria-hidden="true" />
                  </Link>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
