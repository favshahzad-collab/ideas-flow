import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import Button from './Button'

/**
 * Every action in the app is this button. What it decides for a person: whether
 * pressing it does the thing, whether it can be pressed twice while the first
 * request is still in flight, and whether a keyboard reaches it at all.
 *
 * The variants are colour, and colour is not asserted here - a restyle must not
 * turn this file red. What is asserted is the part a person cannot see: the
 * element it actually is, its type inside a form, and whether `disabled` and
 * `pending` really block the click rather than only greying it out.
 */

const VARIANTS = [
  'primary',
  'secondary',
  'ghost',
  'subtle',
  'danger',
  'dangerSolid',
  'dark',
] as const

const SIZES = ['sm', 'md', 'lg'] as const

describe('what it renders', () => {
  it('is a real button element, so the browser gives it keyboard and role for free', () => {
    // A styled div would look identical and be unreachable by Tab, invisible
    // to a screen reader's button list, and deaf to Enter and Space.
    render(<Button>Submit for approval</Button>)

    expect(screen.getByRole('button', { name: 'Submit for approval' }).tagName).toBe(
      'BUTTON',
    )
  })

  it('takes its accessible name from an aria-label when there is only an icon', () => {
    render(<Button aria-label="Close panel" icon={<span>x</span>} />)

    expect(screen.getByRole('button', { name: 'Close panel' })).toBeInTheDocument()
  })

  it.each(VARIANTS)('renders %s as one operable button', async variant => {
    // A variant is a colour choice. If picking one ever changed whether the
    // button works - a bad key, a swallowed handler - it would ship looking fine.
    const onClick = vi.fn()
    render(
      <Button variant={variant} onClick={onClick}>
        Approve
      </Button>,
    )

    const button = screen.getByRole('button', { name: 'Approve' })
    expect(button).toBeEnabled()
    // Not which classes - a restyle renames every one of them and must not turn
    // this red - but that the lookup resolved at all. A variant missing from the
    // map interpolates the literal string "undefined" into the class attribute
    // and ships a button with no styling on it whatsoever.
    expect(button.getAttribute('class')).not.toMatch(/undefined/)
    await userEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it.each(SIZES)('renders %s as one operable button', async size => {
    const onClick = vi.fn()
    render(
      <Button size={size} onClick={onClick}>
        Approve
      </Button>,
    )

    const button = screen.getByRole('button', { name: 'Approve' })
    expect(button.getAttribute('class')).not.toMatch(/undefined/)
    await userEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('gives every variant a treatment of its own', () => {
    // The loops above are satisfied by seven variants that all resolve to the
    // same string: each button still renders, still clicks, still carries no
    // "undefined". They would simply all be the same button. `danger` is the
    // quiet outline Reject that sits beside two other buttons, and
    // `dangerSolid` is the loud one in a confirm dialog where the button IS the
    // decision - the source keeps them apart on purpose, and nothing until now
    // checked that they stayed apart.
    //
    // Which classes is still not asserted, so a restyle that renames all seven
    // stays green. Only that choosing a different variant produces a different
    // button.
    const classes = VARIANTS.map(variant => {
      const { unmount } = render(<Button variant={variant}>Approve</Button>)
      const value = screen.getByRole('button', { name: 'Approve' }).className
      unmount()
      return value
    })

    expect(new Set(classes).size).toBe(VARIANTS.length)
  })

  it('gives every size metrics of its own', () => {
    // Same failure, quieter consequence: sm and lg collapsed onto each other
    // make the button in a 34px table row the same height as the one in a page
    // header, and every dense row on the screen grows.
    const classes = SIZES.map(size => {
      const { unmount } = render(<Button size={size}>Approve</Button>)
      const value = screen.getByRole('button', { name: 'Approve' }).className
      unmount()
      return value
    })

    expect(new Set(classes).size).toBe(SIZES.length)
  })
})

describe('the type attribute, which decides whether a form submits', () => {
  it('defaults to type="button" so a toolbar button inside a form does not submit it', async () => {
    // The single most expensive default to get wrong here: an unadorned
    // <button> in HTML submits its form, so a "Add approver" button next to a
    // half-filled form would post the document.
    const onSubmit = vi.fn(event => event.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Button>Add approver</Button>
      </form>,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Add approver' }))

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('still submits when the caller asks for type="submit"', async () => {
    const onSubmit = vi.fn(event => event.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit">Submit for approval</Button>
      </form>,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Submit for approval' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})

describe('disabled', () => {
  it('is actually disabled, not just faded', async () => {
    // Greyed-out styling with a live handler is the classic double-submit: the
    // button looks unavailable and still fires.
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        Approve
      </Button>,
    )

    const button = screen.getByRole('button', { name: 'Approve' })
    expect(button).toBeDisabled()

    await userEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('cannot be reached by Tab or fired by Enter', async () => {
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        Approve
      </Button>,
    )

    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'Approve' })).not.toHaveFocus()

    await userEvent.keyboard('{Enter}')
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('pending, while a request is in flight', () => {
  it('blocks a second press so the same approval is not sent twice', async () => {
    const onClick = vi.fn()
    render(
      <Button pending onClick={onClick}>
        Approve
      </Button>,
    )

    const button = screen.getByRole('button', { name: /Approve/ })
    expect(button).toBeDisabled()

    await userEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('announces the wait with aria-busy rather than leaving it to the spinner', () => {
    // The spinner is aria-hidden, which is right - but then aria-busy is the
    // only signal a screen reader has that anything is happening at all.
    render(<Button pending>Approve</Button>)

    expect(screen.getByRole('button', { name: /Approve/ })).toHaveAttribute(
      'aria-busy',
      'true',
    )
  })

  it('leaves aria-busy off entirely when nothing is pending', () => {
    // aria-busy="false" on every idle button is noise; absent is the honest state.
    const { rerender } = render(<Button>Approve</Button>)

    expect(screen.getByRole('button', { name: 'Approve' })).not.toHaveAttribute('aria-busy')

    // And "you may not press this" has to stay a different message from "wait":
    // a button disabled by a permission check must not claim a request is in
    // flight, or a screen reader tells somebody to wait for something that is
    // never going to arrive.
    rerender(<Button disabled>Approve</Button>)

    expect(screen.getByRole('button', { name: 'Approve' })).not.toHaveAttribute('aria-busy')
  })

  it('keeps saying which action is in flight', () => {
    // Swapping the label for a bare spinner loses the one piece of information
    // that matters when two requests are running: which one this is.
    render(<Button pending>Submit for approval</Button>)

    expect(
      screen.getByRole('button', { name: 'Submit for approval' }),
    ).toBeInTheDocument()
  })

  it('swaps the caller icon for the spinner rather than showing both or neither', () => {
    // Two glyphs in a 34px button is a layout break, and the static icon beside
    // a spinner reads as though the press had not registered.
    const { rerender } = render(<Button icon={<span>ICON</span>}>Approve</Button>)

    const button = screen.getByRole('button', { name: /Approve/ })
    expect(screen.getByText('ICON')).toBeInTheDocument()
    expect(button.querySelectorAll('svg')).toHaveLength(0)

    rerender(
      <Button pending icon={<span>ICON</span>}>
        Approve
      </Button>,
    )

    // Both halves of the swap. "The icon is gone" on its own is also satisfied
    // by a button that shows nothing at all while the request is in flight -
    // the one failure that would leave a person with no sign it registered.
    expect(screen.queryByText('ICON')).not.toBeInTheDocument()
    const spinner = button.querySelector('svg')
    expect(spinner).not.toBeNull()
    // And the spinner stays out of the name: "Approve", never "Approve, image".
    expect(spinner).toHaveAttribute('aria-hidden', 'true')
    expect(button).toHaveAccessibleName('Approve')
  })

  it('does not submit the form it is sitting in', async () => {
    // The double-submit this prop exists to prevent. Blocking the onClick is
    // not enough on its own: the button that matters is a type="submit" inside
    // the submit form, and if `pending` only greyed it out the second press
    // would post the same document again.
    const onSubmit = vi.fn(event => event.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" pending>
          Submit for approval
        </Button>
      </form>,
    )

    await userEvent.click(screen.getByRole('button', { name: /Submit for approval/ }))

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('stays disabled even when the caller explicitly passes disabled={false}', () => {
    // The two props arrive from different places - `disabled` from a permission
    // check, `pending` from the request - and the request must win.
    render(
      <Button pending disabled={false}>
        Approve
      </Button>,
    )

    expect(screen.getByRole('button', { name: /Approve/ })).toBeDisabled()
  })

  it('stays mounted as the same button across the idle -> pending switch', async () => {
    // Not a re-mount: a fresh element would throw away focus, any tooltip and
    // the caret position. jsdom keeps focus on a disabled element where a real
    // browser moves it to <body>, so the focus consequence is reported as a
    // defect rather than asserted here.
    const { rerender } = render(<Button>Approve</Button>)

    const before = screen.getByRole('button', { name: 'Approve' })
    rerender(<Button pending>Approve</Button>)

    expect(screen.getByRole('button', { name: /Approve/ })).toBe(before)
  })
})

describe('the icon slot', () => {
  it('shows the caller icon when idle', () => {
    render(<Button icon={<span>ICON</span>}>Approve</Button>)

    expect(screen.getByText('ICON')).toBeInTheDocument()
  })

  it('is still pressable when the label lives only in the aria-label', async () => {
    // An icon-only button in a dense toolbar passes no label as children, so
    // its whole accessible name is the aria-label and its whole hit area is the
    // icon. Both have to survive the empty-children path - "it rendered" would
    // also be true of a 0x0 button nobody can hit.
    const onClick = vi.fn()
    render(<Button aria-label="More" icon={<span>ICON</span>} onClick={onClick} />)

    const button = screen.getByRole('button', { name: 'More' })
    expect(button).toHaveAccessibleName('More')
    expect(screen.getByText('ICON')).toBeInTheDocument()

    await userEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('keyboard operation', () => {
  it('fires on Enter and on Space', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Approve</Button>)

    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveFocus()

    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard(' ')

    // Both, because a person using a keyboard reaches for either and a div
    // pretending to be a button would answer neither.
    expect(onClick).toHaveBeenCalledTimes(2)
  })
})

describe('edge input', () => {
  it('renders a very long label without dropping any of it', () => {
    const long = 'Approve the amended warehouse lease extension for the north yard'
    render(<Button>{long}</Button>)

    expect(screen.getByRole('button', { name: long })).toBeInTheDocument()
  })

  it('passes through the props a caller needs for a menu or a form', () => {
    render(
      <Button aria-haspopup="menu" aria-expanded={false} form="doc-form">
        Options
      </Button>,
    )

    const button = screen.getByRole('button', { name: 'Options' })
    // The spread must not be swallowed by the wrapper, or every consumer that
    // wires ARIA onto a Button silently loses it.
    expect(button).toHaveAttribute('aria-haspopup', 'menu')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveAttribute('form', 'doc-form')
  })

  it('keeps the caller className alongside its own', () => {
    // Callers stretch a Button to full width or pin it into a grid cell. The
    // class asserted is one this test invented, so no restyle can move it - but
    // if the wrapper ever dropped the prop, every one of those layouts would
    // quietly collapse back to the default inline size.
    render(<Button className="daws-test-hook">Approve</Button>)

    expect(screen.getByRole('button', { name: 'Approve' })).toHaveClass('daws-test-hook')
  })
})
