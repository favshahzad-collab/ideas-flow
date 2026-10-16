import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadDocumentFile } from '../../utils/downloadDocument'
import type { DashboardDocument } from '../../types/document'
import DocumentsTable from './DocumentsTable'

/**
 * The desktop list of everything a person has in flight. It is the screen
 * people scan to answer three questions: is this mine, who is sitting on it,
 * and how long has it been there. Every assertion below is about one of
 * those, or about the selection controls - because a bulk action that reaches
 * a row somebody could not see is the expensive kind of mistake.
 *
 * The mappers that produce these rows are tested in documentMapper.test.ts.
 * What is tested here is what the table does with a row once it has one -
 * including which COLUMN each value lands in, since a value under the wrong
 * header is a lie a `getByText` anywhere in the row would not catch.
 */

/** Feature gates are read at render, so they can be flipped per test. */
const flags = vi.hoisted(() => ({ bulkActions: true, sla: true }))
vi.mock('../../config/features', () => ({ FEATURES: flags }))

/* The row menu carries a real download, which would reach the API. */
vi.mock('../../utils/downloadDocument', () => ({
  downloadDocumentFile: vi.fn(),
}))

const download = vi.mocked(downloadDocumentFile)

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

function renderTable(
  documents: DashboardDocument[] = [doc()],
  selectedIds: ReadonlySet<string> = new Set(),
  showPreparer = false,
) {
  const onToggle = vi.fn()
  const onTogglePage = vi.fn()
  const onOpen = vi.fn()

  const result = render(
    <DocumentsTable
      documents={documents}
      selectedIds={selectedIds}
      onToggle={onToggle}
      onTogglePage={onTogglePage}
      onOpen={onOpen}
      showPreparer={showPreparer}
    />,
  )

  return { ...result, onToggle, onTogglePage, onOpen }
}

/** The data rows, with the header row dropped. */
const dataRows = () => screen.getAllByRole('row').slice(1)

/**
 * The cell in `row` sitting under a named column header.
 *
 * The index is looked up from the header row rather than hard-coded, so
 * reordering the columns leaves these tests alone - but a value rendered into
 * the wrong cell, or a cell that disappears and shifts every value one column
 * left of the header describing it, does not.
 */
function cellUnder(row: HTMLElement, column: string): HTMLElement {
  const headers = screen.getAllByRole('columnheader')
  const index = headers.findIndex(header => (header.textContent ?? '').trim() === column)
  if (index < 0) throw new Error(`No "${column}" column header on this table`)
  return within(row).getAllByRole('cell')[index]
}

beforeEach(() => {
  flags.bulkActions = true
  flags.sla = true
  // `restoreMocks` restores spies, not the call log of a module mock.
  download.mockReset()
  download.mockResolvedValue(undefined)
})

describe('DocumentsTable structure', () => {
  it('is a real table with a name and a header over every column', () => {
    renderTable()

    // A grid of divs looks identical and announces nothing: without column
    // headers a screen reader reads "Bilal Ahmed" with no hint that it is
    // the holder rather than the person who submitted it.
    expect(
      screen.getByRole('table', { name: /Documents associated with you/i }),
    ).toBeInTheDocument()

    for (const column of ['Document', 'Status', 'Now with', 'Stage', 'Age', 'Actions']) {
      expect(screen.getByRole('columnheader', { name: column })).toBeInTheDocument()
    }
  })

  it.each([
    [
      'with bulk actions on',
      { bulkActions: true },
      ['', 'Document', 'Status', 'Now with', 'Stage', 'Age', 'Actions'],
    ],
    [
      'with bulk actions off',
      { bulkActions: false },
      ['Document', 'Status', 'Now with', 'Stage', 'Age', 'Actions'],
    ],
  ])('gives every row one cell per header, %s', (_case, gates, expected) => {
    Object.assign(flags, gates)
    renderTable([doc({ id: 'aaa' }), doc({ id: 'bbb', title: 'Stationery order' })])

    // Each gated column is TWO conditionals - a `<th>` and a `<td>` - written
    // a hundred lines apart. Drop one of the pair and every value after it
    // sits under the wrong header, which is worse than the column being
    // absent: the table then confidently reads the holder as the stage.
    expect(
      screen.getAllByRole('columnheader').map(h => (h.textContent ?? '').trim()),
    ).toEqual(expected)

    for (const row of dataRows()) {
      expect(within(row).getAllByRole('cell')).toHaveLength(expected.length)
    }
  })

  it('leaves out the value column while there is no value to put in it', () => {
    renderTable()

    // The API returns no amount for a document. A column of em dashes reads
    // as "every one of these is worth nothing", which is worse than no column.
    expect(screen.queryByRole('columnheader', { name: 'Value' })).not.toBeInTheDocument()
  })

  it('keeps its headers when there is nothing in it', () => {
    renderTable([])

    expect(screen.getByRole('table', { name: /Documents/i })).toBeInTheDocument()
    expect(dataRows()).toHaveLength(0)
  })
})

describe('what a row says about a document', () => {
  it('names the holder under the Holder header, and nobody else', () => {
    renderTable()
    const row = dataRows()[0]

    // The holder column is the one people scan for their own name. Showing
    // the submitter here instead is how a table quietly lies about who is
    // blocking a document - and the fixture's submitter is deliberately a
    // different person, so a swap has somewhere visible to land.
    expect(within(cellUnder(row, 'Now with')).getByText('Bilal Ahmed')).toBeInTheDocument()
    expect(row).not.toHaveTextContent('Ayesha Khan')
  })

  it('states the workflow position as text under the Stage header', () => {
    renderTable()
    const stage = cellUnder(dataRows()[0], 'Stage')

    // The pips are aria-hidden, so the mono "2/4" beside them is the only
    // statement of progress a screen reader gets.
    expect(stage).toHaveTextContent(/Step\s*2/)
    expect(stage).toHaveTextContent(/of\s*4/)
  })

  it.each([
    ['draft', 'Draft'],
    ['pending_review', 'Review'],
    ['pending_approval', 'Approval'],
    ['revision_requested', 'Revision'],
    ['approved', 'Approved'],
    ['rejected', 'Rejected'],
    ['deleted', 'Withdrawn'],
  ] as const)('states a %s document as "%s", never as a coloured dot alone', (status, label) => {
    renderTable([doc({ status })])

    // The leading dot in the title cell is aria-hidden and the badge dot is
    // too; if the word went missing, status would be carried by hue alone.
    //
    // Every status, not one: a badge that hard-coded "Revision", or a lookup
    // that fell through to a default for the two statuses nobody demos, would
    // satisfy a single-status assertion. The comparison is exact rather than
    // `toHaveTextContent`, so the verbose form ("Pending Review") drifting
    // into a dense table cell fails here too - and so does "Approved"
    // quietly answering for "Approval".
    expect(cellUnder(dataRows()[0], 'Status').textContent).toBe(label)
  })

  it('drops the avatar when the holder is a state rather than a person', () => {
    renderTable([
      doc({ status: 'approved', currentHolder: 'Completed', currentHolderInitials: null }),
    ])
    const holder = cellUnder(dataRows()[0], 'Now with')

    // A finished document has no holder; `currentHolder` is then the word
    // "Completed". An initials disc beside it would read as a person called
    // Completed sitting on the document.
    expect(within(holder).getByText('Completed')).toBeInTheDocument()
    expect(within(holder).queryByText('CO')).not.toBeInTheDocument()
    // Avatar prints "?" when handed nothing, so ruling out "CO" alone would
    // miss a component that rendered the disc regardless.
    expect(within(holder).queryByText('?')).not.toBeInTheDocument()
    expect(holder).toHaveTextContent(/^Completed$/)
  })

  it('carries the whole title in the accessible name, however long it is', () => {
    const longTitle =
      'Amendment number four to the master services agreement between the northern regional warehouse operations division and the freight consolidation partner'
    renderTable([doc({ title: longTitle })])

    // The cell truncates at 280px. The full string has to stay reachable -
    // half a contract title is not enough to tell two amendments apart.
    const title = screen.getByRole('button', { name: longTitle })
    expect(title).toHaveAttribute('title', longTitle)
  })

  it('shows the version and short id, so two revisions of one title are distinguishable', () => {
    renderTable([doc({ versionNumber: 7 })])

    expect(
      within(cellUnder(dataRows()[0], 'Document')).getByText('#3F2A9B1C · v7'),
    ).toBeInTheDocument()
  })
})

describe('the age column', () => {
  it('says how long an in-flight document has been sitting where it is', () => {
    renderTable([doc({ status: 'pending_approval', updatedAt: daysAgo(3) })])
    const age = cellUnder(dataRows()[0], 'Age')

    // The bar beside it is aria-hidden, so this text is the value. A bar
    // alone would leave "how long" as a length nobody can read out.
    expect(within(age).getByText('3 days')).toBeInTheDocument()
    // And it must stay decoration: giving the bar progressbar semantics would
    // announce "43 percent" beside "3 days" - the same fact twice, one of
    // them in a unit nobody asked for and against a deadline that does not
    // exist.
    expect(within(age).queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('counts one day as a day, not as "1 days"', () => {
    renderTable([doc({ updatedAt: daysAgo(1) })])

    expect(within(cellUnder(dataRows()[0], 'Age')).getByText('1 day')).toBeInTheDocument()
  })

  it.each(['pending_review', 'pending_approval', 'revision_requested'] as const)(
    'ages a %s document, because a person is still holding it',
    status => {
      renderTable([doc({ status, updatedAt: daysAgo(5) })])

      // All three of these sit with somebody. A status left out of the
      // in-flight set fails silently: the column shows a dash, and the
      // document that has been stuck longest stops looking stuck at all.
      expect(within(cellUnder(dataRows()[0], 'Age')).getByText('5 days')).toBeInTheDocument()
    },
  )

  it.each(['draft', 'approved', 'rejected', 'deleted'] as const)(
    'leaves the age blank on a %s document, which is waiting on nobody',
    status => {
      renderTable([doc({ status, updatedAt: daysAgo(9) })])
      const age = cellUnder(dataRows()[0], 'Age')

      // A filling, reddening bar here reads as a deadline still running
      // against somebody. "9 days" is the number people escalate on, and
      // none of these four is anyone's to escalate - a draft least of all,
      // since the only person it is waiting on is the one reading the row.
      expect(age).toHaveTextContent(/^—$/)
      expect(age).not.toHaveTextContent(/day/)
      expect(within(age).queryByRole('progressbar')).not.toBeInTheDocument()
    },
  )
})

describe('opening a document', () => {
  it('opens it from the title, exactly once', async () => {
    const user = userEvent.setup({ delay: null })
    const { onOpen } = renderTable()

    await user.click(screen.getByRole('button', { name: 'Warehouse lease extension' }))

    // The row underneath carries its own click handler. Without the title
    // stopping propagation this fires twice - two navigations, and a back
    // button that does not go back.
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c')
  })

  it('opens it from the keyboard, since a table row itself takes no focus', async () => {
    const user = userEvent.setup({ delay: null })
    const { onOpen } = renderTable()

    const title = screen.getByRole('button', { name: 'Warehouse lease extension' })
    title.focus()
    expect(title).toHaveFocus()
    await user.keyboard('{Enter}')

    // A <tr onClick> is unreachable without a mouse. The title being a real
    // button is the only keyboard route into a document from this screen.
    expect(onOpen).toHaveBeenCalledWith('3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c')
  })

  it('opens the document the row belongs to when the row is clicked', async () => {
    const user = userEvent.setup({ delay: null })
    const { onOpen, onToggle, onTogglePage } = renderTable([
      doc({ id: 'aaa', title: 'Warehouse lease extension' }),
      doc({ id: 'bbb', title: 'Fleet insurance renewal', currentHolder: 'Dania Sheikh' }),
    ])

    await user.click(within(dataRows()[1]).getByText('Dania Sheikh'))

    // Closing over the wrong `doc` in the map is a one-character mistake that
    // opens the top row from every row on the page.
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('bbb')
    // And opening is all it does. A row that also ticked its own box would
    // leave a selection behind on the way out, so the bulk bar comes back
    // populated from a document the person only read.
    expect(onToggle).not.toHaveBeenCalled()
    expect(onTogglePage).not.toHaveBeenCalled()
  })
})

describe('selecting rows', () => {
  const three = [
    doc({ id: 'aaa', title: 'Warehouse lease extension' }),
    doc({ id: 'bbb', title: 'Stationery order' }),
    doc({ id: 'ccc', title: 'Fleet insurance renewal' }),
  ]

  it('names each checkbox after the document it selects', () => {
    renderTable(three)

    // Three boxes all labelled "Select" cannot be told apart by voice
    // control or by a screen reader moving through the column.
    expect(screen.getByRole('checkbox', { name: 'Select Stationery order' })).toBeInTheDocument()
  })

  it('shows a tick against exactly the rows that are selected', () => {
    renderTable(three, new Set(['bbb']))

    // Without this, `checked` could be wired to nothing at all and the rest
    // of this block would still pass: the header's indeterminate state is
    // computed from `selectedIds` directly, not from the row boxes.
    expect(screen.getByRole('checkbox', { name: 'Select Stationery order' })).toBeChecked()
    expect(
      screen.getByRole('checkbox', { name: 'Select Warehouse lease extension' }),
    ).not.toBeChecked()
    expect(
      screen.getByRole('checkbox', { name: 'Select Fleet insurance renewal' }),
    ).not.toBeChecked()
  })

  it('ticks a row without opening the document', async () => {
    const user = userEvent.setup({ delay: null })
    const { onToggle, onOpen, onTogglePage } = renderTable(three)

    await user.click(screen.getByRole('checkbox', { name: 'Select Fleet insurance renewal' }))

    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('ccc')
    // The checkbox sits inside a row that navigates on click. If the cell
    // stopped stopping propagation, ticking a box would leave the screen -
    // and the selection with it.
    expect(onOpen).not.toHaveBeenCalled()
    // One row, not the page. The two handlers differ by three characters and
    // are passed in next to each other; crossing them turns one tick into
    // every document on screen going into the next bulk action.
    expect(onTogglePage).not.toHaveBeenCalled()
  })

  it('offers select-all over exactly the rows on screen, not the whole library', async () => {
    const user = userEvent.setup({ delay: null })
    const { onTogglePage } = renderTable(three)

    await user.click(
      screen.getByRole('checkbox', { name: 'Select all documents on this page' }),
    )

    // The table is handed one filtered, paginated page. Selecting anything
    // it was not given would put documents nobody looked at into a bulk
    // action.
    expect(onTogglePage).toHaveBeenCalledWith(['aaa', 'bbb', 'ccc'], true)
  })

  it('unticks that same page when everything on it is already selected', async () => {
    const user = userEvent.setup({ delay: null })
    const { onTogglePage } = renderTable(three, new Set(['aaa', 'bbb', 'ccc']))

    const all = screen.getByRole('checkbox', { name: 'Select all documents on this page' })
    expect(all).toBeChecked()
    await user.click(all)

    expect(onTogglePage).toHaveBeenCalledWith(['aaa', 'bbb', 'ccc'], false)
  })

  it('does not treat a selection carried in from another page as this page', async () => {
    const user = userEvent.setup({ delay: null })
    const { onTogglePage } = renderTable(three, new Set(['zzz']))

    const all = screen.getByRole('checkbox', {
      name: 'Select all documents on this page',
    }) as HTMLInputElement

    // `selectedIds` is the whole selection across pages. A row selected on
    // page two must not make page one look partly ticked, and select-all
    // must still offer only what is on screen.
    expect(all).not.toBeChecked()
    expect(all.indeterminate).toBe(false)

    await user.click(all)
    expect(onTogglePage).toHaveBeenCalledWith(['aaa', 'bbb', 'ccc'], true)
  })

  it('shows a partial selection as indeterminate rather than as ticked', () => {
    renderTable(three, new Set(['bbb']))

    const all = screen.getByRole('checkbox', {
      name: 'Select all documents on this page',
    }) as HTMLInputElement

    // Ticked would claim all three are selected, and pressing it would then
    // clear the one that is - the opposite of what the person wanted.
    expect(all).not.toBeChecked()
    expect(all.indeterminate).toBe(true)
  })

  it('keeps the header box in step as the selection changes underneath it', () => {
    const view = (selected: ReadonlySet<string>) => (
      <DocumentsTable
        documents={three}
        selectedIds={selected}
        onToggle={vi.fn()}
        onTogglePage={vi.fn()}
        onOpen={vi.fn()}
      />
    )
    const { rerender } = render(view(new Set(['bbb'])))
    const all = () =>
      screen.getByRole('checkbox', {
        name: 'Select all documents on this page',
      }) as HTMLInputElement

    expect(all().indeterminate).toBe(true)

    // `indeterminate` is not something React writes from JSX - it is set on
    // the node by an effect, against a dependency list. Every other
    // assertion in this block renders once and never touches the selection
    // again, so an effect that ran only on mount, or watched the wrong
    // values, would pass all of them and still leave a dash sitting on the
    // header box for the rest of the session: a control that says "some" while
    // the page reads "all", one press away from clearing the lot.
    rerender(view(new Set(['aaa', 'bbb', 'ccc'])))
    expect(all().indeterminate).toBe(false)
    expect(all()).toBeChecked()

    rerender(view(new Set()))
    expect(all().indeterminate).toBe(false)
    expect(all()).not.toBeChecked()
  })

  it('does not claim everything is selected when there is nothing to select', () => {
    renderTable([])

    const all = screen.getByRole('checkbox', {
      name: 'Select all documents on this page',
    }) as HTMLInputElement

    // `[].every(...)` is true. Without the length guard an empty table shows
    // a ticked select-all box over no rows at all.
    expect(all).not.toBeChecked()
    expect(all.indeterminate).toBe(false)
  })

  it('drops the checkbox column entirely when bulk actions are off', () => {
    flags.bulkActions = false
    renderTable(three)

    // A build without the bulk bar must not leave ticks that lead nowhere.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  })
})

describe('the row menu', () => {
  it('is labelled with the document it acts on', () => {
    renderTable()

    // "More" three times over tells a screen reader user nothing about
    // which document they are about to act on.
    expect(
      screen.getByRole('button', { name: 'Actions for Warehouse lease extension' }),
    ).toBeInTheDocument()
  })

  it('reports whether it is open', async () => {
    const user = userEvent.setup({ delay: null })
    renderTable()

    const trigger = screen.getByRole('button', {
      name: 'Actions for Warehouse lease extension',
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    await user.click(trigger)

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('does not open the document just because its menu was opened', async () => {
    const user = userEvent.setup({ delay: null })
    const { onOpen } = renderTable()

    await user.click(
      screen.getByRole('button', { name: 'Actions for Warehouse lease extension' }),
    )

    // The trigger sits inside a <tr onClick>. Reaching for the menu and
    // being navigated away from the table instead is the row's most
    // expensive failure, because the menu is where the download lives.
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('closes on Escape and puts focus back on the trigger', async () => {
    const user = userEvent.setup({ delay: null })
    renderTable()

    const trigger = screen.getByRole('button', {
      name: 'Actions for Warehouse lease extension',
    })
    await user.click(trigger)
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    // Focus left on a closed menu lands on <body>, which sends the next Tab
    // back to the top of the page - the row is lost.
    expect(trigger).toHaveFocus()
  })

  it('opens the document from the menu and closes the menu behind it', async () => {
    const user = userEvent.setup({ delay: null })
    const { onOpen } = renderTable()

    await user.click(
      screen.getByRole('button', { name: 'Actions for Warehouse lease extension' }),
    )
    await user.click(screen.getByRole('menuitem', { name: 'Open document' }))

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c')
    // A menu left hanging over the row covers the result of what was pressed.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('downloads the row its menu belongs to, not the first row on the page', async () => {
    const user = userEvent.setup({ delay: null })
    renderTable([
      doc({
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        title: 'Warehouse lease extension',
        versionNumber: 2,
      }),
      doc({
        id: 'bbbbbbbb-0000-4000-8000-000000000002',
        title: 'Fleet insurance renewal',
        versionNumber: 5,
      }),
    ])

    await user.click(screen.getByRole('button', { name: 'Actions for Fleet insurance renewal' }))
    await user.click(screen.getByRole('button', { name: /Download current version/ }))

    // Handing the row menu the wrong document is silent: the file arrives,
    // it is just somebody else's contract. The version matters as much - a
    // stale v2 of a document now on v5 is a document that says the wrong
    // thing while looking current.
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect(download).toHaveBeenCalledWith(
      'bbbbbbbb-0000-4000-8000-000000000002',
      'document-bbbbbbbb-v5.pdf',
    )
  })

  it('refuses to download a deleted document', async () => {
    const user = userEvent.setup({ delay: null })
    renderTable([doc({ status: 'deleted' })])

    await user.click(
      screen.getByRole('button', { name: 'Actions for Warehouse lease extension' }),
    )

    // The file is gone. An enabled control here produces a failed request
    // and an error the person can do nothing about; the control has to be
    // genuinely disabled, not merely faded.
    const button = screen.getByRole('button', { name: /Download current version/ })
    expect(button).toBeDisabled()

    await user.click(button)
    expect(download).not.toHaveBeenCalled()
  })

  it('leaves the download available on a live document', async () => {
    const user = userEvent.setup({ delay: null })
    renderTable()

    await user.click(
      screen.getByRole('button', { name: 'Actions for Warehouse lease extension' }),
    )

    expect(screen.getByRole('button', { name: /Download current version/ })).toBeEnabled()
  })
})

/**
 * The column that is two columns.
 *
 * Age is how long a memo has sat, and is always true. A countdown is only
 * sayable where somebody set a number of days for the step. Showing one under
 * the other's heading is the quiet kind of wrong: nobody reads a column header
 * twice, so "Due — 6d" is read as six days left when it means six days old.
 */
describe('the age and due column', () => {
  it('reads Age, and shows age, when nothing has a deadline', () => {
    renderTable([doc({ dueAt: null })])

    expect(
      screen.getAllByRole('columnheader').map(h => (h.textContent ?? '').trim()),
    ).toContain('Age')
    expect(screen.queryByText(/left|over|due today/)).not.toBeInTheDocument()
  })

  it('reads Due, and counts down, once a step has one', () => {
    const dueAt = new Date(Date.now() + 3 * 86_400_000).toISOString()
    renderTable([doc({ dueAt })])

    expect(
      screen.getAllByRole('columnheader').map(h => (h.textContent ?? '').trim()),
    ).toContain('Due')
    expect(screen.getByText(/left|due tomorrow|due today/)).toBeInTheDocument()
  })

  it('says how far past a deadline a memo has gone', () => {
    const dueAt = new Date(Date.now() - 3 * 86_400_000).toISOString()
    renderTable([doc({ dueAt })])

    expect(screen.getByText('3d over')).toBeInTheDocument()
  })

  it('goes back to age when the countdown is switched off', () => {
    // Turning the gate off must not leave a "Due" heading over ages.
    flags.sla = false
    const dueAt = new Date(Date.now() + 3 * 86_400_000).toISOString()
    renderTable([doc({ dueAt })])

    expect(
      screen.getAllByRole('columnheader').map(h => (h.textContent ?? '').trim()),
    ).toContain('Age')
    expect(screen.queryByText(/d left/)).not.toBeInTheDocument()
  })

  it('shows a dash for a memo that is not waiting on anybody', () => {
    renderTable([doc({ status: 'approved', dueAt: null })])

    expect(screen.getByText('—')).toBeInTheDocument()
  })
})

describe('whose memo each row is', () => {
  /*
   * An administrator's list is the whole organisation's memos, not theirs.
   * Without this column the table shows five documents and no way to tell
   * who wrote any of them - and the holder column is a different person, so
   * reading it as the author is the mistake the table would invite.
   *
   * It is off for everybody else on purpose: every row in their list is
   * either theirs or one they were asked to approve, so a column repeating
   * their own name is a column of nothing.
   */

  it('names the preparer when the list is everybody\'s', () => {
    renderTable([doc()], new Set(), true)

    const cell = cellUnder(dataRows()[0], 'Prepared by')

    expect(within(cell).getByText('Ayesha Khan')).toBeInTheDocument()
  })

  it('does not show the column otherwise', () => {
    renderTable()

    expect(
      screen.queryByRole('columnheader', { name: 'Prepared by' }),
    ).not.toBeInTheDocument()
  })

  it('keeps the preparer and the holder apart', () => {
    // The two are different people and the table has always had a column for
    // the second. Rendering one under the other's header is the quiet lie
    // this whole column exists to avoid.
    renderTable([doc()], new Set(), true)

    const row = dataRows()[0]

    expect(within(cellUnder(row, 'Prepared by')).getByText('Ayesha Khan')).toBeInTheDocument()
    expect(within(cellUnder(row, 'Now with')).getByText('Bilal Ahmed')).toBeInTheDocument()
  })

  it("names the table for what is in it, which is what a screen reader reads first", () => {
    renderTable([doc()], new Set(), true)

    expect(screen.getByRole('table', { name: /Every document/i })).toBeInTheDocument()
  })
})
