import { afterEach, describe, expect, it, vi } from 'vitest'

describe('Promise.withResolvers stand-in', () => {
  const original = (Promise as unknown as { withResolvers?: unknown }).withResolvers

  afterEach(() => {
    ;(Promise as unknown as { withResolvers?: unknown }).withResolvers = original
    vi.resetModules()
  })

  it('fills in a working withResolvers on a browser without one', async () => {
    delete (Promise as unknown as { withResolvers?: unknown }).withResolvers
    await import('./promiseWithResolvers')
    const { promise, resolve } = (
      Promise as unknown as { withResolvers: <T>() => { promise: Promise<T>; resolve: (v: T) => void } }
    ).withResolvers<number>()
    resolve(42)
    await expect(promise).resolves.toBe(42)
  })

  it('leaves a browser that has one alone', async () => {
    const own = vi.fn()
    ;(Promise as unknown as { withResolvers?: unknown }).withResolvers = own
    await import('./promiseWithResolvers')
    expect((Promise as unknown as { withResolvers?: unknown }).withResolvers).toBe(own)
  })
})
