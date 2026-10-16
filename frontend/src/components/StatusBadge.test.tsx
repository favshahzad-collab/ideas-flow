import { render, type RenderResult } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DocumentStatus } from '../types/document'
import StatusBadge from './StatusBadge'

/**
 * The word a person reads to find out where their document is. It is the
 * column people scan on the documents grid and the first thing they look at
 * on the detail header, so the two failures that matter are: saying nothing
 * (a coloured pill with no word tells a colourblind reader, and any screen
 * reader, absolutely nothing), and saying the wrong word (a document that is
 * still waiting on an approver must never read as approved).
 */

const ALL_STATUSES: DocumentStatus[] = [
  'draft',
  'pending_review',
  'pending_approval',
  'revision_requested',
  'approved',
  'rejected',
  'deleted',
]

/** The badge span itself, which has no role of its own to query by. */
function badge(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement
}

/** What is left for a screen reader once the decorative parts are dropped. */
function announced(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement
  clone.querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove())
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Which semantic tone the pill was drawn in, read off the dot - the one
 * element that carries the hue for every status. Colour is normally none of
 * a test's business, but `DocumentsTable` picks this tone from the document's
 * own status, so a swallowed or mismapped tone means a rejected document is
 * tinted like an approved one: colour asserting the opposite of the word
 * beside it, which is worse than no colour at all.
 */
function toneOf(el: HTMLElement): string | undefined {
  const dot = el.querySelector('[aria-hidden="true"]') as HTMLElement | null
  return /bg-(accent|info|warning|danger|revision|neutral)-mark/.exec(dot?.className ?? '')?.[1]
}

describe('StatusBadge', () => {
  it.each([
    ['draft', 'Draft', 'Draft'],
    ['pending_review', 'Review', 'Pending Review'],
    ['pending_approval', 'Approval', 'Pending Approval'],
    ['revision_requested', 'Revision', 'Revision Requested'],
    ['approved', 'Approved', 'Approved'],
    ['rejected', 'Rejected', 'Rejected'],
    ['deleted', 'Withdrawn', 'Withdrawn'],
  ] as [DocumentStatus, string, string][])(
    'reads %s as "%s" in a dense table and "%s" where there is room',
    (status, short, verbose) => {
      const dense = render(<StatusBadge status={status} />)
      expect(announced(badge(dense.container))).toBe(short)
      dense.unmount()

      // The header form has to be unambiguous on its own: "Approval" is a
      // column-width abbreviation, "Pending Approval" is the actual state.
      const wide = render(<StatusBadge status={status} verbose />)
      expect(announced(badge(wide.container))).toBe(verbose)
    },
  )

  it('gives every status a word of its own, so no two states read alike', () => {
    // Two statuses sharing a label would be indistinguishable in the grid:
    // a document held for revision and one that was rejected are different
    // things to the person who has to act on it.
    for (const verbose of [false, true]) {
      const labels = ALL_STATUSES.map(status => {
        const view = render(<StatusBadge status={status} verbose={verbose} />)
        const text = announced(badge(view.container))
        view.unmount()
        return text
      })

      expect(labels.filter(Boolean), String(verbose)).toHaveLength(ALL_STATUSES.length)
      expect(new Set(labels).size, String(verbose)).toBe(ALL_STATUSES.length)
    }
  })

  it('never lets an unfinished document read as approved', () => {
    // Uniqueness is not enough on its own: swapping two labels keeps them
    // distinct while telling somebody their document has cleared the chain.
    // "Approved" is the one word in this set that ends an argument, so no
    // other state may borrow it, in either form.
    for (const status of ALL_STATUSES.filter(s => s !== 'approved')) {
      for (const verbose of [false, true]) {
        const view = render(<StatusBadge status={status} verbose={verbose} />)
        expect(announced(badge(view.container)), `${status} verbose=${verbose}`).not.toBe(
          'Approved',
        )
        view.unmount()
      }
    }
  })

  it.each([
    ['draft', 'neutral'],
    ['pending_review', 'info'],
    ['pending_approval', 'warning'],
    ['revision_requested', 'revision'],
    ['approved', 'accent'],
    ['rejected', 'danger'],
    ['deleted', 'neutral'],
  ] as [DocumentStatus, string][])('draws %s in the %s tone', (status, tone) => {
    const { container } = render(<StatusBadge status={status} />)

    expect(toneOf(badge(container))).toBe(tone)
  })

  it('keeps the go-ahead colour for the one state that earned it', () => {
    // The accent hue is the app's "this is done and fine". A pill that is
    // still waiting on somebody, or that was refused, wearing it is the same
    // lie as the wrong word - and it is the lie a colourblind reader cannot
    // cross-check, because for them the word is all there is.
    for (const status of ALL_STATUSES.filter(s => s !== 'approved')) {
      const view = render(<StatusBadge status={status} />)
      expect(toneOf(badge(view.container)), status).not.toBe('accent')
      view.unmount()
    }
  })

  it('leaves the colour dot out of the accessibility tree', () => {
    const { container } = render(<StatusBadge status="rejected" />)

    // The hue is the dot's only job. If it were announced, a screen reader
    // would hear a nameless bullet before the word that carries the meaning.
    expect(announced(badge(container))).toBe('Rejected')
    const dot = badge(container).querySelector('[aria-hidden="true"]')
    expect(dot).not.toBeNull()
    expect(dot?.textContent).toBe('')
  })

  it('says the same word at either size, and hides the dot at both', () => {
    // xs is the card and drawer form, sm the table form. The size prop is a
    // density choice; if it reached the label or the dot's hidden-ness, the
    // same document would be described differently in two places at once.
    const xs = render(<StatusBadge status="pending_approval" size="xs" />)
    expect(announced(badge(xs.container))).toBe('Approval')
    expect(badge(xs.container).querySelector('[aria-hidden="true"]')).not.toBeNull()
    const xsClass = badge(xs.container).className
    xs.unmount()

    const sm = render(<StatusBadge status="pending_approval" size="sm" />)
    expect(announced(badge(sm.container))).toBe('Approval')
    expect(badge(sm.container).querySelector('[aria-hidden="true"]')).not.toBeNull()
    // ...and the density genuinely did change. Without this the whole test
    // passes on a component that ignores `size` outright, which is the only
    // way `size` can fail: it has no other observable effect, so "the word is
    // the same at both sizes" is otherwise a claim about one rendering made
    // twice.
    expect(badge(sm.container).className).not.toBe(xsClass)
  })

  it('draws the pill and its dot in one tone, not two', () => {
    // Surface and dot come from two separate fields of the same config entry,
    // so they can be edited apart. A rejected badge with a danger dot on an
    // accent surface is the green-rejection bug wearing a red hat: the reader
    // gets one signal from the fill and the opposite from the mark on it.
    for (const status of ALL_STATUSES) {
      const view = render(<StatusBadge status={status} />)
      const pill = badge(view.container)
      const surface = /border-(accent|info|warning|danger|revision|neutral)-line/.exec(
        pill.className,
      )?.[1]

      expect(surface, status).toBeTruthy()
      expect(surface, status).toBe(toneOf(pill))
      view.unmount()
    }
  })

  it('keeps the two waiting states apart, and the right way round', () => {
    // One backend status renders as two words on screen. A person filtering
    // for work of their own is looking for exactly this distinction: whether
    // the document is waiting on a reviewer or on an approver. Swapped, the
    // labels are still distinct and still wrong.
    const review = render(<StatusBadge status="pending_review" verbose />)
    expect(announced(badge(review.container))).toBe('Pending Review')
    review.unmount()

    const approval = render(<StatusBadge status="pending_approval" verbose />)
    expect(announced(badge(approval.container))).toBe('Pending Approval')
  })

  /**
   * The stage, in the requirement's words.
   *
   * The requirement names a ladder - SUBMITTED, PENDING APPROVER 1, COMPLETED
   * - and the badge named the same states differently. The stage overrides
   * the label so the two read alike, and takes nothing else with it: the hue
   * still comes from the status, because a pill that says "Completed" in the
   * colour of a rejection is worse than either word alone.
   */
  it('prints the stage in place of the label when it is given one', () => {
    const { container } = render(
      <StatusBadge status="pending_approval" verbose stage="Pending Approver 2 of 3" />,
    )

    expect(announced(badge(container))).toBe('Pending Approver 2 of 3')
  })

  it('keeps the status colour, which the stage must never contradict', () => {
    const plain = render(<StatusBadge status="approved" verbose />)
    const staged = render(<StatusBadge status="approved" verbose stage="Completed" />)

    expect(badge(staged.container).className).toBe(badge(plain.container).className)
  })

  /**
   * REPORTED AS A DEFECT. `STATUS_CONFIG[status]` has no fallback, so a status
   * this build has not been taught - a new backend enum member, or the
   * `undefined` that `mapApiStatusToUi`'s exhaustive switch returns for one -
   * throws on `config.className` and takes the whole table down with it.
   * `ActionBadge` already solved this for the audit log ("Unrecognised
   * action"); the same honest degradation belongs here.
   *
   * The first expectation is the defect itself, so this stays red for the
   * right reason and turns green - and has to be deleted - only when a
   * fallback lands.
   */
  it('degrades to an honest label for a status it has not been taught', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    let view: RenderResult | undefined
    expect(() => {
      view = render(<StatusBadge status={'archived' as unknown as DocumentStatus} />)
    }).not.toThrow()

    expect(announced(badge(view!.container))).not.toBe('')
  })
})
