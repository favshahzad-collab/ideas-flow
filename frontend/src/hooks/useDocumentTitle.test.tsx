import { render, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useDocumentTitle } from './useDocumentTitle'

/**
 * What the browser tab, the back-history list and a bookmark say this page is.
 *
 * It reads like decoration and is not: WCAG 2.4.2 (Page Titled, Level A) is
 * failed outright by a whole app that ships one static title, and the people
 * it fails hardest are the ones with eight tabs open who navigate by tab
 * label - or by the history list, where every entry would otherwise read
 * "Ideas Flow" and none of them says which document was open.
 */

const APP_NAME = 'Ideas Flow'

/** A screen that announces itself, so nesting can be exercised. */
function Screen({ title, children }: { title?: string; children?: ReactNode }) {
  useDocumentTitle(title)
  return <>{children}</>
}

let titleBefore = ''

beforeEach(() => {
  titleBefore = document.title
  document.title = APP_NAME
})

afterEach(() => {
  document.title = titleBefore
})

describe('what the tab ends up saying', () => {
  it('names the screen and then the app', () => {
    renderHook(() => useDocumentTitle('My queue'))

    expect(document.title).toBe(`My queue · ${APP_NAME}`)
  })

  it('puts the distinguishing part first', () => {
    // A tab is a few characters wide and it is the end that gets clipped.
    // "Ideas Flow · My queue" would render as eight identical tabs.
    renderHook(() => useDocumentTitle('Audit ledger'))

    // Both halves are present, and the screen's name is the half that survives
    // clipping. Asserting only `startsWith` would also pass for a title that
    // had lost the app name entirely.
    expect(document.title.indexOf('Audit ledger')).toBeLessThan(
      document.title.indexOf(APP_NAME),
    )
    expect(document.title.startsWith(APP_NAME)).toBe(false)
  })

  it('falls back to the bare app name for a screen with no label', () => {
    // The stale title is deliberate. Starting from "Ideas Flow" - which is
    // what `beforeEach` leaves and what `index.html` ships - would let a hook
    // that did nothing at all on an absent title pass this test, and the
    // screen this covers is reached by navigating off one that has a title.
    document.title = `Submit · ${APP_NAME}`

    renderHook(() => useDocumentTitle(undefined))

    expect(document.title).toBe(APP_NAME)
  })

  it('treats an empty label as no label', () => {
    // A title that had not loaded yet arrives as "". Interpolating it would
    // put a dangling " · Ideas Flow" in the tab, which reads as a bug - and
    // leaving the previous screen's title up is the other way to get it wrong.
    document.title = `Submit · ${APP_NAME}`

    renderHook(() => useDocumentTitle(''))

    expect(document.title).toBe(APP_NAME)
  })

  it('keeps a long document title whole rather than cutting it short', () => {
    // Clipping belongs to the browser, which does it with the tab width it
    // actually has. Truncating here would also truncate the history entry
    // and the bookmark, where there is room for the whole thing.
    const long = 'Warehouse lease extension and schedule of dilapidations 2026-2031'

    renderHook(() => useDocumentTitle(long))

    expect(document.title).toBe(`${long} · ${APP_NAME}`)
  })
})

describe('following the person around the app', () => {
  it('changes when they navigate to another screen', () => {
    const { rerender } = renderHook(({ title }) => useDocumentTitle(title), {
      initialProps: { title: 'My queue' as string | undefined },
    })

    rerender({ title: 'Submit' })

    expect(document.title).toBe(`Submit · ${APP_NAME}`)
  })

  it('drops back to the app name when the next screen has no label', () => {
    // Otherwise the tab still says "Submit" on a page that is not the submit
    // form, which is worse than saying nothing.
    const { rerender } = renderHook(({ title }) => useDocumentTitle(title), {
      initialProps: { title: 'Submit' as string | undefined },
    })

    rerender({ title: undefined })

    expect(document.title).toBe(APP_NAME)
  })

  it('gives the outermost consumer the last word', () => {
    // Effects run child-first, so a shell that titles the page overwrites a
    // screen nested inside it. Worth pinning: it means a page cannot make its
    // own tab title more specific than the shell's, and a future caller that
    // tries will see nothing happen at all.
    render(
      <Screen title="Document">
        <Screen title="Warehouse lease extension" />
      </Screen>,
    )

    expect(document.title).toBe(`Document · ${APP_NAME}`)
  })
})

describe('when the screen goes away', () => {
  it('puts back the title it found', () => {
    // Reported defect: the effect has no cleanup, so the title outlives the
    // component that set it. Anything that mounts alongside a screen rather
    // than replacing it - a full-page dialog, a designer opened over the top,
    // a lazy route that is torn down - leaves the tab naming a screen that is
    // no longer on it.
    document.title = `Documents · ${APP_NAME}`

    const { unmount } = renderHook(() => useDocumentTitle('Submit'))
    unmount()

    expect(document.title).toBe(`Documents · ${APP_NAME}`)
  })
})
