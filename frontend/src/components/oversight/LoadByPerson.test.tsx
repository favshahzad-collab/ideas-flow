import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApproverLoad } from '../../utils/oversight'
import LoadByPerson from './LoadByPerson'

/**
 * The panel that answers "who is the bottleneck right now". A manager reads
 * it and moves work off somebody, so the count beside a name has to be the
 * count - not a bar whose length is the only statement of it, and not a row
 * that quietly disappears when the number is inconvenient.
 *
 * `computeApproverLoad` is tested in oversight.test.ts. This is about what
 * the panel says out loud, and what it says when there is nothing to say.
 */

const features = vi.hoisted(() => ({ sla: false }))
vi.mock('../../config/features', () => ({ FEATURES: features }))

function row(overrides: Partial<ApproverLoad> = {}): ApproverLoad {
  return {
    id: 'u1',
    name: 'Priya Nair',
    department: 'Procurement',
    count: 5,
    stalled: 0,
    percent: 100,
    tone: 'danger',
    ...overrides,
  }
}

beforeEach(() => {
  features.sla = false
})

describe('an empty board', () => {
  it('says nobody is holding work rather than showing an empty box', () => {
    render(<LoadByPerson rows={[]} />)

    // A headed card with nothing under it is indistinguishable from a card
    // whose data failed to load. "Nobody is holding work" is a result.
    expect(screen.getByText('Nobody is holding work right now.')).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('keeps its heading, so the region is still findable when it is empty', () => {
    render(<LoadByPerson rows={[]} />)

    // Named, not merely present: an unnamed complementary region is "region"
    // in a landmark list, which is no help at all in getting to it.
    expect(screen.getByRole('heading', { name: 'Load by person' })).toBeInTheDocument()
    expect(
      screen.getByRole('complementary', { name: 'Approver load and escalations' }),
    ).toBeInTheDocument()
  })
})

describe('what each row states', () => {
  it('prints the count as a number beside the name', () => {
    render(<LoadByPerson rows={[row({ count: 5 })]} />)

    // The bar is aria-hidden. If the count were not text, the person with
    // twelve documents and the person with one would sound identical.
    expect(within(screen.getByRole('listitem')).getByText('5')).toBeInTheDocument()
  })

  it('hides the bar from screen readers instead of announcing a bare graphic', () => {
    const { container } = render(<LoadByPerson rows={[row()]} />)

    // Finding the bar by `[aria-hidden]` and then asserting it is hidden is
    // circular. Find it by the one thing that makes it a bar - the width it
    // is drawn to - and then ask whether anything above it hides it.
    const fill = container.querySelector('li [style*="width"]')
    expect(fill).not.toBeNull()
    expect(fill!.closest('[aria-hidden="true"]')).not.toBeNull()
  })

  it('draws the bar to the share it was handed, and leaves the quietest a sliver', () => {
    const { container } = render(
      <LoadByPerson
        rows={[
          row({ id: 'u1', name: 'Priya Nair', count: 9, percent: 100 }),
          row({ id: 'u2', name: 'Tom Becker', count: 4, percent: 44, tone: 'accent' }),
          row({ id: 'u3', name: 'Sana Iqbal', count: 1, percent: 0, tone: 'accent' }),
        ]}
      />,
    )

    // The bar is the only thing on the card that compares two people at a
    // glance, and nothing prints the percentage, so the drawn width is the
    // whole of the claim. The 4% floor is deliberate: a bar rounded away to
    // nothing sits beside a name that is still holding a document.
    const widths = [...container.querySelectorAll('li [style*="width"]')].map(
      node => (node as HTMLElement).style.width,
    )
    expect(widths).toEqual(['100%', '44%', '4%'])
  })

  it('flags how many of a person’s documents have stalled', () => {
    render(<LoadByPerson rows={[row({ count: 5, stalled: 2 })]} />)

    // Five documents held for a day and five held for a fortnight are the
    // same number and completely different problems.
    expect(screen.getByRole('listitem')).toHaveTextContent('5 · 2 stalled')
  })

  it('says nothing about stalling when nothing has stalled', () => {
    render(<LoadByPerson rows={[row({ stalled: 0 })]} />)

    // "0 stalled" on every clean row is noise that hides the rows that are
    // not clean.
    expect(screen.queryByText(/stalled/)).not.toBeInTheDocument()
  })

  it('names the department a person sits in, and omits the line when there is none', () => {
    const { rerender } = render(<LoadByPerson rows={[row({ department: 'Procurement' })]} />)
    expect(screen.getByText('Procurement')).toBeInTheDocument()

    rerender(<LoadByPerson rows={[row({ department: null })]} />)
    // Better an absent line than a stray dash under a name; the row is two
    // lines tall either way.
    expect(screen.queryByText('Procurement')).not.toBeInTheDocument()
    expect(screen.getByRole('listitem')).toHaveTextContent('Priya Nair')
  })
})

describe('the order and the shape of the list', () => {
  it('keeps the order it was handed, busiest first', () => {
    render(
      <LoadByPerson
        rows={[
          row({ id: 'u1', name: 'Priya Nair', count: 9, percent: 100, tone: 'danger' }),
          row({ id: 'u2', name: 'Tom Becker', count: 4, percent: 44, tone: 'accent' }),
          row({ id: 'u3', name: 'Sana Iqbal', count: 1, percent: 11, tone: 'accent' }),
        ]}
      />,
    )

    // The panel is read top-down to find the bottleneck. Re-ordering it
    // anywhere between the calculation and the screen would name the wrong
    // person, and nothing on the card would give that away.
    const rows = screen.getAllByRole('listitem').map(entry => entry.textContent ?? '')
    expect(rows[0]).toContain('Priya Nair')
    expect(rows[1]).toContain('Tom Becker')
    expect(rows[2]).toContain('Sana Iqbal')
  })

  it('renders a row per person even when two of them hold the same amount', () => {
    render(
      <LoadByPerson
        rows={[
          row({ id: 'u1', name: 'Priya Nair', count: 3 }),
          row({ id: 'u2', name: 'Tom Becker', count: 3 }),
        ]}
      />,
    )

    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getAllByText('3')).toHaveLength(2)
  })

  it('shows a count of zero rather than dropping the person', () => {
    render(<LoadByPerson rows={[row({ count: 0, percent: 0, tone: 'accent' })]} />)

    // Not reachable from `computeApproverLoad` today, which only builds a row
    // once somebody holds something - but a row that vanished at zero would
    // silently remove a name from a list people read as a roster.
    expect(within(screen.getByRole('listitem')).getByText('0')).toBeInTheDocument()
  })
})

describe('what it refuses to claim', () => {
  it('measures the bar against the busiest person, not an invented capacity', () => {
    render(<LoadByPerson rows={[row()]} />)

    // No capacity is recorded for anybody, so "78% full" would be a number
    // somebody could reasonably reassign work on and which means nothing.
    expect(screen.getByText('Share of busiest')).toBeInTheDocument()
    expect(screen.queryByText(/capacity|% full/i)).not.toBeInTheDocument()
    // The share stays in the drawn width and never becomes a figure on the
    // row: a printed "100%" beside a name is read as a workload, and it is
    // not one - it only means nobody else is busier.
    expect(screen.getByRole('listitem')).not.toHaveTextContent('%')
  })

  it('shows no chased card while the feature is off', () => {
    render(<LoadByPerson rows={[row()]} chasedToday={2} />)

    expect(screen.queryByRole('heading', { name: /Chased today/ })).not.toBeInTheDocument()
  })

  it('stays away when nothing on the board has a deadline', () => {
    // Null, not zero. "Nobody was chased" is a reassurance, and a board with
    // no deadlines on it has not earned one.
    features.sla = true
    render(<LoadByPerson rows={[row()]} chasedToday={null} />)

    expect(screen.queryByRole('heading', { name: /Chased today/ })).not.toBeInTheDocument()
  })

  it('says nobody was chased, once there is something that could have been', () => {
    features.sla = true
    render(<LoadByPerson rows={[row()]} chasedToday={0} />)

    expect(screen.getByRole('heading', { name: /Chased today/ })).toBeInTheDocument()
    expect(screen.getByText(/Nobody has been chased today/)).toBeInTheDocument()
  })

  it('counts who was chased, and says what being chased means', () => {
    // Told, not moved. An administrator reading this must not think the memo
    // has been reassigned or the step passed over - it still needs that
    // signature.
    features.sla = true
    render(<LoadByPerson rows={[row()]} chasedToday={2} />)

    expect(screen.getByText(/2 memos ran past the days/)).toBeInTheDocument()
    expect(screen.getByText(/told once/)).toBeInTheDocument()
  })

  it('reads one memo as one memo', () => {
    features.sla = true
    render(<LoadByPerson rows={[row()]} chasedToday={1} />)

    expect(screen.getByText(/1 memo ran past/)).toBeInTheDocument()
  })
})
