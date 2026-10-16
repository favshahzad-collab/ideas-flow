import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTheme } from './useTheme'

/**
 * Which theme the whole app is painted in, and whether that choice survives a
 * reload.
 *
 * Three preferences, two outcomes: "system" is a real choice that resolves
 * against the OS, and the resolved value - never the preference - is what gets
 * stamped on <html> for the CSS to match. Getting that wrong is not cosmetic:
 * a page that resolves to the wrong one is a screen of dark text on a dark
 * ground, which is a document nobody can read.
 *
 * `matchMedia` is stubbed per test rather than in setup, because jsdom has no
 * OS to ask and every interesting case here is "what does the OS say".
 */

const STORAGE_KEY = 'daws-theme'

/**
 * A matchMedia that can be told what the OS prefers and can change its mind
 * afterwards, which is the only way to exercise the "system" branch.
 */
function stubSystemTheme(dark: boolean) {
  let prefersDark = dark
  const listeners = new Set<(event: MediaQueryListEvent) => void>()

  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        media: query,
        // Read at call time, so a later change is visible to the next caller.
        get matches() {
          return query.includes('dark') ? prefersDark : false
        },
        onchange: null,
        addEventListener: (_type: string, listener: (e: MediaQueryListEvent) => void) => {
          listeners.add(listener)
        },
        removeEventListener: (
          _type: string,
          listener: (e: MediaQueryListEvent) => void,
        ) => {
          listeners.delete(listener)
        },
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  )

  return {
    /** The person changed their OS theme while the app was open. */
    change(next: boolean) {
      prefersDark = next
      act(() => {
        for (const listener of [...listeners]) {
          listener({ matches: next } as MediaQueryListEvent)
        }
      })
    },
    listenerCount: () => listeners.size,
  }
}

const stampedTheme = () => document.documentElement.dataset.theme

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
})

describe('the preference it reports', () => {
  it('starts on system when nobody has ever chosen', () => {
    // "System" is the default because it is the answer that is right without
    // anyone being asked - not because it means "unset".
    stubSystemTheme(false)

    const { result } = renderHook(() => useTheme())

    expect(result.current.preference).toBe('system')
  })

  it.each(['light', 'dark', 'system'] as const)('reads back a stored %s', stored => {
    stubSystemTheme(false)
    localStorage.setItem(STORAGE_KEY, stored)

    const { result } = renderHook(() => useTheme())

    expect(result.current.preference).toBe(stored)
  })

  it('falls back to system when the stored value is not one of the three', () => {
    // An older build, a hand-edited value, a half-written string: none of them
    // may leave the app with a theme the CSS has no rules for.
    stubSystemTheme(false)
    localStorage.setItem(STORAGE_KEY, 'midnight')

    const { result } = renderHook(() => useTheme())

    expect(result.current.preference).toBe('system')
  })

  it('still works when storage is blocked outright', () => {
    // Private browsing and locked-down enterprise profiles both throw here. The
    // app losing its theme is acceptable; the app failing to render is not.
    stubSystemTheme(false)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('The operation is insecure.')
    })

    const { result } = renderHook(() => useTheme())

    expect(result.current.preference).toBe('system')
  })
})

describe('what gets stamped on the page', () => {
  it('stamps the resolved theme, never the word "system"', () => {
    // The CSS matches [data-theme="dark"] and [data-theme="light"] only. A
    // literal "system" would match neither and the page would fall back to
    // whatever the bare :root rules happen to say.
    stubSystemTheme(true)
    const { result } = renderHook(() => useTheme())

    act(() => result.current.setPreference('system'))

    expect(stampedTheme()).toBe('dark')
  })

  it('resolves system against the OS in both directions', () => {
    const system = stubSystemTheme(false)
    const { result } = renderHook(() => useTheme())

    act(() => result.current.setPreference('system'))
    expect(stampedTheme()).toBe('light')

    system.change(true)
    expect(stampedTheme()).toBe('dark')
  })

  it.each([
    ['dark', 'dark'],
    ['light', 'light'],
  ] as const)('stamps %s when that is the explicit choice', (choice, expected) => {
    stubSystemTheme(false)
    const { result } = renderHook(() => useTheme())

    act(() => result.current.setPreference(choice))

    expect(stampedTheme()).toBe(expected)
  })

  it('lets an explicit choice overrule the OS', () => {
    // Somebody on a dark desktop who asked for light asked for light.
    stubSystemTheme(true)
    const { result } = renderHook(() => useTheme())

    act(() => result.current.setPreference('light'))

    expect(stampedTheme()).toBe('light')
  })
})

describe('remembering the choice', () => {
  it('writes it where the next page load will find it', () => {
    // The pre-paint script in index.html reads this exact key. A different key
    // here means every reload flashes the old theme before React corrects it.
    stubSystemTheme(false)
    const { result } = renderHook(() => useTheme())

    act(() => result.current.setPreference('dark'))

    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark')
  })

  it('is still there for the next mount', () => {
    stubSystemTheme(false)
    const first = renderHook(() => useTheme())
    act(() => first.result.current.setPreference('dark'))
    first.unmount()

    const { result } = renderHook(() => useTheme())

    expect(result.current.preference).toBe('dark')
  })

  it('still switches the page when the write is refused', () => {
    // Private mode: the choice cannot be remembered, but refusing to switch on
    // top of that would leave the person with no theme control at all.
    stubSystemTheme(false)
    const { result } = renderHook(() => useTheme())
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('The operation is insecure.')
    })

    act(() => result.current.setPreference('dark'))

    expect(stampedTheme()).toBe('dark')
  })

  it('reports the choice it just applied even when the write is refused', () => {
    // Reported defect. `preference` is read straight back out of storage, so a
    // refused write leaves the hook saying "system" while the page is painted
    // dark - and the theme toggle then highlights the button the person did
    // not press.
    stubSystemTheme(false)
    const { result } = renderHook(() => useTheme())
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('The operation is insecure.')
    })

    act(() => result.current.setPreference('dark'))

    expect(result.current.preference).toBe('dark')
  })
})

describe('staying in step with everything else', () => {
  it('moves every consumer at once', () => {
    // The toggle in the header and the toggle in settings are two mounts of the
    // same hook. One of them showing a stale choice is a UI that contradicts
    // the page it is sitting on.
    stubSystemTheme(false)
    const a = renderHook(() => useTheme())
    const b = renderHook(() => useTheme())

    act(() => a.result.current.setPreference('dark'))

    expect(b.result.current.preference).toBe('dark')
  })

  it('follows the OS both ways while the choice is system', () => {
    // And keeps calling the preference "system" throughout - the person chose
    // to follow the OS, and the toggle must go on saying so.
    const system = stubSystemTheme(false)
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setPreference('system'))

    system.change(true)
    expect(stampedTheme()).toBe('dark')

    system.change(false)
    expect(stampedTheme()).toBe('light')
    expect(result.current.preference).toBe('system')
  })

  it('ignores the OS once a choice has been made', () => {
    // Somebody who picked light does not want their screen flipping at sunset.
    const system = stubSystemTheme(false)
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setPreference('light'))

    system.change(true)

    expect(stampedTheme()).toBe('light')
    expect(result.current.preference).toBe('light')
  })

  it('picks up a choice made in another tab', () => {
    // Two tabs of the same app; changing the theme in one and returning to the
    // other to find it unchanged reads as the setting not having saved.
    stubSystemTheme(false)
    const { result } = renderHook(() => useTheme())

    act(() => {
      localStorage.setItem(STORAGE_KEY, 'dark')
      window.dispatchEvent(
        new StorageEvent('storage', { key: STORAGE_KEY, newValue: 'dark' }),
      )
    })

    expect(result.current.preference).toBe('dark')
    expect(stampedTheme()).toBe('dark')
  })

  it('ignores a storage event about some other key', () => {
    // Session keys and caches write to localStorage constantly; reacting to
    // them would repaint the page for no reason.
    stubSystemTheme(false)
    const { result } = renderHook(() => useTheme())

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'daws-sidebar', newValue: 'collapsed' }),
      )
    })

    expect(result.current.preference).toBe('system')
    expect(stampedTheme()).toBeUndefined()
  })

  it('keeps following the OS for the consumers that are still mounted', () => {
    // The other half of the cleanup test below, and the one with teeth. Every
    // mount registers its own media listener against a module-level set of
    // subscribers; tearing one subscription down and taking the shared
    // plumbing with it leaves the toggle that is still on screen deaf to the
    // OS for the rest of the session - with nothing to show that it happened,
    // because the preference it reports never changes either.
    const system = stubSystemTheme(false)
    const a = renderHook(() => useTheme())
    const b = renderHook(() => useTheme())
    act(() => a.result.current.setPreference('system'))
    expect(system.listenerCount()).toBe(2)

    a.unmount()
    expect(system.listenerCount()).toBe(1)

    system.change(true)

    expect(stampedTheme()).toBe('dark')
    expect(b.result.current.preference).toBe('system')
  })

  it('falls back to system when another tab writes something unusable', () => {
    // Same key, a value from an older build or a hand-edited profile. The event
    // still has to repaint the page, and it has to repaint it to one of the two
    // values the CSS has rules for - not leave it on the last explicit choice
    // and not stamp the junk through.
    stubSystemTheme(true)
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setPreference('light'))
    expect(stampedTheme()).toBe('light')

    act(() => {
      localStorage.setItem(STORAGE_KEY, 'midnight')
      window.dispatchEvent(
        new StorageEvent('storage', { key: STORAGE_KEY, newValue: 'midnight' }),
      )
    })

    expect(result.current.preference).toBe('system')
    // Resolved against the OS, which here says dark - so the unusable value
    // hands control back rather than freezing the page on light.
    expect(stampedTheme()).toBe('dark')
  })

  it('lets go of its listeners when the last consumer unmounts', () => {
    // A leak here is a listener per mounted component, each one re-stamping the
    // document every time the OS theme changes.
    const system = stubSystemTheme(false)
    const { unmount } = renderHook(() => useTheme())

    expect(system.listenerCount()).toBe(1)
    unmount()
    expect(system.listenerCount()).toBe(0)
  })
})
