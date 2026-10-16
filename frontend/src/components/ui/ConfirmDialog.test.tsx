import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import ConfirmDialog from './ConfirmDialog'

/**
 * The last thing between somebody and an irreversible action: deleting a
 * workflow step, deleting every notification, abandoning a half-filled
 * submission. Two things have to hold every time. The button that carries out
 * the action must be the only one that does, and a confirmation already in
 * flight must not be sendable a second time - a double-pressed "Delete all"
 * is two delete requests, and the second one hits a list that has moved.
 *
 * jsdom has no layout and reports `offsetParent` as null for everything. The
 * focus trap reads that property to skip hidden controls, so the stub below
 * stands in the browser's answer. It is a jsdom gap, not app behaviour.
 */


interface Options {
  open?: boolean
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  pending?: boolean
  onConfirm?: () => void
  onCancel?: () => void
  children?: ReactNode
}

function renderConfirm({
  open = true,
  title = 'Delete all notifications?',
  confirmLabel = 'Delete all',
  cancelLabel,
  destructive = true,
  pending = false,
  onConfirm = vi.fn(),
  onCancel = vi.fn(),
  children = 'All 42 notifications will be removed. This cannot be undone.',
}: Options = {}) {
  const view = render(
    <>
      <button type="button">Page behind</button>
      <ConfirmDialog
        open={open}
        title={title}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        destructive={destructive}
        pending={pending}
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        {children}
      </ConfirmDialog>
    </>,
  )

  return { ...view, onConfirm, onCancel }
}

const button = (name: string) => screen.getByRole('button', { name })
const backdrop = () => screen.getByRole('dialog').parentElement as HTMLElement

describe('what a confirmation asks', () => {
  it('names itself with the question, so a reader announces what is at stake', () => {
    renderConfirm({ title: 'Delete the Legal review step?' })

    // "dialog" on its own tells a screen-reader user nothing about the fact
    // that the next Enter destroys something.
    expect(
      screen.getByRole('dialog', { name: 'Delete the Legal review step?' }),
    ).toBeInTheDocument()
  })

  it('shows the caller’s explanation of the consequence inside the prompt', () => {
    renderConfirm({ children: 'Every connection into or out of it goes too.' })

    // Scoped to the dialog. The consequence rendered outside the panel is text
    // an unsighted user never reaches - the reader is in modal mode and will
    // not read the page underneath - so "it is on screen somewhere" is not the
    // question worth asking about the sentence that explains what is lost.
    expect(
      within(screen.getByRole('dialog')).getByText(
        'Every connection into or out of it goes too.',
      ),
    ).toBeVisible()
  })

  it('labels the way out "Cancel" unless the caller says otherwise', () => {
    const { unmount } = renderConfirm()
    expect(button('Cancel')).toBeInTheDocument()
    unmount()

    renderConfirm({ cancelLabel: 'Keep editing' })
    expect(button('Keep editing')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })

  it('renders nothing while closed', () => {
    renderConfirm({ open: false })

    // A confirm dialog that stayed mounted invisibly would still be holding
    // the Escape key and the page's scroll lock.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete all' })).not.toBeInTheDocument()
  })
})

describe('which button does what', () => {
  it('carries out the action from the confirm button only', async () => {
    const user = userEvent.setup({ delay: null })
    const { onConfirm, onCancel } = renderConfirm({ confirmLabel: 'Delete all' })

    await user.click(button('Delete all'))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    // If cancel fired too, the caller would close the dialog and delete in
    // the same gesture - and any "are you sure" state would be lost.
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('backs out from Cancel without touching anything', async () => {
    const user = userEvent.setup({ delay: null })
    const { onConfirm, onCancel } = renderConfirm()

    await user.click(button('Cancel'))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('backs out on Escape', async () => {
    const user = userEvent.setup({ delay: null })
    const { onConfirm, onCancel } = renderConfirm()

    await user.keyboard('{Escape}')

    // Escape is a refusal. It must never be read as agreement.
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('treats the dialog’s own X as backing out, not as agreeing', async () => {
    const user = userEvent.setup({ delay: null })
    const { onConfirm, onCancel } = renderConfirm({ confirmLabel: 'Delete all' })

    await user.click(button('Close dialog'))

    // The X is inherited from Modal and is the control focus lands on when
    // the prompt opens, so it is the likeliest thing to be pressed by
    // accident. Wiring it to the wrong handler deletes on a dismissal.
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('reads a click on the dimmed area as backing out, never as agreeing', async () => {
    const user = userEvent.setup({ delay: null })
    const { onConfirm, onCancel } = renderConfirm({ confirmLabel: 'Delete all' })

    await user.click(backdrop())

    // This one also earns the pending case its meaning further down: without
    // it, "clicking the dim area while the delete is in flight does nothing"
    // would be equally true of a prompt whose backdrop never did anything at
    // all, and that test would be proving nothing about `pending`.
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('where the keyboard starts and where it can go', () => {
  it('never opens with focus on the destructive button', async () => {
    const user = userEvent.setup({ delay: null })
    const { onConfirm, onCancel } = renderConfirm({ confirmLabel: 'Delete all' })

    expect(button('Delete all')).not.toHaveFocus()
    expect(button('Close dialog')).toHaveFocus()

    await user.keyboard('{Enter}')

    // Somebody who hits Enter the instant the dialog appears - because they
    // were already typing - must not have deleted anything by doing so.
    expect(onConfirm).not.toHaveBeenCalled()
    // The press has to have landed on *something*, or "nothing was deleted"
    // is just as true of a dialog that ignores the keyboard entirely.
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('reaches Cancel before the destructive button when tabbing forward', async () => {
    const user = userEvent.setup({ delay: null })
    renderConfirm({ confirmLabel: 'Delete all' })

    await user.tab()
    expect(button('Cancel')).toHaveFocus()

    await user.tab()
    expect(button('Delete all')).toHaveFocus()
  })

  it('wraps from the destructive button back into the dialog, not out of it', async () => {
    const user = userEvent.setup({ delay: null })
    renderConfirm({ confirmLabel: 'Delete all' })

    await user.tab() // Close -> Cancel
    await user.tab() // Cancel -> Delete all
    await user.tab()

    expect(button('Close dialog')).toHaveFocus()
    // Focus reaching the page behind means the person is now operating a
    // screen that is dimmed out and covered.
    expect(button('Page behind')).not.toHaveFocus()
  })
})

describe('while the confirmation is in flight', () => {
  it('disables the confirm button so it cannot be sent twice', async () => {
    const user = userEvent.setup({ delay: null })
    const { onConfirm } = renderConfirm({ pending: true, confirmLabel: 'Delete all' })

    expect(button('Delete all')).toBeDisabled()

    await user.click(button('Delete all'))
    await user.click(button('Delete all'))

    // Genuinely disabled, not merely faded: two "Delete all" requests is two
    // passes over a list that changed underneath the second one.
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('says it is busy rather than going silent, and keeps its name', () => {
    const { unmount } = renderConfirm({ pending: false, confirmLabel: 'Delete all' })
    // Nothing is busy when nothing is in flight, or aria-busy would be noise
    // a reader learns to ignore by the time it means something.
    expect(
      screen.getByRole('dialog').querySelectorAll('[aria-busy="true"]'),
    ).toHaveLength(0)
    unmount()

    renderConfirm({ pending: true, confirmLabel: 'Delete all' })

    // Found by its busy state rather than by its name, so the name assertion
    // below is a real question: `button('Delete all')` would have answered it
    // inside the query and could never have failed.
    const busy = screen.getByRole('dialog').querySelectorAll('[aria-busy="true"]')
    // Without aria-busy, a screen-reader user gets a button that has simply
    // stopped responding, and presses it again.
    expect(busy).toHaveLength(1)
    // The spinner replaces the icon, never the label - "Delete all" has to
    // still be what the button is called while it works.
    expect(busy[0]).toHaveAccessibleName('Delete all')
    // And it is the confirm button that is busy, not the way out. Marking
    // Cancel busy would say the dismissal is the thing being processed.
    expect(button('Cancel')).not.toHaveAttribute('aria-busy')
  })

  it('disables Cancel too, since the request has already gone', async () => {
    const user = userEvent.setup({ delay: null })
    const { onCancel, onConfirm } = renderConfirm({ pending: true })

    expect(button('Cancel')).toBeDisabled()

    await user.click(button('Cancel'))

    // Disabled has to mean inert, not faded. Backing out of a delete that has
    // already left is the caller being told to undo something it cannot.
    expect(onCancel).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('makes the dialog’s own X inert as well', async () => {
    const user = userEvent.setup({ delay: null })
    const { onCancel, onConfirm } = renderConfirm({ pending: true })

    // The X is the one control still enabled and still focused while the
    // request runs, so it is the last remaining way to dismiss the prompt by
    // reflex. It has to be a no-op, not a cancel.
    expect(button('Close dialog')).toHaveFocus()

    await user.click(button('Close dialog'))
    await user.keyboard('{Enter}')

    expect(onCancel).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('does not let Escape close the dialog out from under the request', async () => {
    const user = userEvent.setup({ delay: null })
    const { onCancel } = renderConfirm({ pending: true })

    await user.keyboard('{Escape}')

    // Closing here would leave the person looking at a list that is about to
    // change with nothing on screen explaining why.
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('does not let a click on the dimmed area close it either', async () => {
    const user = userEvent.setup({ delay: null })
    const { onCancel, onConfirm } = renderConfirm({ pending: true })

    await user.click(backdrop())

    expect(onCancel).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('still holds the keyboard, even with both of its own buttons switched off', async () => {
    const user = userEvent.setup({ delay: null })
    renderConfirm({ pending: true, confirmLabel: 'Delete all' })

    // Disabled buttons are not in the tab ring, so while the request runs the
    // X is the only stop left in it. That is the edge the trap is likeliest to
    // fall off - a ring of one, where "move to the next control" and "wrap" are
    // the same move.
    expect(button('Close dialog')).toHaveFocus()

    await user.tab()
    expect(button('Close dialog')).toHaveFocus()

    await user.tab({ shift: true })
    expect(button('Close dialog')).toHaveFocus()

    // Focus out on the page behind means a person tabbing while they wait ends
    // up operating a screen that is dimmed, covered, and about to change.
    expect(button('Page behind')).not.toHaveFocus()
    expect(button('Delete all')).not.toHaveFocus()
  })
})

describe('how a destructive confirmation is signalled', () => {
  it('marks the destructive confirm with something other than its colour', () => {
    const ordinary = renderConfirm({ destructive: false, confirmLabel: 'Continue' })
    const ordinaryConfirm = button('Continue')
    const ordinaryClass = ordinaryConfirm.className
    expect(ordinaryConfirm).not.toHaveAttribute('aria-describedby')
    ordinary.unmount()

    renderConfirm({ destructive: true, confirmLabel: 'Continue' })
    const dangerous = button('Continue')

    // Colour is one of the differences, and is asserted because it used to be
    // the only one.
    expect(dangerous.className).not.toBe(ordinaryClass)

    /*
     * Described, not renamed.
     *
     * The warning has to reach somebody who has tabbed to the button and
     * hears nothing but it - callers name it "Continue", "OK" or "Yes" as
     * often as they name the act. Renaming the button carries it, and was
     * tried: it breaks what a voice-control user says out loud, and every
     * caller that finds the button by its own label. A description is
     * announced after the name and costs neither.
     */
    const describedBy = dangerous.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)).toHaveTextContent(
      /permanent action/i,
    )
  })

  it('says it in the dialog too, for everyone not using a screen reader', () => {
    // The other half of "not only its colour": somebody who cannot separate
    // the danger red from the accent and is reading the screen normally.
    renderConfirm({ destructive: true, confirmLabel: 'Continue' })

    expect(screen.getByText(/permanent action/i)).toBeVisible()
  })

  it('says nothing of the sort for an ordinary confirmation', () => {
    renderConfirm({ destructive: false, confirmLabel: 'Continue' })

    expect(screen.queryByText(/permanent action/i)).not.toBeInTheDocument()
  })
})
