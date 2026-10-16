import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import Modal from './Modal'

/**
 * Every dialog in the product is this component. It is where somebody signs
 * a document, rejects one, or is asked to confirm a deletion - so what it
 * announces, whether it can be dismissed by accident, and whether a keyboard
 * user can get out of it are all questions about a real document, not about
 * styling. A modal that closes on a stray click loses whatever was typed in
 * it; one that names itself badly is opened blind by a screen-reader user.
 *
 * jsdom has no layout and reports `offsetParent` as null for everything. The
 * focus trap reads that property to skip hidden controls, so the stub below
 * stands in the browser's answer. It is a jsdom gap, not app behaviour.
 */


/**
 * `size` is deliberately absent: it selects a max-width class and nothing
 * else, so the only assertion available is on the class name itself, which a
 * restyle breaks without a single behaviour changing. Plumbing it through
 * here would advertise coverage this file does not have.
 */
interface Options {
  open?: boolean
  onClose?: () => void
  title?: string
  description?: string
  children?: ReactNode
}

/**
 * The modal with a control on the page behind it, which is where focus goes
 * if the trap leaks and what a mis-aimed dismissal would expose.
 */
function renderModal({
  open = true,
  onClose = vi.fn(),
  title = 'Request a revision',
  description,
  children = (
    <>
      <input aria-label="Reason" />
      <button type="button">Send it back</button>
    </>
  ),
}: Options = {}) {
  const view = render(
    <>
      <button type="button">Page behind</button>
      <Modal open={open} onClose={onClose} title={title} description={description}>
        {children}
      </Modal>
    </>,
  )

  return { ...view, onClose }
}

const dialog = () => screen.getByRole('dialog')
const backdrop = () => dialog().parentElement as HTMLElement
const button = (name: string) => screen.getByRole('button', { name })

describe('what a Modal announces', () => {
  it('takes its accessible name from the title, so a reader says what opened', () => {
    renderModal({ title: 'Reject this document?' })

    // An unnamed dialog is announced as just "dialog"; the person then has to
    // go looking for what it is they have been dropped into.
    expect(screen.getByRole('dialog', { name: 'Reject this document?' })).toBeInTheDocument()
  })

  it('marks itself modal so a reader stops browsing the page underneath', () => {
    renderModal()

    expect(dialog()).toHaveAttribute('aria-modal', 'true')
  })

  it('attaches the subtitle as the dialog description', () => {
    renderModal({ description: 'The preparer will be asked to amend it.' })

    // The subtitle is usually the consequence of the action. It has to be
    // announced with the title, not left as loose text the reader may skip.
    expect(dialog()).toHaveAccessibleDescription('The preparer will be asked to amend it.')

    // ...and it has to be the subtitle on screen that is being pointed at.
    // `aria-describedby` resolves hidden text just as happily as visible text,
    // so on its own the line above also holds for a modal that announces a
    // consequence nobody sighted is being shown.
    expect(
      within(dialog()).getByText('The preparer will be asked to amend it.'),
    ).toBeVisible()
  })

  it('leaves the description off entirely when there is no subtitle', () => {
    renderModal()

    // A dangling aria-describedby pointing at an element that was never
    // rendered makes some readers announce nothing at all for the dialog.
    expect(dialog()).not.toHaveAttribute('aria-describedby')
  })

  it('gives the icon-only close button a name and hides the X from the reader', () => {
    renderModal({ children: <button type="button">Send it back</button> })

    // Found by having no text of its own, not by the name being asserted -
    // `getByRole('button', { name: 'Close dialog' })` would have decided the
    // question in the query and left the expectation below unable to fail.
    const iconOnly = within(dialog())
      .getAllByRole('button')
      .filter(el => !el.textContent?.trim())

    expect(iconOnly).toHaveLength(1)
    // An unlabelled icon button is announced as "button" - the one control
    // guaranteed to be in every dialog would be the least identifiable.
    expect(iconOnly[0]).toHaveAccessibleName('Close dialog')
    // And the glyph must not be exposed alongside it, or the name becomes the
    // label plus whatever the icon set decided to call its path.
    expect(iconOnly[0].querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('renders the body inside the labelled panel, not loose on the backdrop', () => {
    renderModal({ children: <p>Version 3 will be withdrawn from the queue.</p> })

    // Scoped to the dialog on purpose. Body content that rendered as a sibling
    // of the panel would still be on screen and `getByText` would still find
    // it - while a reader in modal mode would never reach it, and a click on
    // it would land on the backdrop and throw the dialog away.
    expect(
      within(dialog()).getByText('Version 3 will be withdrawn from the queue.'),
    ).toBeVisible()
  })
})

describe('a closed Modal', () => {
  it('renders nothing at all', () => {
    renderModal({ open: false, children: <p>Secret draft note</p> })

    // Not merely hidden: a modal that rendered its body while closed would
    // have already fired the effects and requests inside it.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Secret draft note')).not.toBeInTheDocument()
  })

  it('leaves the page behind scrollable', () => {
    // Set deliberately: asserting '' would also hold for a modal whose lock
    // never ran at all, which is the thing this is supposed to distinguish.
    document.body.style.overflow = 'scroll'

    renderModal({ open: false })

    expect(document.body.style.overflow).toBe('scroll')
  })
})

describe('dismissing a Modal', () => {
  it('closes from the close button, once', async () => {
    const user = userEvent.setup({ delay: null })
    const { onClose } = renderModal()

    await user.click(button('Close dialog'))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes when the dimmed area outside the panel is clicked', async () => {
    const user = userEvent.setup({ delay: null })
    const { onClose } = renderModal()

    await user.click(backdrop())

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stays open when the click lands inside the panel', async () => {
    const user = userEvent.setup({ delay: null })
    const { onClose } = renderModal()

    await user.click(screen.getByRole('heading', { name: 'Request a revision' }))
    await user.click(screen.getByLabelText('Reason'))

    // Clicking a heading or a field inside a form is not a request to throw
    // the form away; if it were, half-written rejections would vanish.
    expect(onClose).not.toHaveBeenCalled()
  })

  it(
    'does not close when a drag that began inside the panel ends on the dimmed area',
    async () => {
      const user = userEvent.setup({ delay: null })
      const { onClose } = renderModal()

      // Selecting the text of a reason and releasing past the edge of the
      // panel. The browser fires the click on the nearest common ancestor of
      // the press and the release - which is the backdrop.
      await user.pointer([
        { keys: '[MouseLeft>]', target: screen.getByLabelText('Reason') },
        { keys: '[/MouseLeft]', target: backdrop() },
      ])

      // DEFECT: the modal closes and the typed reason is gone. The backdrop
      // decides on `click` alone; it needs to check that the press started on
      // the backdrop too (record the `mousedown` target and compare).
      expect(onClose).not.toHaveBeenCalled()
    },
  )

  it('closes on Escape', async () => {
    const user = userEvent.setup({ delay: null })
    const { onClose } = renderModal()

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('asks to be closed rather than closing itself', async () => {
    const user = userEvent.setup({ delay: null })
    // `open` stays true throughout: this stands in for a caller that hears
    // the request and declines it.
    const { onClose } = renderModal()

    await user.click(button('Close dialog'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('dialog')).toBeInTheDocument()

    await user.click(backdrop())
    expect(onClose).toHaveBeenCalledTimes(3)

    // A modal that hid itself on any of those three would be uncontrollable:
    // ConfirmDialog holds itself open through exactly this route while a
    // delete is in flight, by passing an onClose that does nothing.
    expect(screen.queryByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('Reason')).toBeVisible()
  })
})

describe('keyboard handling in a Modal', () => {
  it('moves focus into the dialog when it opens', async () => {
    renderModal()

    // The close button is the first control in the panel, and a harmless one
    // to land on - unlike the action button, which a hurried Enter would fire.
    expect(button('Close dialog')).toHaveFocus()
    expect(button('Send it back')).not.toHaveFocus()
  })

  it('keeps Tab inside the dialog rather than letting it reach the page behind', async () => {
    const user = userEvent.setup({ delay: null })
    renderModal()

    await user.tab() // Close -> Reason
    await user.tab() // Reason -> Send it back
    expect(button('Send it back')).toHaveFocus()

    await user.tab()

    expect(button('Close dialog')).toHaveFocus()
    expect(button('Page behind')).not.toHaveFocus()
  })

  it('wraps backwards out of the first control to the last', async () => {
    const user = userEvent.setup({ delay: null })
    renderModal()

    await user.tab({ shift: true })

    expect(button('Send it back')).toHaveFocus()
  })

  it('still traps when the body has no controls in it', async () => {
    const user = userEvent.setup({ delay: null })
    renderModal({ children: <p>Nothing to do here yet.</p> })

    await user.tab()

    // The close button is then the whole ring. Tab has to stay on it rather
    // than stepping out to a page the person cannot see.
    expect(button('Close dialog')).toHaveFocus()
    expect(button('Page behind')).not.toHaveFocus()
  })

  it('returns focus to the button that opened it', async () => {
    const user = userEvent.setup({ delay: null })

    function Screen() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Request revision
          </button>
          <Modal open={open} onClose={() => setOpen(false)} title="Request a revision">
            <button type="button">Send it back</button>
          </Modal>
        </>
      )
    }

    render(<Screen />)
    await user.click(button('Request revision'))
    expect(button('Close dialog')).toHaveFocus()

    await user.keyboard('{Escape}')

    // A keyboard user who opened this from a row action has to be put back on
    // that row action, not at the top of a long document page.
    expect(button('Request revision')).toHaveFocus()
  })
})

describe('the page behind an open Modal', () => {
  it('stops scrolling while the dialog is open and puts back what it found', async () => {
    const user = userEvent.setup({ delay: null })

    // Deliberately not the default. Asserting `''` afterwards would hold both
    // for a modal that restored the page and for one that simply wiped the
    // property on the way out - and wiping it is the bug: a screen that had
    // set its own overflow gets silently un-set by any dialog opened over it.
    document.body.style.overflow = 'scroll'

    function Screen() {
      const [open, setOpen] = useState(true)
      return (
        <Modal open={open} onClose={() => setOpen(false)} title="Request a revision">
          <button type="button">Send it back</button>
        </Modal>
      )
    }

    render(<Screen />)
    expect(document.body.style.overflow).toBe('hidden')

    await user.keyboard('{Escape}')

    // Left locked, the whole app would be stuck unable to scroll with no
    // dialog on screen to explain why.
    expect(document.body.style.overflow).toBe('scroll')
  })
})
