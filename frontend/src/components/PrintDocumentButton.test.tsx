import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps, FormEvent } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordDocumentPrint } from '../services/documentDetailApi'
import { printDocumentFile } from '../utils/downloadDocument'
import PrintDocumentButton from './PrintDocumentButton'

/**
 * The control that puts the signed memo on paper.
 *
 * Paper leaves the system. Once a memo is in a folder, that sheet is the
 * record, and nobody looking at it can tell whether every approver had signed
 * when it came off the printer. So the two things this has to get right are:
 * it refuses anything that is not fully approved, and it tells the server that
 * a copy was taken - and it has to say so out loud when either of those goes
 * wrong, because a person who believes they printed an approved memo will file
 * it either way.
 */

vi.mock('../utils/downloadDocument', () => ({
  printDocumentFile: vi.fn(),
}))

vi.mock('../services/documentDetailApi', () => ({
  recordDocumentPrint: vi.fn(),
}))

const print = vi.mocked(printDocumentFile)
const recordPrint = vi.mocked(recordDocumentPrint)

const DOC_ID = '3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c'

type Props = ComponentProps<typeof PrintDocumentButton>

/**
 * Approved by default: that is the only state in which this control does
 * anything, so a test that renders any other status says so at its call site.
 */
function renderButton(overrides: Partial<Props> = {}) {
  return render(
    <PrintDocumentButton documentId={DOC_ID} status="approved" {...overrides} />,
  )
}

/** A promise the test resolves when it wants the print dialog to appear. */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  // `restoreMocks` restores spies, not the call log of a module mock.
  print.mockReset()
  print.mockResolvedValue(undefined)
  recordPrint.mockReset()
  recordPrint.mockResolvedValue(undefined)
})

describe('PrintDocumentButton', () => {
  it('is reachable by name, with the icon left out of the name', async () => {
    renderButton()

    // "Print Print" would be the name if the lucide icon were exposed; an
    // icon that repeats the label is noise in a screen reader.
    expect(await screen.findByRole('button', { name: 'Print' })).toBeInTheDocument()
  })

  it('takes the wording the surrounding screen needs', () => {
    renderButton({ label: 'Print memo' })

    expect(screen.getByRole('button', { name: 'Print memo' })).toBeInTheDocument()
  })

  it('takes the placement class the surrounding layout gives it', () => {
    const { container } = renderButton({ className: 'ml-auto' })

    // The one prop the screens this sits on use to place it. Drop the
    // passthrough and the button jumps position in the detail header with
    // nothing failing anywhere.
    const placed = container.querySelector('.ml-auto')
    expect(placed).not.toBeNull()
    expect(placed).toContainElement(screen.getByRole('button', { name: 'Print' }))
  })

  it('prints the document it is sitting next to', async () => {
    const user = userEvent.setup({ delay: null })
    renderButton()

    await user.click(screen.getByRole('button', { name: 'Print' }))

    expect(print).toHaveBeenCalledTimes(1)
    expect(print).toHaveBeenCalledWith(DOC_ID)
  })

  it('refuses to print a memo that is still going through its approvals', async () => {
    const user = userEvent.setup({ delay: null })
    renderButton({ status: 'pending_approval' })

    const button = screen.getByRole('button', { name: 'Print' })

    // A half-signed memo prints exactly like a finished one, and once it is
    // in a folder nobody can tell the difference. A styled-grey-but-clickable
    // button is how that sheet gets made.
    expect(button).toBeDisabled()
    await user.click(button)
    expect(print).not.toHaveBeenCalled()
  })

  it.each([
    ['draft' as const],
    ['pending_review' as const],
    ['revision_requested' as const],
    ['rejected' as const],
  ])('refuses to print a %s memo too', async status => {
    renderButton({ status })

    // Rejected is the one that matters most here: the file exists, it is
    // signed part of the way down, and printing it produces a document that
    // looks approved to everybody downstream.
    expect(screen.getByRole('button', { name: 'Print' })).toBeDisabled()
  })

  it('says why it cannot print, in words on the page rather than a tooltip', () => {
    renderButton({ status: 'pending_review' })

    const button = screen.getByRole('button', { name: 'Print' })
    const reason = screen.getByText('Not printable until every approver has signed')

    // A disabled button takes no focus and no hover from a keyboard, so a
    // `title` alone leaves the person who most needs the reason with a dead
    // control and no explanation of what would change it.
    expect(reason).toBeInTheDocument()
    expect(button).toHaveAttribute('aria-describedby', reason.id)
    expect(button).toHaveAttribute(
      'title',
      'Not printable until every approver has signed',
    )
  })

  it('says something different when the caller knows there is no file', () => {
    renderButton({ disabled: true })

    // An approved memo whose file is missing is a different problem from an
    // unapproved one, and "wait for the approvers" would be a lie about it.
    expect(screen.getByText('File not available')).toBeInTheDocument()
  })

  it('does not claim the memo is unprintable when it is not', () => {
    renderButton()

    // The other half of the contract: a permanent "not printable" line under
    // a working button is worse than none, because people stop pressing a
    // control they have been told is dead.
    expect(
      screen.queryByText('Not printable until every approver has signed'),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Print' })).toHaveAttribute(
      'title',
      'Print the approved memo',
    )
  })

  it('records the print, so a copy that leaves the building has a trail', async () => {
    const user = userEvent.setup({ delay: null })
    renderButton()

    await user.click(screen.getByRole('button', { name: 'Print' }))

    // The paper copy is untraceable by itself. This row is the only thing
    // that says who took it and when.
    await waitFor(() => expect(recordPrint).toHaveBeenCalledTimes(1))
    expect(recordPrint).toHaveBeenCalledWith(DOC_ID)
  })

  it('records the print only once the dialog is actually up', async () => {
    const user = userEvent.setup({ delay: null })
    const dialog = deferred()
    print.mockReturnValue(dialog.promise)
    renderButton()

    await user.click(screen.getByRole('button', { name: 'Print' }))

    // A DOCUMENT_PRINTED row written at the click would claim a copy exists
    // for every attempt that failed before the dialog ever opened - and an
    // auditor cannot tell those from real ones.
    expect(recordPrint).not.toHaveBeenCalled()

    dialog.resolve()

    await waitFor(() => expect(recordPrint).toHaveBeenCalledTimes(1))
  })

  it('does not record a print that never happened', async () => {
    const user = userEvent.setup({ delay: null })
    print.mockRejectedValue(new Error('The memo did not open for printing'))
    renderButton()

    await user.click(screen.getByRole('button', { name: 'Print' }))
    await screen.findByText('The memo did not open for printing')

    // The reverse of the row above: a trail full of prints nobody made is
    // just as unusable as one missing the prints they did.
    expect(recordPrint).not.toHaveBeenCalled()
  })

  it('still prints when the audit write fails, and says the print went unrecorded', async () => {
    const user = userEvent.setup({ delay: null })
    recordPrint.mockRejectedValue(new Error('Audit service unavailable'))
    const { container } = renderButton()

    await user.click(screen.getByRole('button', { name: 'Print' }))

    // Somebody holding an approved memo has to be able to print it while the
    // audit service is down - blocking that stops the work over a write
    // nobody in the room can fix.
    expect(print).toHaveBeenCalledTimes(1)

    const warning = await screen.findByText(
      'Printed, but this print was not recorded: Audit service unavailable',
    )
    // ...but it must not pass silently either. The trail is what a filed copy
    // gets checked against months later, and a print missing from it is a
    // copy nobody can account for.
    expect(warning.closest('[aria-live]')).toBe(container.querySelector('[aria-live]'))
  })

  it('does not hold the button hostage to the audit write', async () => {
    const user = userEvent.setup({ delay: null })
    // The audit service is not down, it is hanging - the worse of the two,
    // because nothing ever comes back to end the wait.
    recordPrint.mockReturnValue(new Promise(() => {}))
    renderButton()

    const button = screen.getByRole('button', { name: 'Print' })
    await user.click(button)

    // The dialog is already up and the person is printing. Leaving the
    // control spinning behind it says the print has not happened yet, and
    // the next memo they need cannot be started until the audit service
    // decides to answer - which, hanging, it never does.
    // Added after mutation testing: putting an `await` in front of the audit
    // call broke nothing, because every test until this one handed it a
    // promise that had already settled.
    expect(print).toHaveBeenCalledTimes(1)
    expect(button).not.toBeDisabled()
    expect(button).not.toHaveAttribute('aria-busy')
  })

  it('clears the unrecorded warning once a later print is recorded', async () => {
    const user = userEvent.setup({ delay: null })
    recordPrint.mockRejectedValueOnce(new Error('Audit service unavailable'))
    const { container } = renderButton()

    const button = screen.getByRole('button', { name: 'Print' })
    await user.click(button)
    await screen.findByText(
      'Printed, but this print was not recorded: Audit service unavailable',
    )

    await user.click(button)
    await waitFor(() => expect(recordPrint).toHaveBeenCalledTimes(2))

    // Left standing, the line accuses the print that just succeeded. The
    // person reprints, or goes looking for a trail entry that is there -
    // and the next real unrecorded print is one they have learned to ignore.
    // Added after mutation testing: dropping the reset broke nothing. The
    // error line beside it was pinned by the retry test; this one was not.
    expect(container.querySelector('[aria-live]')).toBeEmptyDOMElement()
  })

  it('refuses a second activation landing in the same tick as the first', () => {
    print.mockReturnValue(deferred().promise)
    renderButton()
    const button = screen.getByRole('button', { name: 'Print' })

    // Both handlers run before React has re-rendered the button as disabled,
    // so both close over `loading === false` and the guard waves both
    // through: two print dialogs, and two DOCUMENT_PRINTED rows for one memo
    // somebody meant to print once - which is exactly the count an auditor
    // reads as two copies in circulation.
    // A pin, not a passing test: the guard is state, and state is a render
    // behind. A ref set synchronously in the handler is what would close it.
    // Separate native clicks each get their own task and are already
    // refused; this is the same-task path - a bulk "print selected" that
    // calls .click() across a list, or a synthetic replay.
    // DownloadDocumentButton has the identical shape and the same gap.
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })

    expect(print).toHaveBeenCalledTimes(1)
  })

  it('marks itself busy and refuses a second click while the dialog is coming', async () => {
    const user = userEvent.setup({ delay: null })
    const dialog = deferred()
    print.mockReturnValue(dialog.promise)
    const { container } = renderButton()

    const button = screen.getByRole('button', { name: 'Print' })
    expect(button).not.toHaveAttribute('aria-busy')

    await user.click(button)

    // An impatient second click on a slow connection is two print dialogs
    // and, if both go through, two copies of the memo in the tray.
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    // The printer icon is swapped for a spinner while this runs. The name has
    // to survive that swap - a control that renames itself mid-request is one
    // a screen reader user has just lost track of.
    expect(screen.getByRole('button', { name: 'Print' })).toBe(button)
    await user.click(button)
    expect(print).toHaveBeenCalledTimes(1)

    dialog.resolve()
    await waitFor(() => expect(button).not.toBeDisabled())
    // Coming back is the other half: still busy after the dialog is up and
    // assistive tech goes on describing a finished job as running.
    expect(button).not.toHaveAttribute('aria-busy')
    await waitFor(() => expect(recordPrint).toHaveBeenCalled())
    // ...and a print that worked says nothing. A leftover line under a button
    // that just succeeded is worse than no message at all.
    expect(container.querySelector('[aria-live]')).toBeEmptyDOMElement()
  })

  it('shows why the print failed, where a screen reader will hear it', async () => {
    const user = userEvent.setup({ delay: null })
    print.mockRejectedValue(new Error('The print dialog could not be opened'))
    const { container } = renderButton()

    // The region has to already be in the page before the failure arrives. A
    // live region inserted at the same moment as its first message is not
    // announced by NVDA or VoiceOver.
    const region = container.querySelector('[aria-live]')
    expect(region).not.toBeNull()
    expect(region).toBeEmptyDOMElement()

    await user.click(screen.getByRole('button', { name: 'Print' }))

    const message = await screen.findByText('The print dialog could not be opened')
    // The failure lands long after the click, so it has to be announced; a
    // silent red line means somebody walks to the printer for nothing.
    expect(message.closest('[aria-live]')).toBe(region)
    // `assertive` would interrupt whatever is being read; `off` is silence.
    expect(region).toHaveAttribute('aria-live', 'polite')
    // Without aria-atomic a message replacing an earlier one is announced as
    // only the words that changed, which for two similar failures is a
    // fragment of a sentence.
    expect(region).toHaveAttribute('aria-atomic', 'true')
  })

  it('falls back to plain words when the failure is not an Error', async () => {
    const user = userEvent.setup({ delay: null })
    print.mockRejectedValue('kaboom')
    renderButton()

    await user.click(screen.getByRole('button', { name: 'Print' }))

    // Otherwise the person reads "undefined", or nothing at all.
    expect(await screen.findByText('Print failed')).toBeInTheDocument()
  })

  it('lets the person try again after a failure', async () => {
    const user = userEvent.setup({ delay: null })
    print.mockRejectedValueOnce(new Error('The memo did not open for printing'))
    renderButton()

    const button = screen.getByRole('button', { name: 'Print' })
    await user.click(button)
    await screen.findByText('The memo did not open for printing')

    // A button that stayed disabled after a transient failure would strand
    // somebody who needs the signed copy in front of them today.
    expect(button).not.toBeDisabled()
    expect(button).not.toHaveAttribute('aria-busy')

    await user.click(button)

    // The stale error must clear the moment the retry starts, or a print that
    // worked still looks like it failed.
    expect(
      screen.queryByText('The memo did not open for printing'),
    ).not.toBeInTheDocument()
    expect(print).toHaveBeenCalledTimes(2)
  })

  it('does not submit the form it is rendered inside', async () => {
    const user = userEvent.setup({ delay: null })
    const submit = vi.fn((event: FormEvent) => event.preventDefault())
    render(
      <form onSubmit={submit}>
        <PrintDocumentButton documentId={DOC_ID} status="approved" />
      </form>,
    )

    await user.click(screen.getByRole('button', { name: 'Print' }))

    // A button with no explicit type submits. On the review form this sits
    // beside, that would post the form and navigate away mid-print.
    expect(submit).not.toHaveBeenCalled()
    expect(print).toHaveBeenCalledTimes(1)
  })

  it('does not open the document row it sits inside', async () => {
    const user = userEvent.setup({ delay: null })
    const openRow = vi.fn()
    render(
      <div onClick={openRow}>
        <PrintDocumentButton documentId={DOC_ID} status="approved" />
      </div>,
    )

    await user.click(screen.getByRole('button', { name: 'Print' }))

    // These buttons live on clickable rows. Without stopPropagation, printing
    // would also navigate away from the list mid-fetch.
    expect(openRow).not.toHaveBeenCalled()
    expect(print).toHaveBeenCalledTimes(1)
  })

  it('is operable from the keyboard alone', async () => {
    const user = userEvent.setup({ delay: null })
    renderButton()

    await user.tab()

    expect(screen.getByRole('button', { name: 'Print' })).toHaveFocus()
    await user.keyboard('{Enter}')

    // Printing the signed memo is the whole point of the control; a
    // mouse-only path puts it out of reach of a keyboard or a switch.
    expect(print).toHaveBeenCalledTimes(1)
  })
})
