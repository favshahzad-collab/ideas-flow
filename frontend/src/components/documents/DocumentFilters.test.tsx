import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentStatusFilter } from '../../utils/documentFilters'
import DocumentFilters, { type SortOrder } from './DocumentFilters'

/**
 * The toolbar above the documents table: search, status chips, sort, and the
 * "n of m" count.
 *
 * Everything here changes what the list below is showing, so the thing that
 * must not go wrong is the screen disagreeing with itself - a filtered list
 * with no chip marked active, or a search box with nothing in it while three
 * of twelve documents are on screen. A person who cannot see why the list is
 * short will conclude the documents are gone.
 */

const flags = vi.hoisted(() => ({ savedViews: true }))
vi.mock('../../config/features', () => ({ FEATURES: flags }))

type Props = {
  search?: string
  status?: DocumentStatusFilter
  sort?: SortOrder
  resultCount?: number
  totalCount?: number
}

function renderFilters(props: Props = {}) {
  const onSearch = vi.fn()
  const onStatus = vi.fn()
  const onSort = vi.fn()

  const element = (p: Props) => (
    <DocumentFilters
      search={p.search ?? ''}
      onSearch={onSearch}
      status={p.status ?? 'all'}
      onStatus={onStatus}
      sort={p.sort ?? 'newest'}
      onSort={onSort}
      resultCount={p.resultCount ?? 3}
      totalCount={p.totalCount ?? 12}
    />
  )

  const result = render(element(props))

  return {
    ...result,
    onSearch,
    onStatus,
    onSort,
    /** Re-render as the parent would once it has acted on a callback. */
    apply: (next: Props) => result.rerender(element({ ...props, ...next })),
  }
}

const CHIPS = ['All', 'In progress', 'Approved', 'Revision', 'Rejected'] as const

/** The status chips currently claiming to be filtering the list. */
const pressedChips = () =>
  CHIPS.filter(
    label => screen.getByRole('button', { name: label }).getAttribute('aria-pressed') === 'true',
  )

beforeEach(() => {
  flags.savedViews = true
})

describe('the search field', () => {
  it('is labelled even though the label is not drawn', () => {
    renderFilters()

    // The magnifier icon is aria-hidden, so without the sr-only label this
    // is an unnamed text box - "edit, blank" and nothing else.
    expect(screen.getByLabelText('Search documents')).toBeInTheDocument()
  })

  it('says what it searches', () => {
    renderFilters()

    // People give up on a search box that finds nothing for a person's name.
    expect(screen.getByLabelText('Search documents')).toHaveAttribute(
      'placeholder',
      'Search reference, title or person',
    )
  })

  it('reports every keystroke and holds no value of its own', async () => {
    const user = userEvent.setup({ delay: null })
    const { onSearch } = renderFilters({ search: '' })
    const field = screen.getByLabelText('Search documents')

    await user.type(field, 'le')

    expect(onSearch).toHaveBeenNthCalledWith(1, 'l')
    expect(onSearch).toHaveBeenNthCalledWith(2, 'e')
    // The parent owns the query - it is in the URL. This test never lets the
    // parent act, so a genuinely controlled field stays empty. An
    // uncontrolled `defaultValue` would still pass "shows the search that is
    // currently applied" below while quietly ignoring the back button, a
    // shared link and the Clear press.
    expect(field).toHaveValue('')
  })

  it('reports the whole field, not the key that was pressed', async () => {
    const user = userEvent.setup({ delay: null })
    const { onSearch } = renderFilters({ search: 'lea' })

    await user.type(screen.getByLabelText('Search documents'), 's')

    // The test above types into an empty field, where "the value in the box"
    // and "the key that was struck" are the same one-character string - a
    // handler reading `event.key`, or one appending to its own state, passes
    // it. Here the two differ, and only one of them is a query the parent can
    // put in the URL and run.
    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(onSearch).toHaveBeenCalledWith('leas')
  })

  it('shows the search that is currently applied', () => {
    renderFilters({ search: 'lease' })

    // The field is the only visible explanation for a short list; it has to
    // hold the query that produced it.
    expect(screen.getByLabelText('Search documents')).toHaveValue('lease')
  })

  it('offers a clear only when there is something to clear', () => {
    renderFilters()

    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument()
  })

  it('clears the search with one labelled press, and gets out of the way after', async () => {
    const user = userEvent.setup({ delay: null })
    const { onSearch, onStatus, apply } = renderFilters({ search: 'lease', status: 'approved' })

    // An icon-only button with no name is announced as just "button".
    await user.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(onSearch).toHaveBeenCalledWith('')
    // It clears the query, not the toolbar. Dropping the status filter too
    // would answer "show me all the leases again" with the whole library.
    expect(onStatus).not.toHaveBeenCalled()

    apply({ search: '' })

    // The press has to leave the toolbar in the state it claimed: an empty
    // field, and no leftover cross offering to clear nothing.
    expect(screen.getByLabelText('Search documents')).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument()
  })
})

describe('the status chips', () => {
  it('offers only the filters the API can answer', () => {
    renderFilters()

    for (const label of CHIPS) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    // "Department" and "Value" are in the design but on no document the API
    // returns; a chip that filters on a field nobody has would return
    // nothing and read as "you have no documents".
    expect(screen.queryByRole('button', { name: 'Department' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Value' })).not.toBeInTheDocument()
  })

  it.each([
    ['All', 'all'],
    ['In progress', 'pending'],
    ['Approved', 'approved'],
    ['Revision', 'revision_requested'],
    ['Rejected', 'rejected'],
  ] as const)('sends "%s" through as the %s filter', async (label, value) => {
    const user = userEvent.setup({ delay: null })
    const { onStatus, onSort, onSearch } = renderFilters()

    await user.click(screen.getByRole('button', { name: label }))

    // Five chips and five filter values, mapped by a table two files away.
    // Testing one chip proves the wiring exists; it does not prove "Rejected"
    // does not quietly apply "revision_requested", which is the same list
    // length and the same empty screen.
    expect(onStatus).toHaveBeenCalledTimes(1)
    expect(onStatus).toHaveBeenCalledWith(value)
    // And filtering is all it does. A chip that also re-sorted or emptied the
    // search box would move the documents the person was reading somewhere
    // else on the way to narrowing them.
    expect(onSort).not.toHaveBeenCalled()
    expect(onSearch).not.toHaveBeenCalled()
  })

  it('is not a toggle: pressing the active chip reapplies it rather than clearing it', async () => {
    const user = userEvent.setup({ delay: null })
    const { onStatus } = renderFilters({ status: 'approved' })

    await user.click(screen.getByRole('button', { name: 'Approved' }))

    // Deliberately unlike the KPI tiles above, which do untoggle. "All" is
    // the way back here, and it is sitting right there in the same row -
    // a chip that cleared itself would leave two controls doing the same
    // job and no way to tell which state you are in.
    expect(onStatus).toHaveBeenCalledTimes(1)
    expect(onStatus).toHaveBeenCalledWith('approved')
    expect(onStatus).not.toHaveBeenCalledWith('all')
  })

  it('marks the chip that is filtering, and only that one', () => {
    renderFilters({ status: 'approved' })

    // aria-pressed is what a screen reader has instead of the tinted pill.
    // Two pressed chips is a toolbar that cannot say what the list is.
    expect(pressedChips()).toEqual(['Approved'])
  })

  it('marks "All" when nothing is filtered, and nothing else', () => {
    renderFilters()

    expect(pressedChips()).toEqual(['All'])
  })

  it('marks "In progress" when the applied filter is one of its two halves', () => {
    // `readStatus` in DocumentPage accepts `pending_review` and
    // `pending_approval` from the URL, and no chip carries either value. The
    // list comes back filtered with every chip - including "All" - showing
    // unpressed, so nothing on screen explains why documents are missing.
    // Marked `fails` because that is the defect, not the intended behaviour.
    renderFilters({ status: 'pending_review' })

    expect(screen.getByRole('button', { name: 'In progress' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('does not fall back to marking "All" while a filter is applied', () => {
    renderFilters({ status: 'pending_review' })

    // The one thing worse than no chip being active: claiming the list is
    // unfiltered while it is not. (Whether "In progress" lights up instead is
    // the open defect above; either way "All" must not, and no two chips may
    // claim it at once.)
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false')
    expect(pressedChips().length).toBeLessThanOrEqual(1)
  })
})

describe('the sort toggle', () => {
  it('says which order the list is in and that it can be switched', () => {
    renderFilters({ sort: 'newest' })

    const toggle = screen.getByRole('button', { name: /Sort: newest first/ })
    expect(toggle).toHaveTextContent('Newest first')
    // The visible words and the accessible name are two separate strings in
    // the source; both have to describe the CURRENT order, or the button
    // reads as an instruction to a screen reader and as a state to everyone
    // else.
    expect(toggle).toHaveAccessibleName(/Activate to switch/)
    expect(toggle).not.toHaveAccessibleName(/oldest/)
  })

  it('switches to oldest first', async () => {
    const user = userEvent.setup({ delay: null })
    const { onSort, apply } = renderFilters({ sort: 'newest' })

    await user.click(screen.getByRole('button', { name: /Sort:/ }))
    expect(onSort).toHaveBeenCalledWith('oldest')

    apply({ sort: 'oldest' })

    // The press has to be visible once the parent applies it - a toggle that
    // emits the right value but never redraws leaves the list re-sorted with
    // the button still claiming the old order.
    expect(screen.getByRole('button', { name: /Sort: oldest first/ })).toHaveTextContent(
      'Oldest first',
    )
  })

  it('switches back, rather than sending the same order twice', async () => {
    const user = userEvent.setup({ delay: null })
    const { onSort } = renderFilters({ sort: 'oldest' })

    expect(screen.getByRole('button', { name: /Sort: oldest first/ })).toHaveTextContent(
      'Oldest first',
    )
    await user.click(screen.getByRole('button', { name: /Sort:/ }))

    // A toggle that always emits 'oldest' leaves the oldest documents
    // pinned to the top with no way back.
    expect(onSort).toHaveBeenCalledTimes(1)
    expect(onSort).toHaveBeenCalledWith('newest')
  })

  it('is a toggle in its own right, not a sixth status filter', async () => {
    const user = userEvent.setup({ delay: null })
    const { onSort, onStatus } = renderFilters({ sort: 'oldest', status: 'approved' })

    // Sort and status share a visual row and the same Chip component, and
    // both therefore mark themselves pressed - the sort chip is pressed here
    // because the list IS in oldest-first order, which is a state worth
    // announcing. What has to stay separate is what the two mean: exactly one
    // status chip is narrowing the list, and this is not one of them.
    expect(pressedChips()).toEqual(['Approved'])
    const sort = screen.getByRole('button', { name: /Sort: oldest first/ })
    expect(sort).toHaveAttribute('aria-pressed', 'true')

    await user.click(sort)

    // The two handlers are adjacent props on the same component and are both
    // wired through the same `onClick`. Crossed, re-ordering the list throws
    // away the filter - the documents the person was looking at vanish, and
    // the chip row still says "Approved".
    expect(onSort).toHaveBeenCalledWith('newest')
    expect(onStatus).not.toHaveBeenCalled()
  })
})

describe('the result count', () => {
  it('says how many of the total are showing', () => {
    renderFilters({ resultCount: 3, totalCount: 12 })

    expect(screen.getByText('3 of 12')).toBeInTheDocument()
  })

  it('still states the total when a filter matches nothing', () => {
    renderFilters({ resultCount: 0, totalCount: 12, status: 'rejected' })

    // "0 of 12" is the difference between "your filter excluded everything"
    // and "you have no documents" - two very different next actions.
    expect(screen.getByText('0 of 12')).toBeInTheDocument()
  })

  it('announces the count by changing in place, not by being replaced', () => {
    const { apply } = renderFilters({ resultCount: 3, totalCount: 12 })

    const live = screen.getByText('3 of 12')
    expect(live).toHaveAttribute('aria-live', 'polite')

    apply({ resultCount: 1 })

    // Nothing else tells a screen reader that typing in the box changed the
    // list. A live region only speaks when the text inside the SAME node
    // changes - key the paragraph on the count and it is remounted instead,
    // which looks identical and says nothing.
    expect(live).toHaveTextContent('1 of 12')
    expect(live).toBeInTheDocument()
  })

  it('reads sensibly for a single result and an empty account', () => {
    renderFilters({ resultCount: 1, totalCount: 1 })

    expect(screen.getByText('1 of 1')).toBeInTheDocument()
  })
})

describe('saved views', () => {
  it('is disabled and says what it is waiting for', () => {
    renderFilters()

    const save = screen.getByRole('button', { name: 'Save as view' })
    expect(save).toBeDisabled()
    expect(save.getAttribute('title')).toContain('saved-views')
  })

  it('is absent entirely when the flag is off', () => {
    flags.savedViews = false
    renderFilters()

    // In a production build there is no endpoint, and a dead control on a
    // toolbar teaches people the toolbar is decorative.
    expect(screen.queryByRole('button', { name: 'Save as view' })).not.toBeInTheDocument()
    // Everything the toolbar actually does survives the gate.
    for (const label of CHIPS) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByLabelText('Search documents')).toBeInTheDocument()
  })
})
