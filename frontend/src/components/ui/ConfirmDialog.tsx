import { AlertTriangle } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import Modal from '../Modal'
import Button from './Button'

/**
 * Destructive confirmations used to go through `window.confirm`. That dialog
 * is drawn by the browser, so it ignored the theme entirely — a stark white OS
 * box over a dark app — showed the page's URL as its title, and gave the
 * riskiest actions in the product the least considered surface in it.
 *
 * This is the same prompt on `Modal`, which already traps focus, closes on
 * Escape and restores focus to the trigger.
 */
export default function ConfirmDialog({
  open,
  title,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  pending = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean
  title: string
  confirmLabel: string
  cancelLabel?: string
  /** Colours the confirm button as a danger action. */
  destructive?: boolean
  /** Spinner on the confirm button while the request is in flight. */
  pending?: boolean
  onConfirm: () => void
  onCancel: () => void
  children: ReactNode
}) {
  const warningId = useId()

  return (
    <Modal
      open={open}
      onClose={pending ? () => {} : onCancel}
      title={title}
      size="sm"
    >
      <div className="text-ui leading-relaxed text-content-muted">{children}</div>

      {/* `destructive` used to change nothing but the button's colour tokens,
          so a screen-reader user - and anyone who cannot separate the danger
          red from the accent - got the same dialog either way, with only the
          caller's label to go on. Labels are often "Continue", "OK", "Yes". */}
      {destructive && (
        <p
          id={warningId}
          className="mt-3 flex items-start gap-2 text-meta leading-relaxed text-danger-ink"
        >
          <AlertTriangle
            size={14}
            aria-hidden="true"
            className="mt-0.5 flex-shrink-0"
          />
          {/* Deliberately not "this cannot be undone": callers write that
              sentence in the body themselves, and a banner repeating it back
              is noise. This says the one thing the body cannot - that this is
              the destructive path - in two words a screen reader appends to
              the button name without burying it. */}
          <span>Permanent action</span>
        </p>
      )}

      {/* Cancel first, so the destructive button is never what a hurried
          Enter or a mis-aimed click lands on. */}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          {cancelLabel}
        </Button>
        <Button
          variant={destructive ? 'danger' : 'primary'}
          onClick={onConfirm}
          pending={pending}
          /* Described, not renamed. The warning has to survive reaching the
             button alone - callers name it "Continue", "OK" or "Yes" as
             often as they name the act - but overriding the *name* breaks
             the thing a voice-control user says out loud and every caller
             that finds the button by its label. A description is announced
             after the name and costs neither. */
          aria-describedby={destructive ? warningId : undefined}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  )
}
