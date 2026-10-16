import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import Switch from './Switch'

/**
 * One binary setting - "Out of office" on the delegation panel, which decides
 * whether documents route past somebody or pile up on their desk while they
 * are away.
 *
 * The thing that would hurt a person here is the toggle disagreeing with the
 * server: a track that slides because it was clicked, while the request that
 * was meant to follow it failed. So the tests below insist it is controlled -
 * it moves because the parent said so and never on its own - and that what it
 * announces (`aria-checked`) is the same fact the track is drawing.
 */

function renderSwitch(props: Partial<Parameters<typeof Switch>[0]> = {}) {
  const onChange = vi.fn()
  const result = render(
    <Switch
      checked={false}
      onChange={onChange}
      label="Out of office"
      {...props}
    />,
  )
  return { onChange, ...result }
}

describe('what a screen reader is told', () => {
  it('is a switch, named by the label a sighted person reads', () => {
    // Wired through aria-labelledby rather than repeated in an aria-label, so
    // the two can never drift into saying different things.
    renderSwitch()

    expect(screen.getByRole('switch', { name: 'Out of office' })).toBeInTheDocument()
  })

  it('says on or off, not just draws it', () => {
    // Without aria-checked the control is announced as a plain button and the
    // only remaining cue is which end the knob sits at.
    const { rerender } = renderSwitch({ checked: false })
    expect(screen.getByRole('switch', { name: 'Out of office' })).not.toBeChecked()

    rerender(
      <Switch checked onChange={() => {}} label="Out of office" />,
    )
    expect(screen.getByRole('switch', { name: 'Out of office' })).toBeChecked()
  })

  it('keeps the sliding knob out of the tree', () => {
    // The knob is the entire visual of the control and carries no text of its
    // own. Left announced it becomes a stray "image" between the label and the
    // state, on a control whose whole job is to say two words.
    renderSwitch()

    const control = screen.getByRole('switch', { name: 'Out of office' })
    expect(control.firstElementChild).toHaveAttribute('aria-hidden', 'true')
    // And the switch itself contributes no text: the name comes from the label
    // beside it, so anything inside the button is decoration by definition.
    expect(control).toHaveTextContent('')
  })

  it('keeps the hint out of the accessible name', () => {
    // The name has to stay the short thing: "Out of office", not "Out of office
    // Documents assigned to you go to your delegate instead."
    renderSwitch({ hint: 'Documents assigned to you go to your delegate instead.' })

    expect(screen.getByRole('switch', { name: 'Out of office' })).toBeInTheDocument()
    expect(
      screen.getByText('Documents assigned to you go to your delegate instead.'),
    ).toBeInTheDocument()
  })

  it('gives two switches on the same panel their own labels', () => {
    // The label id comes from useId. If it were a constant, the second switch
    // would borrow the first one's name and a person would toggle the wrong
    // setting believing they toggled the other.
    render(
      <>
        <Switch checked={false} onChange={() => {}} label="Out of office" />
        <Switch checked onChange={() => {}} label="Email me every decision" />
      </>,
    )

    expect(screen.getByRole('switch', { name: 'Out of office' })).not.toBeChecked()
    expect(
      screen.getByRole('switch', { name: 'Email me every decision' }),
    ).toBeChecked()
  })
})

describe('toggling it', () => {
  it('asks the parent for the opposite of what it is showing', async () => {
    const { onChange } = renderSwitch({ checked: false })

    await userEvent.click(screen.getByRole('switch', { name: 'Out of office' }))

    // Reporting the current value instead of the next one is a real and silent
    // bug: the panel saves "off" over an "off" and the toggle springs back.
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('asks for false when it is already on', async () => {
    const { onChange } = renderSwitch({ checked: true })

    await userEvent.click(screen.getByRole('switch', { name: 'Out of office' }))

    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('does not move until the parent moves it', async () => {
    // Controlled, on purpose. If it flipped itself, the track would say "away"
    // the instant it was pressed - including when the save that follows fails,
    // leaving somebody believing their documents are being delegated.
    const { onChange } = renderSwitch({ checked: false })

    const control = screen.getByRole('switch', { name: 'Out of office' })
    await userEvent.click(control)
    await userEvent.click(control)

    expect(control).not.toBeChecked()
    expect(onChange).toHaveBeenNthCalledWith(1, true)
    expect(onChange).toHaveBeenNthCalledWith(2, true)
  })

  it('answers Space and Enter as well as the mouse', async () => {
    const { onChange } = renderSwitch()

    await userEvent.tab()
    expect(screen.getByRole('switch', { name: 'Out of office' })).toHaveFocus()

    await userEvent.keyboard(' ')
    await userEvent.keyboard('{Enter}')

    // Space is the documented key for a switch; Enter is what people press
    // anyway. A div with an onClick would answer neither.
    expect(onChange).toHaveBeenCalledTimes(2)
    // And both keys have to ask for the same thing the mouse asks for. A count
    // on its own is satisfied by a keyboard path that reports the value the
    // switch is already showing - which saves "off" over "off", tells the
    // person nothing failed, and springs the track back on the next render.
    expect(onChange).toHaveBeenNthCalledWith(1, true)
    expect(onChange).toHaveBeenNthCalledWith(2, true)
  })
})

describe('when it is not theirs to change', () => {
  it('is really disabled, so a click cannot start a save', async () => {
    const { onChange } = renderSwitch({ disabled: true, checked: false })

    const control = screen.getByRole('switch', { name: 'Out of office' })
    expect(control).toBeDisabled()

    await userEvent.click(control)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('is skipped by Tab rather than focusable and inert', async () => {
    renderSwitch({ disabled: true })

    await userEvent.tab()
    expect(screen.getByRole('switch', { name: 'Out of office' })).not.toHaveFocus()
  })

  it('still reports its current state while disabled', () => {
    // A disabled toggle is still information: "you are marked away, and only an
    // administrator can change it" is a different message from "off".
    renderSwitch({ disabled: true, checked: true })

    expect(screen.getByRole('switch', { name: 'Out of office' })).toBeChecked()
  })

  it('puts the reason for being disabled on the control itself', () => {
    // On the control, not the wrapping div. A `title` on the wrapper is a
    // tooltip for people with a pointer and nothing at all for a keyboard
    // user, who never hovers and would be told only that this cannot be
    // pressed - never why.
    renderSwitch({
      disabled: true,
      title: 'Only an administrator can change this.',
    })

    expect(screen.getByRole('switch', { name: 'Out of office' })).toHaveAttribute(
      'title',
      'Only an administrator can change this.',
    )
  })
})

describe('the hint, which is the only place the consequence is spelled out', () => {
  it('reads it out with the control it explains', () => {
    // The hint belongs in the accessible DESCRIPTION, not the name - the name
    // stays "Out of office". Rendered as a plain sibling it was in neither,
    // so a screen reader announced "Out of office, switch, off" and the
    // sentence explaining what being out of office does to a person's
    // documents was read only if they happened to arrow past it.
    // `aria-describedby` on the button, pointing at the hint's id, is what
    // puts it where the announcement is.
    renderSwitch({ hint: 'Documents assigned to you go to your delegate instead.' })

    expect(
      screen.getByRole('switch', { name: 'Out of office' }),
    ).toHaveAccessibleDescription('Documents assigned to you go to your delegate instead.')
  })
})

describe('edge input', () => {
  it('renders a long label without losing the control', () => {
    const long =
      'Out of office until the twenty-sixth of August, delegating to Bilal Ahmed'
    renderSwitch({ label: long })

    expect(screen.getByRole('switch', { name: long })).toBeInTheDocument()
  })

  it('renders no hint line when there is no hint', () => {
    const { container } = renderSwitch()

    expect(container.textContent?.trim()).toBe('Out of office')
  })
})
