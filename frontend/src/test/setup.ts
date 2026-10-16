import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

/**
 * Everything here is a gap in jsdom, not a stand-in for application
 * behaviour. Nothing in this file may decide what a component renders - a
 * stub that answers a question the app asked would make the suite agree with
 * itself rather than with the browser.
 */

// jsdom does not implement matchMedia at all. Answering "no" to every query
// is the honest default: it is what a narrow, motion-allowing, light-scheme
// browser reports, and a test that cares asserts by overriding it itself.
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}

// Observers jsdom has no layout engine to drive. They must exist so a
// component that constructs one does not throw on mount; they never fire.
class NeverObserves {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}

globalThis.ResizeObserver ??= NeverObserves as unknown as typeof ResizeObserver
globalThis.IntersectionObserver ??=
  NeverObserves as unknown as typeof IntersectionObserver

// jsdom has no scrolling, so these are no-ops rather than absent methods.
Element.prototype.scrollIntoView ??= function scrollIntoView() {}
Element.prototype.scrollTo ??= function scrollTo() {}

// jsdom has no layout, so it answers `null` to offsetParent for EVERY element
// - connected, visible, or neither. That is not a harmless gap: `useDialogA11y`
// reads this property to skip hidden controls, so under an unpatched jsdom the
// focus trap's candidate list collapses to whatever already has focus and every
// Tab-wrap assertion passes whether or not the trap works. A test that cannot
// fail is worse than no test, so this answers the question the browser would.
//
// It is deliberately the crudest honest model: null when the element or an
// ancestor is display:none or [hidden], document.body when it is connected,
// null when it is not. Nothing here knows about position:fixed, detached
// subtrees or zero-size boxes - a test that turns on any of those needs a real
// browser rather than a better stub.
function offsetParentOf(element: HTMLElement): Element | null {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden) return null
    if (node.style?.display === 'none') return null
  }
  return element.isConnected ? document.body : null
}

Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
  configurable: true,
  get(this: HTMLElement): Element | null {
    return offsetParentOf(this)
  },
})

afterEach(() => {
  cleanup()
  // A dialog that unmounts mid-test leaves the scroll lock behind, and the
  // next test would then start with a body it did not set up.
  document.body.style.overflow = ''
  vi.useRealTimers()
})
