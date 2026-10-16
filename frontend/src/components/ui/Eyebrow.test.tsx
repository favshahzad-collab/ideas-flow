import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Eyebrow from './Eyebrow'

/**
 * The 10px mono kicker above a panel - "WORKSPACE", "STEP 3 OF 4 · ROUTING",
 * "APPEND-ONLY · 17 ENTRIES". It is context, not decoration, so it has to be
 * readable; and because it sits directly above real headings, the element it
 * renders as decides whether a screen-reader user navigating by heading
 * lands on a two-word fragment instead of the title of the screen.
 */

function kicker(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement
}

/**
 * The ink class the tone picked. Colour is normally none of a test's
 * business - the exception here is that `tone` exists solely to keep the
 * text legible against three different surfaces, so a tone that goes
 * nowhere puts light-surface ink on the navy sidebar and the control room:
 * text that is technically present and cannot be read.
 */
function ink(el: HTMLElement): string | undefined {
  return el.className.split(/\s+/).find(c => c.startsWith('text-') && c !== 'text-eyebrow')
}

describe('Eyebrow', () => {
  it('renders the whole kicker, in one element, exactly as written', () => {
    // Eyebrows are compound strings - "APPEND-ONLY · 17 ENTRIES" is a claim
    // about the ledger and a count, joined by a separator that has to survive
    // whatever the component does to its children. `getByText` on a fragment
    // would pass on a kicker that dropped half of it.
    const { container } = render(<Eyebrow>Append-only · 17 entries</Eyebrow>)

    const el = kicker(container)
    expect(el.textContent).toBe('Append-only · 17 entries')
    // ...in this element and not scattered across wrappers beneath it: the
    // one node holding the string is the kicker itself.
    expect(screen.getByText('Append-only · 17 entries')).toBe(el)
    expect(container.children).toHaveLength(1)
  })

  it('is a paragraph, not a heading, by default', () => {
    // Most eyebrows label a panel that already has an h2 underneath. Two
    // headings for one region doubles the heading list and puts the vaguer
    // of the two first.
    const { container } = render(<Eyebrow>Workspace</Eyebrow>)

    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    // Named, not merely "not a heading": a default of `span` also passes the
    // line above while quietly taking the kicker out of the block flow every
    // call site lays it out in.
    expect(kicker(container).tagName).toBe('P')
  })

  it.each([2, 3] as const)(
    'becomes a real h%i where the kicker is the only title a region has',
    level => {
      // The workflow studio's rails have no other title. If this were still a
      // paragraph, those panels would be unreachable by heading navigation.
      render(<Eyebrow as={`h${level}` as 'h2' | 'h3'}>Inspector</Eyebrow>)

      expect(screen.getByRole('heading', { level, name: 'Inspector' })).toBeInTheDocument()
    },
  )

  it('stays out of the heading outline when asked for a span', () => {
    // The inline form sits inside a line of running text. Promoting it would
    // scatter fragments like "· ROUTING" through the heading list, which is
    // how a screen-reader user builds their picture of the page.
    const { container } = render(<Eyebrow as="span">Routing</Eyebrow>)

    expect(kicker(container).tagName).toBe('SPAN')
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })

  it('can be a definition term, so a summary list stays a summary list', () => {
    // The submit-document review step pairs each eyebrow with a dd. A p
    // between dt and dd is invalid markup and breaks the pairing an
    // assistive technology reads the list by.
    const { container } = render(
      <dl>
        <Eyebrow as="dt">Preparer</Eyebrow>
        <dd>Ayesha Khan</dd>
      </dl>,
    )

    const term = container.querySelector('dt')
    expect(term).toHaveTextContent('Preparer')
    // ...and it really is the term, not a p that happens to sit beside one.
    expect(term?.nextElementSibling?.tagName).toBe('DD')
    expect(container.querySelector('p')).toBeNull()
  })

  it('lends its id to whatever region it titles', () => {
    // This is how the sidebar's nav groups get their accessible names. If
    // the id were dropped, every group would announce as an unnamed
    // navigation landmark and there would be no way to tell them apart.
    render(
      <nav aria-labelledby="group-approvals">
        <Eyebrow id="group-approvals">Approvals</Eyebrow>
      </nav>,
    )

    expect(screen.getByRole('navigation', { name: 'Approvals' })).toBeInTheDocument()
  })

  it('leaves the text in its written case and uppercases with type instead', () => {
    // A string shouted in the DOM ("ROUTING") is read letter by letter by
    // some screen readers. Uppercasing belongs to CSS, where it changes only
    // what is drawn - so both halves of that claim get asserted: the DOM
    // keeps the written case, and the class that does the shouting is there.
    const { container } = render(<Eyebrow>Routing</Eyebrow>)

    expect(kicker(container).textContent).toBe('Routing')
    expect(kicker(container).className.split(/\s+/)).toContain('uppercase')
  })

  it('says the same thing on a dark panel as on a light one', () => {
    // Tone only picks a contrast-safe ink for the surface behind it: the
    // words are identical, the ink is not. Three surfaces, three inks - two
    // of them collapsing into one means one of those surfaces is being drawn
    // with the wrong contrast.
    const inks = (['default', 'dark', 'shell'] as const).map(tone => {
      const view = render(<Eyebrow tone={tone}>Nodes</Eyebrow>)
      expect(kicker(view.container).textContent, tone).toBe('Nodes')
      const found = ink(kicker(view.container))
      view.unmount()
      return found
    })

    expect(inks.filter(Boolean)).toHaveLength(3)
    expect(new Set(inks).size).toBe(3)
  })

  it('keeps the classes a caller adds alongside its own', () => {
    // Every call site positions the kicker itself - a dropped className is
    // how an eyebrow ends up overlapping the heading below it.
    const { container } = render(<Eyebrow className="mb-2">Nodes</Eyebrow>)

    const classes = kicker(container).className.split(/\s+/)
    expect(classes).toContain('mb-2')
    expect(classes).toContain('font-mono')
  })
})
