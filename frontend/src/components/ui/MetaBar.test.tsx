import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import MetaBar from './MetaBar'

/**
 * The 4px track behind an age or a queue load. A length is not a value: it
 * is readable only by someone looking at it, and only approximately. So this
 * component has exactly two honest modes - silent, because the number is
 * already spelled out beside it, or a real progressbar with a name. What it
 * must never do is report a different number from the one it draws, or let
 * an overdue document draw a bar past the end of its own track.
 */

function bar(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement
}

function fill(container: HTMLElement): HTMLElement {
  return bar(container).firstElementChild as HTMLElement
}

/** The drawn fill - what a sighted reader actually sees. */
function drawnWidth(container: HTMLElement): string {
  return fill(container).style.width
}

/**
 * Which urgency hue the fill was drawn in. Normally none of a test's
 * business, but `DocumentsTable` picks this from how long the document has
 * waited, so a prop that goes nowhere leaves an overdue row drawn as calm as
 * a fresh one.
 */
function drawnTone(container: HTMLElement): string | undefined {
  return /bg-(accent|warning|danger|neutral)-mark/.exec(fill(container).className)?.[1]
}

describe('MetaBar', () => {
  it('stays out of the accessibility tree when text beside it says the same thing', () => {
    // Everywhere the design uses this, "3d" or "80%" is rendered next to it.
    // A second, nameless progressbar would announce the same value twice -
    // once without a name, so a listener cannot tell what it refers to.
    const { container } = render(<MetaBar pct={40} />)

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(bar(container)).toHaveAttribute('aria-hidden', 'true')
    // Hidden means hidden: a value left on it would still be picked up by
    // some assistive tech even with the role gone.
    expect(bar(container)).not.toHaveAttribute('aria-valuenow')
  })

  it('becomes a named progressbar when it is the only carrier of the value', () => {
    render(<MetaBar pct={62} label="Queue load" />)

    const meter = screen.getByRole('progressbar', { name: 'Queue load' })
    // A progressbar with no min/max is announced as an indeterminate spinner
    // rather than as 62 per cent of anything.
    expect(meter).toHaveAttribute('aria-valuenow', '62')
    expect(meter).toHaveAttribute('aria-valuemin', '0')
    expect(meter).toHaveAttribute('aria-valuemax', '100')
    // And it stopped hiding itself, or the role it just took on is moot.
    expect(meter).not.toHaveAttribute('aria-hidden')
  })

  it('refuses to become a nameless progressbar when handed an empty name', () => {
    // The bad input this has to reject: a caller that computes the label and
    // gets back "". Announcing "62 per cent" of an unnamed something is
    // worse than the silent bar, because the listener cannot even tell what
    // was skipped.
    const { container } = render(<MetaBar pct={62} label="" />)

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(bar(container)).toHaveAttribute('aria-hidden', 'true')
  })

  it('never reports or draws more than a full track, however overdue', () => {
    const { container } = render(<MetaBar pct={250} label="Age" />)

    // 250% would spill the fill out of its own track and tell a listener the
    // document is two and a half times complete.
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    expect(drawnWidth(container)).toBe('100%')
  })

  it('never reports or draws a negative', () => {
    const { container } = render(<MetaBar pct={-30} label="Age" />)

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
    expect(drawnWidth(container)).toBe('3%')
  })

  it('reports a whole number, because a screen reader reads it aloud', () => {
    // Both directions. 33.6 alone cannot tell rounding apart from ceiling,
    // and a ceiling would report an SLA as further gone than it is - the one
    // direction of error that matters on a countdown.
    const up = render(<MetaBar pct={33.6} label="Queue load" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '34')
    expect(drawnWidth(up.container)).toBe('34%')
    up.unmount()

    const down = render(<MetaBar pct={33.4} label="Queue load" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33')
    expect(drawnWidth(down.container)).toBe('33%')
  })

  it('draws the track at the width the column it sits in was built for', () => {
    // 44px in the documents grid, 40px in the admin grids, full inside a
    // card. The track is the only thing that reads this prop, and a swallowed
    // one is invisible in review: the bar still draws, just at somebody
    // else's width, so an age column and a queue-load column stop being
    // comparable at a glance even though they are the same measure.
    const widths = (['table', 'admin', 'full'] as const).map(width => {
      const view = render(<MetaBar pct={50} width={width} label="Age" />)
      // Whatever the track measures, the fill inside it is still 50 per cent
      // of it - width is a layout choice, never a value.
      expect(drawnWidth(view.container), width).toBe('50%')
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
      const track = bar(view.container).className
        .split(/\s+/)
        .find(c => /^w-/.test(c))
      view.unmount()
      return track
    })

    expect(widths.filter(Boolean)).toHaveLength(3)
    expect(new Set(widths).size).toBe(3)
  })

  it('keeps the reported value at zero even though it draws a visible sliver', () => {
    const { container } = render(<MetaBar pct={0} label="Age" />)

    // The 3% floor exists so the mark does not vanish at the start of a
    // workflow. If that floor leaked into the reported value, a document
    // that had waited no time at all would announce as 3% of the way to
    // overdue - a number nothing in the app can justify.
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
    expect(drawnWidth(container)).toBe('3%')
  })

  it('draws what it reports for an ordinary value', () => {
    const { container } = render(<MetaBar pct={45} label="Age" />)

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45')
    expect(drawnWidth(container)).toBe('45%')
  })

  it('keeps the drawn length and the reported number in step across the range', () => {
    // The two audiences read different attributes off the same element. The
    // 0% sliver is the one deliberate exception; anywhere else, a fill that
    // disagrees with the number tells the two of them different things.
    for (const pct of [1, 12, 50, 87, 99, 100]) {
      const view = render(<MetaBar pct={pct} label="Age" />)
      const meter = screen.getByRole('progressbar')
      expect(meter.getAttribute('aria-valuenow'), String(pct)).toBe(String(pct))
      expect(drawnWidth(view.container), String(pct)).toBe(`${pct}%`)
      view.unmount()
    }
  })

  it('says nothing different when the urgency colour changes', () => {
    // Tone is how the age column turns red. The value is the information;
    // the hue only repeats it, so it must not alter what is announced - and
    // the hue does have to actually change, or an overdue row is drawn as
    // calm as a fresh one.
    const calm = render(<MetaBar pct={80} tone="accent" label="Age" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '80')
    expect(drawnTone(calm.container)).toBe('accent')
    calm.unmount()

    const urgent = render(<MetaBar pct={80} tone="danger" label="Age" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '80')
    expect(drawnWidth(urgent.container)).toBe('80%')
    expect(drawnTone(urgent.container)).toBe('danger')
  })

  it('does not silently drop the name it was given', () => {
    // The whole reason to pass `label` is that nothing else on screen states
    // this value. A progressbar without an accessible name is announced as
    // "62 per cent" of an unnamed something.
    render(<MetaBar pct={62} label="Approvals waiting on Ayesha Khan" />)

    expect(screen.getByRole('progressbar')).toHaveAccessibleName(
      'Approvals waiting on Ayesha Khan',
    )
  })
})
