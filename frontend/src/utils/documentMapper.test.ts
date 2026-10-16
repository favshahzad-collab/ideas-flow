import { describe, expect, it } from 'vitest'
import type { ApiDocument, ApiDocumentCurrentStep } from '../types/document'
import { mapApiDocumentToDashboard, mapApiStatusToUi } from './documentMapper'

/**
 * The API's document into the row a person reads. Two things this decides that
 * nothing else does: what the status word says, and who the row names as
 * holding the document - which is the column people scan to find their own
 * work.
 */

const OTHER = 'other-0000-0000-0000-00000000002'

const user = (id: string, firstName: string, lastName: string) => ({
  id,
  firstName,
  lastName,
})

const currentStep = (
  overrides: Partial<ApiDocumentCurrentStep> = {},
): ApiDocumentCurrentStep =>
  ({
    id: 'step-1',
    stepOrder: 1,
    approvalType: 'REVIEWER',
    assignedUser: user(OTHER, 'Bilal', 'Ahmed'),
    ...overrides,
  }) as ApiDocumentCurrentStep

const apiDocument = (overrides: Partial<ApiDocument> = {}): ApiDocument =>
  ({
    id: 'd1',
    title: 'Warehouse lease extension',
    description: 'A lease.',
    status: 'PENDING_REVIEW',
    preparerId: 'preparer-1',
    currentVersionNumber: 1,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-04T09:00:00.000Z',
    submittedAt: '2026-09-02T09:00:00.000Z',
    preparer: user('preparer-1', 'Ayesha', 'Khan'),
    currentStep: currentStep(),
    nextStep: null,
    workflow: { currentStepOrder: 1, totalSteps: 3 },
    awaitingMyAction: false,
    ...overrides,
  }) as ApiDocument

describe('mapApiStatusToUi', () => {
  it('splits pending review by what the current step actually asks for', () => {
    // One backend status, two words on screen: "waiting for a review" and
    // "waiting for approval" are different things to the person waiting.
    expect(mapApiStatusToUi('PENDING_REVIEW', currentStep({ approvalType: 'REVIEWER' }))).toBe(
      'pending_review',
    )
    expect(mapApiStatusToUi('PENDING_REVIEW', currentStep({ approvalType: 'APPROVER' }))).toBe(
      'pending_approval',
    )
    expect(
      mapApiStatusToUi('PENDING_REVIEW', currentStep({ approvalType: 'FINAL_APPROVER' })),
    ).toBe('pending_approval')
  })

  it('falls back to review when there is no step to read', () => {
    expect(mapApiStatusToUi('PENDING_REVIEW', null)).toBe('pending_review')
    expect(mapApiStatusToUi('PENDING_REVIEW')).toBe('pending_review')
  })

  it.each([
    ['DRAFT', 'draft'],
    ['REVISION_REQUESTED', 'revision_requested'],
    ['APPROVED', 'approved'],
    ['REJECTED', 'rejected'],
    ['DELETED', 'deleted'],
  ] as const)('maps %s straight through to %s', (api, ui) => {
    expect(mapApiStatusToUi(api, null)).toBe(ui)
  })
})

describe('who the row says is holding it', () => {
  it('names the person the workflow is waiting on', () => {
    const row = mapApiDocumentToDashboard(apiDocument())

    expect(row.currentHolder).toBe('Bilal Ahmed')
    expect(row.currentHolderInitials).toBe('BA')
  })

  it('hands a document back to the preparer when a revision is asked for', () => {
    // It is not with the approver any more - it is the preparer's to fix.
    const row = mapApiDocumentToDashboard(
      apiDocument({ status: 'REVISION_REQUESTED' }),
    )

    expect(row.currentHolder).toBe('Ayesha Khan')
    expect(row.currentHolderInitials).toBe('AK')
  })

  it('falls back to the preparer when no step is assigned', () => {
    const row = mapApiDocumentToDashboard(apiDocument({ currentStep: null }))

    expect(row.currentHolder).toBe('Ayesha Khan')
  })

  it.each([
    ['APPROVED', 'Completed'],
    ['REJECTED', 'Rejected'],
    ['DELETED', 'Withdrawn'],
  ] as const)('puts a status word in the holder column for %s', (status, word) => {
    const row = mapApiDocumentToDashboard(apiDocument({ status }))

    expect(row.currentHolder).toBe(word)
  })

  it('shows no avatar beside a status word', () => {
    // An avatar next to "Completed" attributes the word to a person, and the
    // initials shown were the last approver's - which reads as blame.
    for (const status of ['APPROVED', 'REJECTED', 'DELETED'] as const) {
      expect(
        mapApiDocumentToDashboard(apiDocument({ status })).currentHolderInitials,
        status,
      ).toBeNull()
    }
  })

  it('keeps the submitter and the holder apart', () => {
    const row = mapApiDocumentToDashboard(apiDocument())

    expect(row.submittedBy).toBe('Ayesha Khan')
    expect(row.submittedByInitials).toBe('AK')
    expect(row.currentHolder).toBe('Bilal Ahmed')
    expect(row.currentHolderInitials).toBe('BA')
  })
})

describe('isAwaitingMyAction', () => {
  // Decided on the server, with the viewer's delegations. These pin that the
  // screen takes that answer and does not second-guess it from `currentStep`.

  it('is what the server says', () => {
    expect(mapApiDocumentToDashboard(apiDocument({ awaitingMyAction: true })).isAwaitingMyAction).toBe(true)
    expect(mapApiDocumentToDashboard(apiDocument({ awaitingMyAction: false })).isAwaitingMyAction).toBe(false)
  })

  it('holds for a delegate, whose name is not the one on the step', () => {
    // The step is assigned to Bilal; the viewer is covering for him. The
    // old check compared the step's assignee with the viewer and said no,
    // while the sidebar badge said one memo was waiting.
    const covered = apiDocument({ currentStep: currentStep(), awaitingMyAction: true })
    expect(mapApiDocumentToDashboard(covered).isAwaitingMyAction).toBe(true)
  })
})

describe('the rest of the row', () => {
  it('says what the current step asks the holder to do', () => {
    expect(
      mapApiDocumentToDashboard(apiDocument()).actionLabel,
    ).toBe('Review Required')
    expect(
      mapApiDocumentToDashboard(
        apiDocument({ currentStep: currentStep({ approvalType: 'APPROVER' }) }),
      ).actionLabel,
    ).toBe('Approval Required')
  })

  it('names who it goes to next, or nobody', () => {
    expect(mapApiDocumentToDashboard(apiDocument()).nextHolder).toBeNull()
    expect(
      mapApiDocumentToDashboard(
        apiDocument({
          nextStep: {
            id: 's2',
            stepOrder: 2,
            approvalType: 'FINAL_APPROVER',
            assignedUser: user('u3', 'Chandni', 'Rao'),
          },
        } as Partial<ApiDocument>),
      ).nextHolder,
    ).toBe('Chandni Rao')
  })

  it('writes a sentence rather than an empty cell for a missing description', () => {
    for (const description of [null, '', '   ']) {
      expect(
        mapApiDocumentToDashboard(apiDocument({ description })).description,
      ).toBe('No description provided.')
    }
  })

  it('carries the progress the workflow reported', () => {
    const row = mapApiDocumentToDashboard(apiDocument())

    expect(row.currentStep).toBe(1)
    expect(row.totalSteps).toBe(3)
  })

  it('reads zero of zero rather than crashing on a document with no workflow', () => {
    const row = mapApiDocumentToDashboard(apiDocument({ workflow: null }))

    expect(row.currentStep).toBe(0)
    expect(row.totalSteps).toBe(0)
  })

  it('falls back to creation time when nothing was ever submitted', () => {
    // A draft has no submittedAt, and an empty date column reads as a bug.
    const row = mapApiDocumentToDashboard(
      apiDocument({ status: 'DRAFT', submittedAt: null }),
    )

    expect(row.submittedAt).toBe('2026-09-01T09:00:00.000Z')
    expect(row.submittedDate).not.toBe('')
  })

  it('keeps the raw timestamps as well as the formatted ones', () => {
    // The formatted date is for reading; the raw one is what the age and
    // sort logic measure against, and rounding it to a day loses hours.
    const row = mapApiDocumentToDashboard(apiDocument())

    expect(row.updatedAt).toBe('2026-09-04T09:00:00.000Z')
    expect(row.lastUpdated).not.toBe(row.updatedAt)
  })
})
