import { AlertCircle, FileText, Info } from 'lucide-react'
import { Card, CardHeader } from '../ui/Card'
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
} from '../../utils/submitDocument'

export interface DuplicateMatch {
  id: string
  title: string
  status: string
  /** Human-readable age, e.g. "3 days ago". */
  age: string
}

export default function DocumentInfoCard({
  title,
  description,
  titleError,
  duplicate,
  onTitleChange,
  onDescriptionChange,
  onOpenDuplicate,
}: {
  title: string
  description: string
  titleError: string | null
  duplicate: DuplicateMatch | null
  onTitleChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onOpenDuplicate: (id: string) => void
}) {
  return (
    <Card>
      <CardHeader
        icon={FileText}
        tone="accent"
        title="Document Information"
        hint="How this document is identified in lists, search and notifications"
      />
      <div className="space-y-5 p-4 sm:p-5">
        <div>
          <label htmlFor="submit-doc-title" className="field-label">
            Document Title
            <span className="ml-1 text-danger-ink" aria-hidden="true">
              *
            </span>
          </label>
          <input
            type="text"
            id="submit-doc-title"
            value={title}
            maxLength={MAX_TITLE_LENGTH}
            onChange={event => onTitleChange(event.target.value)}
            placeholder="e.g. Annual Budget Proposal FY2025"
            aria-required="true"
            aria-invalid={titleError ? true : undefined}
            aria-describedby={titleError ? 'submit-doc-title-error' : undefined}
            className="field h-10"
          />
          {titleError ? (
            <p id="submit-doc-title-error" role="alert" className="field-error">
              <AlertCircle size={13} aria-hidden="true" className="flex-shrink-0" />
              {titleError}
            </p>
          ) : (
            <p className="mt-1.5 text-2xs text-content-subtle">
              Approvers see this title in their queue and in every notification about
              the document.
            </p>
          )}

          {/* A warning, never a block: resubmitting the same title is sometimes
              exactly right, and two approvers signing two versions of the same
              document by accident is expensive. */}
          {/* The wrapper is a live region, because this appears in response
              to typing rather than to a press: somebody not looking at this
              corner of the form - on a screen reader, or reading their own
              notes - was never told the memo may already be in the queue.
              `status` rather than `alert`: a caution about a duplicate is not
              a refusal and should not interrupt. */}
          {duplicate && (
            <div
              role="status"
              className="mt-2.5 flex items-start gap-2 rounded-control border border-warning-line bg-warning-soft px-3 py-2.5 text-2xs text-warning-ink"
            >
              <Info size={13} aria-hidden="true" className="mt-px flex-shrink-0" />
              <p className="min-w-0">
                You already submitted{' '}
                <button
                  type="button"
                  onClick={() => onOpenDuplicate(duplicate.id)}
                  className="font-semibold underline underline-offset-2"
                >
                  “{duplicate.title}”
                </button>{' '}
                {duplicate.age} — it is {duplicate.status.replace(/_/g, ' ').toLowerCase()}.
                Submit anyway if this is a separate document.
              </p>
            </div>
          )}
        </div>

        <div>
          <label htmlFor="submit-doc-description" className="field-label">
            Description / Notes
            <span className="ml-1 font-normal text-content-subtle">(Optional)</span>
          </label>
          <textarea
            id="submit-doc-description"
            value={description}
            rows={4}
            maxLength={MAX_DESCRIPTION_LENGTH}
            onChange={event => onDescriptionChange(event.target.value)}
            placeholder="Briefly describe the document purpose and any relevant context for approvers..."
            className="field resize-none py-2.5"
          />
          <p className="mt-1.5 flex items-center justify-between gap-3 text-2xs text-content-subtle">
            <span>Shown to every approver on the document page.</span>
            <span className="tabular-nums">
              {description.length} / {MAX_DESCRIPTION_LENGTH}
            </span>
          </p>
        </div>
      </div>
    </Card>
  )
}
