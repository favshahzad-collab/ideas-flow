import { describe, expect, it } from 'vitest'
import type { ReadinessCheck } from './submitDocument'
import {
  firstIncompleteStep,
  getStepStates,
  moveItem,
  nextStep,
  outstandingForStep,
  previousStep,
  stepEyebrow,
  stepForCheck,
} from './submitSteps'

const check = (id: string, done: boolean): ReadinessCheck => ({ id, label: id, done })

const ALL_DONE: ReadinessCheck[] = [
  check('title', true),
  check('file', true),
  check('steps', true),
  check('final', true),
]

describe('stepForCheck', () => {
  it('maps the two fixed checks and treats everything else as routing', () => {
    expect(stepForCheck('title')).toBe('details')
    expect(stepForCheck('file')).toBe('file')
    expect(stepForCheck('steps')).toBe('routing')
    expect(stepForCheck('template-completes')).toBe('routing')
    // A check added later must surface somewhere rather than vanish.
    expect(stepForCheck('something-new')).toBe('routing')
  })
})

describe('getStepStates', () => {
  it('marks the current step current even when it is complete', () => {
    expect(getStepStates('details', ALL_DONE, false).details).toBe('current')
  })

  it('completes a step when nothing it owns is outstanding', () => {
    const states = getStepStates('routing', ALL_DONE, false)
    expect(states.details).toBe('complete')
    expect(states.file).toBe('complete')
    expect(states.sign).toBe('complete')
  })

  it('leaves incomplete steps upcoming until a submit is attempted', () => {
    const checks = [check('title', false), check('file', true), check('steps', false)]
    expect(getStepStates('file', checks, false)).toMatchObject({
      details: 'upcoming',
      routing: 'upcoming',
    })
    expect(getStepStates('file', checks, true)).toMatchObject({
      details: 'problem',
      routing: 'problem',
    })
  })

  it('holds Sign incomplete while anything anywhere is outstanding', () => {
    const checks = [check('title', true), check('file', true), check('steps', false)]
    expect(getStepStates('details', checks, false).sign).toBe('upcoming')
    expect(getStepStates('details', ALL_DONE, false).sign).toBe('complete')
  })
})

describe('outstandingForStep', () => {
  it('returns only that step’s outstanding checks', () => {
    const checks = [check('title', false), check('file', false), check('steps', false)]
    expect(outstandingForStep('details', checks).map(c => c.id)).toEqual(['title'])
    expect(outstandingForStep('routing', checks).map(c => c.id)).toEqual(['steps'])
  })

  it('gathers everything outstanding for Sign', () => {
    const checks = [check('title', false), check('file', true), check('steps', false)]
    expect(outstandingForStep('sign', checks)).toHaveLength(2)
  })
})

describe('firstIncompleteStep', () => {
  it('lands on the earliest step with work left', () => {
    expect(firstIncompleteStep([check('title', true), check('steps', false)])).toBe('routing')
    expect(firstIncompleteStep([check('title', false), check('steps', false)])).toBe('details')
  })

  it('falls through to Sign when the form is ready', () => {
    expect(firstIncompleteStep(ALL_DONE)).toBe('sign')
  })
})

describe('navigation helpers', () => {
  it('walks the sequence and stops at both ends', () => {
    expect(nextStep('details')).toBe('file')
    expect(nextStep('sign')).toBeNull()
    expect(previousStep('file')).toBe('details')
    expect(previousStep('details')).toBeNull()
  })

  it('numbers the eyebrow from one', () => {
    expect(stepEyebrow('details')).toBe('Step 1 of 4 · Details')
    expect(stepEyebrow('routing')).toBe('Step 3 of 4 · Routing')
  })
})

describe('moveItem', () => {
  it('moves forwards and backwards', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('clamps a target past either end instead of dropping the item', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a'])
    expect(moveItem(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b'])
  })

  it('returns the same array reference when nothing moves', () => {
    const items = ['a', 'b']
    expect(moveItem(items, 1, 1)).toBe(items)
    expect(moveItem(items, 5, 0)).toBe(items)
  })
})
