import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Keycap from './Keycap'

/**
 * A drawn key - the ⌘K on the command trigger, the J / K / A / R / X in the
 * queue legend. The point of the component is the element it renders: a
 * bordered span looks like a key, but only `<kbd>` means one, and that is
 * what a screen reader and a user stylesheet act on. It is also used for the
 * age value on a queue row, where the text is the information and the
 * urgency colour is only a repeat of it.
 */

function keycap(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement
}

/**
 * The tone's whole visual signature. Colour is normally none of a test's
 * business; the exception is that `QueueList` picks this from how long a
 * document has waited, so a tone that goes nowhere draws an overdue row
 * exactly like a fresh one.
 */
function skin(el: HTMLElement): string {
  return el.className
    .split(/\s+/)
    .filter(c => /^(border|bg|text)-/.test(c) && c !== 'text-data')
    .sort()
    .join(' ')
}

describe('Keycap', () => {
  it('renders the element that means "keyboard input", not a styled span', () => {
    // The border and the mono face are a visual convention; kbd is the part
    // that survives a restyle, a high-contrast mode and a screen reader.
    const { container } = render(<Keycap>K</Keycap>)

    expect(keycap(container).tagName).toBe('KBD')
  })

  it('shows the key it was given', () => {
    const { container } = render(<Keycap>ESC</Keycap>)

    expect(keycap(container).textContent).toBe('ESC')
    expect(screen.getByText('ESC')).toBeInTheDocument()
  })

  it('keeps a symbol key intact rather than swallowing it', () => {
    // The arrows and ↵ in the command palette footer are the whole content
    // of their keycaps: an escaping or trimming bug leaves an empty box that
    // tells nobody which key to press.
    for (const key of ['↑', '↓', '↵', '⌘']) {
      const view = render(<Keycap>{key}</Keycap>)
      expect(keycap(view.container).textContent, key).toBe(key)
      view.unmount()
    }
  })

  it('renders a composed key with its icon and letter inside one kbd', () => {
    // The command trigger draws ⌘ as an icon beside a K. Both parts have to
    // land inside the same kbd, or the shortcut reads as two separate keys -
    // so both parts get checked, not just the one that has text.
    const { container } = render(
      <Keycap>
        <svg data-testid="cmd-glyph" aria-hidden="true" />
        <span>K</span>
      </Keycap>,
    )

    const kbd = keycap(container)
    expect(kbd.tagName).toBe('KBD')
    expect(kbd.textContent).toBe('K')
    expect(kbd.querySelector('[data-testid="cmd-glyph"]')).not.toBeNull()
    // Both halves, in the order they were handed over: an implementation that
    // reordered or re-wrapped its children would draw "K⌘".
    expect(Array.from(kbd.children).map(c => c.tagName)).toEqual(['svg', 'SPAN'])
    // ...and there is exactly one key here, not a kbd wrapping another.
    expect(container.querySelectorAll('kbd')).toHaveLength(1)
  })

  it('does not hide the key it is drawing from a screen reader', () => {
    // The kbd is the whole accessible payload - the shortcut is announced
    // from its text and nothing else. Hiding it, or overriding the role that
    // `kbd` carries, would leave the command trigger announcing its label
    // with no shortcut attached, which is silent in review because the key
    // is still drawn on screen.
    const { container } = render(<Keycap>K</Keycap>)

    const kbd = keycap(container)
    expect(kbd).not.toHaveAttribute('aria-hidden')
    expect(kbd).not.toHaveAttribute('role')
    expect(screen.getByText('K')).toBe(kbd)
  })

  it('keeps the layout classes a caller adds alongside its own', () => {
    // Every keycap in a flex row - the palette footer, the queue SLA cell -
    // is passed `flex-shrink-0`. Dropped, the key is the thing that collapses
    // when the row runs out of room, because it is the narrowest item in it.
    const { container } = render(<Keycap className="flex-shrink-0">3d</Keycap>)

    const classes = keycap(container).className.split(/\s+/)
    expect(classes).toContain('flex-shrink-0')
    expect(classes).toContain('font-mono')
  })

  it('still reads its value when urgency turns it red', () => {
    // A queue row colours this keycap by how long the document has waited.
    // If the hue were the only cue, an overdue row would look identical to a
    // fresh one to a colourblind reader - so the duration has to be text,
    // and the hue has to be something other than the text.
    const neutral = render(<Keycap>3d</Keycap>)
    const neutralSkin = skin(keycap(neutral.container))
    expect(keycap(neutral.container).textContent).toBe('3d')
    neutral.unmount()

    const { container } = render(<Keycap tone="danger">3d</Keycap>)
    expect(keycap(container).textContent).toBe('3d')
    expect(screen.getByText('3d')).toBeInTheDocument()
    expect(skin(keycap(container))).not.toBe(neutralSkin)
  })

  it('gives each urgency a look of its own', () => {
    // Three severities, three skins. Two of them collapsing into one is the
    // same failure as no colour at all, and it is invisible in review
    // because every keycap still renders.
    const skins = (['neutral', 'warning', 'danger'] as const).map(tone => {
      const view = render(<Keycap tone={tone}>3d</Keycap>)
      const found = skin(keycap(view.container))
      expect(keycap(view.container).tagName, tone).toBe('KBD')
      view.unmount()
      return found
    })

    expect(new Set(skins).size).toBe(3)
  })

  it('is calm until somebody says otherwise', () => {
    // Six of the seven call sites pass no tone at all - the palette keys, the
    // queue legend. If the default drifted to a severity, every unremarkable
    // key in the app would be drawn as though something were wrong with it.
    const plain = render(<Keycap>K</Keycap>)
    const plainSkin = skin(keycap(plain.container))
    plain.unmount()

    const neutral = render(<Keycap tone="neutral">K</Keycap>)
    expect(skin(keycap(neutral.container))).toBe(plainSkin)
    neutral.unmount()

    // Stated the other way round too, so the pair above cannot both be
    // "danger" and still agree with each other.
    const danger = render(<Keycap tone="danger">K</Keycap>)
    expect(skin(keycap(danger.container))).not.toBe(plainSkin)
  })

  it('does not truncate a long value out of the DOM', () => {
    // Whatever CSS does about overflow, the text has to be present: a
    // screen reader reads the DOM, not the visible box.
    const long = '14 days 6 hours'
    const { container } = render(<Keycap tone="warning">{long}</Keycap>)

    expect(keycap(container).textContent).toBe(long)
  })
})
