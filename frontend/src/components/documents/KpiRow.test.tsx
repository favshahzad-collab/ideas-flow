import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { DocumentKpis } from '../../utils/documentInsights'
import type { DocumentStatusFilter } from '../../utils/documentFilters'
import KpiRow from './KpiRow'

/**
 * The five figures across the top of the documents screen. They are the first
 * thing read and the least examined, which is why the interesting cases here
 * are the empty ones: a count of nothing has to read as nothing, and a median
 * that cannot be computed must not read as "same day".
 *
 * The second interesting case is the PAIRING. Five labels and five numbers in
 * one row is exactly the shape that survives a swap unnoticed - "12" is still
 * on screen, just under the wrong word - so every value here is asserted
 * inside the tile that names it, never merely somewhere on the row.
 *
 * `computeDocumentKpis` is tested in documentInsights.test.ts. This is about
 * how the row states the numbers it is handed, and which of them can filter.
 */

function kpis(overrides: Partial<DocumentKpis> = {}): DocumentKpis {
  return {
    inFlight: 7,
    awaitingYou: 2,
    waitingOverWeek: 1,
    medianCycleDays: 4.5,
    approvedThisMonth: 12,
    ...overrides,
  }
}

function renderRow(
  overrides: Partial<DocumentKpis> = {},
  activeFilter: DocumentStatusFilter = 'all',
) {
  const onFilter = vi.fn()
  return {
    ...render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route
            path="/dashboard"
            element={
              <KpiRow kpis={kpis(overrides)} activeFilter={activeFilter} onFilter={onFilter} />
            }
          />
          <Route path="/pending-approvals" element={<p>My queue screen</p>} />
        </Routes>
      </MemoryRouter>,
    ),
    onFilter,
  }
}

const LABELS = [
  'In progress',
  'Awaiting you',
  'Waiting 7+ days',
  'Typical time to approve',
  'Approved this month',
] as const

/**
 * The tile carrying a given label. Found through the hint every tile hovers,
 * which is the nearest thing the markup has to an identity - and unlike a
 * class name it is content the product committed to, so a restyle does not
 * move it.
 */
function tile(label: string): HTMLElement {
  const found = screen.getByText(label).closest('[title]')
  if (!found) throw new Error(`No tile with a hint found around "${label}"`)
  return found as HTMLElement
}

describe('what the row states', () => {
  it('labels every figure with what it counts', () => {
    renderRow()

    for (const label of LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('puts each figure inside the tile that names it', () => {
    renderRow()

    // Five distinct numbers, one per tile. `getByText('7')` anywhere on the
    // row would pass just as happily with In flight and Approved this month
    // reading each other's counts.
    const expected: [string, string][] = [
      ['In progress', '7'],
      ['Awaiting you', '2'],
      ['Waiting 7+ days', '1'],
      ['Typical time to approve', '4.5d'],
      ['Approved this month', '12'],
    ]

    for (const [label, value] of expected) {
      expect(within(tile(label)).getByText(value)).toBeInTheDocument()
    }

    // ...and the swap, stated directly.
    expect(within(tile('Approved this month')).queryByText('7')).not.toBeInTheDocument()
    expect(within(tile('In progress')).queryByText('12')).not.toBeInTheDocument()
  })

  it('renders a count of nothing as 0 rather than dropping the tile', () => {
    renderRow({ inFlight: 0, awaitingYou: 0, waitingOverWeek: 0, approvedThisMonth: 0 })

    // "Nothing is waiting on you" is a fact worth stating. A tile that
    // vanished at zero would leave the reader unable to tell "none" from
    // "not loaded".
    for (const label of ['In progress', 'Awaiting you', 'Waiting 7+ days', 'Approved this month']) {
      expect(within(tile(label)).getByText('0')).toBeInTheDocument()
    }
    // The one figure that is not a count keeps its own value.
    expect(within(tile('Typical time to approve')).getByText('4.5d')).toBeInTheDocument()
  })

  it('says the median is unknown instead of reporting zero days', () => {
    renderRow({
      medianCycleDays: null,
      inFlight: 0,
      awaitingYou: 0,
      waitingOverWeek: 0,
      approvedThisMonth: 0,
    })

    // Nothing has been approved yet, so there is no cycle time. Printing 0d
    // would claim every document is approved the day it is submitted -
    // exactly the number somebody would quote in a report.
    //
    // The other four figures are deliberately zero as well, and the queries
    // are scoped to this tile: a row-wide `queryByText('0')` is answered by
    // whichever tile happens to be nearby and says nothing about this one.
    const cycle = tile('Typical time to approve')
    expect(within(cycle).getByText('—')).toBeInTheDocument()
    expect(within(cycle).queryByText('0d')).not.toBeInTheDocument()
    expect(within(cycle).queryByText('0')).not.toBeInTheDocument()
  })

  it('states a same-day median as 0d rather than as no data', () => {
    renderRow({ medianCycleDays: 0 })

    // Zero is a real, and good, median: everything approved the day it
    // arrived. It is a different fact from "nothing has been approved yet",
    // and a falsy check standing in for the null check merges the two -
    // reporting a team at its fastest as having nothing to report.
    expect(within(tile('Typical time to approve')).getByText('0d')).toBeInTheDocument()
    expect(within(tile('Typical time to approve')).queryByText('—')).not.toBeInTheDocument()
  })

  it('spells out what a figure means for people who cannot hover a tooltip', () => {
    renderRow()

    // `title` never reaches a keyboard or touch user, so each hint is
    // duplicated into an sr-only span - which means it has to land in the
    // tile's own accessible name, not merely somewhere in the document.
    expect(screen.getByRole('button', { name: /In progress/ })).toHaveAccessibleName(
      /Submitted and not yet approved, rejected or withdrawn/,
    )
    expect(tile('In progress')).toHaveAttribute(
      'title',
      'Submitted and not yet approved, rejected or withdrawn',
    )
  })

  it('spells it out on the tiles that are not buttons too', () => {
    renderRow()

    // The sr-only sentence is the only place "Awaiting you" is defined as
    // "your review or approval" rather than left to be guessed at, and on the
    // plain tiles it is all a screen reader will ever get.
    expect(
      within(tile('Awaiting you')).getByText(/Waiting on your review or approval/),
    ).toBeInTheDocument()
    expect(
      within(tile('Typical time to approve')).getByText(/Median time from submission to approval/),
    ).toBeInTheDocument()
  })

  it('describes the seven-day figure as age, not as a breached deadline', () => {
    renderRow()

    // There is no due date anywhere in the schema. Calling this an SLA
    // breach would invent a commitment nobody made - and it is the tile
    // people escalate on.
    const waiting = tile('Waiting 7+ days')
    expect(waiting).toHaveTextContent(/Age, not a missed deadline/)
    expect(waiting).toHaveTextContent(/no SLA is configured/)

    // The disclaimer is only worth having if the wording it disclaims is
    // genuinely absent from the row.
    expect(screen.queryByText(/breach/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/overdue/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/past due/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/late/i)).not.toBeInTheDocument()
  })
})

describe('filtering from a tile', () => {
  it.each([
    ['In progress', 'pending'],
    ['Approved this month', 'approved'],
  ] as const)('presses %s through as the %s filter', async (label, expected) => {
    const user = userEvent.setup({ delay: null })
    const { onFilter } = renderRow()

    await user.click(screen.getByRole('button', { name: new RegExp(label) }))

    // Both tiles filter, and they do not filter the same thing. Testing only
    // one of them leaves a row where every press narrows the list to
    // "pending" whatever it says on the tile.
    expect(onFilter).toHaveBeenCalledTimes(1)
    expect(onFilter).toHaveBeenCalledWith(expected)
  })

  it.each([
    ['In progress', 'pending'],
    ['Approved this month', 'approved'],
  ] as const)('clears the filter when the pressed %s tile is already filtering', async (
    label,
    active,
  ) => {
    const user = userEvent.setup({ delay: null })
    const { onFilter } = renderRow({}, active)

    await user.click(screen.getByRole('button', { name: new RegExp(label) }))

    // A toggle that cannot untoggle strands a person in a filtered view with
    // no obvious way back to everything.
    expect(onFilter).toHaveBeenCalledTimes(1)
    expect(onFilter).toHaveBeenCalledWith('all')
  })

  it('reports which tile is currently filtering the list, and only that one', () => {
    renderRow({}, 'approved')

    // aria-pressed is the only signal a screen reader gets; the ring around
    // the active tile is invisible to it. Two rings is a row that cannot say
    // what the list below is showing.
    const pressed = screen
      .getAllByRole('button')
      .filter(button => button.getAttribute('aria-pressed') === 'true')

    expect(pressed).toHaveLength(1)
    expect(pressed[0]).toHaveAccessibleName(/Approved this month/)
  })

  it('is reachable and operable from the keyboard', async () => {
    const user = userEvent.setup({ delay: null })
    const { onFilter } = renderRow()

    await user.tab()

    // In the order they are drawn: the two that filter and the one that goes
    // to My queue. The two plain figures are not in the tab order.
    expect(screen.getByRole('button', { name: /In progress/ })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onFilter).toHaveBeenCalledWith('pending')

    await user.tab()
    expect(screen.getByRole('link', { name: /Awaiting you/ })).toHaveFocus()

    await user.tab()
    expect(screen.getByRole('button', { name: /Approved this month/ })).toHaveFocus()

    // And nothing beyond: Tab off the last tile leaves the row entirely
    // rather than landing on an inert figure.
    await user.tab()
    expect(document.body).toHaveFocus()
  })

  it('offers no press on a figure that maps to no filter and no screen', () => {
    renderRow()

    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /Typical time to approve/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Waiting 7\+ days/ })).not.toBeInTheDocument()
    // Inert, but still stated - the figure does not disappear with the press.
    expect(within(tile('Typical time to approve')).getByText('4.5d')).toBeInTheDocument()
  })

  it('takes "Awaiting you" to My queue, where that work is signed', async () => {
    // It used to show the count and go nowhere. There is no filter on this
    // list for it: the list is documents, and My queue is the to-do list.
    const user = userEvent.setup({ delay: null })
    const { onFilter } = renderRow()

    const link = screen.getByRole('link', { name: /Awaiting you/ })
    expect(link).toHaveAttribute('href', '/pending-approvals')
    expect(within(link).getByText('2')).toBeInTheDocument()

    await user.click(link)

    expect(await screen.findByText('My queue screen')).toBeInTheDocument()
    expect(onFilter).not.toHaveBeenCalled()
  })

  it('leaves every tile unpressed when the applied filter is one no tile offers', () => {
    renderRow({}, 'revision_requested')

    // The chip row below still shows "Revision" as active, so the screen is
    // not lying - but neither KPI tile claims the list is unfiltered either.
    for (const name of [/In progress/, /Approved this month/]) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false')
    }
  })

  it('does not mark "In progress" as active merely because nothing is filtered', () => {
    renderRow({}, 'all')

    // `activeFilter` is 'all' by default and 'all' is a real filter value. A
    // comparison that treated a missing filter as a match would light up
    // every tile on first load and offer to "clear" a filter nobody applied.
    for (const name of [/In progress/, /Approved this month/]) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false')
    }
  })
})

describe('the pulse on a figure', () => {
  const dot = (label: string) => screen.getByText(label).previousElementSibling as HTMLElement

  it('rings out from a figure that has something in it', () => {
    renderRow({ inFlight: 7 })
    expect(dot('In progress')).toHaveClass('figure-pulse')
  })

  it('leaves a zero still, with nothing to draw the eye to', () => {
    renderRow({ waitingOverWeek: 0 })
    expect(dot('Waiting 7+ days')).not.toHaveClass('figure-pulse')
  })
})
