import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { DashboardDocument } from '../../types/document'
import DocumentCards from './DocumentCards'

/**
 * The same rows below the table breakpoint. This is the whole documents
 * screen on a phone, so anything the card leaves out is simply not available
 * to that person - there is no wider layout to fall back to.
 *
 * What is asserted here is that a card still answers "which document, what
 * state, who has it, how long" in one accessible name, that it opens the
 * document it names rather than the first one on the page, and that the card
 * is a real control rather than a tappable box.
 */

const DAY = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString()

function doc(overrides: Partial<DashboardDocument> = {}): DashboardDocument {
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
    totalSteps: 4,
    lastUpdated: '3 days',
    submittedDate: 'Sep 1, 2026',
    submittedAt: daysAgo(6),
    updatedAt: daysAgo(3),
    versionNumber: 2,
    approvalType: 'REVIEWER',
    actionLabel: 'Review',
    nextHolder: 'Chandni Rao',
    fileType: 'pdf',
    isAwaitingMyAction: false,
    dueAt: null,
    ...overrides,
  }
}

function renderCards(documents: DashboardDocument[] = [doc()]) {
  const onOpen = vi.fn()
  return { ...render(<DocumentCards documents={documents} onOpen={onOpen} />), onOpen }
}

/** Two documents, so "the right one" is a claim with something to fail on. */
const two = [
  doc({ id: 'aaa', title: 'Warehouse lease extension', currentHolder: 'Bilal Ahmed' }),
  doc({ id: 'bbb', title: 'Fleet insurance renewal', currentHolder: 'Dania Sheikh' }),
]

describe('DocumentCards', () => {
  it('is a list, so a screen reader can say how many documents are on the page', () => {
    renderCards([doc({ id: 'a' }), doc({ id: 'b' }), doc({ id: 'c' })])

    // "List, 3 items" is the mobile substitute for the row count under the
    // table; a stack of divs announces nothing at all.
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(3)
  })

  it('keeps the order it was handed, because that order is the sort', () => {
    renderCards([
      doc({ id: 'a', title: 'Warehouse lease extension' }),
      doc({ id: 'b', title: 'Fleet insurance renewal' }),
      doc({ id: 'c', title: 'Stationery order' }),
    ])

    // Newest-first is chosen on the toolbar above and applied by the caller.
    // A card list that grouped, sorted or de-duplicated on its own would
    // silently ignore that toggle on exactly the screen where the toggle is
    // hardest to find.
    expect(
      screen.getAllByRole('listitem').map(item => within(item).getByRole('button').textContent),
    ).toEqual([
      expect.stringContaining('Warehouse lease extension'),
      expect.stringContaining('Fleet insurance renewal'),
      expect.stringContaining('Stationery order'),
    ])
  })

  it('makes each card one real button, not a tappable box', async () => {
    const user = userEvent.setup({ delay: null })
    const { onOpen } = renderCards()

    const card = screen.getByRole('button', { name: /Warehouse lease extension/ })
    await user.click(card)

    // A <div onClick> here would be invisible to a switch or keyboard user,
    // and on a phone that is the entire screen.
    expect(onOpen).toHaveBeenCalledWith('3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c')
  })

  it('opens the document its own card names, not the first one', async () => {
    const user = userEvent.setup({ delay: null })
    const { onOpen } = renderCards(two)

    await user.click(screen.getByRole('button', { name: /Fleet insurance renewal/ }))

    expect(onOpen).toHaveBeenCalledWith('bbb')
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it.each(['{Enter}', ' '])('activates the focused card with %s', async key => {
    const user = userEvent.setup({ delay: null })
    const { onOpen } = renderCards(two)

    const second = screen.getByRole('button', { name: /Fleet insurance renewal/ })
    second.focus()
    expect(second).toHaveFocus()
    await user.keyboard(key)

    // Not just "something was called": the key has to open the card that had
    // focus. Both keys matter - Space is what a native button answers to and
    // what a `role="button"` div silently ignores.
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('bbb')
  })

  it('says who holds it, what state it is in and how long it has been there', () => {
    renderCards([doc({ status: 'pending_approval', updatedAt: daysAgo(3) })])
    const card = screen.getByRole('button', { name: /Warehouse lease extension/ })

    // All three facts have to be inside the button's own name: on a phone
    // there is no hover, no row menu and no second column to look across to.
    expect(card).toHaveAccessibleName(/Bilal Ahmed/)
    expect(card).toHaveAccessibleName(/Approval/)
    expect(card).toHaveAccessibleName(/Waiting 3 days/)
    // The submitter is not the holder. Printing "Ayesha Khan" here would
    // name the person who is waiting as the person being waited on.
    expect(card).not.toHaveTextContent('Ayesha Khan')
  })

  it.each([
    ['draft', 'Draft'],
    ['pending_review', 'Review'],
    ['pending_approval', 'Approval'],
    ['revision_requested', 'Revision'],
    ['rejected', 'Rejected'],
    ['approved', 'Approved'],
    ['deleted', 'Withdrawn'],
  ] as const)('states a %s document as "%s"', (status, label) => {
    renderCards([doc({ status })])

    // The badge is the only state signal on the card, and its colour alone
    // cannot carry it. A hard-coded label would pass any single-status test.
    expect(screen.getByRole('button', { name: /Warehouse lease extension/ })).toHaveAccessibleName(
      new RegExp(label),
    )
  })

  it('states the workflow position as text beside the pips', () => {
    renderCards([doc({ currentStep: 3, totalSteps: 5 })])

    // The pips themselves are aria-hidden decoration; "3/5" is the value.
    const card = screen.getByRole('button', { name: /Warehouse lease extension/ })
    expect(card).toHaveTextContent(/Step\s*3/)
    expect(card).toHaveTextContent(/of\s*5/)
  })

  it('drops the avatar when the holder is a state rather than a person', () => {
    renderCards([
      doc({ status: 'approved', currentHolder: 'Completed', currentHolderInitials: null }),
    ])

    // `currentHolderInitials` is null exactly here. Deriving initials anyway
    // would put a "CO" disc beside the word "Completed" as though a person
    // named Completed were holding the document. The word itself is left to
    // the status badge rather than said twice, and never as "With Completed".
    expect(screen.queryByText(/Completed/)).not.toBeInTheDocument()
    expect(screen.queryByText(/With /)).not.toBeInTheDocument()
    expect(screen.queryByText('CO')).not.toBeInTheDocument()
    // Avatar falls back to "?" when it is handed nothing, so ruling out "CO"
    // alone would miss the disc being rendered anyway - which is the shape
    // the bug would actually take.
    expect(screen.queryByText('?')).not.toBeInTheDocument()
  })

  it('shows the holder initials beside the name rather than instead of it', () => {
    renderCards()
    const card = screen.getByRole('button', { name: /Warehouse lease extension/ })

    expect(within(card).getByText('BA')).toBeInTheDocument()
    // The disc is decoration: the name it abbreviates is right beside it.
    // Left announced, every card in the list opens with two capital letters
    // read out one at a time in front of the word they stand for.
    expect(within(card).getByText('BA')).toHaveAttribute('aria-hidden', 'true')
    expect(card).toHaveAccessibleName(/Bilal Ahmed/)
    expect(card).not.toHaveAccessibleName(/BA/)
  })

  it('tells two documents with the same title apart', () => {
    renderCards([
      doc({ id: 'aaaaaaaa-1111-4000-8000-000000000001', versionNumber: 2 }),
      doc({ id: 'bbbbbbbb-2222-4000-8000-000000000002', versionNumber: 3 }),
    ])

    // One contract, two amendments in flight - the ordinary case for the
    // thing this screen is for. The title string is identical on both cards,
    // so the short id and the version are the whole of what says which one is
    // about to be opened, and on a phone there is no second column to check
    // it against.
    const [first, second] = screen.getAllByRole('button')
    expect(first).toHaveAccessibleName(/#AAAAAAAA . v2/)
    expect(second).toHaveAccessibleName(/#BBBBBBBB . v3/)
    expect(first).not.toHaveAccessibleName(/BBBBBBBB/)
    expect(second).not.toHaveAccessibleName(/AAAAAAAA/)
  })

  it('still says how long a finished document has been in that state', () => {
    renderCards([
      doc({
        status: 'approved',
        currentHolder: 'Completed',
        currentHolderInitials: null,
        updatedAt: daysAgo(12),
      }),
    ])

    // Deliberately unlike the table, which blanks the age on a finished
    // document because the bar beside it reads as a deadline still running.
    // The card has no bar, so "12 days in state" is plain fact: approved
    // twelve days ago. Copying the table's rule across would delete it.
    expect(screen.getByRole('button', { name: /Warehouse lease/ })).toHaveTextContent(
      'Updated 12 days ago',
    )
  })

  it('keeps a very long title readable to assistive tech even though it is clipped', () => {
    const longTitle =
      'Amendment number four to the master services agreement between the northern regional warehouse operations division and the freight consolidation partner'
    renderCards([doc({ title: longTitle })])

    // `truncate` is a CSS effect only; the string in the accessible name has
    // to stay whole or the card cannot be identified by voice control.
    expect(screen.getByRole('button', { name: new RegExp(longTitle) })).toBeInTheDocument()
  })

  it('renders nothing at all for an empty page', () => {
    renderCards([])

    // The screen's empty state is the caller's job (DocumentPage renders an
    // EmptyState instead of this list). What matters here is that the
    // component does not invent a phantom card for zero documents.
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('states a one-step workflow as step 1 of 1 rather than a lone pip', () => {
    renderCards([doc({ currentStep: 1, totalSteps: 1, versionNumber: 1 })])

    const card = screen.getByRole('button', { name: /Warehouse lease extension/ })
    expect(card).toHaveTextContent('#3F2A9B1C · v1')
    expect(card).toHaveTextContent(/Step\s*1/)
    expect(card).toHaveTextContent(/of\s*1/)
  })
})

describe('what a card calls things', () => {
  it('shows the memo reference people quote, not the internal id', () => {
    renderCards([doc({ referenceNumber: 'MEMO-2026-0042' })])
    expect(screen.getByText(/MEMO-2026-0042/)).toBeInTheDocument()
    expect(screen.queryByText(/#3F2A9B1C/)).not.toBeInTheDocument()
  })

  it('falls back to the short id for a memo from before references', () => {
    renderCards([doc({ referenceNumber: null })])
    expect(screen.getByText(/#3F2A9B1C/)).toBeInTheDocument()
  })

  it('says who it is from and who has it now, so two names are never ambiguous', () => {
    render(<DocumentCards documents={[doc()]} onOpen={vi.fn()} showPreparer />)
    expect(screen.getByText('From Ayesha Khan')).toBeInTheDocument()
    expect(screen.getByText('With Bilal Ahmed')).toBeInTheDocument()
  })

  it('says a memo sent back is back with its preparer', () => {
    renderCards([
      doc({ status: 'revision_requested', currentHolder: 'Ayesha Khan', currentHolderInitials: 'AK' }),
    ])
    expect(screen.getByText('Back with Ayesha Khan')).toBeInTheDocument()
  })
})
