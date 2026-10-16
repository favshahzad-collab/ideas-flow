import { describe, expect, it } from 'vitest'
import { canSkipStep, type SkipStepInput } from './documentActions'

/**
 * The rule behind the "Skip step" button.
 *
 * Written after finding that nothing anywhere mentioned the control. That is
 * how it came to be gated on a compiled-in flag while the server's answer had
 * moved to a row an administrator edits: an administrator could turn skipping
 * on from the Workflow policy screen, be told it saved, and no button would
 * ever appear. A switch that turns nothing on is the same defect as a button
 * that always answers 403, which is the thing the flag existed to prevent.
 */

const allowed = (overrides: Partial<SkipStepInput> = {}): SkipStepInput => ({
  allowStepSkip: true,
  preparerId: 'the-preparer',
  userId: 'the-preparer',
  documentStatus: 'PENDING_REVIEW',
  workflowStatus: 'IN_PROGRESS',
  steps: [{ status: 'APPROVED' }, { status: 'PENDING' }],
  ...overrides,
})

describe('the deployment policy', () => {
  it('is what decides it, not anything compiled in', () => {
    expect(canSkipStep(allowed())).toBe(true)
  })

  it('hides the control when skipping is switched off', () => {
    /*
     * The shipped default, and the reason the admin screen exists: a memo is
     * supposed to carry the approvals it says it carries, and the one bypass
     * was in the hands of the person who most wants the memo through.
     */
    expect(canSkipStep(allowed({ allowStepSkip: false }))).toBe(false)
  })

  it('is checked first, so no other condition can reinstate it', () => {
    // Every other clause satisfied, policy off. Still no.
    expect(
      canSkipStep(
        allowed({ allowStepSkip: false, steps: [{ status: 'PENDING' }] })
      )
    ).toBe(false)
  })
})

describe('who is asking', () => {
  it('offers it to the preparer, who is the one waiting', () => {
    expect(canSkipStep(allowed())).toBe(true)
  })

  it('refuses an approver skipping the approver after them', () => {
    // The bypass this product spent an administration screen deciding not to
    // hand out. It is the preparer's escape hatch or it is nobody's.
    expect(canSkipStep(allowed({ userId: 'somebody-else' }))).toBe(false)
  })
})

describe('what state the memo is in', () => {
  it('refuses one that is not out for review', () => {
    for (const documentStatus of [
      'DRAFT',
      'APPROVED',
      'REJECTED',
      'REVISION_REQUESTED',
      'DELETED',
    ]) {
      expect(canSkipStep(allowed({ documentStatus }))).toBe(false)
    }
  })

  it('refuses a run that is not in progress', () => {
    expect(canSkipStep(allowed({ workflowStatus: 'COMPLETED' }))).toBe(false)
  })

  it('refuses a memo with no run at all', () => {
    // Both statuses are nullable on the wire. Null is not "anything goes".
    expect(canSkipStep(allowed({ workflowStatus: null }))).toBe(false)
    expect(canSkipStep(allowed({ documentStatus: null }))).toBe(false)
  })

  it('refuses when no step is actually waiting', () => {
    // Nothing to skip. The button would be offering to do nothing.
    expect(canSkipStep(allowed({ steps: [{ status: 'APPROVED' }] }))).toBe(false)
    expect(canSkipStep(allowed({ steps: [] }))).toBe(false)
  })
})
