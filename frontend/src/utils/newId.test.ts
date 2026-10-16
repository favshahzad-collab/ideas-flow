import { describe, expect, it } from 'vitest'
import { newId } from './newId'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('newId', () => {
  it('is a version-4 UUID', () => {
    expect(newId()).toMatch(UUID_V4)
  })

  it('still works on a plain-http page, where randomUUID is missing', () => {
    // http://ids-it-shahzad:5173 is not a secure page, so the browser leaves
    // crypto.randomUUID undefined - which crashed the submit screen.
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
    try {
      const first = newId()
      expect(first).toMatch(UUID_V4)
      expect(newId()).not.toBe(first)
    } finally {
      // Back to the prototype's own.
      delete (crypto as unknown as { randomUUID?: unknown }).randomUUID
    }
  })
})
