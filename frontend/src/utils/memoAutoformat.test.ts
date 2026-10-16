import { describe, expect, it } from 'vitest'

import { blockMarker, convertTyped, smartQuote } from './memoAutoformat'

/**
 * The conversions made as text is typed, decided on text alone: which line
 * openings become a list or a heading, which way a quote curls, when two
 * hyphens are a dash.
 */

describe('a marker at the start of a line', () => {
  it('asks for a list or a heading, exactly', () => {
    expect(blockMarker('- ')).toEqual({ kind: 'bulletList' })
    expect(blockMarker('* ')).toEqual({ kind: 'bulletList' })
    expect(blockMarker('1. ')).toEqual({ kind: 'orderedList' })
    expect(blockMarker('# ')).toEqual({ kind: 'heading', level: 1 })
    expect(blockMarker('## ')).toEqual({ kind: 'heading', level: 2 })
    // The browser writes the space at the end of a line as a non-breaking one.
    expect(blockMarker('-\xa0')).toEqual({ kind: 'bulletList' })
  })

  it('leaves a line alone once it is more than a marker', () => {
    expect(blockMarker('-')).toBeNull()
    expect(blockMarker('- item')).toBeNull()
    expect(blockMarker('2. ')).toBeNull()
    expect(blockMarker('### ')).toBeNull()
    expect(blockMarker(' - ')).toBeNull()
    expect(blockMarker('')).toBeNull()
  })
})

describe('quotes', () => {
  it('open at the start, after a space and after a bracket, and close elsewhere', () => {
    expect(smartQuote('', '"')).toBe('“')
    expect(smartQuote('He said ', '"')).toBe('“')
    expect(smartQuote('(', '"')).toBe('“')
    expect(smartQuote('word', '"')).toBe('”')
    expect(smartQuote('said.', '"')).toBe('”')
  })

  it('make an apostrophe of a single quote inside a word', () => {
    expect(smartQuote('don', "'")).toBe('’')
    expect(smartQuote('the organisation', "'")).toBe('’')
    expect(smartQuote('', "'")).toBe('‘')
    expect(smartQuote('“', "'")).toBe('‘')
  })
})

describe('the character just typed', () => {
  it('curls a quote in place and leaves the caret where it was', () => {
    expect(convertTyped('He said "', 9)).toEqual({ text: 'He said “', offset: 9 })
    expect(convertTyped('don\'t', 4)).toEqual({ text: 'don’t', offset: 4 })
  })

  it('makes a dash of two hyphens, and not of a third', () => {
    expect(convertTyped('2024--', 6)).toEqual({ text: '2024–', offset: 5 })
    expect(convertTyped('---', 3)).toBeNull()
    expect(convertTyped('2024-', 5)).toBeNull()
  })

  it('leaves everything else alone', () => {
    expect(convertTyped('word', 4)).toBeNull()
    expect(convertTyped('', 0)).toBeNull()
  })
})
