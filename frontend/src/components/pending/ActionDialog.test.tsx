import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, type Mock } from 'vitest'
import ActionDialog, { type ActionType } from './ActionDialog'

/**
 * The confirmation in front of the two actions that hand a document back.
 * Both are opened by a single keystroke from a list, so this dialog carries
 * the whole burden of "is this the document you meant, and do you mean it".
 *
 * Two things have to hold every time. A rejection or a revision request must
 * never leave here without a reason - the preparer receives the comment and
 * nothing else, so an empty one is a document returned with no way to act on
 * it. And the request must be sendable exactly once: a second reject lands
 * against a document that has already moved.
 */

/** A promise the test settles by hand, to hold the request in flight. */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Options {
  open?: boolean
  type?: ActionType
  documentTitle?: string
  onCancel?: Mock<() => void>
  onConfirm?: (comment: string) => Promise<void>
}

function renderDialog({
  open = true,
  type = 'reject',
  documentTitle = 'Warehouse lease extension',
  onCancel = vi.fn<() => void>(),
  onConfirm = vi.fn(async () => {}),
}: Options = {}) {
  const view = render(
    <>
      <button type="button">Queue row behind</button>
      <ActionDialog
        open={open}
        type={type}
        documentTitle={documentTitle}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </>,
  )

  return { ...view, onCancel, onConfirm: onConfirm as ReturnType<typeof vi.fn> }
}

const reason = () => screen.getByLabelText(/Reason for rejection|What needs to change/)
const confirmButton = (name: string) => screen.getByRole('button', { name })

describe('what the dialog says it is about to do', () => {
  it('names itself for the action, so a reader announces which one opened', () => {
    const { unmount } = renderDialog({ type: 'reject' })
    expect(screen.getByRole('dialog', { name: 'Reject document' })).toBeInTheDocument()
    unmount()

    renderDialog({ type: 'revision' })
    // R and X are adjacent keys on the same row of the queue. The name of the
    // dialog is the only thing that catches a mistyped one.
    expect(screen.getByRole('dialog', { name: 'Request revision' })).toBeInTheDocument()
  })

  it('says what each action does to the approval chain, and they are not the same', () => {
    const { unmount } = renderDialog({ type: 'reject' })
    expect(screen.getByText(/This ends the approval chain/)).toBeInTheDocument()
    unmount()

    renderDialog({ type: 'revision' })
    // One ends the submission and one sends it back for a new version. They
    // look alike on screen and are nothing alike to the preparer.
    expect(screen.getByText(/returns to the preparer/)).toBeInTheDocument()
    expect(screen.queryByText(/This ends the approval chain/)).not.toBeInTheDocument()
  })

  it('shows which document is about to be rejected', () => {
    renderDialog({ documentTitle: 'Fleet insurance renewal' })

    // The dialog can be opened by pressing X against whatever the cursor
    // happens to be on. Naming the document is the only confirmation that
    // the row under the cursor was the row that was meant.
    expect(screen.getByText('Fleet insurance renewal')).toBeInTheDocument()
  })

  it('still names the action when the document title is missing', () => {
    // The page passes '' if the document has left the queue underneath the
    // dialog. The dialog must not become anonymous when that happens.
    renderDialog({ documentTitle: '' })

    expect(screen.getByRole('dialog', { name: 'Reject document' })).toBeInTheDocument()
    // And it must still be operable: a dialog that renders its title and
    // nothing else is a confirmation nobody can answer or escape.
    expect(confirmButton('Reject document')).toBeInTheDocument()
    expect(confirmButton('Cancel')).toBeInTheDocument()
  })

  it('marks the reason as required in the field name, not only by rejecting it later', () => {
    const { unmount } = renderDialog({ type: 'reject' })

    // The asterisk has to be part of the name of the box itself. Loose in the
    // dialog it is a glyph a reader may never reach, and the field is then
    // announced as optional right up until the dialog refuses to send it.
    expect(reason()).toHaveAccessibleName('Reason for rejection *')
    unmount()

    renderDialog({ type: 'revision' })
    expect(reason()).toHaveAccessibleName('What needs to change *')
  })

  it('says how much room is left and stops where the field stops', async () => {
    const user = userEvent.setup({ delay: null })
    renderDialog()

    expect(screen.getByText('0 / 2000')).toBeInTheDocument()

    await user.type(reason(), 'Wrong annexe')

    // The counter is the only warning before the limit, and the limit has to
    // be on the field too - a comment cut off downstream loses its end
    // silently, which on a rejection is the half that says what to fix.
    expect(screen.getByText('12 / 2000')).toBeInTheDocument()
    expect(reason()).toHaveAttribute('maxlength', '2000')
  })

  it('renders nothing at all while closed', () => {
    renderDialog({ open: false })

    // Left mounted, it would still be holding Escape and the page's scroll
    // lock while the queue behind it is being driven from the keyboard.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(document.body.style.overflow).not.toBe('hidden')
  })

  it('stops the queue behind it scrolling, and gives it back on the way out', () => {
    const { unmount } = renderDialog()

    // The queue is a scroller driven by J and K. Left scrollable behind an
    // open dialog it moves under keys the dialog is not answering; left
    // locked after one closes, the queue is dead until the page reloads.
    expect(document.body.style.overflow).toBe('hidden')

    unmount()
    expect(document.body.style.overflow).not.toBe('hidden')
  })
})

describe('a rejection with no reason', () => {
  it('refuses to send an empty rejection and says why', async () => {
    const user = userEvent.setup({ delay: null })
    const { onConfirm } = renderDialog({ type: 'reject' })

    await user.click(confirmButton('Reject document'))

    // A rejection with no reason is unactionable: the preparer is told their
    // document is dead and nothing about what to do next.
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A reason is required when rejecting a document.',
    )
  })

  it('refuses whitespace as a reason', async () => {
    const user = userEvent.setup({ delay: null })
    const { onConfirm } = renderDialog()

    await user.type(reason(), '    ')
    await user.click(confirmButton('Reject document'))

    // A space is not a reason, and it would pass a naive length check.
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A reason is required when rejecting a document.',
    )
    // Still there to be corrected rather than wiped by the refusal.
    expect(reason()).toHaveValue('    ')
  })

  it('asks for a revision comment in the words of a revision', async () => {
    const user = userEvent.setup({ delay: null })
    const { onConfirm } = renderDialog({ type: 'revision' })

    await user.click(confirmButton('Request revision'))

    // "A reason is required when rejecting" on a revision request would tell
    // somebody they had just done something they had not.
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A comment is required when requesting a revision.',
    )
  })

  it('attaches the complaint to the box it is about', async () => {
    const user = userEvent.setup({ delay: null })
    renderDialog()

    await user.click(confirmButton('Reject document'))

    // Without this the message is a paragraph floating in the dialog: a
    // reader hears it once and never again while the person is in the field
    // that caused it.
    expect(reason()).toHaveAttribute('aria-invalid', 'true')
    expect(reason()).toHaveAccessibleDescription(
      'A reason is required when rejecting a document.',
    )
  })

  it('sends the reason once there is one, trimmed', async () => {
    const user = userEvent.setup({ delay: null })
    const { onConfirm } = renderDialog()

    await user.type(reason(), '   Annexe B is missing the signed schedule   ')
    await user.click(confirmButton('Reject document'))

    // The comment is quoted back to the preparer verbatim; leading spaces
    // are invisible there and shift the whole message in a fixed layout.
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith('Annexe B is missing the signed schedule'),
    )
  })
})

describe('while the request is in flight', () => {
  it('cannot be sent a second time', async () => {
    const user = userEvent.setup({ delay: null })
    const request = deferred()
    const onConfirm = vi.fn(() => request.promise)
    renderDialog({ onConfirm })

    await user.type(reason(), 'Wrong annexe')
    await user.click(confirmButton('Reject document'))

    const confirm = confirmButton('Reject document')
    expect(confirm).toBeDisabled()
    expect(confirm).toHaveAttribute('aria-busy', 'true')

    await user.click(confirm)

    // Two rejections is two audit entries, and the second one lands against
    // a document whose status has already changed.
    expect(onConfirm).toHaveBeenCalledTimes(1)

    request.resolve()
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
  })

  it('locks the reason so it cannot drift out of step with what was sent', async () => {
    const user = userEvent.setup({ delay: null })
    const request = deferred()
    renderDialog({ onConfirm: vi.fn(() => request.promise) })

    await user.type(reason(), 'Wrong annexe')
    await user.click(confirmButton('Reject document'))

    expect(reason()).toBeDisabled()

    request.resolve()
    await waitFor(() => expect(reason()).not.toBeDisabled())
  })

  it('refuses to be dismissed until the request settles', async () => {
    const user = userEvent.setup({ delay: null })
    const request = deferred()
    const { onCancel } = renderDialog({ onConfirm: vi.fn(() => request.promise) })

    await user.type(reason(), 'Wrong annexe')
    await user.click(confirmButton('Reject document'))

    expect(confirmButton('Cancel')).toBeDisabled()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Close dialog' }))

    // Closing mid-flight would hide the outcome of a rejection that is still
    // going to land, and take the typed reason with it.
    expect(onCancel).not.toHaveBeenCalled()

    request.resolve()
    await waitFor(() => expect(confirmButton('Cancel')).not.toBeDisabled())
  })
})

describe('when the request fails', () => {
  it('keeps what was typed and says what went wrong', async () => {
    const user = userEvent.setup({ delay: null })
    const request = deferred()
    renderDialog({ onConfirm: vi.fn(() => request.promise) })

    await user.type(reason(), 'Annexe B is missing the signed schedule')
    await user.click(confirmButton('Reject document'))
    request.reject(new Error('This document has already been approved'))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This document has already been approved',
    )
    // Retyping a rejection reason from memory is how the second attempt ends
    // up saying less than the first one did.
    expect(reason()).toHaveValue('Annexe B is missing the signed schedule')
    expect(screen.getByRole('dialog', { name: 'Reject document' })).toBeInTheDocument()
  })

  it('can be sent again once the failure has been read', async () => {
    const user = userEvent.setup({ delay: null })
    const first = deferred()
    const onConfirm = vi
      .fn<(comment: string) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(undefined)
    renderDialog({ onConfirm })

    await user.type(reason(), 'Wrong annexe')
    await user.click(confirmButton('Reject document'))
    first.reject(new Error('Network error'))
    await screen.findByRole('alert')

    await user.click(confirmButton('Reject document'))

    // A dialog that stayed disabled after a failed request would strand the
    // document in the queue with no way to act on it but a page reload.
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2))
    expect(onConfirm).toHaveBeenLastCalledWith('Wrong annexe')
    // And the failure has to go with the attempt that failed. "Network error"
    // left standing over a rejection that has now landed tells an approver
    // the opposite of what happened, on the screen where they decide whether
    // to try again. Asserted flat rather than through `waitFor`: the error is
    // cleared in the same handler that fires the retry, so if it is still on
    // screen once the retry has been sent it is not going to clear at all.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says something plain when the failure carries no message', async () => {
    const user = userEvent.setup({ delay: null })
    const request = deferred()
    renderDialog({ onConfirm: vi.fn(() => request.promise) })

    await user.type(reason(), 'Wrong annexe')
    await user.click(confirmButton('Reject document'))
    request.reject('boom')

    // Anything is better than a dialog that goes quiet and looks like it
    // worked when it did not.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The action could not be completed.',
    )
  })
})

describe('backing out and coming back', () => {
  it('backs out from Cancel without acting', async () => {
    const user = userEvent.setup({ delay: null })
    const { onCancel, onConfirm } = renderDialog()

    await user.type(reason(), 'Wrong annexe')
    await user.click(confirmButton('Cancel'))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('backs out from Escape too, without acting', async () => {
    const user = userEvent.setup({ delay: null })
    const { onCancel, onConfirm } = renderDialog()

    await user.type(reason(), 'Wrong annexe')
    await user.keyboard('{Escape}')

    // Escape is the only way out that does not need the mouse, and this
    // dialog is opened by a keystroke from a list. It has to close - and it
    // has to close without sending the reason sitting in the box.
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('opens empty the next time, rather than carrying the last reason over', async () => {
    const user = userEvent.setup({ delay: null })
    const onConfirm = vi.fn(async () => {})
    const { rerender } = render(
      <ActionDialog
        open
        type="reject"
        documentTitle="Warehouse lease extension"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    await user.type(reason(), 'Annexe B is missing the signed schedule')
    rerender(
      <ActionDialog
        open={false}
        type="reject"
        documentTitle="Warehouse lease extension"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    )
    rerender(
      <ActionDialog
        open
        type="reject"
        documentTitle="Fleet insurance renewal"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    // One document's rejection reason pre-filled against the next document
    // is a reason that describes something else entirely - and it would be
    // sent by whoever pressed the button without re-reading it.
    expect(reason()).toHaveValue('')
    expect(screen.getByText('Fleet insurance renewal')).toBeInTheDocument()
  })
})

describe('where the keyboard lands', () => {
  it('does not open with focus on the button that carries the action out', () => {
    renderDialog()

    // Somebody who hits Enter the instant the dialog appears - because they
    // were already typing - must not have rejected anything by doing so. The
    // empty-comment guard would catch it, but the focus is what makes that a
    // belt rather than the only line of defence.
    expect(confirmButton('Reject document')).not.toHaveFocus()
    // It lands in the reason box now rather than on the close button - the
    // dialog asks for a comment and will not proceed without one, so that is
    // where somebody has to start. Either satisfies the rule above; this one
    // also saves two Tab presses.
    expect(reason()).toHaveFocus()
  })

  it('puts the cursor in the box it asks you to fill in', () => {
    // Marked as a known failure. The textarea carries `autoFocus`, but the
    // dialog's own focus manager runs after React applies it and moves focus
    // to the close button, so the attribute does nothing. The comment is the
    // entire content of this dialog: a keyboard user has to Tab past two
    // controls before they can start typing the thing it will refuse to
    // proceed without.
    renderDialog()

    expect(reason()).toHaveFocus()
  })
})
