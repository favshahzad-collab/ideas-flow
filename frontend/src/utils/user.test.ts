import { describe, expect, it } from 'vitest'
import { formatFullName, getInitials } from './user'

/** The avatar and the name beside it - on every row, in every header. */

describe('formatFullName', () => {
  it('joins the two names', () => {
    expect(formatFullName('Ayesha', 'Khan')).toBe('Ayesha Khan')
  })

  it('leaves no trailing space when half the name is missing', () => {
    expect(formatFullName('Ayesha', '')).toBe('Ayesha')
    expect(formatFullName('', 'Khan')).toBe('Khan')
    expect(formatFullName('', '')).toBe('')
  })
})

describe('getInitials', () => {
  it('takes one letter from each name, upper-cased', () => {
    expect(getInitials('ayesha', 'khan')).toBe('AK')
  })

  it('ignores padding around the names', () => {
    expect(getInitials('  Ayesha ', ' Khan ')).toBe('AK')
  })

  it('falls back to a question mark rather than an empty circle', () => {
    // An avatar with nothing in it reads as a rendering failure.
    expect(getInitials('', '')).toBe('?')
    expect(getInitials('   ', '   ')).toBe('?')
  })

  it('manages with only one name', () => {
    expect(getInitials('Ayesha', '')).toBe('A')
    expect(getInitials('', 'Khan')).toBe('K')
  })
})
