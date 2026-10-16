import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { DashboardDocument } from '../../types/document'
import type { QueueTab } from '../../utils/pendingQueue'
import QueueList from './QueueList'

/**
 * The filter strip, scoped.
 *
 * These used to be `role="tab"`, which made them unambiguous to query. They
 * are plain toggles now - the role promised arrow-key navigation the screen
 * could not give, and the arrow keys are already spoken for here - so a bare
 * `getByRole('button', { name: /Overdue/ })` also finds the queue rows.
 */
const filters = () => within(screen.getByRole('group', { name: 'Queue filter' }))

/** The rows themselves, for the same reason. */
const queue = () => within(screen.getByRole('list', { name: 'Queue' }))

/**
 * The scanning column of My queue. It answers one question, repeatedly:
 * which of these do I open next? Everything on a row is there to be compared
 * against the row above it - how long it has been waiting, whether this step
 * wants a review or an approval, how far through the chain it is.
 *
 * The column is also the thing the keyboard drives. Which row is selected is
 * not decoration: it is the document that A, R and X will act on, so it has
 * to be stated in something a screen reader can read, not only in a tint.
 */

const DAY = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString()

function makeDoc(overrides: Partial<DashboardDocument> = {}): DashboardDocument {
  return {
    id: '3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c',
    referenceNumber: null,
    title: 'Warehouse lease extension',
    description: 'A lease.',
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
    versionNumber: 1,
    approvalType: 'REVIEWER',
    actionLabel: 'Review Required',
    nextHolder: null,
    fileType: 'pdf',
    isAwaitingMyAction: true,
    dueAt: null,
    ...overrides,
  }
}

const THREE = [
  makeDoc({ id: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'Warehouse lease extension' }),
  makeDoc({
    id: 'bbbbbbbb-0000-0000-0000-000000000002',
    title: 'Fleet insurance renewal',
    submittedBy: 'Bilal Ahmed',
    approvalType: 'APPROVER',
    updatedAt: daysAgo(9),
  }),
  makeDoc({
    id: 'cccccccc-0000-0000-0000-000000000003',
    title: 'Stationery order',
    approvalType: 'FINAL_APPROVER',
    updatedAt: daysAgo(0),
  }),
]

interface Options {
  documents?: DashboardDocument[]
  counts?: Record<QueueTab, number>
  tab?: QueueTab
  cursor?: number
  onTab?: Mock<(tab: QueueTab) => void>
  onCursor?: Mock<(index: number) => void>
}

function renderList({
  documents = THREE,
  counts,
  tab = 'all',
  cursor = 0,
  onTab = vi.fn<(tab: QueueTab) => void>(),
  onCursor = vi.fn<(index: number) => void>(),
}: Options = {}) {
  const rowRefs = { current: [] as (HTMLButtonElement | null)[] }
  const view = render(
    <QueueList
      documents={documents}
      counts={
        counts ?? { all: documents.length, overdue: 1, review: 1, approval: 2 }
      }
      tab={tab}
      onTab={onTab}
      cursor={cursor}
      onCursor={onCursor}
      rowRefs={rowRefs}
    />,
  )

  return { ...view, onTab, onCursor, rowRefs }
}

/** Rows are the only plain buttons here - the filters carry role="tab". */
const rows = () => queue().getAllByRole('button')
const row = (title: string) => queue().getByRole('button', { name: new RegExp(title) })

/**
 * The keys a legend entry offers for one action. `<kbd>` is the element that
 * means "press this", so it is what the keys are read out of - a legend that
 * lost the pairing between the key and the word beside it would still contain
 * every letter.
 */
function legendKeys(label: string): string[] {
  const entry = screen.getByText(label).parentElement
  if (!entry) throw new Error(`No legend entry around "${label}"`)
  return Array.from(entry.querySelectorAll('kbd'), key => key.textContent)
}

describe('what a row says before you open it', () => {
  it('names the document, the id people quote and who sent it', () => {
    renderList({ documents: [makeDoc()] })

    const first = row('Warehouse lease extension')

    // The short id is what somebody reads out on a call, and the submitter is
    // who they chase; a row that carried only a title would send them back to
    // the document to find either.
    expect(within(first).getByText(/3F2A9B1C/)).toBeInTheDocument()
    expect(within(first).getByText(/Ayesha Khan/)).toBeInTheDocument()
  })

  it('says how far through the chain the document already is', () => {
    renderList({ documents: [makeDoc({ currentStep: 2, totalSteps: 3 })] })

    // "Step 2 of 3" is the difference between being one of three signatures
    // and being the one that finishes the document.
    expect(within(row('Warehouse')).getByText('Step 2 of 3')).toBeInTheDocument()
  })

  it('says whether this step wants a review or an approval', () => {
    renderList({
      documents: [
        makeDoc({ title: 'A review', approvalType: 'REVIEWER' }),
        makeDoc({ id: 'b', title: 'An approval', approvalType: 'APPROVER' }),
        makeDoc({ id: 'c', title: 'A final approval', approvalType: 'FINAL_APPROVER' }),
      ],
    })

    // Reviewing and approving are different acts with different consequences
    // in the chain, and the badge is where somebody finds out which one this
    // row is asking them to perform.
    expect(within(row('A review')).getByText('Reviewer')).toBeInTheDocument()
    expect(within(row('An approval')).getByText('Approver')).toBeInTheDocument()
    expect(within(row('A final approval')).getByText('Approver')).toBeInTheDocument()
  })

  it('spells the wait out in text rather than leaving it to the colour of a dot', () => {
    renderList({
      documents: [
        makeDoc({ title: 'Fresh', updatedAt: daysAgo(0) }),
        makeDoc({ id: 'b', title: 'Ageing', updatedAt: daysAgo(4) }),
        makeDoc({ id: 'c', title: 'Overdue', updatedAt: daysAgo(9) }),
      ],
    })

    // The severity dot and the keycap tint are the same fact in colour, and
    // the dot is aria-hidden. The keycap's text is the only statement of the
    // age that survives for a reader, or for anyone who cannot separate the
    // three tints - so it is what has to be asserted.
    expect(within(row('Fresh')).getByText('now')).toBeInTheDocument()
    expect(within(row('Ageing')).getByText('4d')).toBeInTheDocument()
    expect(within(row('Overdue')).getByText('9d')).toBeInTheDocument()
  })

  it('keeps a long title whole instead of cutting it out of the name', () => {
    const title = `Amendment to the ${'very '.repeat(40)}long lease`
    renderList({ documents: [makeDoc({ title })] })

    // The two-line clamp is visual. If the title were truncated in the DOM,
    // a screen reader and the browser's own find-in-page would both lose the
    // half of the name that tells two amendments apart.
    expect(screen.getByRole('button', { name: new RegExp(title) })).toBeInTheDocument()
  })
})

describe('which row the cursor is on', () => {
  it('states the selected row rather than only tinting it', () => {
    renderList({ cursor: 1 })

    // The tint is invisible to a reader and to anybody who cannot separate
    // it from the hover state - and this is the row A, R and X will act on.
    expect(rows()[1]).toHaveAttribute('aria-current', 'true')
    expect(rows()[0]).not.toHaveAttribute('aria-current')
    expect(rows()[2]).not.toHaveAttribute('aria-current')
  })

  it('moves the mark when the cursor moves', () => {
    const rowRefs = { current: [] as (HTMLButtonElement | null)[] }
    const shared = {
      documents: THREE,
      counts: { all: 3, overdue: 1, review: 1, approval: 2 } as Record<QueueTab, number>,
      tab: 'all' as QueueTab,
      onTab: vi.fn(),
      onCursor: vi.fn(),
      rowRefs,
    }
    const { rerender } = render(<QueueList {...shared} cursor={0} />)
    expect(rows()[0]).toHaveAttribute('aria-current', 'true')

    rerender(<QueueList {...shared} cursor={2} />)

    // Changing this prop is the entire visible result of pressing J: the hook
    // owns no cursor and the page only re-renders with a new number. A mark
    // computed once on mount would leave the queue announcing the first row
    // while A, R and X acted on the third.
    expect(rows()[2]).toHaveAttribute('aria-current', 'true')
    expect(rows()[0]).not.toHaveAttribute('aria-current')
    expect(document.querySelectorAll('[aria-current]')).toHaveLength(1)
  })

  it('marks nothing when there is no cursor to show', () => {
    // Below the split-view breakpoint the page passes -1: a tap opens the
    // document instead of selecting it, so claiming a selection would be
    // claiming a state the screen does not have.
    renderList({ cursor: -1 })

    expect(document.querySelectorAll('[aria-current]')).toHaveLength(0)
  })

  it('hands back the row that was pressed, by position', async () => {
    const user = userEvent.setup({ delay: null })
    const { onCursor, onTab } = renderList()

    await user.click(row('Stationery order'))

    expect(onCursor).toHaveBeenCalledWith(2)
    expect(onCursor).toHaveBeenCalledTimes(1)
    // Selecting a row must not also change the cut of the queue being shown,
    // which would renumber every index under the cursor.
    expect(onTab).not.toHaveBeenCalled()
  })

  it('gives the scroller a handle on every row', () => {
    const { rowRefs } = renderList()

    // `scrollRowIntoView` reads these. Unwired, J and K would move the cursor
    // onto rows that stay below the fold - the selection would be real and
    // invisible at the same time.
    // Every handle, in the order the cursor counts in: the cursor is an index
    // into this array, so a ref stored under the wrong index scrolls to a
    // different document than the one the mark is on.
    expect(rowRefs.current).toEqual([
      row('Warehouse lease extension'),
      row('Fleet insurance renewal'),
      row('Stationery order'),
    ])
  })

  it('lets go of the rows a filter has taken away', () => {
    const rowRefs = { current: [] as (HTMLButtonElement | null)[] }
    const shared = {
      counts: { all: 3, overdue: 1, review: 1, approval: 2 } as Record<QueueTab, number>,
      tab: 'all' as QueueTab,
      onTab: vi.fn(),
      cursor: 0,
      onCursor: vi.fn(),
      rowRefs,
    }
    const { rerender } = render(<QueueList {...shared} documents={THREE} />)
    rerender(<QueueList {...shared} documents={[THREE[0]]} />)

    // Switching to a shorter tab drops two rows. If their handles survived,
    // `scrollRowIntoView` would be measuring buttons that are no longer in
    // the document and the column would scroll to a row nobody can see.
    expect(rowRefs.current[0]).toBe(row('Warehouse lease extension'))
    expect(rowRefs.current[1]).toBeNull()
    expect(rowRefs.current[2]).toBeNull()
  })
})

describe('the filter strip', () => {
  it('says what the strip of filters is for', () => {
    renderList()

    // Four unlabelled toggles above a list are announced as "group, All,
    // toggle button" with nothing to say what is being filtered. The group
    // name is the only place that fact exists for a reader.
    expect(
      screen.getByRole('group', { name: 'Queue filter' }),
    ).toBeInTheDocument()
  })

  it('explains what each filter means, since the labels are one word each', () => {
    renderList()

    // "Overdue" is a threshold, not a category, and nothing on screen says
    // which one. The hint is the only place it is written down.
    expect(filters().getByRole('button', { name: /Overdue/ })).toHaveAttribute(
      'title',
      'Waiting more than a week',
    )
    expect(filters().getByRole('button', { name: /Approval/ })).toHaveAttribute(
      'title',
      'Approver and final approver steps',
    )
  })

  it('shows every filter with its own count', () => {
    renderList({ counts: { all: 9, overdue: 2, review: 4, approval: 5 } })

    // The count is what makes a tab worth pressing; "Overdue" with no number
    // beside it is a question rather than an answer. Matched loosely because
    // the label and the number are separate inline spans, so the accessible
    // name comes back with no space between them.
    expect(filters().getByRole('button', { name: /^All\s*9$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Overdue\s*2$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Review\s*4$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Approval\s*5$/ })).toBeInTheDocument()
  })

  it('states which filter is on rather than only filling it in', () => {
    renderList({ tab: 'overdue' })

    expect(filters().getByRole('button', { name: /Overdue/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(filters().getByRole('button', { name: /^All/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('switches the filter when a tab is pressed', async () => {
    const user = userEvent.setup({ delay: null })
    const { onTab, onCursor } = renderList()

    await user.click(filters().getByRole('button', { name: /Review/ }))

    expect(onTab).toHaveBeenCalledWith('review')
    expect(onTab).toHaveBeenCalledTimes(1)
    // The page resets the cursor itself when the tab changes. A tab that also
    // reported a cursor would select whichever row happened to be at that
    // index in the *new* list - a document nobody chose.
    expect(onCursor).not.toHaveBeenCalled()
  })

  it('is operable the way its tab role promises', () => {
    // Marked as a known failure. These carry role="tab" inside a role
    // "tablist", which tells a screen-reader user "tab 2 of 4" and teaches
    // them to press the arrow keys - but there is no roving tabindex, no
    // arrow handling and no aria-controls here. Worse, the arrow keys are
    // already taken on this screen: pressing one while a filter has focus
    // moves the document cursor instead, silently, in the pane they cannot
    // see. Either implement the pattern or use plain buttons with
    // aria-pressed, which promises nothing it does not do.
    renderList({ tab: 'all' })

    const overdue = filters().getByRole('button', { name: /Overdue/ })
    const all = filters().getByRole('button', { name: /^All/ })

    // Toggles, so each one carries its own on/off state...
    expect(overdue).toHaveAttribute('aria-pressed', 'false')
    expect(all).toHaveAttribute('aria-pressed', 'true')

    // ...and every one of them stays reachable by Tab. The tab pattern would
    // have taken that away in exchange for arrow keys this screen cannot
    // give: the arrows already move the document cursor in the pane beside
    // this one.
    expect(overdue).not.toHaveAttribute('tabindex')
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })
})

describe('the count above the list', () => {
  it('counts one waiting document in the singular', () => {
    renderList({
      documents: [makeDoc()],
      counts: { all: 1, overdue: 0, review: 1, approval: 0 },
    })

    // "1 items" is the detail that makes a screen look unfinished on exactly
    // the day somebody has almost nothing left to do.
    expect(screen.getByText('1 item')).toBeInTheDocument()
  })

  it('counts several in the plural', () => {
    renderList({ counts: { all: 9, overdue: 2, review: 4, approval: 5 } })

    expect(screen.getByText('9 items')).toBeInTheDocument()
  })

  it('counts the whole queue, not the rows a filter left on screen', () => {
    // Reported as a defect: on Overdue the header says "9 items" above one
    // visible row. The per-tab number is on the pill, so the header is the
    // whole-queue total - but nothing on screen says so.
    renderList({
      documents: [THREE[1]],
      counts: { all: 9, overdue: 1, review: 4, approval: 5 },
      tab: 'overdue',
    })

    expect(screen.getByText('9 items')).toBeInTheDocument()
    expect(rows()).toHaveLength(1)
  })
})

describe('an empty column', () => {
  it('shows no rows, an honest zero, and the filters that get you back', () => {
    // The "You're all caught up" message belongs to the page above this one:
    // `MyQueuePage` renders an EmptyState instead of the list, so this
    // component is never the whole of an empty screen. What it owes here is
    // not to claim rows or counts it does not have.
    renderList({
      documents: [],
      counts: { all: 0, overdue: 0, review: 0, approval: 0 },
      tab: 'overdue',
    })

    // Scoped to the list: the filter chips are buttons too, and are still
    // on screen precisely so somebody can get back from an empty view.
    expect(queue().queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByText('0 items')).toBeInTheDocument()
    expect(filters().getByRole('button', { name: /^All\s*0$/ })).toBeInTheDocument()
  })

  it('survives a document with no workflow behind it', () => {
    // `mapApiDocumentToDashboard` reports 0 of 0 for a document whose
    // workflow row is missing rather than throwing, and the row has to be
    // readable when it does.
    renderList({
      documents: [makeDoc({ currentStep: 0, totalSteps: 0, approvalType: null })],
      counts: { all: 1, overdue: 0, review: 0, approval: 0 },
    })

    expect(within(row('Warehouse')).getByText('Step 0 of 0')).toBeInTheDocument()
    // No approvalType is not REVIEWER, so the row must not claim it is one.
    expect(within(row('Warehouse')).getByText('Approver')).toBeInTheDocument()
  })
})

describe('the shortcut legend', () => {
  it('puts each key beside the thing that key does', () => {
    renderList({ documents: [] })

    // Listing the five letters somewhere on screen is not the promise this
    // strip makes - the pairing is. A legend that read "A reject / X approve"
    // would contain every key and every word and be worse than none at all:
    // X is irreversible and A is the one people press without reading.
    expect(legendKeys('move')).toEqual(['J', 'K'])
    expect(legendKeys('approve')).toEqual(['A'])
    expect(legendKeys('revision')).toEqual(['R'])
    expect(legendKeys('reject')).toEqual(['X'])
  })

  it('does not offer a key the queue does not answer', () => {
    renderList({ documents: [] })

    // The hook binds J, K, A, R, X and Enter and nothing else. A legend entry
    // for a key that does nothing teaches a shortcut that silently fails.
    const advertised = Array.from(
      document.querySelectorAll('kbd'),
      key => key.textContent,
    )
    expect(advertised.sort()).toEqual(['A', 'J', 'K', 'R', 'X'])
  })
})
