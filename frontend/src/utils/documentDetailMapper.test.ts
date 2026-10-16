import { describe, expect, it } from 'vitest'
import type {
  ApiComment,
  ApiDocumentAuditEntry,
  ApiDocumentDetail,
  ApiSupportingDocument,
  ApiWorkflowResponse,
  ApiWorkflowStep,
} from '../types/documentDetail'
import {
  assembleDocumentDetailData,
  buildCommentViews,
  buildDocumentAuditViews,
  buildLatestActionReason,
  buildDocumentDetailView,
  buildSupportingDocumentViews,
  buildWorkflowSteps,
  buildWorkflowSummary,
} from './documentDetailMapper'

/**
 * Four API responses into one detail screen. The chain is the part worth
 * being exact about: it is the picture people use to answer "where is this,
 * and who has it", and it has to say the same thing as the sentence printed
 * underneath it.
 */

const user = (id: string, firstName: string, lastName: string) => ({
  id,
  firstName,
  lastName,
})

const PREPARER = user('u0', 'Ayesha', 'Khan')
const REVIEWER = user('u1', 'Bilal', 'Ahmed')
const APPROVER = user('u2', 'Chandni', 'Rao')
const FINAL = user('u3', 'Dawood', 'Iqbal')

const chainStep = (
  stepOrder: number,
  assignedUser: typeof REVIEWER,
  approvalType: ApiWorkflowStep['approvalType'],
) => ({ id: `chain-${stepOrder}`, stepOrder, approvalType, assignedUser })

const detail = (overrides: Partial<ApiDocumentDetail> = {}): ApiDocumentDetail =>
  ({
    id: 'd1',
    title: 'Warehouse lease extension',
    description: 'A lease.',
    status: 'PENDING_REVIEW',
    preparerId: PREPARER.id,
    currentVersionNumber: 2,
    createdAt: new Date(2026, 8, 1, 9).toISOString(),
    updatedAt: new Date(2026, 8, 4, 9).toISOString(),
    submittedAt: new Date(2026, 8, 2, 9).toISOString(),
    preparer: PREPARER,
    versions: [],
    supportingDocuments: [],
    approvalChain: {
      steps: [
        chainStep(1, REVIEWER, 'REVIEWER'),
        chainStep(2, APPROVER, 'APPROVER'),
        chainStep(3, FINAL, 'FINAL_APPROVER'),
      ],
    },
    currentWorkflowRun: { id: 'r1', status: 'IN_PROGRESS', currentStepOrder: 1 },
    currentStep: chainStep(1, REVIEWER, 'REVIEWER'),
    ...overrides,
  }) as ApiDocumentDetail

const runStep = (
  stepOrder: number,
  assignedUser: typeof REVIEWER,
  approvalType: ApiWorkflowStep['approvalType'],
  status: string,
  extra: Partial<ApiWorkflowStep> = {},
): ApiWorkflowStep => ({
  stepOrder,
  approvalType,
  assignedUser,
  status,
  actedAt: null,
  comment: null,
  ...extra,
})

const workflow = (
  overrides: Partial<ApiWorkflowResponse> = {},
): ApiWorkflowResponse =>
  ({
    documentId: 'd1',
    documentStatus: 'PENDING_REVIEW',
    workflowStatus: 'IN_PROGRESS',
    currentStepOrder: 1,
    workflow: [
      runStep(1, REVIEWER, 'REVIEWER', 'PENDING'),
      runStep(2, APPROVER, 'APPROVER', 'WAITING'),
      runStep(3, FINAL, 'FINAL_APPROVER', 'WAITING'),
    ],
    ...overrides,
  }) as ApiWorkflowResponse

describe('buildDocumentDetailView', () => {
  it('names a file a person can save, not a storage path', () => {
    // The API stores an object path made of uuids; that is not what the
    // Download button should call the file.
    expect(buildDocumentDetailView(detail()).fileName).toBe('v2.pdf')
  })

  it('names whoever is holding it', () => {
    expect(buildDocumentDetailView(detail()).currentHolder).toBe('Bilal Ahmed')
  })

  it.each([
    ['APPROVED', 'Completed'],
    ['REJECTED', 'Rejected'],
    ['DELETED', 'Withdrawn'],
    ['REVISION_REQUESTED', 'Ayesha Khan'],
  ] as const)('reads the holder for %s as %s', (status, expected) => {
    expect(buildDocumentDetailView(detail({ status })).currentHolder).toBe(expected)
  })

  it('gives the holder as an id, for controls that must do more than print a name', () => {
    expect(buildDocumentDetailView(detail()).currentHolderId).toBe(REVIEWER.id)
  })

  it.each(['APPROVED', 'REJECTED', 'DELETED', 'REVISION_REQUESTED'] as const)(
    'has no holder id on a %s memo, rather than falling back to the preparer',
    status => {
      /*
       * `currentHolder` falls back to the preparer's NAME so the column always
       * reads as something. An id doing the same would hand a caller the
       * preparer where the honest answer is that nobody is holding a step -
       * and the caller most likely to ask is the one deciding whether to offer
       * an action against that person.
       */
      expect(buildDocumentDetailView(detail({ status })).currentHolderId).toBeNull()
    },
  )

  it('has no holder id when the response names no current step either', () => {
    // A memo that is in flight as far as its status goes, with no step
    // reported. The name falls back to the preparer so the column reads as
    // something; the id must not, or a control offers an action against
    // somebody who is not holding anything.
    expect(
      buildDocumentDetailView(detail({ currentStep: null })).currentHolderId,
    ).toBeNull()
  })

  it('reads an empty description as empty, not as the word null', () => {
    expect(buildDocumentDetailView(detail({ description: null })).description).toBe('')
  })

  it('falls back to creation time when nothing was submitted', () => {
    const view = buildDocumentDetailView(detail({ submittedAt: null }))

    expect(view.submittedDate).toBe('Sep 1, 2026')
  })
})

describe('buildWorkflowSteps', () => {
  it('puts the preparer at the head of the chain, already done', () => {
    // They signed the document before it moved. A chain that starts at step 1
    // hides who sent it.
    const steps = buildWorkflowSteps(detail(), workflow())

    expect(steps[0]).toMatchObject({
      step: 0,
      type: 'Preparer',
      user: 'Ayesha Khan',
      initials: 'AK',
      status: 'completed',
    })
  })

  it('carries whose step each one is, preparer included', () => {
    /*
     * Everybody already on the memo, from one list. A control that has to
     * refuse a person for being on the chain would otherwise take the chain
     * from here and the preparer from somewhere else, and the preparer is the
     * one who must never be offered as an approver.
     */
    const steps = buildWorkflowSteps(detail(), workflow())

    expect(steps.map(step => step.userId)).toEqual([
      PREPARER.id,
      REVIEWER.id,
      APPROVER.id,
      FINAL.id,
    ])
  })

  it('reads each run step into the state the chip shows', () => {
    const steps = buildWorkflowSteps(
      detail(),
      workflow({
        workflow: [
          runStep(1, REVIEWER, 'REVIEWER', 'APPROVE', { actedAt: new Date(2026, 8, 3).toISOString() }),
          runStep(2, APPROVER, 'APPROVER', 'PENDING'),
          runStep(3, FINAL, 'FINAL_APPROVER', 'WAITING'),
        ],
      }),
    )

    expect(steps.map(step => step.status)).toEqual([
      'completed',
      'completed',
      'current',
      'pending',
    ])
  })

  it('reads a skipped step as skipped, not as approved', () => {
    // Somebody was passed over. Showing that as an approval would put a
    // decision in their name that they never made.
    const steps = buildWorkflowSteps(
      detail(),
      workflow({
        workflow: [
          runStep(1, REVIEWER, 'REVIEWER', 'SKIP', { comment: 'On leave.' }),
          runStep(2, APPROVER, 'APPROVER', 'PENDING'),
        ],
      }),
    )

    expect(steps[1].status).toBe('skipped')
    expect(steps[1].comment).toBe('On leave.')
  })

  it('labels each step by what it asks for', () => {
    const steps = buildWorkflowSteps(detail(), workflow())

    expect(steps.map(step => step.type)).toEqual([
      'Preparer',
      'Reviewer',
      'Approver',
      'Final Approver',
    ])
  })

  it('falls back to the chain when no run has started', () => {
    // A document whose run has not begun still has an approval chain, and
    // showing an empty chain would read as "nobody is assigned".
    const steps = buildWorkflowSteps(
      detail(),
      workflow({ workflow: undefined, workflowStatus: null }),
    )

    expect(steps).toHaveLength(4)
    expect(steps.slice(1).map(step => step.status)).toEqual([
      'pending',
      'pending',
      'pending',
    ])
  })

  it('shows the preparer alone when there is no chain at all', () => {
    const steps = buildWorkflowSteps(
      detail({ approvalChain: null }),
      workflow({ workflow: [] }),
    )

    expect(steps).toHaveLength(1)
    expect(steps[0].type).toBe('Preparer')
  })

  it('carries a date only for steps that were acted on', () => {
    const steps = buildWorkflowSteps(
      detail(),
      workflow({
        workflow: [
          runStep(1, REVIEWER, 'REVIEWER', 'APPROVE', {
            actedAt: new Date(2026, 8, 3, 10).toISOString(),
          }),
          runStep(2, APPROVER, 'APPROVER', 'PENDING'),
        ],
      }),
    )

    expect(steps[1].date).toBe('Sep 3, 2026')
    expect(steps[2].date).toBeUndefined()
  })
})

describe('buildWorkflowSummary', () => {
  const summarise = (
    workflowOverrides: Partial<ApiWorkflowResponse> = {},
    documentOverrides: Partial<ApiDocumentDetail> = {},
  ) => {
    const flow = workflow(workflowOverrides)
    return buildWorkflowSummary(flow, buildWorkflowSteps(detail(documentOverrides), flow))
  }

  it('says where it is and who has it', () => {
    expect(summarise()).toBe('Step 1 of 3, waiting on Bilal Ahmed (Reviewer).')
  })

  it('agrees with the chain it sits under', () => {
    // The sentence and the chip are two statements about one document; a
    // sentence naming step 1 under a chain highlighting step 2 is the kind of
    // contradiction that costs the whole screen its credibility.
    const flow = workflow({
      workflow: [
        runStep(1, REVIEWER, 'REVIEWER', 'APPROVE'),
        runStep(2, APPROVER, 'APPROVER', 'PENDING'),
        runStep(3, FINAL, 'FINAL_APPROVER', 'WAITING'),
      ],
    })
    const steps = buildWorkflowSteps(detail(), flow)
    const summary = buildWorkflowSummary(flow, steps)

    const current = steps.find(step => step.status === 'current')
    expect(summary).toContain(`Step ${current!.step}`)
    expect(summary).toContain(current!.user)
  })

  it('counts the chain without counting the preparer', () => {
    // Three approval steps is "of 3", not "of 4".
    expect(summarise()).toContain('of 3')
  })

  it('says it is done, and how many steps it took', () => {
    expect(
      summarise({
        documentStatus: 'APPROVED',
        workflow: [
          runStep(1, REVIEWER, 'REVIEWER', 'APPROVE'),
          runStep(2, APPROVER, 'APPROVER', 'APPROVE'),
          runStep(3, FINAL, 'FINAL_APPROVER', 'APPROVE'),
        ],
      }),
    ).toBe('Completed. All 3 steps approved.')
  })

  it('says step, singular, for a one-step chain', () => {
    expect(
      summarise({
        documentStatus: 'APPROVED',
        workflow: [runStep(1, FINAL, 'FINAL_APPROVER', 'APPROVE')],
      }),
    ).toBe('Completed. All 1 step approved.')
  })

  it('names where a rejection happened', () => {
    expect(
      summarise({
        documentStatus: 'REJECTED',
        workflow: [
          runStep(1, REVIEWER, 'REVIEWER', 'REJECT', { comment: 'Figures wrong.' }),
          runStep(2, APPROVER, 'APPROVER', 'WAITING'),
        ],
      }),
    ).toBe('Rejected at step 1 by Bilal Ahmed. The approval chain ended there.')
  })

  it('still says it was rejected when it cannot say where', () => {
    expect(
      summarise({
        documentStatus: 'REJECTED',
        workflow: [runStep(1, REVIEWER, 'REVIEWER', 'WAITING')],
      }),
    ).toBe('Rejected. The approval chain ended before it completed.')
  })

  it('explains that a revision restarts the chain', () => {
    expect(summarise({ documentStatus: 'REVISION_REQUESTED' })).toContain(
      'restarts when they resubmit',
    )
  })

  it('says a chain exists but has not started', () => {
    expect(
      summarise({
        documentStatus: 'PENDING_REVIEW',
        workflow: [
          runStep(1, REVIEWER, 'REVIEWER', 'WAITING'),
          runStep(2, FINAL, 'FINAL_APPROVER', 'WAITING'),
        ],
      }),
    ).toBe('2 approval steps, not started yet.')
  })

  it('says so plainly when there is no chain', () => {
    const flow = workflow({ workflow: [] })
    const steps = buildWorkflowSteps(detail({ approvalChain: null }), flow)

    expect(buildWorkflowSummary(flow, steps)).toBe(
      'No approval chain has been set for this document.',
    )
  })
})

describe('buildSupportingDocumentViews', () => {
  const attachment = (sizeBytes: number): ApiSupportingDocument => ({
    id: 'a1',
    fileName: 'survey.pdf',
    contentType: 'application/pdf',
    sizeBytes,
    uploadedAt: new Date(2026, 8, 3).toISOString(),
  })

  it('never renders an attachment as 0 KB', () => {
    // A 300-byte file exists; rounding it to nothing reads as a failed upload.
    expect(buildSupportingDocumentViews([attachment(300)])[0].sizeLabel).toBe('1 KB')
    expect(buildSupportingDocumentViews([attachment(1)])[0].sizeLabel).toBe('1 KB')
  })

  it('scales to megabytes past a megabyte', () => {
    expect(buildSupportingDocumentViews([attachment(1024 * 1024)])[0].sizeLabel).toBe(
      '1.0 MB',
    )
    expect(
      buildSupportingDocumentViews([attachment(5.5 * 1024 * 1024)])[0].sizeLabel,
    ).toBe('5.5 MB')
  })

  it('handles no attachments at all', () => {
    expect(buildSupportingDocumentViews(undefined)).toEqual([])
    expect(buildSupportingDocumentViews([])).toEqual([])
  })
})

describe('buildLatestActionReason', () => {
  /**
   * The sentence a preparer acts on.
   *
   * A revision request will not send without a comment, so when a memo comes
   * back the comment IS the reason - and it used to be readable only two tabs
   * away under Comments while the banner said nothing more than that something
   * needed changing.
   */
  const entry = (
    overrides: Partial<ApiDocumentAuditEntry> = {},
  ): ApiDocumentAuditEntry => ({
    id: 'e1',
    date: new Date(2026, 8, 2, 9, 0, 0).toISOString(),
    time: '',
    user: REVIEWER,
    role: 'REVIEWER',
    action: 'REQUEST_REVISION',
    comments: 'Add the per-diem table.',
    ...overrides,
  })

  it('hands back the reason, who wrote it and when', () => {
    expect(buildLatestActionReason([entry()], ['REQUEST_REVISION'])).toEqual({
      user: 'Bilal Ahmed',
      comment: 'Add the per-diem table.',
      date: 'Sep 2, 2026',
    })
  })

  it('takes the newest when a memo has been round more than once', () => {
    // An older revision request has already been answered; showing it would
    // send the preparer to fix something they fixed last week.
    const older = entry({
      id: 'old',
      date: new Date(2026, 8, 1).toISOString(),
      comments: 'Fix the header.',
    })
    const newer = entry({
      id: 'new',
      date: new Date(2026, 8, 5).toISOString(),
      comments: 'Now add the per-diem table.',
    })

    expect(
      buildLatestActionReason([older, newer], ['REQUEST_REVISION'])?.comment,
    ).toBe('Now add the per-diem table.')
  })

  it('does not depend on the order the API happened to return', () => {
    // The endpoint sorts newest first today. This is the sentence somebody
    // acts on; it should not quietly become the wrong one if that changes.
    const older = entry({ id: 'old', date: new Date(2026, 8, 1).toISOString(), comments: 'Older.' })
    const newer = entry({ id: 'new', date: new Date(2026, 8, 5).toISOString(), comments: 'Newer.' })

    expect(buildLatestActionReason([newer, older], ['REQUEST_REVISION'])?.comment).toBe('Newer.')
    expect(buildLatestActionReason([older, newer], ['REQUEST_REVISION'])?.comment).toBe('Newer.')
  })

  it('ignores actions it was not asked about', () => {
    const approval = entry({ action: 'APPROVE', comments: 'Looks good to me.' })

    expect(buildLatestActionReason([approval], ['REQUEST_REVISION'])).toBeNull()
  })

  it('reads a rejection too, when asked for both', () => {
    const rejection = entry({ action: 'REJECT', comments: 'Budget not approved.' })

    expect(
      buildLatestActionReason([rejection], ['REQUEST_REVISION', 'REJECT'])?.comment,
    ).toBe('Budget not approved.')
  })

  it('skips an action carrying no reason rather than printing an empty banner', () => {
    // The dialogs refuse to send without one, but a row written before they
    // did - or a future action that carries no reason - must not render as a
    // blank quote under a heading that promises an explanation.
    expect(
      buildLatestActionReason([entry({ comments: null })], ['REQUEST_REVISION']),
    ).toBeNull()
    expect(
      buildLatestActionReason([entry({ comments: '   ' })], ['REQUEST_REVISION']),
    ).toBeNull()
  })

  it('is null when nothing has been sent back', () => {
    expect(buildLatestActionReason([], ['REQUEST_REVISION'])).toBeNull()
  })
})

describe('buildCommentViews and buildDocumentAuditViews', () => {
  it('names the author and their initials', () => {
    const comments: ApiComment[] = [
      {
        id: 'c1',
        comment: 'Please attach the survey.',
        createdAt: new Date(2026, 8, 3).toISOString(),
        author: REVIEWER,
      },
    ]

    expect(buildCommentViews(comments)[0]).toMatchObject({
      user: 'Bilal Ahmed',
      initials: 'BA',
      comment: 'Please attach the survey.',
      date: 'Sep 3, 2026',
    })
  })

  it('keeps the preparer role readable in the audit tab', () => {
    // The role labeller only knows the three approval types; "Preparer"
    // arrives as free text and has to survive rather than blanking the cell.
    const entries: ApiDocumentAuditEntry[] = [
      {
        id: 'e1',
        date: new Date(2026, 8, 2, 14, 30, 45).toISOString(),
        time: '',
        user: PREPARER,
        role: 'Preparer',
        action: 'DOCUMENT_UPLOADED',
        comments: null,
      },
    ]

    expect(buildDocumentAuditViews(entries)[0]).toMatchObject({
      role: 'Preparer',
      action: 'Document Uploaded',
      time: '14:30:45',
      comment: '—',
    })
  })
})

describe('assembleDocumentDetailData', () => {
  const assembled = (
    workflowOverrides: Partial<ApiWorkflowResponse> = {},
  ) =>
    assembleDocumentDetailData(detail(), workflow(workflowOverrides), [], [])

  it('counts the approval steps, not the preparer, as every other screen does', () => {
    // It used to count the preparer too, so a three-step chain nobody had
    // acted on read "1/4" under a header saying "Reviewer 1 of 3", and the
    // documents table and My queue said "of 3" for the same memo.
    const data = assembled()

    expect(data.totalSteps).toBe(3)
    expect(data.completedSteps).toBe(0)
  })

  it('counts a skipped step as done for progress', () => {
    const data = assembled({
      workflow: [
        runStep(1, REVIEWER, 'REVIEWER', 'SKIP'),
        runStep(2, APPROVER, 'APPROVER', 'PENDING'),
        runStep(3, FINAL, 'FINAL_APPROVER', 'WAITING'),
      ],
    })

    expect(data.completedSteps).toBe(1)
  })

  it('counts reviewers and approvers without counting the preparer', () => {
    const data = assembled()

    expect(data.reviewers).toBe(1)
    expect(data.approvers).toBe(2)
    expect(data.reviewers + data.approvers).toBe(data.totalSteps)
  })

  it('returns every section the screen renders', () => {
    const data = assembled()

    expect(Object.keys(data).sort()).toEqual([
      'approvers',
      'auditRecords',
      'comments',
      'completedSteps',
      'document',
      'earlierSupportingDocuments',
      'returnedReason',
      'reviewers',
      'supportingDocuments',
      'totalSteps',
      'workflowSteps',
      'workflowSummary',
    ])
  })
})

/**
 * What the screen needs to know about a memo that was typed rather than
 * uploaded: which version's text to open for a rewrite, and where this
 * reader's own signature belongs.
 */
describe('a memo typed in the portal', () => {
  const body = (text: string) =>
    ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    }) as never

  const version = (versionNumber: number, bodyJson: unknown) => ({
    id: `v${versionNumber}`,
    versionNumber,
    storagePath: `documents/d1/v${versionNumber}.pdf`,
    uploadedAt: new Date(2026, 8, 2, 9).toISOString(),
    bodyJson,
  })

  it('carries the template and the header lines', () => {
    const view = buildDocumentDetailView(
      detail({
        memoType: 'APPROVAL_REQUEST',
        memoTo: 'Sir BMD',
        memoFrom: 'Human Resource Department',
      }),
    )

    expect(view.memoType).toBe('APPROVAL_REQUEST')
    expect(view.memoTo).toBe('Sir BMD')
    expect(view.memoFrom).toBe('Human Resource Department')
  })

  it("carries the server's answer to whether a resubmission must be signed", () => {
    // The page used to guess from the organisation's switch, and for an
    // Approval Request with it off sent an unsigned upload the server refused.
    expect(buildDocumentDetailView(detail({ resubmissionSigned: true })).resubmissionSigned).toBe(true)
    expect(buildDocumentDetailView(detail({ resubmissionSigned: false })).resubmissionSigned).toBe(false)
    // A server too old to say leaves the page to its old rule.
    expect(buildDocumentDetailView(detail()).resubmissionSigned).toBeNull()
  })

  it('says nothing about a template for an uploaded memo', () => {
    const view = buildDocumentDetailView(detail())

    expect(view.memoType).toBeNull()
    expect(view.memoBody).toBeNull()
    expect(view.mySignatureSlot).toBeNull()
  })

  it('opens the version the document is actually on, not the newest row', () => {
    /*
     * During a revision cycle those differ: the newest row is the one that
     * came back, and `currentVersionNumber` is what the document points at.
     * Seeding the editor from the wrong one hands the preparer text they did
     * not write.
     */
    const view = buildDocumentDetailView(
      detail({
        currentVersionNumber: 2,
        versions: [
          version(3, body('A draft nobody submitted.')),
          version(2, body('The memo as it stands.')),
          version(1, body('The first attempt.')),
        ] as never,
      }),
    )

    expect(JSON.stringify(view.memoBody)).toContain('The memo as it stands.')
  })

  it('has no body to open when the version carries none', () => {
    const view = buildDocumentDetailView(
      detail({ currentVersionNumber: 2, versions: [version(2, null)] as never }),
    )

    expect(view.memoBody).toBeNull()
  })

  it("turns this reader's ruled line into a placement the signing dialog uses", () => {
    const view = buildDocumentDetailView(
      detail({
        mySignatureSlot: {
          key: 'u0',
          name: 'Ayesha Khan',
          page: 1,
          x: 49,
          y: 372,
          width: 150,
          height: 40,
        },
      }),
    )

    expect(view.mySignatureSlot).toMatchObject({
      page: 1,
      signatureX: 49,
      signatureY: 372,
      signatureWidth: 150,
    })
    // The date is printed under the line, so the signature gets the lane
    // above it rather than the whole box.
    expect(view.mySignatureSlot!.signatureHeight).toBeLessThan(40)
  })
})
