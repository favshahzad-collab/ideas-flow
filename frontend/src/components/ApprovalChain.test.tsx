import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { WorkflowStepStatus, WorkflowStepView } from '../types/documentDetail'
import ApprovalChain from './ApprovalChain'

/**
 * The read-only chain: who has already handled this document, who is holding
 * it right now, and who has not seen it yet. It is drawn on the queue rail
 * and on the document detail screen, and it is what somebody scans before
 * they chase a signature - so the failures that matter are saying a step is
 * finished when it is not, naming the wrong person, and saying it all in tint
 * alone, which is nothing at all to a colourblind reader or a screen reader.
 */

const step = (overrides: Partial<WorkflowStepView> = {}): WorkflowStepView => ({
  id: 's1',
  step: 1,
  type: 'Reviewer',
  user: 'Bilal Ahmed',
  userId: 'u-bilal',
  initials: 'BA',
  status: 'pending',
  ...overrides,
})

/**
 * What is left of a row once every decorative part is dropped - i.e. what a
 * screen reader would read out, and what survives if the tints are stripped.
 */
function announced(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement
  clone.querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove())

  // Joined with a space rather than read off `textContent`, because the DOM
  // runs adjacent elements together ("Bilal AhmedReviewer") while a screen
  // reader pauses between them.
  const parts: string[] = []
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim()
      if (text) parts.push(text)
      return
    }
    node.childNodes.forEach(walk)
  }
  walk(clone)
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

const rows = () => screen.getAllByRole('listitem')

describe('ApprovalChain', () => {
  it('says a document has no chain rather than drawing an empty panel', () => {
    // A blank space where the routing should be reads as a loading bug. The
    // person needs to know the document genuinely has nowhere to go.
    render(<ApprovalChain steps={[]} />)

    expect(screen.getByText('No approval chain on this document.')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it.each([
    ['completed', 'Completed'],
    ['current', 'Waiting on this step'],
    ['pending', 'Not yet reached'],
    ['skipped', 'Skipped'],
  ] as [WorkflowStepStatus, string][])(
    'puts the %s state of a step into words, not only a tint',
    (status, label) => {
      render(<ApprovalChain steps={[step({ status })]} />)

      // The glyph and the fill are both invisible to a screen reader and to
      // anyone who cannot separate the tints; the word is the only thing that
      // travels. Without it every row reads identically.
      expect(announced(rows()[0])).toContain(label)
    },
  )

  it('gives the four states four different words, so no two rows read alike', () => {
    const statuses: WorkflowStepStatus[] = ['completed', 'current', 'pending', 'skipped']
    render(
      <ApprovalChain
        steps={statuses.map((status, index) =>
          step({ id: `s${index}`, status, user: 'Bilal Ahmed', type: 'Approver' }),
        )}
      />,
    )

    // Not merely four *distinct* words: the right word against the right row.
    // A mapping shifted by one - every row reading out its neighbour's state,
    // so a finished step says "waiting" and a waiting step says "done" - is
    // still four different strings and would satisfy a uniqueness count.
    expect(rows().map(announced)).toEqual([
      'Bilal Ahmed Approver — Completed',
      'Bilal Ahmed Approver — Waiting on this step',
      'Bilal Ahmed Approver — Not yet reached',
      'Bilal Ahmed Approver — Skipped',
    ])
  })

  it('draws every glyph as decoration, so nothing is carried by the icon alone', () => {
    const { container } = render(
      <ApprovalChain steps={[step({ status: 'completed' }), step({ id: 's2' })]} />,
    )

    // A tick that is not aria-hidden would be announced as an unlabelled
    // graphic, and a tick that is the ONLY carrier of "done" would tell a
    // screen-reader user nothing at all. Both are covered by: every icon is
    // decorative, and the state is in the text.
    // Each half of that has to be asserted, and the first one is what keeps
    // the loop below from passing on an empty list: every row carries a glyph
    // (it is the only state marker a sighted reader gets)...
    for (const row of rows()) expect(row.querySelectorAll('svg').length).toBeGreaterThan(0)

    // ...and not one of them is exposed to the accessibility tree.
    const icons = [...container.querySelectorAll('svg')]
    for (const icon of icons) expect(icon).toHaveAttribute('aria-hidden', 'true')
  })

  it('lists the steps in the order the document actually travels them', () => {
    // The rail is read top to bottom as "next it goes to". Rendering the
    // array in any other order would have somebody chase the wrong person.
    render(
      <ApprovalChain
        steps={[
          step({ id: 'a', user: 'Ayesha Khan', type: 'Preparer', status: 'completed' }),
          step({ id: 'b', user: 'Bilal Ahmed', type: 'Reviewer', status: 'current' }),
          step({ id: 'c', user: 'Chandni Rao', type: 'Final Approver' }),
        ]}
      />,
    )

    // Whole rows, not just the names: reading each person back with the role
    // and the state that belong to them is what catches the other half of
    // this bug, where the list is in the right order but the states are drawn
    // from a parallel array that is not.
    expect(rows().map(announced)).toEqual([
      'Ayesha Khan Preparer — Completed',
      'Bilal Ahmed Reviewer — Waiting on this step',
      'Chandni Rao Final Approver — Not yet reached',
    ])

    // An unordered list tells a screen reader these three are a set. They are
    // a sequence, and "2 of 3" is half of what the rail is for.
    expect(screen.getByRole('list').tagName).toBe('OL')
  })

  it('shows the comment an approver left on the step they left it on', () => {
    // This is the difference the two old implementations drifted apart over:
    // a chain that hides "sending back, figures are last quarter's" leaves the
    // preparer with an unexplained bounce.
    render(
      <ApprovalChain
        steps={[
          step({ id: 'a', user: 'Ayesha Khan', status: 'completed' }),
          step({
            id: 'b',
            user: 'Bilal Ahmed',
            status: 'completed',
            comment: 'Figures are last quarter’s.',
          }),
        ]}
      />,
    )

    expect(within(rows()[1]).getByText('Figures are last quarter’s.')).toBeInTheDocument()
    expect(announced(rows()[0])).not.toContain('Figures')
  })

  it('reads out a whole row as person, date, role and state', () => {
    render(
      <ApprovalChain
        steps={[
          step({
            user: 'Bilal Ahmed',
            type: 'Approver',
            date: '12 Aug 2026',
            status: 'completed',
          }),
        ]}
      />,
    )

    expect(announced(rows()[0])).toBe('Bilal Ahmed 12 Aug 2026 Approver — Completed')
  })

  it('never invents a date for a step nobody has acted on yet', () => {
    // A pending step carrying a date would read as already handled. The row
    // for someone who has not touched the document must be silent about when.
    render(<ApprovalChain steps={[step({ status: 'pending', date: undefined })]} />)

    expect(announced(rows()[0])).toBe('Bilal Ahmed Reviewer — Not yet reached')
  })

  it('leaves no empty comment bubble when there is no comment', () => {
    // An empty bubble contributes no text, so `announced` cannot see one and
    // an assertion on the announced row would be the previous test again.
    // Rendering the same step three ways instead - no comment key at all, an
    // explicit null, an empty string - and demanding identical markup does
    // catch it, because the tinted box only exists in one of the three. It
    // also survives a restyle, since a restyle moves all three together.
    const bare = render(<ApprovalChain steps={[step()]} />)
    const noCommentKey = bare.container.querySelector('li')!.innerHTML
    bare.unmount()

    const nulled = render(<ApprovalChain steps={[step({ comment: null })]} />)
    const nullComment = nulled.container.querySelector('li')!.innerHTML
    nulled.unmount()

    const { container } = render(<ApprovalChain steps={[step({ comment: '' })]} />)

    expect(nullComment).toBe(noCommentKey)
    expect(container.querySelector('li')!.innerHTML).toBe(noCommentKey)
    expect(announced(rows()[0])).toBe('Bilal Ahmed Reviewer — Not yet reached')
  })

  it('keeps a very long name whole rather than cutting it short', () => {
    // The name may be clipped visually, but the text must stay complete: a
    // truncated string baked into the DOM would name the wrong person to
    // anyone reading it with assistive technology.
    const long = 'Muhammad Abdul Rahman Siddiqui Al-Hussaini'
    render(<ApprovalChain steps={[step({ user: long })]} />)

    expect(screen.getByText(long)).toBeInTheDocument()
  })

  it('names somebody, or says nobody, on a step with no assignee', () => {
    // An unassigned step arrives here as an empty name (`formatFullName` of a
    // missing user trims to ''), and the row then shows a role and a state
    // with a blank where the person goes. A reader cannot tell whether the
    // step is unassigned or the screen failed to load.
    render(<ApprovalChain steps={[step({ user: '', initials: '?' })]} />)

    expect(announced(rows()[0])).toMatch(/unassigned|not assigned|nobody/i)
  })

  it('survives a step state it has no word for', () => {
    // The API sends the approver's action as the step status - APPROVE,
    // REJECT, REQUEST_REVISION, SKIP - and only four of those have a node
    // here. Anything unmapped reads `undefined.icon` and takes the whole
    // detail screen down with it.
    expect(() =>
      render(
        <ApprovalChain
          steps={[step({ status: 'rejected' as unknown as WorkflowStepStatus })]}
        />,
      ),
    ).not.toThrow()
  })
})
