import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { useDocumentDetail } from '../../hooks/useDocumentDetail'
import { fetchDocumentFile } from '../../services/documentDetailApi'
import type { DashboardDocument } from '../../types/document'
import type { DocumentDetailData, WorkflowStepView } from '../../types/documentDetail'
import QueueDetail from './QueueDetail'

/**
 * The right-hand pane of My queue: what the document is, how long it has sat
 * there, where it is in the chain, and the three buttons that move it on.
 *
 * This is the last screen somebody reads before they sign. Two failures
 * matter more than anything else here. The pane must describe the document
 * the cursor is actually on - it is re-rendered under a cursor driven by
 * single keystrokes. And it must not state as fact anything it does not
 * know: an empty approval chain and an approval chain that failed to load
 * look identical, and only one of them is a fact about the document.
 */

vi.mock('../../hooks/useDocumentDetail', () => ({
  useDocumentDetail: vi.fn(),
}))

// The pane embeds the PDF paper, which fetches on mount. Held in flight so
// these tests are about the pane rather than about pdf.js.
vi.mock('../../services/documentDetailApi', () => ({
  fetchDocumentFile: vi.fn(() => new Promise<Blob>(() => {})),
}))

const DAY = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString()

function makeDoc(overrides: Partial<DashboardDocument> = {}): DashboardDocument {
  return {
    id: '3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c',
    referenceNumber: null,
    title: 'Warehouse lease extension',
    description: 'Extends the Sundar Road lease by three years.',
    status: 'pending_review',
    preparerId: 'preparer-1',
    submittedBy: 'Ayesha Khan',
    submittedByInitials: 'AK',
    currentHolder: 'Bilal Ahmed',
    currentHolderInitials: 'BA',
    currentStep: 2,
    totalSteps: 3,
    lastUpdated: '4 days ago',
    submittedDate: 'Sep 1, 2026',
    submittedAt: daysAgo(6),
    updatedAt: daysAgo(4),
    versionNumber: 3,
    approvalType: 'REVIEWER',
    actionLabel: 'Review Required',
    nextHolder: null,
    fileType: 'pdf',
    isAwaitingMyAction: true,
    dueAt: null,
    ...overrides,
  }
}

function makeStep(overrides: Partial<WorkflowStepView> = {}): WorkflowStepView {
  return {
    id: 'step-1',
    step: 1,
    type: 'Reviewer',
    user: 'Ayesha Khan',
    userId: 'u-ayesha',
    initials: 'AK',
    status: 'completed',
    ...overrides,
  }
}

interface Options {
  document?: DashboardDocument
  busy?: boolean
  detail?: {
    data: Partial<DocumentDetailData> | null
    loading?: boolean
    error?: string | null
  }
  onApprove?: Mock<(id: string) => void>
  onRevision?: Mock<(id: string) => void>
  onReject?: Mock<(id: string) => void>
}

function renderDetail({
  document = makeDoc(),
  busy = false,
  detail = { data: { workflowSteps: [] }, loading: false, error: null },
  onApprove = vi.fn<(id: string) => void>(),
  onRevision = vi.fn<(id: string) => void>(),
  onReject = vi.fn<(id: string) => void>(),
}: Options = {}) {
  vi.mocked(useDocumentDetail).mockReturnValue({
    data: detail.data as DocumentDetailData | null,
    loading: detail.loading ?? false,
    error: detail.error ?? null,
    commentLoading: false,
    refetch: vi.fn(),
    addComment: vi.fn(),
  } as unknown as ReturnType<typeof useDocumentDetail>)

  const view = render(
    <QueueDetail
      document={document}
      busy={busy}
      onApprove={onApprove}
      onRevision={onRevision}
      onReject={onReject}
    />,
  )

  return { ...view, onApprove, onRevision, onReject }
}

const button = (name: string | RegExp) => screen.getByRole('button', { name })

describe('what the pane says the document is', () => {
  it('names the document and the version that would be signed', () => {
    renderDetail({ document: makeDoc({ versionNumber: 3 }) })

    expect(
      screen.getByRole('heading', { name: 'Warehouse lease extension' }),
    ).toBeInTheDocument()
    // Signing v2 while v3 is the current version is the mistake this line is
    // here to prevent, and the short id is what gets quoted when it happens.
    // Asserted as one string: an id beside somebody else's version number is
    // the failure, and either half alone would pass without the other.
    expect(screen.getByText(/#3F2A9B1C\s*·\s*v3/)).toBeInTheDocument()
  })

  it('shows the paper of the document it is naming', () => {
    const document = makeDoc({ id: 'bbbbbbbb-0000-0000-0000-000000000002' })
    renderDetail({ document })

    // The header, the buttons and the page all have to be about one document.
    // The file is fetched by id, so a stale or detail-sourced id here would
    // put the previous row's paper under this row's title and its Sign
    // button - and the signature follows the title, not the paper.
    expect(vi.mocked(fetchDocumentFile)).toHaveBeenCalledWith(
      document.id,
      'view',
    )
    // Exactly once, and for nothing else: `toHaveBeenCalledWith` is happy as
    // long as one call matched, so a second fetch for a stale id - the one
    // that would actually put the wrong page on screen - would slip past it.
    expect(vi.mocked(fetchDocumentFile)).toHaveBeenCalledTimes(1)
  })

  it('shows the description when the document has one', () => {
    renderDetail()

    expect(
      screen.getByText('Extends the Sundar Road lease by three years.'),
    ).toBeInTheDocument()
  })

  it('leaves the description out rather than saying something in its place', () => {
    renderDetail({ document: makeDoc({ description: '' }) })

    // A document with no description should read as a short header. Anchored
    // on the title block's whole text rather than on the absence of one
    // sentence: the failure worth catching is an em-dash, a "No description"
    // or a stale summary appearing where the document says nothing.
    const heading = screen.getByRole('heading', { name: 'Warehouse lease extension' })
    expect(heading.parentElement).toHaveTextContent(/^Warehouse lease extension$/)
  })

  it('is focusable and named for the document it is showing, because Enter lands here', () => {
    // Named with a title the fixture does not default to: an aria-label
    // hard-coded to whatever this pane first shipped with would pass against
    // the default document and be wrong for every row after the first.
    renderDetail({ document: makeDoc({ title: 'Fleet insurance renewal' }) })

    // The queue's Enter key calls focus() on this element. If it were not
    // focusable the shortcut would do nothing, and if it were unnamed a
    // reader would announce nothing when it landed.
    const pane = screen.getByLabelText('Details for Fleet insurance renewal')
    expect(pane).toHaveAttribute('tabindex', '-1')
    expect(pane).toContainElement(
      screen.getByRole('heading', { name: 'Fleet insurance renewal' }),
    )
  })
})

describe('how long it has been waiting', () => {
  it('says the age in words once it is worth flagging', () => {
    renderDetail({ document: makeDoc({ updatedAt: daysAgo(12) }) })

    // The red pill is not the statement - "Waiting 12 days" is. Colour alone
    // would leave the age unreadable to anybody who cannot separate the
    // warning tint from the danger one.
    expect(screen.getByText(/Waiting 12 days/)).toBeInTheDocument()
  })

  it('marks a week-old document differently from a three-day-old one, in words', () => {
    const { unmount } = renderDetail({ document: makeDoc({ updatedAt: daysAgo(4) }) })
    expect(screen.getByText(/Waiting 4 days/)).toBeInTheDocument()
    unmount()

    renderDetail({ document: makeDoc({ updatedAt: daysAgo(9) }) })
    expect(screen.getByText(/Waiting 9 days/)).toBeInTheDocument()
  })

  it('stays quiet about a document that arrived today', () => {
    renderDetail({ document: makeDoc({ updatedAt: daysAgo(0) }) })

    // A banner on every document is a banner nobody reads, and this one is
    // meant to mean "this one has been sitting".
    expect(screen.queryByText(/Waiting/)).not.toBeInTheDocument()
  })
})

describe('the three things you can do with it', () => {
  it('asks a reviewer to complete a review and an approver to approve', () => {
    const { unmount } = renderDetail({ document: makeDoc({ approvalType: 'REVIEWER' }) })
    expect(button('Sign & complete review')).toBeInTheDocument()
    unmount()

    renderDetail({ document: makeDoc({ approvalType: 'APPROVER' }) })
    // The word on the button is what tells somebody which act their
    // signature performs; "Sign & approve" on a reviewer step overstates
    // what they are being asked to do.
    expect(button('Sign & approve')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign & complete review' })).toBeNull()
  })

  it('acts on the document it is showing, not on some other one', async () => {
    const user = userEvent.setup({ delay: null })
    const document = makeDoc({ id: 'bbbbbbbb-0000-0000-0000-000000000002' })
    const { onApprove, onRevision, onReject } = renderDetail({ document })

    await user.click(button('Revision'))
    await user.click(button('Reject'))
    await user.click(button(/^Sign/))

    // The pane is re-rendered for whichever row the cursor lands on. An id
    // captured from a stale render would reject a document nobody is
    // looking at.
    expect(onRevision).toHaveBeenCalledWith(document.id)
    expect(onReject).toHaveBeenCalledWith(document.id)
    expect(onApprove).toHaveBeenCalledWith(document.id)
  })

  it('keeps the three actions apart', async () => {
    const user = userEvent.setup({ delay: null })
    const { onApprove, onRevision, onReject } = renderDetail()

    await user.click(button('Reject'))

    // Reject and Revision sit side by side and do opposite things to the
    // preparer's submission.
    expect(onReject).toHaveBeenCalledTimes(1)
    expect(onRevision).not.toHaveBeenCalled()
    expect(onApprove).not.toHaveBeenCalled()
  })

  it('disables all three while one of them is in flight, and says which', async () => {
    const user = userEvent.setup({ delay: null })
    const { onReject, onRevision, onApprove } = renderDetail({ busy: true })

    expect(button('Revision')).toBeDisabled()
    expect(button('Reject')).toBeDisabled()
    expect(button(/^Sign/)).toBeDisabled()
    expect(button(/^Sign/)).toHaveAttribute('aria-busy', 'true')

    await user.click(button('Reject'))

    // Genuinely disabled rather than faded: a second reject lands against a
    // document whose status has already changed, and the busy state is the
    // only signal that the first one is still going.
    expect(onReject).not.toHaveBeenCalled()
    expect(onRevision).not.toHaveBeenCalled()
    expect(onApprove).not.toHaveBeenCalled()
  })

  it('says nothing is in flight when nothing is', () => {
    renderDetail({ busy: false })

    // The other half of the busy contract. A Sign button that reported
    // aria-busy permanently would have a reader announce every idle pane as
    // "busy", and the one moment the word means something would be lost.
    expect(button('Revision')).toBeEnabled()
    expect(button('Reject')).toBeEnabled()
    expect(button(/^Sign/)).toBeEnabled()
    expect(button(/^Sign/)).not.toHaveAttribute('aria-busy')
  })
})

describe('the approval chain beside it', () => {
  it('lists who has acted and who is being waited on', () => {
    renderDetail({
      detail: {
        data: {
          workflowSteps: [
            makeStep({ id: 's1', user: 'Ayesha Khan', status: 'completed' }),
            makeStep({
              id: 's2',
              step: 2,
              user: 'Bilal Ahmed',
              type: 'Approver',
              status: 'current',
            }),
            makeStep({ id: 's3', step: 3, user: 'Chandni Rao', status: 'pending' }),
          ],
        },
      },
    })

    const chain = screen.getByRole('list')
    expect(within(chain).getByText('Ayesha Khan')).toBeInTheDocument()
    expect(within(chain).getByText('Bilal Ahmed')).toBeInTheDocument()
    // The glyphs carry the state visually; the sr-only words are what carry
    // it to a reader, and "who is this waiting on" is the whole question.
    expect(within(chain).getByText(/Waiting on this step/)).toBeInTheDocument()
    expect(within(chain).getByText(/Not yet reached/)).toBeInTheDocument()
  })

  it('does not claim the document has no chain while the chain is loading', () => {
    renderDetail({ detail: { data: null, loading: true } })

    // "No approval chain on this document" is a statement about the
    // document. Shown during the request, it tells an approver a five-step
    // chain does not exist.
    expect(screen.queryByText('No approval chain on this document.')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Approval chain' })).toBeInTheDocument()
  })

  it('says a document genuinely has no chain when it has none', () => {
    renderDetail({ detail: { data: { workflowSteps: [] }, loading: false } })

    expect(screen.getByText('No approval chain on this document.')).toBeInTheDocument()
  })

  it('keeps a chain it already has while that chain is being refetched', () => {
    renderDetail({
      detail: {
        data: {
          workflowSteps: [
            makeStep({ id: 's1', user: 'Ayesha Khan', status: 'completed' }),
            makeStep({ id: 's2', step: 2, user: 'Bilal Ahmed', status: 'current' }),
          ],
        },
        loading: true,
      },
    })

    // `loading` goes true again on every refetch - the pane refetches after
    // each action settles. Falling back to skeletons whenever it is true
    // would blank the chain on a document whose chain is already known, in
    // front of somebody reading it to decide whether they are the last
    // signature.
    const chain = screen.getByRole('list')
    expect(within(chain).getByText('Ayesha Khan')).toBeInTheDocument()
    expect(within(chain).getByText('Bilal Ahmed')).toBeInTheDocument()
  })

  it('says the chain could not be loaded, rather than that there is none', () => {
    // Marked as a known failure. `QueueDetail` destructures only `data` and
    // `loading` from `useDocumentDetail` and drops `error` on the floor, so
    // a failed workflow request renders the empty-chain sentence. An
    // approver reads "no approval chain on this document" about a document
    // that has one, on the screen where they are deciding whether to sign.
    renderDetail({
      detail: { data: null, loading: false, error: 'Failed to load document' },
    })

    expect(screen.queryByText('No approval chain on this document.')).toBeNull()
  })
})
