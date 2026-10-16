import { AlertCircle, Check, CircleDot, PenLine, Send, X } from 'lucide-react'
import Button from '../ui/Button'
import type { ReadinessCheck } from '../../utils/submitDocument'
import { formatFileSize } from '../../utils/submitDocument'
import type { UploadProgress } from '../../services/uploadClient'

export function ReadinessPanel({ checks }: { checks: ReadinessCheck[] }) {
  const readyCount = checks.filter(check => check.done).length

  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line-soft px-3.5 py-3">
        <h2 className="text-ui font-semibold text-content">Ready to submit</h2>
        {/* Announced on change: the count is the screen's main progress signal
            and used to move silently for anyone not looking at it. */}
        <p
          className="font-mono text-data tabular-nums text-content-subtle"
          aria-live="polite"
          aria-atomic="true"
        >
          {readyCount}/{checks.length}
        </p>
      </div>

      <ul className="space-y-2 px-3.5 py-3">
        {checks.map(check => (
          <li key={check.id} className="flex items-start gap-2.5">
            <span
              aria-hidden="true"
              className={`mt-px flex h-4.5 w-4.5 flex-shrink-0 items-center justify-center rounded-pill ${
                check.done
                  ? 'bg-accent-soft text-accent-ink'
                  : 'bg-sunken text-content-subtle'
              }`}
            >
              {check.done ? (
                <Check size={11} strokeWidth={3} />
              ) : (
                <CircleDot size={10} />
              )}
            </span>
            <span
              className={`text-meta leading-relaxed ${
                check.done ? 'text-content-subtle' : 'text-content'
              }`}
            >
              {check.label}
              <span className="sr-only">
                {check.done ? ' — done' : ' — not yet done'}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function UploadProgressBar({
  progress,
  onCancel,
}: {
  progress: UploadProgress
  onCancel: () => void
}) {
  const percent = progress.fraction === null ? null : Math.round(progress.fraction * 100)

  return (
    <div className="rounded-control border border-line bg-surface px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-meta font-medium text-content">
          {percent === null ? 'Uploading…' : `Uploading ${percent}%`}
        </p>
        {/* While an upload runs there are two buttons on screen whose
            accessible name is exactly "Cancel" - this one aborts the upload,
            the other abandons the whole submission. Nothing but DOM order
            told them apart, so somebody hearing "Cancel" had no way to know
            which they had picked. The visible word stays short. */}
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel upload"
          className="flex items-center gap-1 text-2xs text-content-subtle transition-colors hover:text-danger-ink"
        >
          <X size={12} aria-hidden="true" />
          Cancel
        </button>
      </div>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-label="Upload progress"
        className="h-1.5 w-full overflow-hidden rounded-pill bg-line-soft"
      >
        <div
          className="h-full rounded-pill bg-accent transition-[width] duration-200"
          style={{ width: percent === null ? '100%' : `${percent}%` }}
        />
      </div>

      {progress.total > 0 && (
        <p className="mt-1.5 text-2xs tabular-nums text-content-subtle">
          {formatFileSize(progress.loaded)} of {formatFileSize(progress.total)}
        </p>
      )}
    </div>
  )
}

export function SubmitActions({
  submitError,
  outstanding,
  attempted,
  submitting,
  progress,
  onSubmit,
  signs = true,
  onCancel,
  onCancelUpload,
}: {
  submitError: string | null
  outstanding: number
  attempted: boolean
  submitting: boolean
  progress: UploadProgress | null
  onSubmit: () => void
  /**
   * Does this submission collect a signature?
   *
   * The button names what pressing it does. On a document whose author is not
   * a signatory there is no dialog and no mark to place, and a button reading
   * "Sign & submit" would be describing a step that does not happen.
   */
  signs?: boolean
  onCancel: () => void
  onCancelUpload: () => void
}) {
  return (
    <div className="space-y-3">
      {submitError && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-control border border-danger-line bg-danger-soft px-3 py-2.5 text-meta leading-relaxed text-danger-ink"
        >
          <AlertCircle size={14} aria-hidden="true" className="mt-px flex-shrink-0" />
          {submitError}
        </p>
      )}

      {attempted && outstanding > 0 && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-control border border-warning-line bg-warning-soft px-3 py-2.5 text-meta leading-relaxed text-warning-ink"
        >
          <AlertCircle size={14} aria-hidden="true" className="mt-px flex-shrink-0" />
          {/* The specific messages are already marked on the controls and in
              the checklist above; repeating one here would say it twice. */}
          {outstanding === 1
            ? '1 requirement above still needs attention.'
            : `${outstanding} requirements above still need attention.`}
        </p>
      )}

      {progress && <UploadProgressBar progress={progress} onCancel={onCancelUpload} />}

      <Button
        size="lg"
        onClick={onSubmit}
        disabled={submitting}
        pending={submitting}
        icon={
          signs ? (
            <PenLine size={15} aria-hidden="true" />
          ) : (
            <Send size={15} aria-hidden="true" />
          )
        }
        className="w-full"
      >
        {signs ? <>Sign &amp; submit</> : 'Submit for approval'}
      </Button>

      <Button
        variant="ghost"
        size="lg"
        onClick={onCancel}
        disabled={submitting}
        className="w-full"
      >
        Cancel
      </Button>

      <p className="text-center text-meta leading-relaxed text-content-subtle">
        You place your signature on the PDF in the next step.
      </p>
    </div>
  )
}
