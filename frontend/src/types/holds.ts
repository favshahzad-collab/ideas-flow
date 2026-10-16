/**
 * What stops if one person does.
 *
 * Four ways a memo stops at somebody, and they are genuinely different
 * problems: it is with them now, it will reach them, it was sent back to them
 * for revision, or it was sent back to somebody else and their step is on the
 * chain it will travel again. Only the first two can be handed to anybody
 * else today - a memo waiting to be corrected waits on its preparer, and the
 * server refuses an approver the correction and refuses to move a step on a
 * memo that is not in flight - so the screen keeps them apart rather than
 * offering one button over all four.
 */
export interface HeldMemo {
  documentId: string
  referenceNumber: string | null
  title: string
  submittedAt: string
  preparer: { id: string; firstName: string; lastName: string }
  /** Null for a memo sent back: its preparer has no step on the chain. */
  stepOrder: number | null
  approvalType: string | null
  totalSteps: number | null
  /** When the wait began: the step started, or the revision was asked for. */
  heldSince: string | null
  dueAt: string | null
  /** Approvals between the memo and them. Zero means it is with them now. */
  stepsAway: number
}

export interface MemosHeld {
  person: {
    id: string
    firstName: string
    lastName: string
    email: string
    department: string | null
  }
  holdingNow: HeldMemo[]
  ahead: HeldMemo[]
  returned: HeldMemo[]
  /**
   * Sent back to its preparer, with this person's step on the chain it will
   * travel again. A resubmission restarts the run at step one, so everybody
   * named on the chain sees it a second time - including whoever sent it back.
   */
  comingBack: HeldMemo[]
  total: number
}
