import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ReadinessCheck } from '../../utils/submitDocument'
import type { SubmitStepId } from '../../utils/submitSteps'
import SubmitStepper from './SubmitStepper'

/**
 * The four-node rail across the top of the submit form. It is the only thing
 * that tells a preparer where they are in a form whose remaining three
 * quarters are off screen, and - once they have tried to submit - which part
 * of it is holding the submission up.
 *
 * `getStepStates` is tested in submitSteps.test.ts. What matters here is what
 * a person is actually told: that the current node says it is current in
 * words rather than in accent colour, that "not started" and "needs
 * attention" are told apart without seeing red, and that pressing a node
 * moves the form.
 */

type CheckId = 'title' | 'file' | 'steps' | 'unique' | 'final'

/** The five checks the real form produces, all satisfied unless said otherwise. */
function checks(overrides: Partial<Record<CheckId, boolean>> = {}): ReadinessCheck[] {
  const done = {
    title: true,
    file: true,
    steps: true,
    unique: true,
    final: true,
    ...overrides,
  }
  return [
    { id: 'title', label: 'Document title provided', done: done.title },
    { id: 'file', label: 'PDF attached (max 20 MB)', done: done.file },
    { id: 'steps', label: 'Every step has an assignee', done: done.steps },
    { id: 'unique', label: 'No person appears twice', done: done.unique },
    {
      id: 'final',
      label: 'Exactly one final approver, placed last',
      done: done.final,
    },
  ]
}

function renderStepper(
  overrides: {
    current?: SubmitStepId
    checks?: ReadinessCheck[]
    attempted?: boolean
  } = {},
) {
  const onSelect = vi.fn()
  const view = render(
    <SubmitStepper
      current={overrides.current ?? 'details'}
      checks={overrides.checks ?? checks()}
      attempted={overrides.attempted ?? false}
      onSelect={onSelect}
    />,
  )
  return { ...view, onSelect }
}

const node = (label: string) =>
  screen.getByRole('button', { name: new RegExp(`^${label}`) })

describe('where the preparer is', () => {
  it('names the rail, so it is not four loose buttons above the form', () => {
    renderStepper()

    // The landmark has to contain the nodes, not merely sit beside them: an
    // empty <nav aria-label="Submission steps"> is a landmark a screen-reader
    // user jumps to and finds nothing in.
    const rail = screen.getByRole('navigation', { name: 'Submission steps' })
    expect(within(rail).getAllByRole('button')).toHaveLength(4)
    expect(screen.getAllByRole('button')).toHaveLength(4)
  })

  it('lists the four steps in the order they are worked through', () => {
    renderStepper()

    // Routing before Sign is the whole point of the split: signing is the
    // irreversible act and must come after the chain has been settled.
    const labels = screen
      .getAllByRole('button')
      .map(button => button.textContent?.replace(/^\d+/, '').split('—')[0].trim())

    expect(labels).toEqual(['Details', 'File', 'Routing', 'Sign'])
  })

  it('marks the step being edited, and only that one, as current', () => {
    renderStepper({ current: 'routing' })

    expect(node('Routing')).toHaveAttribute('aria-current', 'step')
    // A second aria-current would leave a screen reader announcing two
    // "current" steps and no way to tell which panel is on screen.
    for (const label of ['Details', 'File', 'Sign']) {
      expect(node(label)).not.toHaveAttribute('aria-current')
    }
  })

  it('says how far along the step is, not just which one it is', () => {
    renderStepper({ current: 'routing' })

    expect(node('Routing')).toHaveAccessibleName(/step 3 of 4, current step/)
  })
})

describe('what each node says about its state', () => {
  it('spells out "complete" instead of relying on the tick and the tint', () => {
    // The only visual difference between a finished step and an untouched one
    // is a tick and a background colour. Neither survives a screen reader or
    // a person who cannot separate the accent from the surface.
    renderStepper({ current: 'file' })

    expect(node('Details')).toHaveAccessibleName(/complete/)
  })

  it('calls an unfinished step "not started" before anything has been submitted', () => {
    renderStepper({ current: 'details', checks: checks({ file: false }) })

    // Opening the form with a step already flagged red reads as a fault in
    // the app rather than as guidance about a form nobody has filled in yet.
    expect(node('File')).toHaveAccessibleName(/not started/)
    expect(node('File')).not.toHaveAccessibleName(/needs attention/)
  })

  it('turns it into "needs attention" once a submit has been refused', () => {
    renderStepper({
      current: 'details',
      checks: checks({ file: false }),
      attempted: true,
    })

    expect(node('File')).toHaveAccessibleName(/needs attention/)
  })

  it('does not flag the step being worked on, even after a refused submit', () => {
    // The preparer is standing in Details with the title still empty. Telling
    // them the panel they are looking at "needs attention" is noise - the
    // field beneath the cursor is already marked invalid - and it costs the
    // rail the one thing it is for: saying which step is open.
    renderStepper({
      current: 'details',
      checks: checks({ title: false, file: false }),
      attempted: true,
    })

    expect(node('Details')).toHaveAccessibleName(/current step/)
    expect(node('Details')).not.toHaveAccessibleName(/needs attention/)
    // ...while the step they are not looking at is flagged.
    expect(node('File')).toHaveAccessibleName(/needs attention/)
  })

  it('counts what is outstanding, in singular and in plural', () => {
    const one = renderStepper({ current: 'details', checks: checks({ final: false }) })
    expect(node('Routing')).toHaveAccessibleName(/1 item outstanding/)
    one.unmount()

    renderStepper({
      current: 'details',
      checks: checks({ steps: false, unique: false }),
    })
    // "2 item outstanding" is the kind of wording that makes a person doubt
    // the count itself, on the one screen where the count is the instruction.
    expect(node('Routing')).toHaveAccessibleName(/2 items outstanding/)
  })

  it('says which requirements are outstanding, not merely how many', () => {
    // The description comes from the `title` attribute, which assistive tech
    // reads out and a mouse user hovers. "Routing, 2 items outstanding" with
    // no further detail sends somebody hunting through the panel.
    renderStepper({ current: 'sign', checks: checks({ steps: false, final: false }) })

    expect(node('Routing')).toHaveAccessibleDescription(
      'Every step has an assignee · Exactly one final approver, placed last',
    )
  })

  it('describes a finished step by what it holds rather than as a warning', () => {
    renderStepper({ current: 'sign' })

    expect(node('Details')).toHaveAccessibleDescription('Title and description')
  })

  it('makes the last node answer for the whole form, not just for itself', () => {
    // Sign is the only step that owns no checks of its own, so if it counted
    // the way the other three do it would sit there ticked while the form was
    // unsubmittable. It is the node a preparer looks at to ask "can I send
    // this yet?", and the answer has to be everything that is still missing -
    // a title from step one and a final approver from step three alike.
    renderStepper({
      current: 'details',
      checks: checks({ title: false, final: false }),
      attempted: true,
    })

    expect(node('Sign')).toHaveAccessibleName(/needs attention/)
    expect(node('Sign')).toHaveAccessibleName(/2 items outstanding/)
    expect(node('Sign')).toHaveAccessibleDescription(
      'Document title provided · Exactly one final approver, placed last',
    )
  })

  it('lets the last node go clean only when nothing at all is outstanding', () => {
    renderStepper({ current: 'details' })

    expect(node('Sign')).toHaveAccessibleName(/complete/)
    expect(node('Sign')).not.toHaveAccessibleName(/outstanding/)
    // Falls back to the step's own hint once there is nothing to report.
    expect(node('Sign')).toHaveAccessibleDescription('Review, sign and submit')
  })
})

describe('moving between steps', () => {
  it('takes a preparer back to a step they have already passed', async () => {
    const user = userEvent.setup({ delay: null })
    const { onSelect } = renderStepper({ current: 'sign' })

    await user.click(node('Details'))

    // Fixing a typo in the title from the sign step should not cost three
    // presses of Back.
    expect(onSelect).toHaveBeenCalledWith('details')
  })

  it('lets a preparer jump ahead to a step whose prerequisites are unmet', async () => {
    // Deliberate: nothing is gated, because reading the summary before the
    // chain is finished is a reasonable thing to want, and the refusal that
    // matters - the submit button - is still there. The node says "needs
    // attention" rather than refusing the press.
    const user = userEvent.setup({ delay: null })
    const { onSelect } = renderStepper({
      current: 'details',
      checks: checks({ title: false, file: false, final: false }),
      attempted: true,
    })

    await user.click(node('Sign'))

    expect(onSelect).toHaveBeenCalledWith('sign')
  })

  it('is operable from the keyboard, not only by pointer', async () => {
    const user = userEvent.setup({ delay: null })
    const { onSelect } = renderStepper({ current: 'details' })

    await user.tab()
    expect(node('Details')).toHaveFocus()

    await user.tab()
    await user.keyboard('{Enter}')

    expect(onSelect).toHaveBeenCalledWith('file')
  })

  it('keeps the drawn numeral out of what is read aloud', () => {
    // The disc shows "2" for an upcoming step and a tick for a finished one.
    // Exposing it would have a screen reader say "2 File, step 2 of 4" - and
    // read the tick out as an image with no name.
    renderStepper({ current: 'details' })

    expect(node('File')).toHaveAccessibleName(/^File\s*— step 2 of 4/)
  })
})

describe('on a phone', () => {
  it('is a bar of four segments, each still a button to its step, with the current one marked', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          media: query,
          matches: query === '(max-width: 639px)',
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    )
    try {
      const onSelect = vi.fn()
      render(<SubmitStepper current="file" checks={[]} attempted={false} onSelect={onSelect} />)
      const steps = within(screen.getByRole('navigation', { name: 'Submission steps' })).getAllByRole('button')
      expect(steps).toHaveLength(4)
      expect(steps[1]).toHaveAttribute('aria-current', 'step')
      expect(steps[1]).toHaveAccessibleName(/step 2 of 4, current step/)
      await userEvent.click(steps[3])
      expect(onSelect).toHaveBeenCalledWith('sign')
    } finally {
      vi.restoreAllMocks()
    }
  })
})
