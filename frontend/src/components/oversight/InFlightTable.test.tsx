import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '../../test/render'
import type { OversightItem } from '../../types/document'
import InFlightTable from './InFlightTable'

/**
 * The board an administrator scans to find out where the organisation's work
 * has stopped. Every row answers one question - who is this sitting with, and
 * for how long - and both answers are the basis of somebody being chased. A
 * row that names the preparer where the holder should be, or that leaves the
 * holder cell blank when nobody has been assigned, sends the chase to the
 * wrong desk.
 *
 * Ages are asserted against the `asOf` the table is handed rather than the
 * wall clock, because that is the contract: one instant for the whole page,
 * so two rows an hour apart never disagree about what "3 days" means.
 */

const DAY = 86_400_000
const AS_OF = new Date('2026-01-10T12:00:00Z').getTime()
const ago = (ms: number) => new Date(AS_OF - ms).toISOString()

let seq = 0

function item(overrides: Partial<OversightItem> = {}): OversightItem {
  seq += 1
  return {
    id: `d1abcdef-0000-4000-8000-00000000000${seq}`,
    title: `Warehouse lease extension ${seq}`,
    versionNumber: 3,
    submittedAt: ago(10 * DAY),
    updatedAt: ago(2 * DAY),
    heldSince: ago(2 * DAY),
    preparer: { id: 'p1', firstName: 'Tom', lastName: 'Becker', department: 'Legal' },
    holder: {
      id: 'u1',
      firstName: 'Priya',
      lastName: 'Nair',
      department: 'Procurement',
      approvalType: 'APPROVER',
    },
    currentStepOrder: 2,
    totalSteps: 4,
    ...overrides,
  } as OversightItem
}

function renderTable(items: OversightItem[]) {
  return renderWithProviders(<InFlightTable items={items} asOf={AS_OF} />)
}

/** The one data row, when a test renders a single item. */
function onlyRow(): HTMLElement {
  const [, row] = screen.getAllByRole('row')
  return row
}

describe('who is holding the document', () => {
  it('names the holder and the department they sit in', () => {
    renderTable([item()])

    expect(within(onlyRow()).getByText('Priya Nair')).toBeInTheDocument()
    expect(within(onlyRow()).getByText('Procurement')).toBeInTheDocument()
  })

  it('keeps the holder and the preparer in their own columns', () => {
    renderTable([item()])
    const cells = within(onlyRow()).getAllByRole('cell')

    // The two names are the only people on the row and they mean opposite
    // things: one is waiting to act, the other is waiting to hear back.
    // Swapping the columns would send every chase to the person who has
    // already done their part.
    expect(cells[1]).toHaveTextContent('Priya Nair')
    expect(cells[4]).toHaveTextContent('Tom Becker')
    expect(cells[1]).not.toHaveTextContent('Tom Becker')
  })

  it('says "Unassigned" rather than leaving the holder cell empty', () => {
    renderTable([item({ holder: null })])

    // An empty cell reads as "nothing to do here". An unassigned workflow is
    // the opposite: it will sit there until somebody notices, and this row is
    // the only place anybody would notice.
    const holderCell = within(onlyRow()).getAllByRole('cell')[1]
    expect(within(holderCell).getByText('Unassigned')).toBeInTheDocument()

    // And nothing else: an initials disc with no name under it, or a stray
    // "No department" line, would dress the empty holder up as a person.
    expect(holderCell.textContent?.trim()).toBe('Unassigned')
  })

  it('says "No department" rather than leaving a gap under a holder', () => {
    renderTable([
      item({
        holder: {
          id: 'u2',
          firstName: 'Sana',
          lastName: 'Iqbal',
          department: null,
          approvalType: 'REVIEWER',
        } as OversightItem['holder'],
      }),
    ])

    expect(within(onlyRow()).getByText('No department')).toBeInTheDocument()
  })

  it('does not read the initials disc out loud beside the name it abbreviates', () => {
    renderTable([item()])

    // "P N Priya Nair" is what an unhidden avatar sounds like on every row.
    expect(screen.getByText('PN')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('how long it has been waiting', () => {
  it('spells the wait out in words, so the pill colour is never the only signal', () => {
    renderTable([item({ heldSince: ago(2 * DAY) })])

    expect(within(onlyRow()).getByText('Waiting 2 days')).toBeInTheDocument()
  })

  it('calls a wait past a week overdue, and one under it waiting', () => {
    renderTable([
      item({ id: 'aaaaaaaa-fresh', heldSince: ago(6 * DAY) }),
      item({ id: 'bbbbbbbb-stale', heldSince: ago(8 * DAY) }),
    ])

    // Seven days is where the tint changes from amber to red. If the word did
    // not change with it, the distinction would exist only in the colour -
    // and this is the column the whole screen is sorted by.
    expect(screen.getByText('Waiting 6 days')).toBeInTheDocument()
    expect(screen.getByText('Overdue 8 days')).toBeInTheDocument()
    // Not "Overdue 6 days" on a row the same colour as the calm ones.
    expect(screen.queryByText('Overdue 6 days')).not.toBeInTheDocument()
    expect(screen.queryByText('Waiting 8 days')).not.toBeInTheDocument()
  })

  it('still says overdue once a wait is old enough to be counted in weeks', () => {
    renderTable([item({ heldSince: ago(45 * DAY) })])

    // Past thirty days the severity tips from `overdue` to `critical`, which
    // is a second tint and a second entry in the prefix map. A month-and-a-
    // half-old document that came back reading "Waiting 6 weeks" would be the
    // worst row on the board wearing the calmest word on it.
    expect(within(onlyRow()).getByText('Overdue 6 weeks')).toBeInTheDocument()
  })

  it('measures from the instant it was handed, not from the wall clock', () => {
    renderTable([item({ heldSince: ago(3 * DAY) })])

    // `asOf` is January; the machine running this is not. A component that
    // reached for `Date.now()` itself would report months here, and two
    // panels on the same page would quote different ages for one document.
    expect(screen.getByText('Waiting 3 days')).toBeInTheDocument()
  })

  it('does not read the severity dot, which repeats the pill beside it', () => {
    renderTable([item()])

    // Asking for `span[aria-hidden="true"]` and then asserting it exists
    // proves nothing twice over: the selector supplies the answer, and the
    // initials disc would satisfy it even with the dot fully exposed. So ask
    // it the other way round - every node on the row that carries no text is
    // decoration, and a screen reader must be told about none of them.
    const wordless = [...onlyRow().querySelectorAll('span')].filter(
      node => (node.textContent ?? '').trim() === '',
    )
    expect(wordless).toHaveLength(1)
    expect(wordless[0].closest('[aria-hidden="true"]')).not.toBeNull()
  })
})

describe('opening a document from the board', () => {
  it('gives every open control a name that says which document it opens', () => {
    renderTable([
      item({ title: 'Warehouse lease extension' }),
      item({ title: 'Fleet insurance renewal' }),
    ])

    // Two rows, two identical arrow glyphs. Without the title in the name,
    // a screen reader hears "link, link" and the list of links on the page
    // is useless for getting to a specific document.
    expect(
      screen.getByRole('link', { name: 'Open Warehouse lease extension' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Open Fleet insurance renewal' }),
    ).toBeInTheDocument()
  })

  it('sends the title and the arrow to the same document', () => {
    renderTable([item({ id: 'd1abcdef-0000-4000-8000-000000000009', title: 'Fleet insurance' })])

    const href = '/documents/d1abcdef-0000-4000-8000-000000000009'
    expect(screen.getByRole('link', { name: 'Fleet insurance' })).toHaveAttribute('href', href)
    expect(screen.getByRole('link', { name: 'Open Fleet insurance' })).toHaveAttribute(
      'href',
      href,
    )
  })

  it('shows the short id and version somebody would quote back', () => {
    renderTable([item({ versionNumber: 7 })])

    expect(within(onlyRow()).getByText(/#D1ABCDEF/)).toHaveTextContent('v7')
  })

  it('shows which step of how many the document has reached', () => {
    renderTable([item({ currentStepOrder: 2, totalSteps: 4 })])

    // "2/4" and "4/4" are the difference between a document that has barely
    // started and one that is a signature away from done.
    expect(within(onlyRow()).getByText('2/4')).toBeInTheDocument()
  })
})

describe('what a screen reader is told about the table', () => {
  it('says what the table lists and the order it is in', () => {
    renderTable([item()])

    // Through the table's accessible name rather than as text somewhere on
    // the page: a caption that has come loose from its table - moved into a
    // div above it, say - still passes `getByText` while announcing nothing.
    expect(
      screen.getByRole('table', {
        name: 'Memos in flight across the organisation, longest waiting first',
      }),
    ).toBeInTheDocument()
  })

  it('names the actions column instead of leaving an empty header', () => {
    renderTable([item()])

    expect(screen.getByRole('columnheader', { name: 'Open' })).toBeInTheDocument()
  })

  it('names every other column', () => {
    renderTable([item()])

    for (const name of ['Document', 'Holder', 'Step', 'Waiting', 'Submitted by']) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument()
    }
  })
})

describe('edge input', () => {
  it('renders the header and no rows when handed nothing', () => {
    renderTable([])

    // The Control room shows its own "Nothing in flight" panel instead of an
    // empty table, so the table itself only has to survive the case - but it
    // must not invent a row or throw on the way.
    expect(screen.getAllByRole('row')).toHaveLength(1)
  })

  it('keeps a very long title reachable by its full name', () => {
    const title = `Annual procurement framework agreement ${'and its schedules '.repeat(12)}2026`
    renderTable([item({ title })])

    // The cell truncates with CSS. The accessible name and the hover title
    // still carry the whole string, so the row can be identified.
    expect(screen.getByRole('link', { name: `Open ${title}` })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: title })).toHaveAttribute('title', title)
  })

  it('renders one row per item without collapsing repeats of a holder', () => {
    const items = [item(), item(), item()]
    renderTable(items)

    // Three documents held by the same person are three separate chases. A
    // row count alone would still pass if two of them rendered the same
    // document twice, so the titles are checked as well as the tally.
    expect(screen.getAllByRole('row')).toHaveLength(4)
    for (const entry of items) {
      expect(screen.getByRole('link', { name: `Open ${entry.title}` })).toBeInTheDocument()
    }
  })
})
