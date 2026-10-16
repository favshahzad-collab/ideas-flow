import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import RouteFallback from './RouteFallback'

/**
 * What fills the screen while a route chunk downloads or the session check
 * is in flight. A skeleton is a purely visual promise: it says "something is
 * coming" to someone who can see it and nothing at all to someone who
 * cannot. So the contract here is that the pulsing bars stay out of the
 * accessibility tree entirely, and a plain sentence goes into a live region
 * beside them - otherwise a person using a screen reader is left on a page
 * that has silently stopped saying anything.
 */

/** The outermost element, which is where the layout choice lands. */
function root(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement
}

/** The pulsing bars: hidden by contract, so there is nothing to query them by. */
function skeleton(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[aria-hidden="true"]')
}

function liveRegions(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[aria-live]'))
}

describe('RouteFallback', () => {
  it('announces that something is happening, since the skeleton is invisible to AT', () => {
    const { container } = render(<RouteFallback />)

    const announcement = screen.getByText('Loading')
    expect(announcement).toHaveAttribute('aria-live', 'polite')
    // Exactly one region, and it holds the whole sentence. Two would say it
    // twice; polite rather than assertive, because a page that has not
    // finished arriving has no business interrupting anybody.
    expect(liveRegions(container)).toHaveLength(1)
    expect(liveRegions(container)[0].textContent?.trim()).toBe('Loading')
  })

  it('keeps the announcement off the screen it is standing in for', () => {
    // The live region is the only text in the component. Without `sr-only`
    // the word "Loading" is drawn across the middle of a skeleton whose
    // entire job is to imply the page without stating it. jsdom applies no
    // stylesheet, so the class is the only thing there is to assert on - and
    // it is the mechanism, not a decoration.
    const { container } = render(<RouteFallback />)

    expect(liveRegions(container)[0].className.split(/\s+/)).toContain('sr-only')
  })

  it('says what is loading when the caller knows', () => {
    // "Checking your session" and "Loading your workspace" are different
    // waits with different reasons to be patient; the guards pass the
    // distinction in, and dropping it would leave every wait identical.
    const { container } = render(<RouteFallback label="Checking your session" />)

    expect(liveRegions(container)[0].textContent?.trim()).toBe('Checking your session')
    // ...and the default did not tag along beside it.
    expect(screen.queryByText('Loading')).not.toBeInTheDocument()
  })

  it('keeps the pulsing bars out of the accessibility tree', () => {
    const { container } = render(<RouteFallback />)

    const bars = skeleton(container)
    expect(bars).not.toBeNull()
    // Two shapes with no text and no role: announced, they are noise; and a
    // reader that tried to describe them would say nothing useful.
    expect(bars?.children.length).toBeGreaterThan(0)
    expect(bars?.textContent).toBe('')
  })

  it('does not bury the announcement inside the hidden skeleton', () => {
    // aria-hidden applies to the whole subtree. If the live region were
    // nested inside it - an easy edit to make - the label would be present
    // in the DOM, look correct in review, and never be read out.
    const { container } = render(<RouteFallback label="Loading page" />)

    const announcement = screen.getByText('Loading page')
    expect(skeleton(container)?.contains(announcement)).toBe(false)
    expect(announcement.closest('[aria-hidden="true"]')).toBeNull()
  })

  it('announces the same way whether or not it is covering the whole viewport', () => {
    // `full` is a layout choice about the sidebar. A person listening should
    // not be able to tell the difference, and should not be told less
    // because the shell has not rendered yet.
    const inShell = render(<RouteFallback label="Loading page" />)
    const shellLayout = root(inShell.container).className
    expect(screen.getByText('Loading page')).toHaveAttribute('aria-live', 'polite')
    expect(liveRegions(inShell.container)[0].textContent?.trim()).toBe('Loading page')
    inShell.unmount()

    const { container } = render(<RouteFallback label="Loading page" full />)
    expect(screen.getByText('Loading page')).toHaveAttribute('aria-live', 'polite')
    expect(liveRegions(container)[0].textContent?.trim()).toBe('Loading page')
    // The prop does have to reach the layout, though: `full` is what covers
    // the viewport for the checks that run before the shell exists, and a
    // dropped prop leaves those waits floating in half a page.
    expect(root(container).className).not.toBe(shellLayout)
  })

  it('never renders a wait with nothing to announce', () => {
    // A caller that forgets the label still gets a sentence. A silent
    // fallback is indistinguishable from a page that has crashed.
    const { container } = render(<RouteFallback />)

    expect(liveRegions(container)[0].textContent?.trim()).toBe('Loading')
  })
})
