import { useCallback, useSyncExternalStore } from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'daws-theme'
const listeners = new Set<() => void>()

/**
 * A choice that storage refused to keep.
 *
 * `preference` used to be read straight back out of storage, so a refused
 * write - private mode, blocked site data - left the hook reporting "system"
 * while the page was painted dark, and the theme toggle then highlighted the
 * button the person had not pressed.
 *
 * Set only when a write actually throws, and cleared the moment one succeeds
 * or storage produces a real value. That precision matters: it must never
 * shadow a preference another tab saved, and it must not outlive the failure
 * it describes.
 */
let unsaved: ThemePreference | null = null

function read(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      // Storage is authoritative when it holds something real: another tab
      // writing a preference is newer than whatever this one last chose.
      unsaved = null
      return stored
    }
  } catch {
    // Unreadable. Whatever is below is still the best answer available.
  }

  return unsaved ?? 'system'
}

function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Stamp the resolved value; the CSS only ever matches light or dark. */
function apply(preference: ThemePreference): void {
  const dark = preference === 'dark' || (preference === 'system' && prefersDark())
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)

  // While the preference is "system", the OS switching themes has to move
  // the page with it.
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const onSystemChange = () => {
    if (read() === 'system') {
      apply('system')
      emit()
    }
  }
  media.addEventListener('change', onSystemChange)

  // Another tab changing the preference keeps this one in step.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      apply(read())
      emit()
    }
  }
  window.addEventListener('storage', onStorage)

  return () => {
    listeners.delete(listener)
    media.removeEventListener('change', onSystemChange)
    window.removeEventListener('storage', onStorage)
  }
}

/**
 * Theme preference, shared across every component that asks for it.
 * `useSyncExternalStore` rather than an effect, so the value is read during
 * render and no cascading re-render is needed to settle it.
 */
export function useTheme() {
  const preference = useSyncExternalStore(subscribe, read, () => 'system' as const)

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      localStorage.setItem(STORAGE_KEY, next)
      unsaved = null
    } catch {
      unsaved = next
      // Will not survive a reload, but the page switches and the hook says so.
    }
    apply(next)
    emit()
  }, [])

  return { preference, setPreference }
}
