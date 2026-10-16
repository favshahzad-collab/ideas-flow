import StatusBadge from '../StatusBadge'
import { Avatar } from '../ui/Card'
import StagePips from '../ui/StagePips'
import { describeAge, formatMemoReference } from '../../utils/format'
import type { DashboardDocument } from '../../types/document'

/**
 * The same rows below the table breakpoint. A dense seven-column grid does
 * not survive a phone, so each document becomes a card carrying the same
 * facts in reading order rather than a table scrolled sideways.
 */
export default function DocumentCards({
  documents,
  onOpen,
  showPreparer = false,
}: {
  documents: DashboardDocument[]
  onOpen: (id: string) => void
  /** Whose memo this is. See the same prop on `DocumentsTable`. */
  showPreparer?: boolean
}) {
  return (
    <ul className="divide-y divide-line-soft">
      {documents.map(doc => (
        <li key={doc.id}>
          <button
            type="button"
            onClick={() => onOpen(doc.id)}
            className="w-full px-3.5 py-3 text-left transition-colors hover:bg-canvas"
          >
            <span className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block truncate text-ui font-medium text-content">
                  {doc.title}
                </span>
                <span className="mt-0.5 block font-mono text-data text-content-subtle">
                  {formatMemoReference(doc.referenceNumber, doc.id)} &middot; v{doc.versionNumber}
                </span>
              </span>
              <StatusBadge status={doc.status} size="xs" />
            </span>

            <span className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {showPreparer && (
                <span className="flex items-center gap-1.5">
                  <Avatar initials={doc.submittedByInitials} size="xs" />
                  <span className="text-meta text-content-muted">
                    From {doc.submittedBy}
                  </span>
                </span>
              )}
              {/* Who has it now - a person only while it is still moving. A
                  finished memo's holder is a status word the badge above
                  already says, so it is not repeated here. */}
              {doc.currentHolderInitials && (
                <span className="flex items-center gap-1.5">
                  <Avatar initials={doc.currentHolderInitials} size="xs" />
                  <span className="text-meta text-content-muted">
                    {doc.status === 'revision_requested' ? 'Back with' : 'With'}{' '}
                    {doc.currentHolder}
                  </span>
                </span>
              )}
              <StagePips
                current={doc.currentStep}
                total={doc.totalSteps}
                tone={doc.status === 'rejected' ? 'danger' : 'accent'}
                active={doc.status === 'pending_review' || doc.status === 'pending_approval'}
              />
              <span className="text-meta tabular-nums text-content-subtle">
                {describeAge(doc.status, doc.updatedAt)}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
