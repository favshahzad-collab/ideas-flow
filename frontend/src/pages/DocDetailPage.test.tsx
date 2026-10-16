import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeUser, renderWithProviders } from '../test/render'
import type { DocumentDetailData } from '../types/documentDetail'
import DocumentDetail from './DocDetailPage'

/**
 * The memo screen, for what it shows once and how its two refusals are asked.
 *
 * It used to draw the approval chain twice (a Chain tab and the card beside
 * the tabs), repeat the chain's step counts in Quick Info, and build its own
 * Reject and Request revision dialogs - with different wording from My
 * queue's, and a revision dialog that closed before sending.
 */

const mocks = vi.hoisted(() => ({
  leaveRejected: vi.fn(),
  rejectDocument: vi.fn(),
  requestRevision: vi.fn(),
  data: null as unknown,
}))

vi.mock('../hooks/useDocumentDetail', () => ({
  useDocumentDetail: () => ({
    data: mocks.data,
    loading: false,
    error: null,
    commentLoading: false,
    refetch: vi.fn(),
    addComment: vi.fn(),
  }),
}))
vi.mock('../services/documentsApi', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/documentsApi')>()),
  leaveRejected: mocks.leaveRejected,
}))
vi.mock('../services/approvalApi', () => ({
  rejectDocument: mocks.rejectDocument,
  requestRevision: mocks.requestRevision,
  skipWorkflowStep: vi.fn(),
}))
// The PDF itself is not what these tests are about, and pdf.js does not run
// in jsdom.
vi.mock('../components/document-detail/DocumentPreview', () => ({
  default: ({ signHere }: { signHere?: { name: string; onSign: () => void } | null }) => (
    <div>
      memo preview
      {signHere && (
        <button type="button" onClick={signHere.onSign}>
          Sign here: {signHere.name}
        </button>
      )}
    </div>
  ),
}))
// What opens is the point here, not the signing dialog's own workings, which
// have their own tests.
vi.mock('../components/SignApproveModal', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="Signing" /> : null),
}))
vi.mock('../components/document-detail/PageThumbnails', () => ({
  default: () => null,
}))

function detail(overrides: Partial<DocumentDetailData> = {}): DocumentDetailData {
  return {
    document: {
      id: 'd1',
      referenceNumber: null,
      checksum: null,
      title: 'Warehouse lease extension',
      description: 'A lease.',
      status: 'pending_review',
      preparerId: 'preparer-1',
      preparerName: 'Ayesha Khan',
      submittedDate: '2 Sep 2026',
      lastUpdated: '4 Sep 2026',
      currentHolder: 'Me Myself',
      currentHolderId: 'user-0000-0000-0000-000000000001',
      fileName: 'lease.pdf',
      versionNumber: 1,
      memoType: null,
      memoTo: null,
      memoFrom: null,
      memoDate: null,
      memoBody: null,
      memoNotes: [],
      mySignatureSlot: null,
    },
    workflowSteps: [
      {
        id: 's1',
        step: 1,
        type: 'Reviewer',
        user: 'Me Myself',
        userId: 'user-0000-0000-0000-000000000001',
        initials: 'MM',
        status: 'current',
      },
      {
        id: 's2',
        step: 2,
        type: 'Final Approver',
        user: 'Chandni Rao',
        userId: 'u3',
        initials: 'CR',
        status: 'pending',
      },
    ],
    completedSteps: 0,
    totalSteps: 2,
    reviewers: 1,
    approvers: 1,
    workflowSummary: 'Step 1 of 2, waiting on Me Myself (Reviewer).',
    comments: [],
    auditRecords: [],
    returnedReason: null,
    supportingDocuments: [],
    canApprove: true,
    pendingActionType: 'REVIEWER',
    canResubmit: false,
    canSkipStep: false,
    actingFor: null,
    ...overrides,
  } as DocumentDetailData
}

const open = (route = '/documents/d1') =>
  renderWithProviders(
    <Routes>
      <Route path="/documents/:id" element={<DocumentDetail />} />
      <Route path="/dashboard" element={<p>documents list</p>} />
    </Routes>,
    { route, currentUser: { user: makeUser() } },
  )

beforeEach(() => {
  vi.clearAllMocks()
  mocks.data = detail()
})

describe('the approval chain', () => {
  it('is drawn once, in the card beside the memo, with where it stands', () => {
    open()

    expect(screen.getAllByRole('heading', { name: 'Approval chain' })).toHaveLength(1)
    expect(screen.queryByRole('tab', { name: /chain/i })).not.toBeInTheDocument()
    expect(screen.getByText('Step 1 of 2, waiting on Me Myself (Reviewer).')).toBeInTheDocument()
    // The counter counts approval steps, as the header and every list do.
    expect(screen.getByText('0 of 2 steps done')).toBeInTheDocument()
  })

  it('offers these tabs and no others', () => {
    open()

    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      'Preview',
      'Supporting',
      'Comments',
      'Audit ledger',
    ])
  })

  it('leaves the step counts to the chain card', () => {
    open()

    const quickInfo = screen.getByRole('heading', { name: 'Quick Info' }).closest('section')!
    expect(
      within(quickInfo)
        .getAllByRole('term')
        .map(term => term.textContent),
    ).toEqual(['Reviewers', 'Approvers'])
  })
})

describe('rejecting and requesting a revision', () => {
  it('asks for a revision in the same dialog My queue uses, with a visible label', async () => {
    const user = userEvent.setup()
    mocks.requestRevision.mockResolvedValue(undefined)
    open()

    await user.click(screen.getByRole('button', { name: 'Revision' }))
    const dialog = screen.getByRole('dialog', { name: 'Request revision' })
    await user.type(within(dialog).getByLabelText(/What needs to change/), 'Add the rent schedule.')
    await user.click(within(dialog).getByRole('button', { name: 'Request revision' }))

    expect(mocks.requestRevision.mock.calls).toEqual([['d1', 'Add the rent schedule.']])
    expect(await screen.findByText('documents list')).toBeInTheDocument()
  })

  it('rejects in the same dialog, and requires a reason', async () => {
    const user = userEvent.setup()
    mocks.rejectDocument.mockResolvedValue(undefined)
    open()

    await user.click(screen.getByRole('button', { name: 'Reject' }))
    const dialog = screen.getByRole('dialog', { name: 'Reject document' })
    await user.click(within(dialog).getByRole('button', { name: 'Reject document' }))

    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'A reason is required when rejecting a document.',
    )
    expect(mocks.rejectDocument).not.toHaveBeenCalled()

    await user.type(within(dialog).getByLabelText(/Reason for rejection/), 'Wrong landlord.')
    await user.click(within(dialog).getByRole('button', { name: 'Reject document' }))

    expect(mocks.rejectDocument.mock.calls).toEqual([['d1', 'Wrong landlord.']])
  })

  it('keeps what was typed when the request fails', async () => {
    // The page's own revision dialog closed before sending, so a failure
    // came back to an empty box.
    const user = userEvent.setup()
    mocks.requestRevision.mockRejectedValue(new Error('This step has already been acted on.'))
    open()

    await user.click(screen.getByRole('button', { name: 'Revision' }))
    const dialog = screen.getByRole('dialog', { name: 'Request revision' })
    await user.type(within(dialog).getByLabelText(/What needs to change/), 'Add the rent schedule.')
    await user.click(within(dialog).getByRole('button', { name: 'Request revision' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This step has already been acted on.',
    )
    expect(within(dialog).getByLabelText(/What needs to change/)).toHaveValue('Add the rent schedule.')
    expect(screen.queryByText('documents list')).not.toBeInTheDocument()
  })
})

describe('arriving from "Open to sign"', () => {
  it('opens signing straight away when the memo is waiting on the reader', () => {
    open('/documents/d1?sign=1')
    expect(screen.getByRole('dialog', { name: 'Signing' })).toBeInTheDocument()
  })

  it('opens the memo and nothing more once it is no longer their turn', () => {
    // A link kept from last week, for a memo somebody else has since signed.
    mocks.data = detail({ canApprove: false })
    open('/documents/d1?sign=1')
    expect(screen.queryByRole('dialog', { name: 'Signing' })).not.toBeInTheDocument()
  })

  it('does not open signing for an ordinary visit', () => {
    open()
    expect(screen.queryByRole('dialog', { name: 'Signing' })).not.toBeInTheDocument()
  })
})

describe('the "Sign here" mark on the memo', () => {
  const slot = { page: 1, signatureX: 220, signatureY: 700, signatureWidth: 150, signatureHeight: 40 }

  it('marks the reader\'s own line while it is their turn, and opens signing from it', async () => {
    mocks.data = detail({ document: { ...detail().document, mySignatureSlot: slot } })
    open()
    screen.getByRole('button', { name: /^Sign here:/ }).click()
    expect(await screen.findByRole('dialog', { name: 'Signing' })).toBeInTheDocument()
  })

  it('is not shown once it is not their turn', () => {
    mocks.data = detail({ canApprove: false, document: { ...detail().document, mySignatureSlot: slot } })
    open()
    expect(screen.queryByRole('button', { name: /^Sign here:/ })).not.toBeInTheDocument()
  })

  it('is not shown to a delegate, whose signature does not go on the line printed for someone else', () => {
    mocks.data = detail({
      actingFor: { id: 'u9', firstName: 'Moiz', lastName: 'Somrow' },
      document: { ...detail().document, mySignatureSlot: slot },
    } as never)
    open()
    expect(screen.queryByRole('button', { name: /^Sign here:/ })).not.toBeInTheDocument()
  })
})

describe('the Withdraw button', () => {
  const mine = (status: string) =>
    detail({
      canApprove: false,
      document: { ...detail().document, preparerId: 'user-0000-0000-0000-000000000001', status },
    } as never)

  it('is offered to the preparer while the memo is in flight', () => {
    mocks.data = mine('pending_review')
    open()
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument()
  })

  it('is not offered on an approved memo, which is a finished record', () => {
    mocks.data = mine('approved')
    open()
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument()
  })
  it('asks for a reason before withdrawing', async () => {
    const user = userEvent.setup({ delay: null })
    mocks.data = mine('pending_review')
    open()

    await user.click(screen.getByRole('button', { name: 'Withdraw' }))
    await user.click(await screen.findByRole('button', { name: 'Withdraw memo' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Say why')
  })
})

describe('the Cancel memo button', () => {
  it("is offered to an administrator with the power, on somebody else's memo", () => {
    mocks.data = detail({ canApprove: false } as never)
    renderWithProviders(
      <Routes>
        <Route path="/documents/:id" element={<DocumentDetail />} />
      </Routes>,
      {
        route: '/documents/d1',
        currentUser: { user: makeUser({ role: 'ADMINISTRATOR', capabilities: ['memos.cancel'] }) },
      },
    )
    expect(screen.getByRole('button', { name: 'Cancel memo' })).toBeInTheDocument()
  })

  it('is not offered without the power', () => {
    mocks.data = detail({ canApprove: false } as never)
    open()
    expect(screen.queryByRole('button', { name: 'Cancel memo' })).not.toBeInTheDocument()
  })
})

describe('a rejected memo', () => {
  const rejectedMine = () =>
    detail({
      canApprove: false,
      canResubmit: true,
      returnedReason: { comment: 'The lease term is wrong.', user: 'Chandni Rao', date: '4 Sep 2026' },
      document: {
        ...detail().document,
        preparerId: 'user-0000-0000-0000-000000000001',
        status: 'rejected',
      },
    } as never)

  it('offers the preparer a resubmission as a new version, through the whole chain again', () => {
    mocks.data = rejectedMine()
    open()

    expect(screen.getByText('Resubmit after rejection')).toBeInTheDocument()
    expect(
      screen.getByText(/goes through the whole approval chain again from the first step, with the same approvers/),
    ).toBeInTheDocument()
    // The reason is shown once, in the Rejected panel.
    expect(screen.getAllByText('The lease term is wrong.')).toHaveLength(1)
  })

  it('cannot be withdrawn, because the rejection stays on record', () => {
    mocks.data = rejectedMine()
    open()
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument()
  })

  it('lets the preparer leave it as rejected, after saying that is final', async () => {
    mocks.data = rejectedMine()
    mocks.leaveRejected.mockResolvedValue({ id: 'd1', rejectionClosedAt: '2026-10-09T10:00:00Z' })
    open()

    await userEvent.click(screen.getByRole('button', { name: 'Leave as rejected' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/This is final/)).toBeInTheDocument()
    expect(mocks.leaveRejected).not.toHaveBeenCalled()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Leave as rejected' }))
    expect(mocks.leaveRejected).toHaveBeenCalledWith('d1')
  })

  it('once left as rejected, says it is closed and offers nothing more', () => {
    mocks.data = detail({
      ...rejectedMine(),
      canResubmit: false,
      document: { ...rejectedMine().document, rejectionClosedAt: '2026-10-09T10:00:00Z' },
    } as never)
    open()

    expect(screen.getByText(/left it as rejected on .*closed for good/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Leave as rejected' })).not.toBeInTheDocument()
    expect(screen.queryByText('Resubmit after rejection')).not.toBeInTheDocument()
  })

  it('is not offered to anyone but its preparer', () => {
    mocks.data = detail({ ...rejectedMine(), canResubmit: false } as never)
    open()
    expect(screen.queryByRole('button', { name: 'Leave as rejected' })).not.toBeInTheDocument()
  })
})

describe('a memo taken out of circulation', () => {
  const me = 'user-0000-0000-0000-000000000001'
  const takenOut = (withdrawnById: string, canResubmit: boolean) =>
    detail({
      canApprove: false,
      pendingActionType: null,
      canResubmit,
      document: {
        ...detail().document,
        preparerId: me,
        status: 'deleted',
        withdrawnById,
        withdrawalReason: 'No longer needed',
      },
    } as never)

  it('offers its preparer a new version after they withdrew it', () => {
    mocks.data = takenOut(me, true)
    open()
    expect(screen.getByText('Withdrawn by its preparer')).toBeInTheDocument()
    expect(screen.getByText(/Upload a new version below to send it round again/)).toBeInTheDocument()
  })

  it("says an administrator's cancel is final, and points to a new memo", () => {
    mocks.data = takenOut('admin-1', false)
    open()
    expect(screen.getByText('Cancelled by an administrator')).toBeInTheDocument()
    expect(screen.getByText(/closed for good\. To go ahead, submit a new memo/)).toBeInTheDocument()
    expect(screen.queryByText(/send it round again/)).not.toBeInTheDocument()
  })
})

describe('an approved copy', () => {
  const approved = (sealedBy: string | null) =>
    detail({
      canApprove: false,
      document: {
        ...detail().document,
        status: 'approved',
        checksum: 'ab'.repeat(32),
        sealedBy,
      },
    } as never)

  it('says whose digital seal it carries', () => {
    mocks.data = approved('Ideas Flow document seal')
    open()
    expect(screen.getByText(/Digitally sealed by Ideas Flow document seal/)).toBeInTheDocument()
  })

  it('says plainly when it is not sealed', () => {
    mocks.data = approved(null)
    open()
    expect(screen.getByText(/Not digitally sealed/)).toBeInTheDocument()
  })
})

describe('on a phone', () => {
  it('keeps the main action in the bar at the foot, and the rest behind More', async () => {
    mocks.data = detail()
    open()
    const more = screen.getByRole('button', { name: 'More' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Close actions' }))
    expect(more).toHaveAttribute('aria-expanded', 'false')
  })

  it('says Actions rather than More when there is no main action to sit beside it', () => {
    mocks.data = detail({ canApprove: false, pendingActionType: null } as never)
    open()
    expect(screen.getByRole('button', { name: 'Actions' })).toBeInTheDocument()
  })
})
