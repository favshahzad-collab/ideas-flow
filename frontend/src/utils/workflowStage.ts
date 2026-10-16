import type { DocumentStatus } from '../types/document'
import type { WorkflowStepView } from '../types/documentDetail'

/**
 * Where a memo is, in the words the requirement uses.
 *
 * The requirement names a ladder - DRAFT, SUBMITTED, PENDING APPROVER 1,
 * PENDING FINAL APPROVER, COMPLETED - and the screen named the same states
 * differently: "Pending Review" for submitted, "Approved" for completed, and
 * nothing at all for "approver 2 of 3", which was only ever readable as a
 * sentence under the chain two tabs away.
 *
 * Nothing behind this changes. The stored status is still PENDING_REVIEW, the
 * filter values in the URL are still `pending_review` and `pending_approval`,
 * and every route and permission rule is untouched - this is the label, and
 * only the label. It exists so that somebody holding the requirement beside
 * the screen reads the same word twice.
 *
 * The numbered rungs cannot be statuses: the requirement writes out APPROVER
 * 1 and APPROVER 2 because it is describing a three-step example, but a memo
 * here can have any number of approvers, so the position is computed from the
 * chain rather than enumerated in a type.
 */

/** The role word the chain already shows for this step, kept in step. */
function stageFor(step: WorkflowStepView, total: number): string {
  /*
   * A final approver is the last rung by definition, so the position would
   * only repeat what the word already says. Every other step carries "of N",
   * which is the "remaining approvers" the requirement asks to be visible.
   */
  if (step.type === 'Final Approver') return 'Pending Final Approver'

  return `Pending ${step.type} ${step.step} of ${total}`
}

export function workflowStage(
  status: DocumentStatus,
  steps: WorkflowStepView[],
): string {
  switch (status) {
    case 'draft':
      return 'Draft'
    case 'rejected':
      return 'Rejected'
    case 'deleted':
      return 'Withdrawn'
    case 'revision_requested':
      // The requirement's rejection/return handling, which is a state of its
      // own rather than a rung on the approval ladder.
      return 'Returned for Revision'
    case 'approved':
      /*
       * "Completed", not "Approved". The requirement marks the workflow
       * COMPLETED once the final approver signs, and is explicit that nothing
       * further may happen to it - a word that reads as an event ("approved")
       * invites the question of what comes next, which is the question this
       * state exists to close.
       */
      return 'Completed'
    case 'pending_review':
    case 'pending_approval': {
      const chain = steps.filter(step => step.type !== 'Preparer')
      const current = chain.find(step => step.status === 'current')

      /*
       * Submitted, and not yet with anybody. Rare - submitting normally
       * places the memo on step one in the same breath - but it is the
       * requirement's SUBMITTED rung, and a memo whose run has not started
       * is genuinely there rather than pending a person who does not exist.
       */
      if (!current) return 'Submitted'

      return stageFor(current, chain.length)
    }
  }
}
