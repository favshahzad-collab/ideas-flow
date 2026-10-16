import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OversightStats as Stats } from '../../utils/oversight'
import OversightStats from './OversightStats'

/**
 * The four figures at the top of the Control room. An administrator reads
 * these before deciding whether to go and chase somebody, so each one has to
 * be a number that was measured rather than one that was implied: "3 stalled"
 * is a reason to pick up the phone, and "—" or a blank is a reason to reload
 * the page. Neither may be mistaken for the other.
 *
 * `computeOversightStats` is tested in oversight.test.ts. This is about how
 * the row states what it is handed - whether the number reaches a reader at
 * all, and what it claims about a policy the organisation has not set.
 */

const features = vi.hoisted(() => ({ sla: false }))
vi.mock('../../config/features', () => ({ FEATURES: features }))

function stats(overrides: Partial<Stats> = {}): Stats {
  return {
    inFlight: 12,
    stalled: 3,
    holders: 5,
    longestWaitDays: 9,
    breaching: null,
    chasedToday: null,
    ...overrides,
  }
}

/**
 * A stat card carries no role, no group and no accessible name tying its
 * number to its label - reading order is the only thing joining them - so
 * there is no way to ask for "the Stalled card" through the accessibility
 * tree. Both walks live here so no individual test depends on the markup.
 */
function statCard(label: string): HTMLElement {
  return screen.getByText(label).closest('p')!.parentElement!.parentElement!
}

function statValue(label: string): string {
  const value = screen.getByText(label).closest('p')!.nextElementSibling
  return (value?.textContent ?? '').trim()
}

/**
 * The drawn width of the 3px rule along the bottom of a card. This is the
 * only place the percentage is ever stated - it reaches the DOM as an inline
 * width and nothing prints it - so an assertion about the share a card claims
 * has to read it here.
 */
function statRuleWidth(label: string): string {
  const fill = statCard(label).lastElementChild!.firstElementChild as HTMLElement
  return fill.style.width
}

beforeEach(() => {
  features.sla = false
})

describe('what the row states', () => {
  it('labels every figure with what it counts', () => {
    render(<OversightStats stats={stats()} />)

    for (const label of [
      'In progress',
      'Stalled over a week',
      'People holding work',
      'Longest wait',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('states each figure as a number, not only as the length of a rule', () => {
    render(<OversightStats stats={stats()} />)

    // The 3px rule along the bottom of each card is aria-hidden, so if the
    // value were not also printed the card would be unreadable to anyone not
    // measuring pixels - and the whole point of the row is the number.
    expect(statValue('In progress')).toBe('12')
    expect(statValue('Stalled over a week')).toBe('3')
    expect(statValue('People holding work')).toBe('5')
    expect(statValue('Longest wait')).toMatch(/^9\s*days$/)
  })

  it('hides the rule and the tone dot, which only repeat the number', () => {
    const { container } = render(<OversightStats stats={stats()} />)

    // Announcing them would give a screen reader "bullet, In flight, 12,
    // graphic" for every card. The number is the content; the colour is not.
    expect(screen.getByText('In progress').previousElementSibling).toHaveAttribute(
      'aria-hidden',
      'true',
    )
    expect(statCard('In progress').lastElementChild).toHaveAttribute('aria-hidden', 'true')

    // And the same for the other three, without naming one of them: every
    // node in the row that carries no text is decoration, so every one of
    // them has to sit inside a hidden subtree. Twelve of them - a dot, a
    // track and a fill per card - and a single exposed one is a stray
    // "graphic" announced between a label and its number.
    const wordless = [...container.querySelectorAll('span, div')].filter(
      node => (node.textContent ?? '').trim() === '',
    )
    expect(wordless).toHaveLength(12)
    for (const node of wordless) {
      expect(node.closest('[aria-hidden="true"]')).not.toBeNull()
    }
  })

  it('draws each rule as the share of the board it claims to be', () => {
    render(<OversightStats stats={stats({ inFlight: 12, stalled: 3, holders: 6, longestWaitDays: 15 })} />)

    // The rule is the only statement of the proportion - three stalled out of
    // twelve is a quarter of the board, and a rule drawn to some other number
    // is a picture of a different organisation. In flight is the denominator,
    // so its own rule is always full; the wait is a share of thirty days.
    expect(statRuleWidth('In progress')).toBe('100%')
    expect(statRuleWidth('Stalled over a week')).toBe('25%')
    expect(statRuleWidth('People holding work')).toBe('50%')
    expect(statRuleWidth('Longest wait')).toBe('50%')
  })
})

describe('an empty board', () => {
  const nothing = stats({ inFlight: 0, stalled: 0, holders: 5, longestWaitDays: 0 })

  it('reads as four zeroes rather than four blanks', () => {
    render(<OversightStats stats={stats({ inFlight: 0, stalled: 0, holders: 0, longestWaitDays: 0 })} />)

    // A card that dropped its value at zero would be indistinguishable from
    // one whose data never arrived, and "nothing is stalled" is exactly the
    // fact somebody opened this screen to confirm.
    expect(statValue('In progress')).toBe('0')
    expect(statValue('Stalled over a week')).toBe('0')
    expect(statValue('People holding work')).toBe('0')
    expect(statValue('Longest wait')).toMatch(/^0\s*days$/)
  })

  it('never divides by an in-flight count of zero', () => {
    render(<OversightStats stats={nothing} />)

    // Three of the four rules are a share of `inFlight`. Unguarded, an empty
    // board makes every one of them `width: NaN%`, which the cards silently
    // lose their rule to and the row looks half-rendered.
    //
    // Searching the markup for the string "NaN" cannot see this: React hands
    // `NaN%` to the CSSOM, the CSSOM rejects it, and the whole style
    // attribute disappears - the rendered node is `<div></div>` either way.
    // Only the resolved width tells the two apart, so that is what is read.
    expect(statRuleWidth('Stalled over a week')).toBe('0%')
    expect(statRuleWidth('People holding work')).toBe('0%')
    expect(statRuleWidth('Longest wait')).toBe('0%')
    expect(statRuleWidth('In progress')).toBe('100%')
  })
})

describe('the wording of a duration', () => {
  it('says "day" for one and "days" for more than one', () => {
    const { rerender } = render(<OversightStats stats={stats({ longestWaitDays: 1 })} />)
    expect(screen.getByText('day')).toBeInTheDocument()

    rerender(<OversightStats stats={stats({ longestWaitDays: 2 })} />)
    expect(screen.getByText('days')).toBeInTheDocument()
  })

  it('says "days" for zero, not "day"', () => {
    render(<OversightStats stats={stats({ longestWaitDays: 0 })} />)

    expect(screen.getByText('days')).toBeInTheDocument()
    expect(screen.queryByText('day')).not.toBeInTheDocument()
  })

  it('keeps the true figure once the rule has run out of room', () => {
    render(<OversightStats stats={stats({ longestWaitDays: 412 })} />)

    // The rule is capped at 100% - a year-old document cannot draw a longer
    // bar than a month-old one. The text must not be capped with it, because
    // 412 days and 30 days call for very different conversations.
    expect(statRuleWidth('Longest wait')).toBe('100%')
    expect(statValue('Longest wait')).toMatch(/^412\s*days$/)
  })
})

describe('what it refuses to claim', () => {
  it('names the stalled figure by age, never as a missed deadline', () => {
    render(<OversightStats stats={stats()} />)

    // No step carries a due date, so nothing in this system can breach one.
    // A card headed "Breaching SLA" would assert a policy the organisation
    // has not set, over a number that is really just "old".
    expect(screen.getByText('Stalled over a week')).toBeInTheDocument()
    expect(screen.queryByText(/SLA|breach/i)).not.toBeInTheDocument()
    expect(statCard('Stalled over a week').getAttribute('title')).toMatch(
      /No SLA is configured/,
    )
  })

  it('shows no SLA card while the feature is off', () => {
    render(<OversightStats stats={stats()} />)

    expect(screen.queryByText('Breaching SLA')).not.toBeInTheDocument()
  })

  it('stays away when no deadline has been set anywhere on the board', () => {
    // `breaching` is null, not zero. A card reading "0 breaching" is a
    // compliance claim, and a deployment that has set no deadline has made
    // no commitment to be compliant with.
    features.sla = true
    render(<OversightStats stats={stats({ breaching: null })} />)

    expect(screen.queryByText('Breaching SLA')).not.toBeInTheDocument()
  })

  it('reports a real breach count where deadlines exist', () => {
    features.sla = true
    render(<OversightStats stats={stats({ inFlight: 12, breaching: 3 })} />)

    expect(screen.getByText('Breaching SLA')).toBeInTheDocument()
    expect(statValue('Breaching SLA')).toBe('3memos')
    // Three of twelve, drawn as three of twelve.
    expect(statRuleWidth('Breaching SLA')).toBe('25%')
  })

  it('says nothing is breaching, once there is something it could have breached', () => {
    // Zero means something here that it did not mean above: deadlines are set
    // and everything is inside them. That is worth showing.
    features.sla = true
    render(<OversightStats stats={stats({ breaching: 0 })} />)

    expect(statValue('Breaching SLA')).toBe('0memos')
    expect(statRuleWidth('Breaching SLA')).toBe('0%')
  })
})
