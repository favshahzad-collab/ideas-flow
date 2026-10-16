import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { QuickInfo } from './QuickInfo'

/**
 * The panel beside an open document that says how its approval chain is made
 * up: how many reviewers, how many approvers.
 *
 * It used to lead with "Total Steps" and "Completed Steps" as well, directly
 * under the Approval chain card that heads itself with the same two numbers.
 * Those rows are gone, and a test below keeps them gone.
 *
 * The pairing is a description list, so each number is tied to its label by
 * markup rather than by position - which is what `valueFor` asserts below.
 */

type Props = Parameters<typeof QuickInfo>[0]

function renderInfo(overrides: Partial<Props> = {}) {
  return render(<QuickInfo reviewers={2} approvers={2} {...overrides} />)
}

/**
 * The number defined by `label`. This walks the <dt> to its <dd> rather than
 * taking whatever sits last in the row: the point of the markup is that the
 * relationship exists, so the helper has to fail if it stops existing.
 */
function valueFor(label: string): string {
  const term = screen.getByText(label)
  if (term.tagName !== 'DT') {
    throw new Error(`"${label}" is a <${term.tagName.toLowerCase()}>, not a <dt>`)
  }
  const value = term.nextElementSibling
  if (!value || value.tagName !== 'DD') {
    throw new Error(`"${label}" has no <dd> after it`)
  }
  return value.textContent?.trim() ?? ''
}

describe('QuickInfo', () => {
  it('is findable by heading, since it carries no landmark of its own', () => {
    renderInfo()

    // The <section> has no accessible name, so heading navigation is the only
    // way a screen reader user reaches this panel from the document body -
    // and only at the level the rest of the page's panels use.
    expect(
      screen.getByRole('heading', { name: 'Quick Info', level: 2 }),
    ).toBeInTheDocument()
  })

  it('lists how the chain is made up, and nothing the chain card already says', () => {
    renderInfo({ reviewers: 2, approvers: 5 })

    // Exactly these rows, in this order. The step counts are the Approval
    // chain card's to show; a second copy here is what this panel was cut
    // back to get rid of.
    expect(
      Array.from(document.querySelectorAll('dt')).map(term => term.textContent),
    ).toEqual(['Reviewers', 'Approvers'])
    expect(valueFor('Reviewers')).toBe('2')
    expect(valueFor('Approvers')).toBe('5')
  })

  it('keeps two rows that hold the same number apart', () => {
    renderInfo({ reviewers: 3, approvers: 3 })

    // Both rows read "3". Anything that finds the number before the label it
    // belongs to cannot tell them apart, which is why the pairing has to
    // survive duplicate values.
    expect(screen.getAllByText('3')).toHaveLength(2)
    expect(valueFor('Reviewers')).toBe('3')
    expect(valueFor('Approvers')).toBe('3')
  })

  it('prints a zero rather than leaving the row blank', () => {
    renderInfo({ reviewers: 0, approvers: 0 })

    // A document submitted with no approval chain has two legitimate zeros.
    // Blank rows in their place look like a panel that failed to load.
    expect(valueFor('Reviewers')).toBe('0')
    expect(valueFor('Approvers')).toBe('0')
  })

  it('follows the chain when it changes', () => {
    const { rerender } = renderInfo({ reviewers: 1, approvers: 3 })

    rerender(<QuickInfo reviewers={2} approvers={3} />)

    // Fed by the workflow query, which refetches after every change to the
    // chain. A number captured once would keep describing the old chain.
    expect(valueFor('Reviewers')).toBe('2')
    expect(valueFor('Approvers')).toBe('3')
  })

  it('prints a large count as a plain number, not a grouped or shortened one', () => {
    renderInfo({ reviewers: 1200, approvers: 560 })

    // `toLocaleString` renders 1,200 under one runtime and 1.200 under
    // another, and a comma reads as a decimal point in half of Europe.
    expect(valueFor('Reviewers')).toBe('1200')
    expect(valueFor('Approvers')).toBe('560')
  })
})
