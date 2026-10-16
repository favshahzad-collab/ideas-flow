import { describe, expect, it } from 'vitest'
import { isCancelledByAdministrator } from './cancellation'

describe('isCancelledByAdministrator', () => {
  it('is a cancel when somebody other than the preparer took it out', () => {
    expect(isCancelledByAdministrator({ preparerId: 'p', withdrawnById: 'admin' })).toBe(true)
  })

  it('is a withdrawal when the preparer did', () => {
    expect(isCancelledByAdministrator({ preparerId: 'p', withdrawnById: 'p' })).toBe(false)
  })

  it('is neither for a memo nobody took out', () => {
    expect(isCancelledByAdministrator({ preparerId: 'p', withdrawnById: null })).toBe(false)
    expect(isCancelledByAdministrator({ preparerId: 'p' })).toBe(false)
  })
})
