import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import StagePips from './StagePips'

/**
 * How far along the approval chain a document has got, shown as a row of
 * pips and a `n/total`. Two people read this: one sees the filled shapes,
 * one hears the number. They must be told the same thing - a document at step
 * 2 of 4 that draws three pips, or that announces "4 of 4" because the data
 * drifted, is telling somebody their document is nearly finished when it is
 * not.
 */

function pips(container: HTMLElement): HTMLElement[] {
  const decorative = container.querySelector('[aria-hidden="true"]')
  return Array.from((decorative?.children ?? []) as HTMLCollectionOf<HTMLElement>)
}

/**
 * The semantic hue a pip was filled in, or `undefined` for an unfilled one
 * still wearing the inert track grey. This is the one place a class is the
 * only carrier of meaning - acceptable here precisely because the `n/total`
 * beside it states the count in words, and these assertions are what keep
 * the two from drifting apart.
 */
function pipTone(pip: HTMLElement): string | undefined {
  return /bg-(accent|info|warning|danger|revision|neutral)-mark/.exec(pip.className)?.[1]
}

function pipTones(container: HTMLElement): (string | undefined)[] {
  return pips(container).map(pipTone)
}

function filledCount(container: HTMLElement): number {
  return pipTones(container).filter(Boolean).length
}

/** What is left for a screen reader once the decorative parts are dropped. */
function announced(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement
  clone.querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove())
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * What a sighted reader actually sees, once the screen-reader-only words are
 * dropped. The counterpart to `announced`: between them they pin down which
 * half of the markup each audience gets, and neither is checkable from the
 * other. jsdom applies no stylesheet, so `sr-only` has to be read as the
 * class it is - it is the mechanism, not a decoration.
 */
function visible(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement
  clone.querySelectorAll('.sr-only').forEach(node => node.remove())
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
}

describe('StagePips', () => {
  it('tells a screen reader which step of how many, not a run of empty shapes', () => {
    const { container } = render(<StagePips current={3} total={5} />)

    // Without the sr-only "Step" and "of", this row is announced as "3 5" or
    // as nothing at all - progress information that only sighted users get.
    expect(announced(container)).toBe('Step 3 of 5')
  })

  it('shows a sighted reader the compact ratio, not the spelled-out sentence', () => {
    const { container } = render(<StagePips current={3} total={5} />)

    // The mono "3/5" is what fits the column. If the sr-only words lost their
    // class the cell would read "Step 3 of 5" and blow the grid apart; if the
    // slash lost its aria-hidden it would be read out as "3 slash of 5".
    expect(visible(container)).toBe('3/5')
    expect(announced(container)).toBe('Step 3 of 5')
  })

  it('draws one pip per step, filled up to the step the document is at', () => {
    const { container } = render(<StagePips current={3} total={5} />)

    expect(pips(container)).toHaveLength(5)
    // An off-by-one here would show a document as further along than it is,
    // and would contradict the "Step 3 of 5" announced beside it.
    expect(filledCount(container)).toBe(3)
    // Filled-then-empty, in that order: three filled pips scattered through
    // five would count correctly and read as nonsense.
    expect(pipTones(container)).toEqual(['accent', 'accent', 'accent', undefined, undefined])
  })

  it('still draws the steps that have not happened yet', () => {
    // `pipTone` returns undefined for an unfilled pip, which is also what it
    // returns for a pip drawn with no background at all. Those are very
    // different rows: with the track colour gone, a document at step 3 of 5
    // shows three shapes and reads as finished, and every assertion about
    // counts above still passes because the spans are all still there.
    const { container } = render(<StagePips current={3} total={5} />)

    const backgrounds = pips(container).map(
      pip => pip.className.split(/\s+/).find(c => c.startsWith('bg-')),
    )

    expect(backgrounds.filter(Boolean)).toHaveLength(5)
    // Two filled, three remaining - and the remaining ones are not wearing a
    // semantic hue, or they would read as done.
    expect(new Set(backgrounds).size).toBe(2)
    expect(backgrounds.slice(3).every(c => c === backgrounds[4])).toBe(true)
    expect(pipTone(pips(container)[4])).toBeUndefined()
  })

  it('shows a document that has not moved yet as at no step at all', () => {
    const { container } = render(<StagePips current={0} total={4} />)

    // A freshly submitted document with a filled first pip would read as
    // already reviewed by the person holding step one.
    expect(filledCount(container)).toBe(0)
    expect(announced(container)).toBe('Step 0 of 4')
    expect(visible(container)).toBe('0/4')
  })

  it('shows the last pip filled once every step is done', () => {
    const { container } = render(<StagePips current={4} total={4} />)

    expect(filledCount(container)).toBe(4)
    expect(announced(container)).toBe('Step 4 of 4')
  })

  it('never claims a step past the end of the workflow', () => {
    // Step counts and workflow lengths come from two different fields on the
    // API document and can disagree. "Step 9 of 4" is nonsense; overflowing
    // the pip row with five extra shapes is worse.
    const { container } = render(<StagePips current={9} total={4} />)

    expect(pips(container)).toHaveLength(4)
    expect(filledCount(container)).toBe(4)
    expect(announced(container)).toBe('Step 4 of 4')
    expect(visible(container)).toBe('4/4')
  })

  it('survives a negative step without drawing anything backwards', () => {
    const { container } = render(<StagePips current={-2} total={3} />)

    expect(filledCount(container)).toBe(0)
    expect(announced(container)).toBe('Step 0 of 3')
  })

  it('survives a document with no workflow attached', () => {
    // `mapApiDocumentToDashboard` reports 0/0 for a document that has not
    // been routed yet, and the documents grid renders this column for every
    // row - so zero steps has to be a shape it can draw, not a crash.
    const { container } = render(<StagePips current={0} total={0} />)

    expect(pips(container)).toHaveLength(0)
    expect(announced(container)).toBe('Step 0 of 0')
    expect(visible(container)).toBe('0/0')
  })

  it('refuses to invent a workflow out of a negative length', () => {
    // The other half of the same data drift: a total that arrives below zero
    // must collapse to no workflow, not to a negative-length loop or a step
    // count the row cannot justify.
    const { container } = render(<StagePips current={2} total={-3} />)

    expect(pips(container)).toHaveLength(0)
    expect(filledCount(container)).toBe(0)
    expect(announced(container)).toBe('Step 0 of 0')
  })

  it('keeps the pips themselves silent, so the row is announced once', () => {
    const { container } = render(<StagePips current={2} total={4} />)

    const decorative = container.querySelector('[aria-hidden="true"]')
    expect(decorative).not.toBeNull()
    // Every pip lives inside the hidden wrapper: four unlabelled spans read
    // out one after another would be noise wrapped around the real answer.
    expect(pips(container)).toHaveLength(4)
    expect(decorative?.textContent).toBe('')
  })

  it('fills the pips in the tone it was handed, not always the default', () => {
    // `DocumentsTable` picks this tone from the document's own status, so a
    // swallowed prop draws a rejected document's progress in the same green
    // as a healthy one - and the pips are the only part of this row that
    // carries status at all.
    const { container } = render(<StagePips current={2} total={4} tone="danger" />)

    expect(pipTones(container)).toEqual(['danger', 'danger', undefined, undefined])
  })

  it('is announced the same whatever colour the workflow is in', () => {
    // Tone tracks document status (a rejected document draws danger pips).
    // The words must not change with it, or colour becomes load-bearing.
    const accent = render(<StagePips current={2} total={4} tone="accent" />)
    const accentText = announced(accent.container)
    const accentTones = pipTones(accent.container)
    accent.unmount()

    const danger = render(<StagePips current={2} total={4} tone="danger" />)
    expect(announced(danger.container)).toBe('Step 2 of 4')
    expect(announced(danger.container)).toBe(accentText)
    expect(filledCount(danger.container)).toBe(2)
    // ...and the colour genuinely did change, so the sameness above is a
    // finding about the words rather than about a prop nothing reads.
    expect(pipTones(danger.container)).not.toEqual(accentTones)
  })
})

describe('activity', () => {
  const breathing = (container: HTMLElement) =>
    pips(container).map(pip => pip.classList.contains('progress-pending'))

  it('breathes on the step a waiting memo is sitting at, and nowhere else', () => {
    const { container } = render(<StagePips current={2} total={3} active />)
    expect(breathing(container)).toEqual([false, true, false])
  })

  it('sits still for a memo that is not waiting on anybody', () => {
    const { container } = render(<StagePips current={2} total={3} />)
    expect(breathing(container)).toEqual([false, false, false])
  })

  it('marks the first step on a memo that has only just been submitted', () => {
    const { container } = render(<StagePips current={0} total={3} active />)
    expect(breathing(container)).toEqual([true, false, false])
  })
})
