import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { CommandPaletteProvider } from '../contexts/CommandPaletteContext'
import { useCommandPalette } from '../contexts/commandPalette'
import { renderWithProviders } from '../test/render'
import { GO_TO, useGlobalShortcuts } from './useGlobalShortcuts'

/**
 * Two bindings live on `document` for the whole session: ⌘K opens the command
 * bar, and `G` then a letter jumps to a screen. Because they are global, the
 * interesting question is never "does the key work" - it is "whose keystroke
 * was that". A `g` typed into a revision comment belongs to the comment. One
 * that jumps the screen instead loses the sentence and, worse, the reviewer
 * only finds out after they have been thrown somewhere else.
 *
 * The starting route is a document, so any jump is visible as a change - and
 * so that "nothing happened" is a real assertion rather than a coincidence.
 */

const HERE = '/documents/3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c'

function Shortcuts() {
  useGlobalShortcuts()
  return null
}

/** Where the router ended up, and whether the palette is open. */
function Probe() {
  const { pathname } = useLocation()
  const { open, setOpen } = useCommandPalette()
  return (
    <>
      <p>Now at {pathname}</p>
      <p>{open ? 'Palette open' : 'Palette closed'}</p>
      <button type="button" onClick={() => setOpen(true)}>
        Force the palette open
      </button>
    </>
  )
}

/**
 * A screen with the two things a global key handler has to be careful of: a
 * field somebody is typing into, and another dialog that is already holding
 * the keyboard.
 */
function Page({ shortcuts = true, extra }: { shortcuts?: boolean; extra?: ReactNode }) {
  return (
    <>
      {shortcuts && <Shortcuts />}
      <Probe />
      <label htmlFor="note">Reviewer note</label>
      <textarea id="note" defaultValue="" />
      <label htmlFor="title">Title</label>
      <input id="title" defaultValue="" />
      <div role="dialog" aria-modal="true" aria-label="Request revision">
        <button type="button">Send it back</button>
      </div>
      {extra}
    </>
  )
}

function renderPage({ shortcuts = true }: { shortcuts?: boolean } = {}) {
  const user = userEvent.setup({ delay: null })
  const view = renderWithProviders(
    <CommandPaletteProvider>
      <Page shortcuts={shortcuts} />
    </CommandPaletteProvider>,
    { route: HERE },
  )

  return {
    ...view,
    user,
    /** Re-render with the hook gone, the way navigating off the shell would. */
    removeShortcuts() {
      view.rerender(
        <CommandPaletteProvider>
          <Page shortcuts={false} />
        </CommandPaletteProvider>,
      )
    },
  }
}

const at = (pathname: string) => screen.getByText(`Now at ${pathname}`)
const paletteIs = (state: 'open' | 'closed') => screen.getByText(`Palette ${state}`)

describe('⌘K and Ctrl+K', () => {
  it('opens the command bar', async () => {
    const { user } = renderPage()

    await user.keyboard('{Control>}k{/Control}')

    expect(paletteIs('open')).toBeInTheDocument()
  })

  it('opens it on a Mac keyboard too', async () => {
    const { user } = renderPage()

    await user.keyboard('{Meta>}k{/Meta}')

    // ⌘ and Ctrl are the same binding to the person pressing it; binding only
    // one of them makes the shortcut half-work depending on the desk.
    expect(paletteIs('open')).toBeInTheDocument()
  })

  it('opens it with caps lock on', () => {
    renderPage()

    fireEvent.keyDown(document.body, { key: 'K', ctrlKey: true })

    // The browser reports the shifted letter. Comparing against 'k' alone
    // would make the shortcut fail for anyone holding shift or caps lock.
    expect(paletteIs('open')).toBeInTheDocument()
  })

  it('closes it again on a second press', async () => {
    const { user } = renderPage()

    await user.keyboard('{Control>}k{/Control}')
    await user.keyboard('{Control>}k{/Control}')

    expect(paletteIs('closed')).toBeInTheDocument()
  })

  it('opens mid-sentence, from inside the box somebody is typing in', async () => {
    const { user } = renderPage()
    const note = screen.getByLabelText('Reviewer note')

    await user.type(note, 'Needs the sign-off')
    await user.keyboard('{Control>}k{/Control}')

    // ⌘K is the one binding that has to survive the typing guard: it is how
    // you get out of a half-written comment to look something up.
    expect(paletteIs('open')).toBeInTheDocument()
    expect(note).toHaveValue('Needs the sign-off')
  })

  it('takes the chord off the browser rather than sharing it', () => {
    renderPage()

    /* `fireEvent` returns false when a handler called `preventDefault`, and
       that is the only thing here that actually stops the browser's own
       "search the page" on this chord. Asserting an untouched textarea
       instead proves nothing: userEvent does not insert a character while
       Ctrl is held, so that assertion passes with no handler mounted at all. */
    expect(fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })).toBe(false)
    expect(paletteIs('open')).toBeInTheDocument()
  })

  it('leaves the chord alone while another dialog holds the keyboard', async () => {
    const { user } = renderPage()

    await user.click(screen.getByRole('button', { name: 'Send it back' }))
    await user.keyboard('{Control>}k{/Control}')

    // Opening a palette underneath an open modal gives two things claiming to
    // be modal, and Escape then closes the wrong one.
    expect(paletteIs('closed')).toBeInTheDocument()
  })

  it('still answers the chord from inside a dialog once the palette is the dialog', async () => {
    const { user } = renderPage()

    await user.click(screen.getByRole('button', { name: 'Force the palette open' }))
    await user.click(screen.getByRole('button', { name: 'Send it back' }))
    expect(paletteIs('open')).toBeInTheDocument()

    await user.keyboard('{Control>}k{/Control}')

    // The guard above is "do not open a palette under somebody else's modal",
    // not "never listen inside a dialog" - the palette's own search box is
    // itself inside one. A guard without that second half makes ⌘K a one-way
    // door: it opens the bar and can never close it again.
    expect(paletteIs('closed')).toBeInTheDocument()
  })
})

describe('G then a letter', () => {
  it('jumps to the queue', async () => {
    const { user } = renderPage()

    await user.keyboard('gq')

    expect(at('/pending-approvals')).toBeInTheDocument()
  })

  it.each(Object.entries(GO_TO))('sends G %s to %s', async (letter, destination) => {
    const { user } = renderPage()

    await user.keyboard(`g${letter}`)

    // The palette prints these same letters beside each screen. A letter that
    // is advertised and not bound is a promise the product does not keep.
    expect(at(destination)).toBeInTheDocument()
  })

  it('takes the second key of a jump off the page as well', () => {
    renderPage()

    fireEvent.keyDown(document.body, { key: 'g' })

    // The letters `G` binds are also native accesskeys and browser chords on
    // some setups; the jump has to claim the keystroke it acted on.
    expect(fireEvent.keyDown(document.body, { key: 'd' })).toBe(false)
    expect(at('/dashboard')).toBeInTheDocument()
  })

  it('ignores a second key that is not a screen, and forgets the G', async () => {
    const { user } = renderPage()

    await user.keyboard('gz')
    expect(at(HERE)).toBeInTheDocument()

    await user.keyboard('d')

    // If the failed pair left `G` armed, the next single letter anybody typed
    // would jump - "gzd" would land on the dashboard.
    expect(at(HERE)).toBeInTheDocument()
  })

  it('hands back a key it did not use', () => {
    renderPage()

    fireEvent.keyDown(document.body, { key: 'g' })

    // A global handler that swallowed every second keystroke after a `G`
    // would eat the page's own shortcuts - and `?` for the help sheet.
    expect(fireEvent.keyDown(document.body, { key: 'z' })).toBe(true)
    expect(at(HERE)).toBeInTheDocument()
  })

  it('forgets the G once the window has passed', () => {
    renderPage()
    const now = vi.spyOn(Date, 'now')

    now.mockReturnValue(1_000)
    fireEvent.keyDown(document.body, { key: 'g' })
    now.mockReturnValue(1_000 + 1_300)
    fireEvent.keyDown(document.body, { key: 'd' })

    // A `G` that stayed armed for ever turns any later `d` - the first letter
    // of "draft" - into a navigation away from whatever was on screen.
    expect(at(HERE)).toBeInTheDocument()
  })

  it('still jumps when the second key comes inside the window', () => {
    renderPage()
    const now = vi.spyOn(Date, 'now')

    now.mockReturnValue(1_000)
    fireEvent.keyDown(document.body, { key: 'g' })
    now.mockReturnValue(1_000 + 900)
    fireEvent.keyDown(document.body, { key: 'd' })

    expect(at('/dashboard')).toBeInTheDocument()
  })

  it('ignores a lone letter that was never preceded by G', async () => {
    const { user } = renderPage()

    await user.keyboard('d')

    expect(at(HERE)).toBeInTheDocument()
  })

  it('stays out of the way while somebody is typing a comment', async () => {
    const { user } = renderPage()
    const note = screen.getByLabelText('Reviewer note')

    await user.type(note, 'logistics')

    // "lo-g-i-stics" contains `g` then `i`, which is the jump to the inbox.
    // This is the classic bug: the reviewer loses the comment and lands on a
    // screen they did not ask for.
    expect(at(HERE)).toBeInTheDocument()
    expect(note).toHaveValue('logistics')
  })

  it('stays out of the way in a single-line field too', async () => {
    const { user } = renderPage()
    const title = screen.getByLabelText('Title')

    await user.type(title, 'Budget gd Q4')

    expect(at(HERE)).toBeInTheDocument()
    expect(title).toHaveValue('Budget gd Q4')
  })

  it('stays out of the way in a rich-text field', () => {
    renderPage()
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    /* jsdom does not implement contenteditable, so `isContentEditable` is
       never true in it. This is the browser's answer for an element the app
       has marked editable - a jsdom gap, not application behaviour. */
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    document.body.appendChild(editable)

    fireEvent.keyDown(editable, { key: 'g' })
    fireEvent.keyDown(editable, { key: 'd' })

    expect(at(HERE)).toBeInTheDocument()
    editable.remove()
  })

  it('stays out of the way inside another dialog', async () => {
    const { user } = renderPage()

    await user.click(screen.getByRole('button', { name: 'Send it back' }))
    await user.keyboard('gd')

    // The focused control here is a button, not a field - so this is the
    // dialog guard doing the work, not the typing guard. Navigating out from
    // under an open modal would leave the modal's state stranded.
    expect(at(HERE)).toBeInTheDocument()
  })

  it('stays out of the way while the command bar is open', async () => {
    const { user } = renderPage()

    await user.click(screen.getByRole('button', { name: 'Force the palette open' }))
    await user.keyboard('gd')

    // Every letter typed into the palette's search box is a search term.
    expect(at(HERE)).toBeInTheDocument()
  })

  it.each([
    ['Alt', { altKey: true }],
    ['Ctrl', { ctrlKey: true }],
    ['Meta', { metaKey: true }],
  ])('does not let %s+G arm the jump', (_held, modifier) => {
    renderPage()

    fireEvent.keyDown(document.body, { key: 'g', ...modifier })
    fireEvent.keyDown(document.body, { key: 'd' })

    // Alt+G is a menu accelerator on Windows, Ctrl+G is "find again", ⌘G is
    // the same on a Mac. None of them is somebody asking to change screens,
    // and none may leave the prefix armed for the next innocent letter.
    expect(at(HERE)).toBeInTheDocument()
  })

  it('does not let a modifier chord finish a jump either', () => {
    renderPage()

    fireEvent.keyDown(document.body, { key: 'g' })
    fireEvent.keyDown(document.body, { key: 'd', ctrlKey: true })

    // Ctrl+D is "bookmark this page". Arming `G` must not turn every later
    // chord that happens to start with a bound letter into a navigation.
    expect(at(HERE)).toBeInTheDocument()
  })
})

describe('when the shell goes away', () => {
  it('stops listening, so a gone screen cannot still be steering the router', async () => {
    const { user, removeShortcuts } = renderPage()

    removeShortcuts()
    await user.keyboard('gd')

    // A leaked document listener keeps navigating for the rest of the
    // session - and it navigates using a `navigate` bound to a router the
    // unmounted tree owned.
    expect(at(HERE)).toBeInTheDocument()
  })
})
