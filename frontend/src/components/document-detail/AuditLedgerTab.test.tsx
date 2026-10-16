import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadDocumentAuditCsv } from '../../services/auditApi'
import type { DocumentAuditView } from '../../types/documentDetail'
import AuditLedgerTab from './AuditLedgerTab'

/**
 * The approval log for one document - who did what to it, when, and what they
 * said while doing it. This is the tab somebody opens when there is a dispute,
 * so its obligations are those of a record rather than a screen: every entry
 * that exists is shown, in the order it was given, attributed to somebody, and
 * labelled with what actually happened. A rejection that reads as an approval
 * here is worse than no log at all.
 *
 * The panel renders the same records twice - a table above the md breakpoint
 * and a stack of cards below it - and jsdom has no CSS, so both are in the
 * document during these tests. Assertions are scoped with `within(table)` or
 * by excluding anything inside a <table>, and which layout is being checked is
 * said out loud each time.
 */

vi.mock('../../services/auditApi', () => ({
  downloadDocumentAuditCsv: vi.fn(),
}))

const exportCsv = vi.mocked(downloadDocumentAuditCsv)

const DOC_ID = '3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c'

function entry(overrides: Partial<DocumentAuditView> = {}): DocumentAuditView {
  return {
    id: 'e-1',
    date: 'Sep 4, 2026',
    time: '14:02',
    user: 'Bilal Ahmed',
    role: 'Reviewer',
    action: 'Approved',
    comment: '—',
    ...overrides,
  }
}

function renderTab(records: DocumentAuditView[] = [entry()]) {
  return render(<AuditLedgerTab records={records} documentId={DOC_ID} />)
}

const table = () => screen.getByRole('table')
const bodyRows = () => within(table()).getAllByRole('row').slice(1)
const exportButton = () => screen.getByRole('button', { name: 'Export CSV' })

/**
 * The phone layout duplicates every record outside the table. `queryAllByText`
 * rather than `getAllByText` so that "the phone cards do NOT show this" is
 * expressible as a length of 0 instead of a thrown error.
 */
const onPhone = (text: string) =>
  screen.queryAllByText(text).filter(el => !el.closest('table'))

/** A promise the test resolves when it wants the export to finish. */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(res => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  // `restoreMocks` restores spies, not a module mock's call log.
  exportCsv.mockReset()
  exportCsv.mockResolvedValue(undefined)
})

describe('AuditLedgerTab', () => {
  it('says the log is empty instead of showing an empty table', () => {
    renderTab([])

    // An audit tab that renders headers over no rows reads as a fetch that
    // failed, and "the log did not load" is a very different statement from
    // "nothing has happened to this document yet".
    expect(screen.getByText('No audit records yet.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('genuinely disables the export when there is nothing to export', async () => {
    const user = userEvent.setup({ delay: null })
    renderTab([])

    expect(exportButton()).toBeDisabled()
    await user.click(exportButton())

    // A greyed-but-live button would hand somebody a CSV with a header row
    // and nothing under it, which they would then file as evidence.
    expect(exportCsv).not.toHaveBeenCalled()
  })

  it('names the table for a screen reader that lands on it out of context', () => {
    renderTab()

    // Six unnamed columns of dates and names could belong to any panel on the
    // page; the caption is what says these rows are this document's history.
    expect(
      screen.getByRole('table', { name: 'Audit ledger for this document' }),
    ).toBeInTheDocument()
  })

  it('heads every column so a cell can be read back with its meaning', () => {
    renderTab()

    // Without scope="col", "Bilal Ahmed / Reviewer / Approved" is three
    // unlabelled strings, and a screen reader user cannot tell the person who
    // acted from the role they acted in.
    expect(
      within(table())
        .getAllByRole('columnheader')
        .map(header => header.textContent),
    ).toEqual(['Date', 'Time', 'User', 'Role', 'Action', 'Comments'])
  })

  it('keeps the entries in the order they were given', () => {
    renderTab([
      entry({ id: 'e-1', user: 'Ayesha Khan', action: 'Document Uploaded' }),
      entry({ id: 'e-2', user: 'Bilal Ahmed', action: 'Revision Requested' }),
      entry({ id: 'e-3', user: 'Chandni Rao', action: 'Approved' }),
    ])

    // The order is the causality. A log that says the approval came before
    // the revision request describes a different sequence of events from the
    // one that happened.
    expect(bodyRows().map(row => within(row).getAllByRole('cell')[2].textContent)).toEqual(
      ['Ayesha Khan', 'Bilal Ahmed', 'Chandni Rao'],
    )
  })

  it('keeps a rejection labelled as a rejection', () => {
    renderTab([entry({ action: 'Rejected', user: 'Bilal Ahmed' })])

    // The badge is the only place the outcome is stated. Reading "Approved"
    // against a rejection would be a record that contradicts the document.
    const badge = within(table()).getByText('Rejected')
    // The badge abbreviates - "Revision Requested" prints as "Revision" - and
    // carries the unabbreviated action as its tooltip. That tooltip is the
    // only thing tying the word on screen back to the event the backend
    // recorded, so a badge that took the right tone from one action and its
    // text from another would still read correctly here without it.
    expect(badge).toHaveAttribute('title', 'Rejected')
    // And the word it replaced must be gone, not merely outvoted: a row that
    // says both is a row a reader resolves in whichever direction suits them.
    expect(within(table()).queryByText('Approved')).not.toBeInTheDocument()
  })

  it('renders an entry whose actor is missing without dropping the rest of the trail', () => {
    renderTab([
      entry({ id: 'e-1', user: 'Ayesha Khan', action: 'Document Uploaded' }),
      // A backend row whose user was deleted, or a system action with no
      // person behind it: `formatFullName('', '')` returns an empty string.
      entry({ id: 'e-2', user: '', role: '', action: 'Step Skipped' }),
      entry({ id: 'e-3', user: 'Chandni Rao', action: 'Approved' }),
    ])

    // One unattributable event must not take the two either side of it with
    // it. A log that silently omits the step that was skipped is a log that
    // shows a clean approval chain over an overridden one.
    expect(bodyRows()).toHaveLength(3)
    expect(within(table()).getByText('Skipped')).toBeInTheDocument()
    expect(within(table()).getByText('Ayesha Khan')).toBeInTheDocument()
    expect(within(table()).getByText('Chandni Rao')).toBeInTheDocument()
  })

  it('fills the empty comment column on the table but not on the phone card', () => {
    renderTab([
      entry({ id: 'e-1', comment: '—' }),
      entry({ id: 'e-2', user: 'Chandni Rao', comment: 'Clause 4 is wrong.' }),
    ])

    // In a table an empty final cell reads as a column that failed to render,
    // so the dash goes in: it says "this approver signed without saying
    // anything", which is a fact worth stating.
    expect(within(bodyRows()[0]).getAllByRole('cell')[5]).toHaveTextContent('—')

    // The phone card has no column to hold open, and the same dash there is a
    // paragraph of its own containing one punctuation mark - which a screen
    // reader announces, on every silent step, as "em dash". So the card drops
    // it. That branch is the one thing the two layouts deliberately disagree
    // on, and asserting the dash alone could never see it.
    expect(onPhone('—')).toHaveLength(0)
    expect(onPhone('Clause 4 is wrong.')).toHaveLength(1)
  })

  it('shows the comment an approver attached to their decision', () => {
    renderTab([
      entry({
        action: 'Revision Requested',
        comment: 'Clause 4 restates the indexation basis twice.',
      }),
    ])

    // The reason for a revision request is the actionable part of the entry;
    // an action with no reason sends the preparer back to guess.
    expect(
      within(table()).getByText('Clause 4 restates the indexation basis twice.'),
    ).toBeInTheDocument()
  })

  it('carries the same entry through to the phone layout', () => {
    renderTab([entry({ user: 'Bilal Ahmed', action: 'Rejected' })])

    // Below the table breakpoint the cards are the entire log. Anything they
    // leave out is simply unavailable on a phone.
    expect(onPhone('Bilal Ahmed')).toHaveLength(1)
    expect(onPhone('Rejected')).toHaveLength(1)
    expect(onPhone('14:02')).toHaveLength(1)
  })

  it('exports the log for the document on screen', async () => {
    const user = userEvent.setup({ delay: null })
    renderTab([entry()])

    await user.click(exportButton())

    // The CSV is what leaves the building. Exporting the previously opened
    // document's log under this document's name is a discovery problem, not
    // a UI one.
    expect(exportCsv).toHaveBeenCalledWith(DOC_ID)
  })

  it('blocks a second export while the first is still running', async () => {
    const user = userEvent.setup({ delay: null })
    const pending = deferred()
    exportCsv.mockReturnValue(pending.promise)
    renderTab([entry()])

    await user.click(exportButton())

    // Each click triggers a browser download; three impatient clicks means
    // three near-identical CSVs in the downloads folder and no way to tell
    // which one is complete.
    await waitFor(() => expect(exportButton()).toBeDisabled())
    expect(exportButton()).toHaveAttribute('aria-busy', 'true')

    await user.click(exportButton())
    expect(exportCsv).toHaveBeenCalledTimes(1)

    pending.resolve()
    await waitFor(() => expect(exportButton()).toBeEnabled())
  })

  it('survives a log long enough to need scrolling', () => {
    renderTab(
      Array.from({ length: 60 }, (_, index) =>
        entry({ id: `e-${index}`, user: `Approver ${index}` }),
      ),
    )

    // A record has no upper bound: a document that has bounced back and forth
    // between preparer and approvers accumulates dozens of entries, and every
    // one of them has to still be reachable.
    expect(bodyRows()).toHaveLength(60)
    expect(within(table()).getByText('Approver 59')).toBeInTheDocument()
  })

  it('does not paint a rejection in the approval colour on the phone layout', () => {
    renderTab([
      entry({ id: 'e-1', action: 'Rejected' }),
      entry({ id: 'e-2', action: 'Approved' }),
    ])

    // ActionBadge exists because this exact bug was fixed in the table: every
    // badge used to be drawn in accent, so a rejection rendered green - colour
    // asserting the opposite of the event it labelled. The phone cards below
    // the table still tint every badge with the approval colour, so the fix
    // reaches everybody on a laptop and nobody on a phone. The word is right;
    // the colour beside it says the document was approved.
    // Stated as a difference rather than as a class name on purpose. Naming
    // the token would make this marker go quiet the day somebody renames it,
    // which is the day it would be reporting a fix that never happened. Two
    // opposite outcomes rendered in identical classes is the defect itself,
    // in terms no restyle can satisfy by accident.
    // Compared on the badge, not on the text node: `ActionBadge` puts the
    // word in a bare span and the tone on the element around it, so reading
    // className off the text finds an empty string for both and would pass
    // whatever the colours were.
    const badge = (text: string) => {
      let node: HTMLElement | null = onPhone(text)[0] ?? null
      while (node && !node.className) node = node.parentElement
      return node?.className ?? ''
    }

    expect(badge('Rejected')).not.toBe('')
    expect(badge('Rejected')).not.toBe(badge('Approved'))
  })

  it('says so when the export fails, rather than going quiet', async () => {
    /*
     * This could not be written at all until `handleExport` had a `catch`:
     * the rejection escaped as an unhandled promise rejection and failed the
     * whole file. What it produced on screen was worse - the button stopped
     * spinning, no file arrived, and nothing said why. Somebody exporting an
     * approval log reads that as "there is nothing here to export".
     */
    const user = userEvent.setup({ delay: null })
    exportCsv.mockRejectedValueOnce(new Error('Audit export is unavailable.'))
    renderTab()

    await user.click(exportButton())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Audit export is unavailable.'
    )
  })

  it('offers the export again once it has failed', async () => {
    // A `finally` that never re-enabled the button would leave the only route
    // to this file behind a spinner until the page was reloaded.
    const user = userEvent.setup({ delay: null })
    exportCsv.mockRejectedValueOnce(new Error('Network request failed'))
    renderTab()

    await user.click(exportButton())
    await screen.findByRole('alert')

    expect(exportButton()).toBeEnabled()
  })

  it('clears a stale failure when the next export is started', async () => {
    /*
     * A red "Network request failed" left standing over a log that has just
     * exported cleanly tells somebody their download is bad and sends them
     * looking for a file that is already correct.
     */
    const user = userEvent.setup({ delay: null })
    exportCsv.mockRejectedValueOnce(new Error('Network request failed'))
    renderTab()

    await user.click(exportButton())
    await screen.findByRole('alert')

    exportCsv.mockResolvedValueOnce(undefined)
    await user.click(exportButton())

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  it('falls back to wording of its own when the failure carries none', async () => {
    // Rejections that are not Errors do reach here - an aborted fetch and a
    // non-JSON error body both arrive as something without a `.message`.
    const user = userEvent.setup({ delay: null })
    exportCsv.mockRejectedValueOnce('teapot')
    renderTab()

    await user.click(exportButton())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to download audit CSV'
    )
  })
})
