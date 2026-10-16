import { useEffect, useRef } from 'react'
import StatusBadge from '../StatusBadge'
import DownloadDocumentButton from '../DownloadDocumentButton'
import { Avatar } from '../ui/Card'
import RowMenu, { MenuItem } from '../ui/RowMenu'
import MetaBar from '../ui/MetaBar'
import StagePips from '../ui/StagePips'
import { FEATURES } from '../../config/features'
import {
  formatMemoReference,
  formatDueShort,
  formatWaitingDuration,
  getDuePercent,
  getDueSeverity,
  getWaitingPercent,
  getWaitingSeverity,
} from '../../utils/format'
import type { DashboardDocument, DocumentStatus } from '../../types/document'

const IN_FLIGHT = new Set<DocumentStatus>([
  'pending_review',
  'pending_approval',
  'revision_requested',
])

const STATUS_DOTS: Record<DocumentStatus, string> = {
  draft: 'bg-neutral-mark',
  pending_review: 'bg-info-mark',
  pending_approval: 'bg-warning-mark',
  revision_requested: 'bg-revision-mark',
  approved: 'bg-accent-mark',
  rejected: 'bg-danger-mark',
  deleted: 'bg-neutral-mark',
}

const STAGE_TONES: Record<DocumentStatus, 'accent' | 'danger' | 'revision' | 'neutral'> = {
  draft: 'neutral',
  pending_review: 'accent',
  pending_approval: 'accent',
  revision_requested: 'revision',
  approved: 'accent',
  rejected: 'danger',
  deleted: 'neutral',
}

const AGE_TONES = {
  fresh: 'accent',
  ageing: 'warning',
  overdue: 'danger',
  critical: 'danger',
} as const

/**
 * Time in the current state, with a bar that fills as it approaches a week.
 *
 * This is NOT the design's SLA column. The schema has no due date, so there
 * is no deadline to count down to; what is real is how long the document has
 * sat where it is. The header says "Age" and the tooltip says so again,
 * because a bar that turns red is easily read as a missed commitment.
 */
const DUE_TONES = {
  ahead: 'accent',
  soon: 'warning',
  overdue: 'danger',
} as const

/**
 * A countdown where a deadline exists, and an age where none does.
 *
 * Two different claims in one column, which is right because they answer the
 * same question at different strengths. "4d left" is only sayable when
 * somebody set a number of days for this step; where nobody has, "6d" is the
 * true thing to say and a countdown would be a deadline invented on the
 * screen. The header above changes with it, so the column never labels one as
 * the other.
 */
function AgeCell({ doc }: { doc: DashboardDocument }) {
  if (!IN_FLIGHT.has(doc.status)) {
    return <span className="text-content-faint">&mdash;</span>
  }

  if (FEATURES.sla && doc.dueAt) {
    const severity = getDueSeverity(doc.dueAt)

    return (
      <span
        className="inline-flex items-center gap-2 whitespace-nowrap"
        title={`Due ${new Date(doc.dueAt).toLocaleDateString()}. Counted in working days from when it reached the current approver.`}
      >
        <MetaBar
          pct={getDuePercent(doc.updatedAt, doc.dueAt)}
          tone={DUE_TONES[severity]}
          width="table"
        />
        <span
          className={`font-mono text-2xs tabular-nums ${
            severity === 'overdue' ? 'text-danger-ink' : 'text-content-subtle'
          }`}
        >
          {formatDueShort(doc.dueAt)}
        </span>
      </span>
    )
  }

  const severity = getWaitingSeverity(doc.updatedAt)
  const pct = getWaitingPercent(doc.updatedAt)

  return (
    <span
      className="inline-flex items-center gap-2 whitespace-nowrap"
      title="Time in the current state. No deadline is set for this step, so this is age, not a missed one."
    >
      <MetaBar pct={pct} tone={AGE_TONES[severity]} width="table" />
      <span className="font-mono text-2xs tabular-nums text-content-subtle">
        {formatWaitingDuration(doc.updatedAt)}
      </span>
    </span>
  )
}

/**
 * The row carries an `onClick` for mouse users, but a `<tr>` is not a
 * control: it takes no focus, Enter does nothing on it, and a screen reader
 * announces a row of cells with no hint that any of it opens anything. The
 * only keyboard route to a document was the row menu.
 *
 * So the title is a real button. It sits inside the cell rather than
 * wrapping the row, which keeps the checkbox, the row menu and the download
 * control as siblings instead of nesting them inside a button.
 */
function TitleCell({ doc, onOpen }: { doc: DashboardDocument; onOpen: (id: string) => void }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        className={`h-1.75 w-1.75 flex-shrink-0 rounded-pill ${STATUS_DOTS[doc.status]}`}
      />
      <span className="min-w-0">
        <button
          type="button"
          onClick={event => {
            /* The row would otherwise open it a second time. */
            event.stopPropagation()
            onOpen(doc.id)
          }}
          title={doc.title}
          className="block w-full truncate text-left text-ui font-medium text-content hover:text-accent-ink"
        >
          {doc.title}
        </button>
        <span className="block font-mono text-data text-content-subtle">
          {formatMemoReference(doc.referenceNumber, doc.id)} &middot; v{doc.versionNumber}
        </span>
      </span>
    </span>
  )
}

export default function DocumentsTable({
  documents,
  selectedIds,
  onToggle,
  onTogglePage,
  onOpen,
  showPreparer = false,
}: {
  documents: DashboardDocument[]
  selectedIds: ReadonlySet<string>
  onToggle: (id: string) => void
  onTogglePage: (ids: string[], select: boolean) => void
  onOpen: (id: string) => void
  /**
   * Whose memo each row is.
   *
   * Off for everybody else, because every row in their list is either theirs
   * or one they were asked to approve, and a column repeating their own name
   * is a column of nothing. On for an administrator, whose list is the whole
   * organisation's - without it the table shows five memos and no way to tell
   * whose any of them are.
   */
  showPreparer?: boolean
}) {
  const pageIds = documents.map(doc => doc.id)
  // Whether this page has anything with a deadline on it decides what the
  // column is called. A header reading "Due" over a column of ages is the
  // same lie as an invented date in the cells.
  const anyDeadlines = FEATURES.sla && documents.some(doc => doc.dueAt !== null)
  const allSelected = pageIds.length > 0 && pageIds.every(id => selectedIds.has(id))
  const someSelected = pageIds.some(id => selectedIds.has(id))

  const headerCheckbox = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (headerCheckbox.current) {
      headerCheckbox.current.indeterminate = someSelected && !allSelected
    }
  }, [someSelected, allSelected])

  return (
    <div className="relative overflow-x-auto">
      {/* `relative` on the scroller above is load-bearing: the sr-only spans
          in the header row are absolutely positioned, and with no positioned
          ancestor they escape this scroller's clip and stretch the whole
          document sideways once the table is wider than the viewport. */}
      <table
        className={`w-full border-collapse ${showPreparer ? 'min-w-262' : 'min-w-225'}`}
      >
        <caption className="sr-only">
          {showPreparer
            ? 'Every document, with who prepared it, approval stage, age and status'
            : 'Documents associated with you, with approval stage, age and status'}
        </caption>
        <thead>
          <tr className="border-b border-line bg-canvas">
            {FEATURES.bulkActions && (
              <th scope="col" className="table-head w-9 pl-3.5">
                <input
                  ref={headerCheckbox}
                  type="checkbox"
                  checked={allSelected}
                  onChange={event => onTogglePage(pageIds, event.target.checked)}
                  aria-label="Select all documents on this page"
                  className="h-3.75 w-3.75 cursor-pointer rounded-sm border-line-strong accent-accent"
                />
              </th>
            )}
            <th scope="col" className="table-head pl-3.5">
              Document
            </th>
            <th scope="col" className="table-head">
              Status
            </th>
            {showPreparer && (
              <th scope="col" className="table-head">
                Prepared by
              </th>
            )}
            <th scope="col" className="table-head">
              Now with
            </th>
            <th scope="col" className="table-head">
              Stage
            </th>
            <th scope="col" className="table-head">
              {anyDeadlines ? 'Due' : 'Age'}
            </th>
            <th scope="col" className="table-head w-10">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>

        <tbody>
          {documents.map(doc => {
            const selected = selectedIds.has(doc.id)
            return (
              <tr
                key={doc.id}
                onClick={() => onOpen(doc.id)}
                className={`doc-table-row cursor-pointer border-b border-line-soft last:border-0 ${
                  selected ? 'bg-accent-soft/50' : ''
                }`}
              >
                {FEATURES.bulkActions && (
                  <td className="px-3.5 py-2.25" onClick={event => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => onToggle(doc.id)}
                      aria-label={`Select ${doc.title}`}
                      className="h-3.75 w-3.75 cursor-pointer rounded-sm border-line-strong accent-accent"
                    />
                  </td>
                )}

                <td className="max-w-70 py-2.25 pl-3.5 pr-3">
                  <TitleCell doc={doc} onOpen={onOpen} />
                </td>

                <td className="px-3 py-2.25">
                  <StatusBadge status={doc.status} />
                </td>

                {showPreparer && (
                  <td className="whitespace-nowrap px-3 py-2.25">
                    <span className="flex items-center gap-1.5">
                      <Avatar initials={doc.submittedByInitials} size="xs" />
                      <span className="text-ui text-content-muted">
                        {doc.submittedBy}
                      </span>
                    </span>
                  </td>
                )}

                <td className="whitespace-nowrap px-3 py-2.25">
                  <span className="flex items-center gap-1.5">
                    {/* No avatar on a finished document: `currentHolder` is
                        then the word "Completed" or "Rejected", not a person. */}
                    {doc.currentHolderInitials && (
                      <Avatar initials={doc.currentHolderInitials} size="xs" />
                    )}
                    <span className="text-ui text-content-muted">{doc.currentHolder}</span>
                  </span>
                </td>

                <td className="whitespace-nowrap px-3 py-2.25">
                  <StagePips
                    current={doc.currentStep}
                    total={doc.totalSteps}
                    tone={STAGE_TONES[doc.status]}
                    active={doc.status === 'pending_review' || doc.status === 'pending_approval'}
                  />
                </td>

                <td className="px-3 py-2.25">
                  <AgeCell doc={doc} />
                </td>

                <td className="px-3 py-2.25">
                  <RowMenu label={`Actions for ${doc.title}`}>
                    {close => (
                      <>
                        <MenuItem
                          onSelect={() => {
                            close()
                            onOpen(doc.id)
                          }}
                        >
                          Open document
                        </MenuItem>
                        <DownloadDocumentButton
                          documentId={doc.id}
                          versionNumber={doc.versionNumber}
                          disabled={doc.status === 'deleted'}
                          label="Download current version"
                          className="[&>button]:w-full [&>button]:justify-start [&>button]:rounded-none [&>button]:px-3 [&>button]:py-1.5 [&>button]:text-ui"
                        />
                      </>
                    )}
                  </RowMenu>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
