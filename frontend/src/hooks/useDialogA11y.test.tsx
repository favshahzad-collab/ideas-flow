import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useDialogA11y } from './useDialogA11y'

/**
 * This hook is the entire keyboard contract for every dialog in the product -
 * the modals, the confirm prompts, the command palette, the mobile drawer.
 * If it slips, a keyboard-only or screen-reader user tabs straight out of an
 * open dialog into the page behind it and starts operating controls they
 * cannot see, or presses Escape on a prompt that will not let go, or lands
 * back at the top of the page having lost the button they opened it from.
 *
 * Everything here goes through a small component that uses the hook, because
 * what is being asserted is what happens to the DOM and to focus - not what
 * the hook returns.
 *
 * jsdom has no layout, so `offsetParent` is `null` for every element in it.
 * The hook reads that property to skip hidden controls, so the stub below
 * stands in the browser's answer for it. It is a jsdom gap, not application
 * behaviour: an element that is in the document and not display:none has an
 * offset parent, and one that is hidden does not.
 */


/** A dialog panel with the hook attached, and nothing else going on. */
function Panel({
  open,
  onClose,
  children,
}: {
  open: boolean
  onClose: () => void
  children?: ReactNode
}) {
  const panelRef = useDialogA11y(open, onClose)
  if (!open) return null

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Reassign step"
      tabIndex={-1}
    >
      {children ?? (
        <>
          <button type="button">Reassign</button>
          <input aria-label="Reason" />
          <button type="button">Send</button>
        </>
      )}
    </div>
  )
}

/**
 * The panel plus a control on the page behind it. That control is the point:
 * it is where focus goes if the trap leaks, and it is what a stray Escape
 * would reach if the hook let the event through.
 */
function Screen({
  open,
  onClose,
  children,
  onPageKeyDown,
}: {
  open: boolean
  onClose: () => void
  children?: ReactNode
  onPageKeyDown?: (event: KeyboardEvent) => void
}) {
  return (
    <div onKeyDown={onPageKeyDown}>
      <button type="button">Page behind</button>
      <Panel open={open} onClose={onClose}>
        {children}
      </Panel>
    </div>
  )
}

function renderScreen({
  open = true,
  onClose = vi.fn(),
  children,
  onPageKeyDown,
}: {
  open?: boolean
  onClose?: () => void
  children?: ReactNode
  onPageKeyDown?: (event: KeyboardEvent) => void
} = {}) {
  const view = render(
    <Screen open={open} onClose={onClose} onPageKeyDown={onPageKeyDown}>
      {children}
    </Screen>,
  )

  return {
    ...view,
    onClose,
    setOpen(next: boolean, nextOnClose: () => void = onClose) {
      view.rerender(
        <Screen open={next} onClose={nextOnClose} onPageKeyDown={onPageKeyDown}>
          {children}
        </Screen>,
      )
    },
  }
}

const dialog = () => screen.getByRole('dialog', { name: 'Reassign step' })
const button = (name: string) => screen.getByRole('button', { name })

describe('opening a dialog', () => {
  it('moves focus to the first control inside the panel', () => {
    renderScreen()

    // Without this the caret is still on the page behind, so the first thing
    // a keyboard user types goes somewhere they cannot see.
    expect(button('Reassign')).toHaveFocus()
  })

  it('falls back to the panel itself when there is nothing to focus yet', () => {
    renderScreen({ children: <p>Loading the step…</p> })

    // A dialog that is still loading has no controls. Focus has to land
    // *somewhere* inside it, or the next Tab starts from the page behind.
    expect(dialog()).toHaveFocus()
  })

  it('takes focus in again every time it is reopened, and aims the return trip afresh', async () => {
    const user = userEvent.setup({ delay: null })

    // A second way in, so the two openings are not from the same control and
    // "focus went back" cannot be satisfied by a restore target captured once
    // and never updated.
    const secondTrigger = document.createElement('button')
    secondTrigger.textContent = 'Reassign from the row menu'
    document.body.appendChild(secondTrigger)

    const { setOpen } = renderScreen({ open: false })

    await user.click(button('Page behind'))
    setOpen(true)
    expect(button('Reassign')).toHaveFocus()

    setOpen(false)
    expect(button('Page behind')).toHaveFocus()

    await user.click(secondTrigger)
    setOpen(true)

    // Screens keep one dialog mounted and toggle `open` all day. A hook that
    // moved focus on mount rather than on open would do this correctly once
    // and then leave the caret out on the page for every reopen after it -
    // the failure nobody reproduces, because the first try always works.
    expect(button('Reassign')).toHaveFocus()

    setOpen(false)

    // ...and it has to go back to *this* opening's trigger, not to the one
    // that opened it the first time - which is a control that may well not be
    // on screen any more.
    expect(secondTrigger).toHaveFocus()
    expect(button('Page behind')).not.toHaveFocus()

    secondTrigger.remove()
  })

  it('stops the page behind from scrolling', () => {
    renderScreen()

    expect(document.body.style.overflow).toBe('hidden')
  })

  it('leaves the page scrollable while the dialog is closed', () => {
    // Set deliberately, so this cannot pass just because '' is the default a
    // hook that never ran would also have left behind.
    document.body.style.overflow = 'scroll'

    renderScreen({ open: false })

    // A hook that locked on mount rather than on open would freeze the page
    // for every dialog in the tree that has not been opened.
    expect(document.body.style.overflow).toBe('scroll')
  })

  it('does not answer Escape while it is closed', async () => {
    const user = userEvent.setup({ delay: null })
    const { onClose } = renderScreen({ open: false })

    await user.keyboard('{Escape}')

    // Screens mount their dialogs closed and leave them mounted. A hook that
    // bound its listener regardless of `open` would mean every unopened
    // dialog on the page fires its close handler on one Escape press.
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('Escape', () => {
  it('closes the dialog once for one press', async () => {
    const user = userEvent.setup({ delay: null })
    const { onClose } = renderScreen()

    await user.keyboard('{Escape}')

    // Twice would mean two handlers are live, and a confirm dialog stacked
    // over a modal would take both of them down together.
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the press from reaching the screen behind it, but only that press', async () => {
    const user = userEvent.setup({ delay: null })
    const onPageKeyDown = vi.fn()
    renderScreen({ onPageKeyDown })

    // Control first. Without it, "the page never heard Escape" would also be
    // true of a page that never hears anything - a mis-wired handler, a
    // detached tree - and the assertion below would be proving nothing.
    await user.keyboard('a')
    expect(onPageKeyDown).toHaveBeenCalledTimes(1)
    onPageKeyDown.mockClear()

    await user.keyboard('{Escape}')

    // The page behind commonly binds Escape too - to clear a search box, to
    // deselect a row. Dismissing a dialog must not also do that.
    expect(onPageKeyDown).not.toHaveBeenCalled()

    // ...and the hook must swallow Escape only. A trap that stopped every key
    // would cut off the shortcuts the dialog's own contents rely on.
    await user.keyboard('{Enter}')
    expect(onPageKeyDown).toHaveBeenCalledTimes(1)
  })

  it('closes even while the caret is in a field inside the dialog', async () => {
    const user = userEvent.setup({ delay: null })
    const { onClose } = renderScreen()

    await user.click(screen.getByLabelText('Reason'))
    await user.type(screen.getByLabelText('Reason'), 'Wrong reviewer')
    await user.keyboard('{Escape}')

    // Half-typed text is exactly when somebody wants out.
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('uses the latest close handler without dragging focus back on a re-render', async () => {
    const user = userEvent.setup({ delay: null })
    const first = vi.fn()
    const second = vi.fn()
    const { setOpen } = renderScreen({ onClose: first })

    await user.tab()
    expect(screen.getByLabelText('Reason')).toHaveFocus()

    setOpen(true, second)

    // The parent re-rendering mid-edit must not yank the caret back to the
    // first control - that would eat the next keystroke on every render.
    expect(screen.getByLabelText('Reason')).toHaveFocus()

    await user.keyboard('{Escape}')

    // ...and the stale handler must not be the one that runs, or the dialog
    // closes by calling back into a parent state that no longer exists.
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('leaves the dialog underneath open when a stacked one is dismissed', () => {
    const underneath = vi.fn()
    const onTop = vi.fn()

    render(
      <>
        <Panel open onClose={underneath} />
        <Panel open onClose={onTop} />
      </>,
    )

    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )

    expect(onTop).toHaveBeenCalledTimes(1)
    // DEFECT: both dialogs close. Every instance of the hook binds its own
    // capture listener on `document`, and `stopPropagation` does not stop
    // listeners already bound to the same node - that needs
    // stopImmediatePropagation, or a stack that only lets the topmost dialog
    // answer. Backing out of a confirm prompt therefore also discards the
    // modal that raised it, along with whatever was typed into it.
    expect(underneath).not.toHaveBeenCalled()
  })
})

describe('Tab', () => {
  it('wraps from the last control back to the first instead of leaving the dialog', async () => {
    const user = userEvent.setup({ delay: null })
    renderScreen()

    await user.tab() // Reassign -> Reason
    await user.tab() // Reason -> Send
    expect(button('Send')).toHaveFocus()

    await user.tab()

    expect(button('Reassign')).toHaveFocus()
    // The whole reason for a trap: the page behind is inert and covered, so
    // focus landing there is focus that has disappeared.
    expect(button('Page behind')).not.toHaveFocus()
  })

  it('wraps backwards from the first control to the last', async () => {
    const user = userEvent.setup({ delay: null })
    renderScreen()

    await user.tab({ shift: true })

    expect(button('Send')).toHaveFocus()
  })

  it('wraps backwards from the panel itself to the last control', async () => {
    const user = userEvent.setup({ delay: null })
    renderScreen()

    // Clicking the dialog's own background focuses the panel; a Shift+Tab
    // from there would otherwise walk out into the page behind.
    await user.click(dialog())
    expect(dialog()).toHaveFocus()

    await user.tab({ shift: true })

    expect(button('Send')).toHaveFocus()
  })

  it('ignores a hidden control when deciding where the ring ends', async () => {
    const user = userEvent.setup({ delay: null })
    renderScreen({
      children: (
        <>
          <button type="button">Reassign</button>
          <button type="button">Send</button>
          <button type="button" style={{ display: 'none' }}>
            Delete draft
          </button>
        </>
      ),
    })

    await user.tab() // Reassign -> Send
    await user.tab()

    // If the hidden button counted as the last stop, nothing would wrap and
    // Tab would carry focus out of the dialog entirely.
    expect(button('Reassign')).toHaveFocus()
  })

  it('ignores a disabled control when deciding where the ring ends', async () => {
    const user = userEvent.setup({ delay: null })
    renderScreen({
      children: (
        <>
          <button type="button">Reassign</button>
          <button type="button">Send</button>
          <button type="button" disabled>
            Delete draft
          </button>
        </>
      ),
    })

    await user.tab() // Reassign -> Send
    expect(button('Send')).toHaveFocus()

    await user.tab()

    // A disabled button is the commonest last child of a dialog footer - the
    // submit that is not valid yet. The browser skips it on Tab, so if the
    // trap still counted it as the end of the ring the wrap would never fire
    // and focus would step out of the dialog on every attempt.
    expect(button('Reassign')).toHaveFocus()
    expect(button('Page behind')).not.toHaveFocus()
  })

  it('swallows Tab when the dialog has no controls at all', async () => {
    const user = userEvent.setup({ delay: null })
    renderScreen({ children: <p>Loading the step…</p> })

    await user.tab()

    expect(dialog()).toHaveFocus()
    expect(button('Page behind')).not.toHaveFocus()
  })
})

describe('closing a dialog', () => {
  it('restores the page scroll to what it was, rather than blanking it', () => {
    document.body.style.overflow = 'scroll'
    const { setOpen } = renderScreen()

    expect(document.body.style.overflow).toBe('hidden')

    setOpen(false)

    // Blanking it would silently undo whatever the layout had set - the
    // dialog would leave the page scrolling differently than it found it.
    expect(document.body.style.overflow).toBe('scroll')
  })

  it('returns focus to the control that opened it', async () => {
    const user = userEvent.setup({ delay: null })

    function WithTrigger() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Reassign step
          </button>
          <Panel open={open} onClose={() => setOpen(false)} />
        </>
      )
    }

    render(<WithTrigger />)

    await user.click(button('Reassign step'))
    expect(button('Reassign')).toHaveFocus()

    await user.keyboard('{Escape}')

    // Otherwise focus falls back to the top of the document and a keyboard
    // user has to tab all the way down to where they were.
    expect(button('Reassign step')).toHaveFocus()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('stops listening once it unmounts, so a gone dialog cannot swallow Escape', async () => {
    const user = userEvent.setup({ delay: null })
    const { onClose, unmount } = renderScreen()

    unmount()
    await user.keyboard('{Escape}')

    // A leaked listener would keep eating Escape for the rest of the session
    // - the screen behind would stop responding to it for no visible reason.
    expect(onClose).not.toHaveBeenCalled()
  })

  it('gives the page its scroll back when it unmounts still open', () => {
    document.body.style.overflow = 'scroll'

    const { unmount } = renderScreen()
    expect(document.body.style.overflow).toBe('hidden')

    // Navigating away, or the parent route dropping the tree, is the common
    // way an open dialog leaves - `open` never goes false, so a teardown that
    // only undid the lock on the close path would strand the whole app
    // unscrollable with no dialog on screen to blame it on.
    unmount()

    expect(document.body.style.overflow).toBe('scroll')
  })

  it('still tidies up when the trigger was removed while the dialog was open', async () => {
    const user = userEvent.setup({ delay: null })
    document.body.style.overflow = 'scroll'

    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    const { setOpen, onClose } = renderScreen()
    trigger.remove()

    // Closing a dialog whose opener was re-rendered away must not throw -
    // that would take the whole screen down on a routine close.
    expect(() => setOpen(false)).not.toThrow()

    // Not throwing is the least of it. The rest of the teardown has to have
    // run too, or a vanished trigger leaves the page permanently unscrollable
    // and a dead listener eating Escape - the two failures that are hardest
    // to trace back to a dialog that is no longer on screen.
    expect(document.body.style.overflow).toBe('scroll')

    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })
})
