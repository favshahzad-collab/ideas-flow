import { describe, expect, it } from 'vitest'
import { peopleEyebrow } from './people'

/**
 * The header line on People & delegation, and the security figure it carries.
 *
 * The figure is the reason these tests exist: it is the only place in the
 * application that says how many people sign in on a password alone, and an
 * administrator will act on it. A count that is wrong by one is worse than no
 * count, because it will be believed.
 */

const on = { twoFactorEnabled: true }
const off = { twoFactorEnabled: false }

describe('the people eyebrow', () => {
  it('says nothing about numbers until the numbers have arrived', () => {
    // Mid-load there are no people, and "0 people" is a statement about an
    // organisation rather than about a request that has not finished.
    expect(peopleEyebrow([], true)).toBe('People & delegation')
  })

  it('counts one person as a person', () => {
    expect(peopleEyebrow([on], false)).toBe('1 person')
  })

  it('counts the rest as people', () => {
    expect(peopleEyebrow([on, on], false)).toBe('2 people')
  })

  it('stays quiet when everybody is protected', () => {
    // Not "0 without two-step": a line that reads zero every day is one an
    // administrator stops reading before the day it does not.
    expect(peopleEyebrow([on, on, on], false)).toBe('3 people')
  })

  it('names how many are signing in on a password alone', () => {
    expect(peopleEyebrow([on, off, off], false)).toBe('3 people · 2 without two-step')
  })

  it('counts a person the server said nothing about as not protected', () => {
    /*
     * `twoFactorEnabled` is optional on the wire. A server too old to send it
     * must not make the organisation look safer than it is - the direction of
     * this default is the whole point of it.
     */
    expect(peopleEyebrow([{}], false)).toBe('1 person · 1 without two-step')
  })

  it('reports an organisation with nobody in it as empty, not as a risk', () => {
    expect(peopleEyebrow([], false)).toBe('0 people')
  })
})
