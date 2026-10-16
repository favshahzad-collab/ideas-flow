import { useState } from 'react'
import { BellRing } from 'lucide-react'
import Button from './ui/Button'
import { remindApprover } from '../services/approvalApi'

/**
 * "Send a reminder", on a memo that is sitting with somebody else.
 *
 * Until this existed the only thing that ever chased a memo was the deadline
 * sweep, and it chases one case: a step that has run past the working days it
 * was given. With no deadline set anywhere - which is this deployment - a memo
 * could sit for a week and nobody was told anything. The preparer's options
 * were to wait or to walk down the corridor.
 *
 * The server decides everything that matters: who may send one, who hears
 * about it, and whether enough time has passed since the last. This holds the
 * three states that decision can produce, because a button that reports
 * nothing is a button somebody presses four times.
 */
export default function RemindApproverButton({
  documentId,
  holderFirstName,
}: {
  documentId: string
  /** Only for the label. The server decides who is actually told. */
  holderFirstName?: string
}) {
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    setPending(true)
    setError(null)

    try {
      const result = await remindApprover(documentId)
      setSent(result.message)
    } catch (problem) {
      /*
       * The refusal is the useful half here: "Omar was reminded less than 12
       * hours ago. You can send another in 9 hours" is the answer to the
       * question the person is about to ask. It is shown as the server wrote
       * it rather than replaced with something generic.
       */
      setError(
        problem instanceof Error ? problem.message : 'Could not send the reminder.'
      )
    } finally {
      setPending(false)
    }
  }

  if (sent) {
    return (
      <p role="status" className="text-meta font-medium text-accent-ink">
        {sent}
      </p>
    )
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="secondary"
        icon={<BellRing size={15} aria-hidden="true" />}
        onClick={send}
        pending={pending}
      >
        {holderFirstName ? `Remind ${holderFirstName}` : 'Send a reminder'}
      </Button>
      {error && (
        <span role="alert" className="max-w-80 text-meta text-danger-ink">
          {error}
        </span>
      )}
    </span>
  )
}
