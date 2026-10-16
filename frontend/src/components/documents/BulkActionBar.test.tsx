import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import BulkActionBar from './BulkActionBar'

/**
 * The strip that appears across the top of the table once rows are ticked.
 *
 * It exists to answer one question before anybody presses anything: how many
 * documents is the next action about to touch. Everything else on it is a
 * promise the product cannot keep yet - three actions with no endpoint behind
 * them - so the second thing tested here is that those stay genuinely
 * unpressable rather than merely faded.
 */

function renderBar(count = 3) {
  const onClear = vi.fn()
  const result = render(<BulkActionBar count={count} onClear={onClear} />)
  return {
    ...result,
    onClear,
    /** Re-render with a new count, keeping the same handler. */
    setCount: (next: number) => result.rerender(<BulkActionBar count={next} onClear={onClear} />),
  }
}

const enabledButtons = () =>
  screen.getAllByRole('button').filter(button => !(button as HTMLButtonElement).disabled)

describe('BulkActionBar', () => {
  it('says how many rows the next action would reach, and keeps saying it', () => {
    const { setCount } = renderBar(3)
    expect(screen.getByRole('status')).toHaveTextContent('3 selected')

    setCount(7)

    // Asserting "3 selected" once would pass just as well on a bar that
    // ignored the prop and printed whatever it first rendered - and a stale
    // count above a bulk action is the number somebody acts on.
    expect(screen.getByRole('status')).toHaveTextContent('7 selected')
    expect(screen.queryByText('3 selected')).not.toBeInTheDocument()
  })

  it('says the same for a single row', () => {
    renderBar(1)

    // The count carries no noun, so there is no plural to get wrong - but a
    // "1 documents selected" regression would show up right here.
    expect(screen.getByText('1 selected')).toBeInTheDocument()
  })

  it('announces itself through exactly one live region', () => {
    renderBar()

    // The bar appears without anything moving focus. Without a live region,
    // a screen reader user ticks a row and is told nothing at all - and with
    // two, they are told twice, a beat apart, which is how a count gets
    // misheard as a different count.
    const live = screen.getAllByRole('status')
    expect(live).toHaveLength(1)
    expect(live[0]).toHaveTextContent('3 selected')
  })

  it('keeps the count inside the live region, not merely next to it', () => {
    const { setCount } = renderBar(3)
    const live = screen.getByRole('status')

    setCount(4)

    // A live region only announces when the text INSIDE it changes. Moving
    // the count out - or remounting the region on every change - leaves the
    // bar visually correct and silent.
    expect(live).toHaveTextContent('4 selected')
    expect(screen.getByRole('status')).toBe(live)
  })

  it('clears the selection when asked', async () => {
    const user = userEvent.setup({ delay: null })
    const { onClear } = renderBar()

    const clear = screen.getByRole('button', { name: 'Clear' })
    expect(clear).toBeEnabled()
    await user.click(clear)

    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('puts the one action that works within a single tab stop, and nothing after it', async () => {
    const user = userEvent.setup({ delay: null })
    const { onClear } = renderBar()

    await user.tab()

    // Disabled buttons are skipped by Tab. If any of the three placeholders
    // were merely styled disabled, a keyboard user would land on one of them
    // first and press an action that cannot happen.
    expect(screen.getByRole('button', { name: 'Clear' })).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(onClear).toHaveBeenCalledTimes(1)

    // And Clear is the last thing on the bar: tabbing on leaves it rather
    // than reaching a fourth control nobody meant to ship.
    await user.tab()
    expect(document.body).toHaveFocus()
  })

  it.each(['Approve all', 'Reassign', 'Nudge holder'])(
    'keeps "%s" genuinely disabled while it has nothing behind it',
    label => {
      renderBar()

      // Bulk approval in particular cannot be faked: an approval is a
      // signature placed on the rendered PDF. An enabled button here would
      // offer to approve documents nobody has opened.
      expect(screen.getByRole('button', { name: label })).toBeDisabled()
    },
  )

  it('leaves exactly one control on the bar pressable', () => {
    renderBar()

    // The three placeholders are named one by one above, which says nothing
    // about a fourth. This is the shape of the bar as a whole: everything
    // that can be pressed, and it is one thing.
    expect(enabledButtons().map(button => button.textContent)).toEqual(['Clear'])
  })

  it.each([
    ['Approve all', /signature/],
    ['Reassign', /reassignment endpoint/],
    ['Nudge holder', /reminder endpoint/],
  ])('gives a reason it cannot perform "%s"', (label, reason) => {
    renderBar()

    // Today the reason is a `title` only, which no keyboard or touch user
    // can reach - see the defect note. The reason existing at all, and
    // naming the thing that is actually missing rather than being copied
    // from the button beside it, is still worth holding onto.
    expect(screen.getByRole('button', { name: label }).getAttribute('title')).toMatch(reason)
  })

  it.each(['Approve all', 'Reassign', 'Nudge holder'])(
    'swallows the press on "%s" rather than only looking unpressable',
    async label => {
      const user = userEvent.setup({ delay: null })
      renderBar()

      // `onClear` is wired to one button, so "the disabled one did not call
      // onClear" was never a claim about the disabled one. This watches for
      // the press itself instead.
      const pressed: string[] = []
      const listen = (event: Event) =>
        pressed.push((event.target as HTMLElement).closest('button')?.textContent ?? 'nothing')
      document.addEventListener('click', listen, true)

      try {
        await user.click(screen.getByRole('button', { name: label }))

        // A button carrying `disabled:opacity-60` but not the attribute looks
        // exactly the same and still fires. Nothing is wired behind these
        // three, so the press going nowhere is the whole of what stops a
        // person from believing they have just approved forty documents.
        expect(pressed).toEqual([])

        // The control. Without it an empty log proves only that the listener
        // was attached to nothing - which is also what a broken test looks
        // like.
        await user.click(screen.getByRole('button', { name: 'Clear' }))
        expect(pressed).toEqual(['Clear'])
      } finally {
        document.removeEventListener('click', listen, true)
      }
    },
  )

  it.each(['Approve all', 'Reassign', 'Nudge holder'])(
    'will not let the keyboard land on "%s" either',
    label => {
      renderBar()
      const button = screen.getByRole('button', { name: label })

      // The Tab test above proves the first stop is Clear; it does not prove
      // these cannot be reached another way. A disabled control refuses focus
      // outright, so nothing - not a click, not a stray `focus()` after a
      // re-render - can leave a person sitting on a dead action wondering why
      // Enter does nothing.
      button.focus()
      expect(button).not.toHaveFocus()
      expect(document.body).toHaveFocus()
    },
  )

  it('states a count of zero honestly if it is ever rendered with one', () => {
    renderBar(0)

    // The screen only mounts the bar above zero, so this is a guard on the
    // component alone: it must not round an empty selection up to "1".
    expect(screen.getByRole('status')).toHaveTextContent('0 selected')
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
  })
})
