import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AuditActionLabel } from '../../types/audit'
import ActionBadge from './ActionBadge'

/**
 * One line of the approval log, in a pill. The audit ledger is what somebody
 * opens to establish what actually happened to a document, which makes two
 * things non-negotiable: the event is named in words (not implied by a hue),
 * and the hue never contradicts the word - the bug this component was written
 * to kill was a REJECTION drawn in accent green.
 */

const ALL_ACTIONS: AuditActionLabel[] = [
  'Approved',
  'Rejected',
  'Revision Requested',
  'Step Skipped',
  'Document Uploaded',
  'Document Resubmitted',
  'Document Withdrawn',
  'Unrecognised action',
]

/** The pill itself; it carries no role, so there is nothing to query it by. */
function badge(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement
}

/** What a screen reader is left with once the decorative dot is dropped. */
function announced(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement
  clone.querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove())
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Which semantic tone the pill was drawn in. Colour is normally none of a
 * test's business, but here it is the one thing the label cannot self-report,
 * and a tone that disagrees with the label is exactly the failure mode this
 * component exists to prevent.
 */
function toneOf(el: HTMLElement): string | undefined {
  return /bg-(accent|info|warning|danger|revision|neutral)-soft/.exec(el.className)?.[1]
}

/** The hover text that restores whatever the dense spelling dropped. */
function titleOf(el: HTMLElement): string | null | undefined {
  return el.querySelector('[title]')?.getAttribute('title')
}

describe('ActionBadge', () => {
  it.each([
    ['Approved', 'Approved'],
    ['Rejected', 'Rejected'],
    ['Revision Requested', 'Revision'],
    ['Step Skipped', 'Skipped'],
    ['Document Uploaded', 'Uploaded'],
    ['Document Resubmitted', 'Resubmitted'],
    ['Document Withdrawn', 'Withdrawn'],
    ['Unrecognised action', 'Unrecognised'],
  ] as [AuditActionLabel, string][])('shortens %s to "%s" for a dense row', (action, short) => {
    const { container } = render(<ActionBadge action={action} />)

    // The whole announced string, not a substring of it: `getByText('Revision')`
    // also passes on a pill that never shortened anything.
    expect(announced(badge(container))).toBe(short)
  })

  it.each(ALL_ACTIONS)('spells %s out in full when asked to', action => {
    const { container } = render(<ActionBadge action={action} verbose />)

    expect(announced(badge(container))).toBe(action)
  })

  it('actually spells out the four actions the short form abbreviates', () => {
    // Four of the eight labels are identical either way, so an ignored
    // `verbose` prop is invisible in half the table above. These are the
    // rows that would give it away.
    const abbreviated: [AuditActionLabel, string][] = [
      ['Revision Requested', 'Revision'],
      ['Step Skipped', 'Skipped'],
      ['Document Uploaded', 'Uploaded'],
      ['Document Resubmitted', 'Resubmitted'],
    ]

    for (const [action, short] of abbreviated) {
      const view = render(<ActionBadge action={action} verbose />)
      expect(announced(badge(view.container)), action).not.toBe(short)
      expect(announced(badge(view.container)), action).toBe(action)
      view.unmount()
    }
  })

  it('gives every action a label of its own, none of them blank', () => {
    // A ledger row whose action cell is empty, or that reads the same as the
    // row above it, cannot be used to establish what happened - which is the
    // only reason the ledger exists.
    const labels = ALL_ACTIONS.map(action => {
      const view = render(<ActionBadge action={action} />)
      const text = announced(badge(view.container))
      view.unmount()
      return text
    })

    expect(labels.filter(Boolean)).toHaveLength(ALL_ACTIONS.length)
    expect(new Set(labels).size).toBe(ALL_ACTIONS.length)
  })

  it.each([
    ['Approved', 'accent'],
    ['Rejected', 'danger'],
    ['Revision Requested', 'revision'],
    ['Step Skipped', 'warning'],
    ['Document Uploaded', 'neutral'],
    ['Document Resubmitted', 'info'],
    ['Document Withdrawn', 'neutral'],
    ['Unrecognised action', 'neutral'],
  ] as [AuditActionLabel, string][])('draws %s in the %s tone', (action, tone) => {
    // The regression this replaces drew every badge in the detail view in
    // accent, so a rejection was tinted green: colour asserting the opposite
    // of the event beside it, which is worse than no colour at all.
    const { container } = render(<ActionBadge action={action} />)

    expect(toneOf(badge(container))).toBe(tone)
  })

  it('lets no event but an approval wear the go-ahead colour', () => {
    // The specific regression, stated as the rule rather than case by case:
    // accent is reserved. Anything else claiming it is the green rejection
    // all over again, in whichever row happens to be mismapped next.
    for (const action of ALL_ACTIONS.filter(a => a !== 'Approved')) {
      const view = render(<ActionBadge action={action} />)
      expect(toneOf(badge(view.container)), action).not.toBe('accent')
      view.unmount()
    }
  })

  it('tints the same way whether the row is dense or spelled out', () => {
    // Two consumers, one map. The detail view passes `verbose`; if the tone
    // were read off the rendered label rather than the action, the long form
    // is exactly where it would drift back apart.
    for (const action of ALL_ACTIONS) {
      const short = render(<ActionBadge action={action} />)
      const shortTone = toneOf(badge(short.container))
      short.unmount()

      const long = render(<ActionBadge action={action} verbose />)
      expect(toneOf(badge(long.container)), action).toBe(shortTone)
      long.unmount()
    }
  })

  it('names an action it has never heard of instead of guessing', () => {
    // The fallback this replaced labelled unknown actions "Approved" - it
    // reported a positive outcome for an event nobody had identified.
    const { container } = render(<ActionBadge action={'Quarantined' as AuditActionLabel} />)

    expect(announced(badge(container))).toBe('Quarantined')
  })

  it('refuses to lend an unknown action another event’s colour', () => {
    const { container } = render(<ActionBadge action={'Quarantined' as AuditActionLabel} />)

    // Neutral is the only honest hue for an event this build cannot classify.
    expect(toneOf(badge(container))).toBe('neutral')
  })

  it('still names and labels an unknown action in the spelled-out row', () => {
    // The detail view renders the same ledger with `verbose`, and takes a
    // different branch to do it. An unknown action is exactly the row a
    // reader most needs to be able to read and hover, because it is the one
    // this build cannot explain - so neither branch may drop it, and neither
    // may quietly classify it.
    const { container } = render(
      <ActionBadge action={'Quarantined' as AuditActionLabel} verbose />,
    )

    expect(announced(badge(container))).toBe('Quarantined')
    expect(titleOf(badge(container))).toBe('Quarantined')
    expect(toneOf(badge(container))).toBe('neutral')
  })

  it('leaves the tone dot out of the accessibility tree', () => {
    const { container } = render(<ActionBadge action="Rejected" />)

    // The dot repeats the tone and nothing else. Announced, it would put a
    // nameless bullet in front of every row of the log.
    expect(announced(badge(container))).toBe('Rejected')
    const dot = badge(container).querySelector('[aria-hidden="true"]')
    expect(dot).not.toBeNull()
    expect(dot?.textContent).toBe('')
  })

  it('keeps the full action name on the shortened pill', () => {
    // "Skipped" loses the fact that it was a workflow STEP that was skipped;
    // the title restores it on hover for anyone unsure what the row means.
    // A title echoing the shortened label instead would restore nothing.
    const { container } = render(<ActionBadge action="Step Skipped" />)

    expect(announced(badge(container))).toBe('Skipped')
    expect(titleOf(badge(container))).toBe('Step Skipped')
  })

  it.each(ALL_ACTIONS)('carries the unabbreviated %s as hover text', action => {
    const { container } = render(<ActionBadge action={action} />)

    expect(titleOf(badge(container))).toBe(action)
  })
})
