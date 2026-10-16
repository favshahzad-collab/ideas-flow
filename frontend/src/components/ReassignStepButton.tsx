import { useState } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import Button from './ui/Button'
import Modal from './Modal'
import ApproverCombobox from './submit/ApproverCombobox'
import { reassignStep } from '../services/approvalApi'
import type { AssignableUser } from '../types/submitDocument'
import type { WorkflowStepView } from '../types/documentDetail'
import { movableSteps } from '../utils/documentActions'

/**
 * "Reassign", on a memo whose chain names somebody who cannot act on it.
 *
 * A memo stops at whoever is assigned to it, and until this existed nothing
 * could move it if that person had left, was away with no cover recorded, or
 * should never have been asked. The two exits both said the wrong thing:
 * skipping drops the approval entirely and is off unless a deployment turns it
 * on, and a delegation written after the fact claims the approver arranged
 * cover when in fact the work was moved over their head.
 *
 * It offers the steps still ahead as well as the one the memo is sitting on.
 * A memo stops just as completely at an approver who has left but is third in
 * the chain - the only difference is that this one can be seen coming, and
 * being able to see it coming is worth nothing if the only cure is to wait for
 * the memo to arrive and get stuck.
 *
 * A reason is required, and it is not a formality: this is the one action in
 * the product that changes who is entitled to sign a memo after it was
 * submitted, so "the chain says so" stops being an answer unless the change
 * carries who made it and why. It goes on the memo's own thread, where the
 * approvers waiting behind this step can read it, as well as into the trail.
 *
 * Everything that decides anything is the server's: who may do it, who may
 * receive it, which steps may move and who is told. What is here is the
 * picking and the reporting.
 */

export default function ReassignStepButton({
  documentId,
  preparerId,
  /** The chain as the page has it, preparer row and all. */
  steps,
  actingUserId,
  onDone,
  betweenCycles = false,
}: {
  documentId: string
  preparerId: string
  steps: WorkflowStepView[]
  /** The administrator doing the moving, who can never be moved onto it. */
  actingUserId?: string
  onDone: () => void
  /**
   * The memo is back with its preparer (sent back or rejected). The next
   * cycle starts at step 1 over this chain, so every step can be moved -
   * which is how a step held by somebody who has since left is cleared.
   */
  betweenCycles?: boolean
}) {
  const movable = betweenCycles ? steps.filter(step => step.step > 0) : movableSteps(steps)
  const currentOrder = movable.find(step => step.status === 'current')?.step

  const [open, setOpen] = useState(false)
  const [stepOrder, setStepOrder] = useState<number | null>(null)
  const [person, setPerson] = useState<AssignableUser | null>(null)
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [moved, setMoved] = useState<{ message: string; wasCurrent: boolean } | null>(
    null,
  )

  if (movable.length === 0) return null

  /* Nothing chosen yet means the step the memo is sitting on - the one
     somebody opening this is usually here for. */
  const chosenOrder = stepOrder ?? currentOrder ?? movable[0].step
  const chosen = movable.find(step => step.step === chosenOrder) ?? movable[0]
  const holderName = chosen.user.trim() || 'nobody'

  /*
   * Dismissing, whichever way: the Done button, Escape, the backdrop.
   *
   * The reload is deliberately here rather than at the moment the server
   * answers. `refetch` puts the whole screen back into its loading state,
   * which unmounts this control and everything it was saying - so a
   * confirmation shown first and reloaded afterwards was a confirmation
   * nobody could read. The person reads what happened, then the page catches
   * up with it.
   */
  const close = () => {
    if (pending) return

    setOpen(false)

    if (moved) {
      setMoved(null)
      setStepOrder(null)
      onDone()
    }
  }

  const submit = async () => {
    if (!person || reason.trim() === '') return

    setPending(true)
    setError(null)

    try {
      /*
       * The step is always named, even when it is the one the memo is on.
       * Between this screen loading and the button being pressed an approver
       * may have signed, and the step that was current then is decided now -
       * naming it has the server refuse, which is the right answer, instead
       * of moving whichever step happens to be current at the moment it
       * arrives.
       */
      const result = await reassignStep(documentId, person.id, reason, chosen.step)
      setMoved({ message: result.message, wasCurrent: chosen.status === 'current' })
      setPerson(null)
      setReason('')
    } catch (problem) {
      /*
       * Handed over as the server wrote it. "Dania already has a step on this
       * memo. One person cannot hold two" is the answer to the question the
       * person is about to ask; "Could not reassign" is a shrug.
       */
      setError(
        problem instanceof Error ? problem.message : 'Could not move the step.',
      )
    } finally {
      setPending(false)
    }
  }

  /* Shown but not selectable: somebody who can see WHY a name is unavailable
     stops looking for it. The preparer is the exception and is hidden
     outright - they can never approve their own memo, so their name in a list
     of possible approvers is an offer that could never be honoured. So is the
     administrator doing the moving: the server refuses a step moved to the
     person moving it, because that would let them choose to sign it. */
  const taken = new Set(steps.map(step => step.userId).filter(id => id !== preparerId))
  const hidden = new Set(actingUserId ? [preparerId, actingUserId] : [preparerId])

  return (
    <>
      <Button
        variant="secondary"
        icon={<ArrowLeftRight size={15} aria-hidden="true" />}
        onClick={() => {
          setError(null)
          setOpen(true)
        }}
      >
        Reassign
      </Button>

      <Modal
        open={open}
        onClose={close}
        title={moved ? 'Step reassigned' : 'Reassign a step'}
        description={
          moved
            ? undefined
            : movable.length === 1
              ? `It is with ${holderName} and cannot move until somebody acts on it.`
              : 'The step it is sitting on, or one still ahead of it.'
        }
      >
        {moved ? (
          <div className="space-y-4">
            <p role="status" className="text-ui leading-relaxed text-content">
              {moved.message}
            </p>
            <p className="text-meta leading-relaxed text-content-subtle">
              {moved.wasCurrent
                ? `${holderName} has been told it is no longer with them, and the reason is on the memo's thread.`
                : `${holderName} has been told they are off this memo, and the reason is on its thread.`}
            </p>
            <div className="flex justify-end">
              <Button onClick={close}>Done</Button>
            </div>
          </div>
        ) : (
        <div className="space-y-4">
          <p className="text-ui leading-relaxed text-content-muted">
            The approval is still required — this asks somebody else for it. To
            drop the step instead, skip it.
          </p>

          {/* One movable step is the whole chain's remainder, so there is
              nothing to choose between and a picker of one is a question with
              a single answer. */}
          {movable.length > 1 && (
            <div>
              <label htmlFor="reassign-step" className="field-label">
                Which step
              </label>
              <select
                id="reassign-step"
                value={chosen.step}
                onChange={event => setStepOrder(Number(event.target.value))}
                className="field h-8.5"
              >
                {movable.map(step => (
                  <option key={step.id} value={step.step}>
                    {`Step ${step.step} — ${step.user.trim() || 'Not assigned'}`}
                    {step.status === 'current' ? ' (with them now)' : ''}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-meta text-content-subtle">
                {betweenCycles
                  ? 'The memo is back with its preparer. This person will be asked when it is resubmitted.'
                  : chosen.status === 'current'
                    ? 'The memo is waiting on this step now.'
                    : 'The memo has not reached this step yet.'}
              </p>
            </div>
          )}

          <div>
            <label htmlFor="reassign-person" className="field-label">
              Hand this step to
            </label>
            <ApproverCombobox
              id="reassign-person"
              value={person?.id ?? ''}
              selected={person}
              takenIds={taken}
              excludeIds={hidden}
              onChange={setPerson}
              onResolved={setPerson}
            />
          </div>

          <div>
            <label htmlFor="reassign-reason" className="field-label">
              Why it is moving
            </label>
            <textarea
              id="reassign-reason"
              value={reason}
              onChange={event => setReason(event.target.value)}
              rows={3}
              aria-describedby="reassign-reason-hint"
              className="field resize-none py-2.5"
            />
            <p id="reassign-reason-hint" className="mt-1 text-meta text-content-subtle">
              Everybody on this memo sees this on its thread, {holderName}{' '}
              included.
            </p>
          </div>

          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              pending={pending}
              disabled={!person || reason.trim() === ''}
            >
              Move the step
            </Button>
          </div>
        </div>
        )}
      </Modal>
    </>
  )
}
