import { describe, expect, it } from 'vitest'
import type { WorkflowStepView } from '../types/documentDetail'
import { workflowStage } from './workflowStage'

/**
 * The stage name, against the ladder the requirement writes out:
 *
 *   DRAFT -> SUBMITTED -> PENDING APPROVER 1 -> ... ->
 *   PENDING FINAL APPROVER -> COMPLETED
 *
 * These tests are the mapping between that ladder and what the application
 * actually stores, which is a short status plus a position on the chain. They
 * are deliberately about words: the behaviour they describe was already
 * right, and what was wrong was that the screen said "Pending Review" where
 * the requirement says SUBMITTED and "Approved" where it says COMPLETED.
 */

const preparer: WorkflowStepView = {
  id: 'p',
  step: 0,
  type: 'Preparer',
  user: 'Sadia Rehman',
  userId: 'u-sadia',
  initials: 'SR',
  status: 'completed',
}

const step = (
  order: number,
  type: string,
  status: WorkflowStepView['status'],
): WorkflowStepView => ({
  id: `s${order}`,
  step: order,
  type,
  user: `Person ${order}`,
  userId: `u-${order}`,
  initials: 'P',
  status,
})

/** A three-step chain, waiting at `at`. */
const chain = (at: number) => [
  preparer,
  step(1, 'Reviewer', at > 1 ? 'completed' : at === 1 ? 'current' : 'pending'),
  step(2, 'Approver', at > 2 ? 'completed' : at === 2 ? 'current' : 'pending'),
  step(
    3,
    'Final Approver',
    at > 3 ? 'completed' : at === 3 ? 'current' : 'pending',
  ),
]

describe('the rungs of the ladder', () => {
  it('names the step it is waiting on, and how many there are', () => {
    // "PENDING APPROVER 1" in the requirement. The position is computed
    // rather than enumerated, because a memo here can have any number of
    // approvers and the requirement's 1, 2, 3 are only its example.
    expect(workflowStage('pending_review', chain(1))).toBe(
      'Pending Reviewer 1 of 3',
    )
    expect(workflowStage('pending_approval', chain(2))).toBe(
      'Pending Approver 2 of 3',
    )
  })

  it('keeps the role word the chain itself shows', () => {
    /*
     * The requirement says APPROVER at every rung; this application
     * distinguishes a reviewer from an approver and shows that distinction on
     * the chain. Printing "Approver 1" over somebody the next tab calls a
     * Reviewer would make the screen disagree with itself, which is a worse
     * failure than wording the rung more precisely than the requirement did.
     */
    expect(workflowStage('pending_review', chain(1))).toContain('Reviewer')
  })

  it('does not number the final approver, whose name already says it is last', () => {
    expect(workflowStage('pending_approval', chain(3))).toBe(
      'Pending Final Approver',
    )
  })

  it('reads Submitted when the run has not reached anybody yet', () => {
    // The requirement's SUBMITTED rung. Submitting normally places the memo on
    // step one in the same breath, so this is rare - but a memo with no
    // current step is genuinely here, and "Pending Approver" would name a
    // person who is not yet waiting.
    const notStarted = [
      preparer,
      step(1, 'Reviewer', 'pending'),
      step(2, 'Final Approver', 'pending'),
    ]

    expect(workflowStage('pending_review', notStarted)).toBe('Submitted')
  })

  it('says Completed, not Approved', () => {
    /*
     * The requirement marks the workflow COMPLETED and is explicit that no
     * further approval is possible. "Approved" reads as an event that
     * something might follow; this is the state that closes the question.
     */
    expect(workflowStage('approved', chain(4))).toBe('Completed')
  })
})

describe('the states that are not rungs', () => {
  it('draft', () => {
    expect(workflowStage('draft', [preparer])).toBe('Draft')
  })

  it('returned for revision, which is its own state and not a stage', () => {
    expect(workflowStage('revision_requested', chain(2))).toBe(
      'Returned for Revision',
    )
  })

  it('rejected', () => {
    expect(workflowStage('rejected', chain(2))).toBe('Rejected')
  })

  it('deleted', () => {
    expect(workflowStage('deleted', chain(2))).toBe('Withdrawn')
  })
})

describe('what it does not depend on', () => {
  it('ignores the preparer row, which is not an approval step', () => {
    // The preparer is on the chain without being on it: counting their row
    // would make every memo one step longer than its own approval chain.
    expect(workflowStage('pending_review', chain(1))).toContain('of 3')
  })

  it('reads the same for a one-step chain', () => {
    const single = [preparer, step(1, 'Approver', 'current')]

    expect(workflowStage('pending_approval', single)).toBe(
      'Pending Approver 1 of 1',
    )
  })
})
