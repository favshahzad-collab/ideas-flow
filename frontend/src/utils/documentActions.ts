/**
 * Which of a memo's actions this person is actually offered.
 *
 * Lifted out of `useDocumentDetail` so the rules can be read and tested
 * without standing up four fetches and a context. `canSkipStep` is here first
 * because it is the one that has already been wrong: the control was gated on
 * a build-time flag while the server's answer moved to a database row an
 * administrator changes, so turning the policy on turned nothing on. Nothing
 * failed - there was no test that mentioned the control at all.
 */

export type SkipStepInput = {
  /** What the server says this deployment allows, from `GET /api/auth/me`. */
  allowStepSkip: boolean
  /** Who prepared the memo. */
  preparerId: string
  /** Who is looking at it. */
  userId: string
  documentStatus: string | null
  /** Null for a memo that has no run yet, which is not a memo with a step to skip. */
  workflowStatus: string | null
  steps: { status: string }[]
}

/**
 * May this person pass over an approver who has not acted?
 *
 * Every clause is a refusal the API would make anyway, mirrored here so the
 * button is absent rather than answering 403 - with the deployment's own
 * policy first, because that is the one that is not about this memo.
 *
 * Only the preparer: the point of the escape hatch is to unstick a memo you
 * are waiting on, and an approver skipping the approver after them is the
 * bypass this product spent an admin screen deciding not to hand out.
 */
export function canSkipStep(input: SkipStepInput): boolean {
  return (
    input.allowStepSkip &&
    input.preparerId === input.userId &&
    input.documentStatus === 'PENDING_REVIEW' &&
    input.workflowStatus === 'IN_PROGRESS' &&
    input.steps.some(step => step.status === 'PENDING')
  )
}

/**
 * The steps that can still be moved to a different approver: the one the memo
 * is sitting on, and the ones ahead of it.
 *
 * A step already decided is not on the list, and the server refuses it: it
 * carries a signature or a recorded skip, and rewriting whose name stands
 * against it would make the chain disagree with the actions taken on it.
 *
 * Step 0 is the preparer's row rather than an approval. It is drawn in the
 * chain because a chain that starts at step 1 hides who sent the memo, but
 * there is nothing on it to hand to anybody.
 */
export function movableSteps<T extends { step: number; status: string }>(
  steps: T[],
): T[] {
  return steps.filter(
    step =>
      step.step > 0 && (step.status === 'current' || step.status === 'pending'),
  )
}
