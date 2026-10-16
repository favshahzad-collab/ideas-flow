import { forwardRef } from 'react'
import { AlertCircle } from 'lucide-react'
import Button from '../ui/Button'
import ApprovalChain from '../ApprovalChain'
import QueuePaper from './QueuePaper'
import { Skeleton } from '../ui/Skeleton'
import { useDocumentDetail } from '../../hooks/useDocumentDetail'
import {
  formatMemoReference,
  formatWaitingDuration,
  getWaitingSeverity,
} from '../../utils/format'
import type { DashboardDocument } from '../../types/document'

/**
 * The design's banner reads "SLA BREACHED · 12 DAYS". Nothing is breached —
 * there is no due date on a step — so this states the age instead, which is
 * the fact the queue actually has. It only appears once a document has been
 * sitting long enough to be worth flagging.
 */
function AgeBanner({ since }: { since: string }) {
  const severity = getWaitingSeverity(since)
  if (severity === 'fresh') return null

  const danger = severity === 'overdue' || severity === 'critical'

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 font-mono text-data font-semibold uppercase tracking-wide ${
        danger
          ? 'bg-danger-soft text-danger-ink'
          : 'bg-warning-soft text-warning-ink'
      }`}
    >
      <AlertCircle size={11} aria-hidden="true" />
      Waiting {formatWaitingDuration(since)}
    </span>
  )
}

interface QueueDetailProps {
  document: DashboardDocument
  busy: boolean
  onApprove: (id: string) => void
  onRevision: (id: string) => void
  onReject: (id: string) => void
}

const QueueDetail = forwardRef<HTMLDivElement, QueueDetailProps>(function QueueDetail(
  { document: doc, busy, onApprove, onRevision, onReject },
  ref,
) {
  /*
   * `error` was destructured off and dropped, so a failed workflow request
   * rendered the empty-chain sentence: an approver reading "no approval chain
   * on this document" about a document that has one, on the screen where they
   * are deciding whether to sign it.
   */
  const { data, loading, error } = useDocumentDetail(doc.id)
  const isReviewer = doc.approvalType === 'REVIEWER'

  return (
    <div
      ref={ref}
      tabIndex={-1}
      aria-label={`Details for ${doc.title}`}
      className="flex h-full min-w-0 flex-1 flex-col outline-none"
    >
      <div className="flex-shrink-0 border-b border-line bg-surface px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <AgeBanner since={doc.updatedAt} />
          <span className="font-mono text-data text-content-subtle">
            {formatMemoReference(doc.referenceNumber, doc.id)} &middot; v{doc.versionNumber}
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-pane font-semibold tracking-[-0.02em] text-content">
              {doc.title}
            </h2>
            {doc.description && (
              <p className="mt-1.5 max-w-208 text-ui leading-relaxed text-content-muted">
                {doc.description}
              </p>
            )}
          </div>

          <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => onRevision(doc.id)}
              disabled={busy}
            >
              Revision
            </Button>
            <Button variant="danger" onClick={() => onReject(doc.id)} disabled={busy}>
              Reject
            </Button>
            {/* Signing happens on the document itself — the signature has to
                be placed on the rendered page — so this opens it rather than
                pretending to approve from here. */}
            <Button onClick={() => onApprove(doc.id)} pending={busy}>
              {isReviewer ? 'Sign & complete review' : 'Sign & approve'}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
        <div className="min-h-0 flex-1 overflow-y-auto bg-canvas p-6">
          <QueuePaper documentId={doc.id} />
        </div>

        <aside className="min-h-0 flex-shrink-0 overflow-y-auto border-line bg-surface p-4 xl:w-75 xl:border-l">
          <h3 className="mb-3 text-section font-semibold text-content">
            Approval chain
          </h3>
          {loading && !data ? (
            <div className="space-y-3" aria-hidden="true">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-12 rounded-control" />
              ))}
            </div>
          ) : error ? (
            <p role="alert" className="field-error">
              The approval chain could not be loaded. This document may well
              have one — reload before deciding anything from what is on
              screen.
            </p>
          ) : (
            <ApprovalChain steps={data?.workflowSteps ?? []} />
          )}
        </aside>
      </div>
    </div>
  )
})

export default QueueDetail
