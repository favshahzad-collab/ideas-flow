import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ThemeToggle from './ThemeToggle'

/**
 * The three-way theme control in the header. Three explicit buttons rather than
 * one that cycles, so a person can see which of the three they are on - the
 * whole point of the design, and the thing these tests protect.
 *
 * The state that matters is `aria-pressed`. Which button is selected is drawn
 * as a filled pill, and a filled pill is colour; if the pressed state were not
 * also in the accessibility tree, a person who cannot see the fill would have
 * no way to know whether they are following the OS or overriding it - and no
 * way to tell whether the press they just made took effect.
 */

function stubSystemTheme(dark: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        media: query,
        matches: query.includes('dark') ? dark : false,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  )
}

const option = (name: 'Light' | 'Dark' | 'System') =>
  screen.getByRole('button', { name: `${name} theme` })

const pressed = () =>
  screen
    .getAllByRole('button')
    .filter(button => button.getAttribute('aria-pressed') === 'true')
    .map(button => button.getAttribute('aria-label'))

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  stubSystemTheme(false)
})

describe('what it offers', () => {
  it('is a named group of three named buttons', () => {
    // Every one of them is an icon on its own. Unlabelled, the header would
    // offer a screen reader three anonymous buttons in a row.
    render(<ThemeToggle />)

    const group = screen.getByRole('group', { name: 'Colour theme' })
    // Three, and no more: a fourth control in here - a stray "Auto", a
    // leftover cycle button - would make "one of these is pressed" ambiguous,
    // and `pressed()` below would go on passing while the header offered a
    // choice nobody designed.
    expect(within(group).getAllByRole('button')).toHaveLength(3)
    expect(screen.getAllByRole('button')).toHaveLength(3)
    // And all three inside the group, not merely somewhere on the page. The
    // group is what makes a screen reader announce them as one control with
    // three options rather than three unrelated buttons in a row.
    for (const name of ['Light', 'Dark', 'System'] as const) {
      expect(group).toContainElement(option(name))
    }
  })

  it('keeps the caller className, which is how it is placed in the header', () => {
    // The class asserted is one this test invented, so no restyle can move it.
    render(<ThemeToggle className="daws-test-hook" />)

    expect(screen.getByRole('group', { name: 'Colour theme' })).toHaveClass(
      'daws-test-hook',
    )
  })

  it('does not let the icons double the label', () => {
    render(<ThemeToggle />)

    // An icon left unhidden inside a labelled button is announced after it -
    // "Dark theme, image" - on all three, in the header of every screen.
    const icon = option('Dark').querySelector('svg')
    expect(icon).toHaveAttribute('aria-hidden', 'true')
  })

  it('offers all three as real, enabled buttons', () => {
    render(<ThemeToggle />)

    for (const name of ['Light', 'Dark', 'System'] as const) {
      expect(option(name).tagName).toBe('BUTTON')
      expect(option(name)).toBeEnabled()
    }
  })
})

describe('which one it says you are on', () => {
  it('shows System selected before any choice has been made', () => {
    render(<ThemeToggle />)

    expect(pressed()).toEqual(['System theme'])
  })

  it('shows the stored choice on a fresh page load', () => {
    // Following a reload the control has to agree with the page it is sitting
    // on, or the person presses the button that is already in effect.
    localStorage.setItem('daws-theme', 'dark')

    render(<ThemeToggle />)

    expect(pressed()).toEqual(['Dark theme'])
  })

  it('marks exactly one at a time', () => {
    render(<ThemeToggle />)

    // Two pressed buttons would be a control that cannot be read at all.
    expect(pressed()).toHaveLength(1)
  })

  it('announces the selection rather than only filling the pill', async () => {
    render(<ThemeToggle />)

    await userEvent.click(option('Light'))

    expect(option('Light')).toHaveAttribute('aria-pressed', 'true')
    expect(option('System')).toHaveAttribute('aria-pressed', 'false')
    expect(option('Dark')).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('pressing one', () => {
  it('repaints the page, not just the toggle', async () => {
    // data-theme on <html> is the only thing the stylesheet reads. A toggle
    // that moved its own highlight and left the page alone would look like it
    // worked and change nothing.
    render(<ThemeToggle />)

    await userEvent.click(option('Dark'))

    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('remembers the choice for the next visit', async () => {
    render(<ThemeToggle />)

    await userEvent.click(option('Dark'))

    expect(localStorage.getItem('daws-theme')).toBe('dark')
  })

  it('keeps the choice when the control is mounted again', async () => {
    const { unmount } = render(<ThemeToggle />)
    await userEvent.click(option('Light'))
    unmount()

    render(<ThemeToggle />)

    expect(pressed()).toEqual(['Light theme'])
  })

  it('switches back and forth without getting stuck', async () => {
    render(<ThemeToggle />)

    await userEvent.click(option('Dark'))
    await userEvent.click(option('Light'))

    expect(pressed()).toEqual(['Light theme'])
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('is pressable a second time without turning itself off', async () => {
    // aria-pressed makes these look like toggles; pressing the selected one
    // must re-assert the choice rather than leave the app with none.
    render(<ThemeToggle />)

    await userEvent.click(option('Dark'))
    await userEvent.click(option('Dark'))

    expect(pressed()).toEqual(['Dark theme'])
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})

describe('two of them on the same page', () => {
  it('moves the copy nobody pressed', async () => {
    // The header has one and the settings screen has another. They are two
    // mounts of one shared preference, and every test above renders a single
    // toggle - which a component holding its selection in its own useState
    // would pass all of. The failure that hides behind that: the settings
    // screen goes on claiming "System" while the page is painted dark, so the
    // person presses System to fix it and nothing happens.
    render(
      <>
        <div data-testid="header">
          <ThemeToggle />
        </div>
        <div data-testid="settings">
          <ThemeToggle />
        </div>
      </>,
    )

    const header = within(screen.getByTestId('header'))
    const settings = within(screen.getByTestId('settings'))
    const state = (scope: ReturnType<typeof within>, name: string) =>
      scope.getByRole('button', { name }).getAttribute('aria-pressed')

    expect(state(settings, 'System theme')).toBe('true')

    await userEvent.click(header.getByRole('button', { name: 'Dark theme' }))

    expect(state(settings, 'Dark theme')).toBe('true')
    expect(state(settings, 'System theme')).toBe('false')
    expect(state(header, 'Dark theme')).toBe('true')
  })
})

describe('System, which is a choice and not an absence of one', () => {
  it('paints dark when that is what the desktop asked for', async () => {
    stubSystemTheme(true)
    render(<ThemeToggle />)

    await userEvent.click(option('System'))

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(pressed()).toEqual(['System theme'])
  })

  it('paints light when the desktop is light', async () => {
    stubSystemTheme(false)
    render(<ThemeToggle />)

    await userEvent.click(option('System'))

    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('hands control back to the desktop after an override', async () => {
    // The one thing a cycling toggle cannot do: return to "follow the OS" and
    // show that that is where you are.
    stubSystemTheme(true)
    render(<ThemeToggle />)

    await userEvent.click(option('Light'))
    expect(document.documentElement.dataset.theme).toBe('light')

    await userEvent.click(option('System'))

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(pressed()).toEqual(['System theme'])
  })
})

describe('keyboard operation', () => {
  it('reaches all three by Tab and selects with Enter', async () => {
    render(<ThemeToggle />)

    await userEvent.tab()
    expect(option('Light')).toHaveFocus()
    await userEvent.tab()
    expect(option('Dark')).toHaveFocus()

    await userEvent.keyboard('{Enter}')

    // Enter as well as Space, because these are buttons and a person reaches
    // for whichever key their habit says.
    expect(pressed()).toEqual(['Dark theme'])
  })

  it('selects with Space too', async () => {
    render(<ThemeToggle />)

    option('System').focus()
    await userEvent.keyboard(' ')

    expect(pressed()).toEqual(['System theme'])
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
