import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import Modal from '../Modal'
import Button from '../ui/Button'

export type ActionType = 'reject' | 'revision'

const COPY = {
  reject: {
    title: 'Reject document',
    lede: 'This ends the approval chain. The preparer is notified and must start a new submission.',
    label: 'Reason for rejection',
    placeholder: 'Explain what is wrong so the preparer can act on it...',
    confirm: 'Reject document',
    empty: 'A reason is required when rejecting a document.',
    variant: 'dangerSolid',
  },
  revision: {
    title: 'Request revision',
    lede: 'The document returns to the preparer for a new version. The approval chain restarts when they resubmit.',
    label: 'What needs to change',
    placeholder: 'Describe the changes needed before this can proceed...',
    confirm: 'Request revision',
    empty: 'A comment is required when requesting a revision.',
    variant: 'primary',
  },
} as const

/**
 * Stays open and busy until the request settles.
 *
 * The previous version closed on Confirm and fired the request afterwards, so
 * a failure surfaced as a banner on a page that no longer held what you typed
 * — on a revision request, where the comment is the entire content of the
 * action, that meant retyping it from memory.
 */
export default function ActionDialog({
  open,
  type,
  documentTitle,
  onCancel,
  onConfirm,
}: {
  open: boolean
  type: ActionType
  documentTitle: string
  onCancel: () => void
  onConfirm: (comment: string) => Promise<void>
}) {
  if (!open) return null
  return (
    <ActionDialogBody
      type={type}
      documentTitle={documentTitle}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}

function ActionDialogBody({
  type,
  documentTitle,
  onCancel,
  onConfirm,
}: {
  type: ActionType
  documentTitle: string
  onCancel: () => void
  onConfirm: (comment: string) => Promise<void>
}) {
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const copy = COPY[type]

  const handleConfirm = async () => {
    if (!comment.trim()) {
      setError(copy.empty)
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      await onConfirm(comment.trim())
    } catch (err) {
      // Stay open with the text intact so it can be retried rather than retyped.
      setError(err instanceof Error ? err.message : 'The action could not be completed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open
      onClose={submitting ? () => {} : onCancel}
      title={copy.title}
      size="sm"
    >
      <div className="space-y-4">
        <p className="text-ui text-content-muted">{copy.lede}</p>

        <p className="rounded-control border border-line bg-sunken px-3 py-2 text-ui font-medium text-content">
          {documentTitle}
        </p>

        <div>
          <label
            htmlFor="approval-action-comment"
            className="mb-1.5 block text-ui font-medium text-content"
          >
            {copy.label} <span className="text-danger-ink">*</span>
          </label>
          <textarea
            id="approval-action-comment"
            value={comment}
            onChange={e => setComment(e.target.value)}
            disabled={submitting}
            rows={4}
            /*
             * `autoFocus` did nothing here: React applies it during the
             * commit and the dialog's own focus manager runs afterwards,
             * moving focus to the close button. The comment is the entire
             * content of this dialog - it will not proceed without one - and
             * a keyboard user had to Tab past two controls to start typing
             * it. `data-autofocus` is what the dialog looks for.
             */
            data-autofocus="true"
            maxLength={2000}
            placeholder={copy.placeholder}
            aria-describedby={error ? 'approval-action-error' : undefined}
            aria-invalid={error ? true : undefined}
            className="field w-full resize-none px-3 py-2 text-ui disabled:opacity-60"
          />
          <p className="mt-1 text-right text-2xs text-content-subtle tabular-nums">
            {comment.length} / 2000
          </p>
        </div>

        {error && (
          <p
            id="approval-action-error"
            role="alert"
            className="flex items-start gap-2 rounded-control border border-danger-line bg-danger-soft px-3 py-2 text-ui text-danger-ink"
          >
            <AlertTriangle size={15} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button variant={copy.variant} onClick={handleConfirm} pending={submitting}>
            {copy.confirm}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
