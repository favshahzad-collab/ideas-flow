import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPaletteProvider } from '../contexts/CommandPaletteContext'
import {
  useCommandPalette,
  useRegisterCommands,
  type Command,
} from '../contexts/commandPalette'
import type { CurrentUser } from '../contexts/currentUser'
import { GO_TO } from '../hooks/useGlobalShortcuts'
import { makeUser, renderWithProviders } from '../test/render'
import type { DashboardDocument } from '../types/document'
import CommandPalette from './CommandPalette'

/**
 * The command bar is the fastest way into any document in the product, and
 * for a keyboard-only user it is often the only way. Everything it shows is
 * a claim: that this document exists, that this screen is one you are allowed
 * to open, that the row lit up is the one Enter will run. Get any of those
 * wrong and somebody either lands somewhere they should not be, or concludes
 * a document they can see in the list is simply not there.
 *
 * The palette is mounted here the way the shell mounts it - from a trigger
 * that already has focus - because "Escape puts me back where I was" cannot
 * be asserted against a palette that was rendered on its own.
 */

/* useDocuments fetches on mount. The palette does not care where its
   documents came from, only what it does with them, so the hook is the seam:
   mocking it keeps the list deterministic instead of racing a promise. */
const docsState = vi.hoisted(() => ({
  documents: [] as unknown[],
  loading: false,
  error: null as string | null,
}))

vi.mock('../hooks/useDocuments', () => ({
  useDocuments: () => ({
    documents: docsState.documents,
    currentUserId: 'user-0000-0000-0000-000000000001',
    userName: 'Ayesha Khan',
    loading: docsState.loading,
    error: docsState.error,
    refetch: () => {},
  }),
}))

function makeDoc(overrides: Partial<DashboardDocument> = {}): DashboardDocument {
  return {
    id: '3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c',
    referenceNumber: null,
    title: 'Warehouse lease extension',
    description: 'Two-year extension on the Korangi warehouse.',
    status: 'pending_review',
    preparerId: 'user-0000-0000-0000-000000000002',
    submittedBy: 'Bilal Ahmed',
    submittedByInitials: 'BA',
    currentHolder: 'Chandni Rao',
    currentHolderInitials: 'CR',
    currentStep: 2,
    totalSteps: 4,
    lastUpdated: '2h',
    submittedDate: '2026-09-01',
    submittedAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-05T09:00:00.000Z',
    versionNumber: 1,
    approvalType: 'REVIEWER',
    actionLabel: 'Review',
    nextHolder: 'Danish Iqbal',
    fileType: 'pdf',
    isAwaitingMyAction: true,
    dueAt: null,
    ...overrides,
  }
}

/** The contextual ACTIONS a document screen contributes while it is open. */
function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: 'doc:sign',
    group: 'actions',
    label: 'Sign & approve this document',
    hint: 'Warehouse lease extension',
    shortcut: 'A',
    run: () => {},
    ...overrides,
  }
}

function Contextual({ commands }: { commands: Command[] }) {
  useRegisterCommands('document-detail', commands, [commands])
  return null
}

/** Where the router ended up, in words a test can read back. */
function Probe() {
  const { pathname } = useLocation()
  return <p>Now at {pathname}</p>
}

/**
 * The shell, reduced to the parts that matter: a trigger that opens the
 * palette and holds focus until it does, and the palette mounted only while
 * open - exactly as `AppShell` mounts it.
 */
function Shell({ commands }: { commands: Command[] }) {
  const { open, setOpen } = useCommandPalette()
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Search
      </button>
      <Contextual commands={commands} />
      <Probe />
      {open && <CommandPalette />}
    </>
  )
}

/** The document the palette is opened from - so "the screen did not change" is assertable. */
const HERE = '/documents/3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c'

async function openPalette({
  documents = [makeDoc()],
  commands = [] as Command[],
  role = 'USER' as CurrentUser['role'],
  loading = false,
  error = null as string | null,
} = {}) {
  docsState.documents = documents
  docsState.loading = loading
  docsState.error = error
  const user = userEvent.setup({ delay: null })
  const view = renderWithProviders(
    <CommandPaletteProvider>
      <Shell commands={commands} />
    </CommandPaletteProvider>,
    { route: HERE, currentUser: { user: makeUser({ role }) } },
  )

  const trigger = screen.getByRole('button', { name: 'Search' })
  await user.click(trigger)

  return { ...view, user, trigger }
}

const dialog = () => screen.getByRole('dialog', { name: 'Command palette' })
const searchBox = () =>
  screen.getByRole('combobox', { name: 'Search documents, people and actions' })
const options = () => screen.queryAllByRole('option')
const litRows = () => options().filter(option => option.getAttribute('aria-selected') === 'true')

/**
 * The one row Enter would run.
 *
 * Deliberately strict: `find`ing the first row marked selected answers
 * "is the right row lit" identically whether one row is lit or all of them
 * are, and a palette that marked every row `aria-selected="true"` would tell
 * a screen reader user the list is entirely selected while sighted users see
 * one highlight. Every `selected()` below is therefore also an assertion that
 * exactly one row is armed.
 */
const selected = () => {
  const lit = litRows()
  if (lit.length !== 1) {
    throw new Error(
      `expected exactly one highlighted row, found ${lit.length}` +
        (lit.length ? `: ${lit.map(row => row.textContent).join(' | ')}` : ''),
    )
  }
  return lit[0]
}

beforeEach(() => {
  docsState.documents = []
  docsState.loading = false
  docsState.error = null
})

describe('opening the command palette', () => {
  it('announces itself as a modal dialog with a name', async () => {
    await openPalette()

    // Without the name a screen reader announces "dialog" and nothing else,
    // and without aria-modal it reads the page behind as if it were reachable.
    expect(dialog()).toHaveAttribute('aria-modal', 'true')
  })

  it('puts the caret in the search box so the first keystroke is a search', async () => {
    await openPalette()

    expect(searchBox()).toHaveFocus()
  })

  it('wires the search box to the list of results it is driving', async () => {
    await openPalette()

    const controls = searchBox().getAttribute('aria-controls')
    const list = controls ? document.getElementById(controls) : null

    // `aria-controls` is what tells a screen reader the box and the rows are
    // one widget. Pointing it at nothing - or at a node that is not the list -
    // reads as an empty combobox however many rows are on screen, and
    // `aria-activedescendant` then names a row inside a list nobody is on.
    expect(list).toBe(screen.getByRole('listbox', { name: 'Results' }))
    expect(list).toContainElement(options()[0])
    expect(searchBox()).toHaveAttribute('aria-expanded', 'true')
  })

  it('highlights the first result, so Enter is never a dead key', async () => {
    const run = vi.fn()
    await openPalette({ commands: [makeCommand({ run })] })

    expect(selected()).toHaveTextContent('Sign & approve this document')
    // The combobox has to point at the highlighted row by id or a screen
    // reader user hears nothing as the arrow keys move.
    const pointer = searchBox().getAttribute('aria-activedescendant')
    expect(pointer).toBe('cmd-doc:sign')

    // ...and it has to point at a node that is really there. An id that
    // resolves to nothing is announced as nothing, which is the same silence
    // as having no `aria-activedescendant` at all - only harder to spot.
    expect(document.getElementById(pointer as string)).toBe(selected())
  })

  it('keeps Tab inside the panel instead of leaking into the page behind', async () => {
    const { user, trigger } = await openPalette()

    await user.tab()

    // The page behind is covered by a scrim; focus landing on it is focus a
    // keyboard user cannot see or get back from.
    expect(searchBox()).toHaveFocus()

    // Backwards is the direction that actually leaks, and the only direction
    // this fixture can prove it in: the trigger sits BEFORE the panel in the
    // document, so an untrapped Shift+Tab out of the search box lands on it.
    // Forwards there is nothing after the panel to catch a leak, which is why
    // the assertion above passes either way and this one does not.
    await user.tab({ shift: true })

    expect(searchBox()).toHaveFocus()
    expect(trigger).not.toHaveFocus()
  })
})

describe('what the palette offers', () => {
  it('puts the actions for the open document above the list of every screen', async () => {
    await openPalette({ commands: [makeCommand()] })

    // Order is the whole value of the grouping: what you can do here first,
    // then what you were looking at, then where you can go.
    expect(screen.getAllByRole('group').map(group => group.getAttribute('aria-label'))).toEqual([
      'Actions',
      'Documents',
      'Go to',
    ])
  })

  it('names a document by its title and says who is holding it', async () => {
    await openPalette({ documents: [makeDoc()] })

    const documents = screen.getByRole('group', { name: 'Documents' })
    const row = within(documents).getByRole('option', { name: /Warehouse lease extension/ })

    // Two documents can share a title. The short id and the holder are what
    // tell somebody they are about to open the right one - and the holder is
    // the single most misleading thing to get wrong on a document row.
    expect(row).toHaveTextContent('#3F2A9B1C')
    expect(row).toHaveTextContent('Chandni Rao')
  })

  it('hides administrator-only screens from an ordinary user', async () => {
    await openPalette({ role: 'USER' })

    // Offering "Control room" to somebody the API will refuse is an invitation
    // to a permission error, and it leaks that the screen exists.
    expect(screen.queryByRole('option', { name: /Control room/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /People & delegation/ })).not.toBeInTheDocument()

    // By path as well as by label, because the labels are renamed copy: an
    // admin screen renamed tomorrow would walk straight past the two lines
    // above and be offered to everybody.
    expect(screen.queryByRole('option', { name: /\/admin\// })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /\/admin\/people/ })).not.toBeInTheDocument()

    expect(screen.getByRole('option', { name: /My queue/ })).toBeInTheDocument()
  })

  it('offers them to an administrator', async () => {
    await openPalette({ role: 'ADMINISTRATOR' })

    expect(screen.getByRole('option', { name: /Control room/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Workflow studio/ })).toBeInTheDocument()
  })

  it('teaches the keyboard jump beside every screen that has one', async () => {
    // As an administrator, so every screen `GO_TO` binds is actually on offer.
    await openPalette({ role: 'ADMINISTRATOR' })

    const goTo = screen.getByRole('group', { name: 'Go to' })

    // The palette advertises `G D`; `useGlobalShortcuts` is what has to honour
    // it. Both read the same map, and this is the assertion that says so - a
    // palette that promises a key nobody bound is worse than no hint at all.
    expect(within(goTo).getByRole('option', { name: /^Documents/ })).toHaveTextContent('G D')

    // ...and the same for the rest of the map, found by the path each row
    // names rather than by its label, so renaming a screen does not quietly
    // stop this checking anything.
    for (const [letter, path] of Object.entries(GO_TO)) {
      const row = within(goTo).getByRole('option', { name: new RegExp(path) })
      expect(row).toHaveTextContent(`G ${letter.toUpperCase()}`)
    }
  })

  it('does not advertise a key beside a screen the map does not bind', async () => {
    await openPalette({ role: 'ADMINISTRATOR' })

    const goTo = screen.getByRole('group', { name: 'Go to' })
    const unbound = within(goTo).getByRole('option', { name: /\/admin\/people/ })

    // `G` is only bound for six screens. A hint invented for the others - or
    // copied from the row above - is a key that does nothing when pressed.
    expect(Object.values(GO_TO)).not.toContain('/admin/people')
    expect(unbound.textContent).not.toMatch(/\bG [A-Z]\b/)
  })

  it('shows the go-to list even when there is not a single document yet', async () => {
    await openPalette({ documents: [] })

    // A brand new account has no documents. An empty panel would read as
    // "the palette is broken" rather than "you have not submitted anything".
    expect(screen.queryByRole('group', { name: 'Documents' })).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Go to' })).toBeInTheDocument()
  })
})

describe('while the documents are still arriving', () => {
  /* `it.fails` passes when a test throws for ANY reason, so the two expected
     failures below would still be "green" if the palette stopped opening
     altogether. This is the same setup, asserted where a break is reported as
     a break. */
  it('still opens, and still offers the screens, while the list is in flight', async () => {
    await openPalette({ documents: [], loading: true })

    expect(dialog()).toBeInTheDocument()
    expect(searchBox()).toHaveFocus()
    expect(screen.getByRole('group', { name: 'Go to' })).toBeInTheDocument()
  })

  it('says the list is still loading rather than reporting no match', async () => {
    // The palette mounts when it opens, so its documents are always still in
    // flight for the first moment somebody types. That moment used to read as
    // "Nothing matches" - the palette telling a person a document they can
    // see on the dashboard behind it does not exist.
    const { user } = await openPalette({ documents: [], loading: true })

    await user.type(searchBox(), 'Warehouse')

    expect(await screen.findByText(/Still loading documents/i)).toBeInTheDocument()
    expect(screen.queryByText(/Nothing matches/)).not.toBeInTheDocument()
  })

  it('still opens, and still offers the screens, when the list failed to load', async () => {
    await openPalette({ documents: [], error: 'Failed to load documents' })

    // The guard on the expected failure below. `it.fails` cannot tell a
    // missing feature from a palette that stopped opening, so the fixture
    // being alive at all is asserted here, where a break is reported as one.
    expect(dialog()).toBeInTheDocument()
    expect(searchBox()).toHaveFocus()
    expect(screen.getByRole('group', { name: 'Go to' })).toBeInTheDocument()
  })

  it('says so when the document list could not be loaded at all', async () => {
    await openPalette({ documents: [], error: 'Failed to load documents' })

    // The go-to rows are local, so the palette still looks alive.
    expect(screen.getByRole('group', { name: 'Go to' })).toBeInTheDocument()

    // DEFECT: `useDocuments` hands back an error and the palette drops it on
    // the floor. Every document silently disappears from search with nothing
    // to say why, and the person concludes the documents are gone rather than
    // that the request failed and is worth retrying.
    expect(screen.getByText(/could not|failed|try again/i)).toBeInTheDocument()
  })
})

describe('searching', () => {
  it('narrows to the documents that match and drops the screens that do not', async () => {
    const { user } = await openPalette({
      documents: [
        makeDoc(),
        makeDoc({ id: 'aaaaaaaa-0000-0000-0000-000000000000', title: 'Stationery order' }),
      ],
    })

    await user.type(searchBox(), 'lease')

    await waitFor(() => expect(options()).toHaveLength(1))
    expect(screen.getByRole('option', { name: /Warehouse lease extension/ })).toBeInTheDocument()
  })

  it('matches on the second line too, so a holder’s name finds their work', async () => {
    const { user } = await openPalette({
      documents: [
        makeDoc({ currentHolder: 'Chandni Rao' }),
        makeDoc({
          id: 'aaaaaaaa-0000-0000-0000-000000000000',
          title: 'Stationery order',
          currentHolder: 'Bilal Ahmed',
        }),
      ],
    })

    await user.type(searchBox(), 'chandni')

    // "What is Chandni sitting on?" is the question this bar is for. Matching
    // titles alone would answer it with "nothing".
    await waitFor(() => expect(options()).toHaveLength(1))
    expect(screen.getByRole('option', { name: /Warehouse lease extension/ })).toBeInTheDocument()
  })

  it('says nothing matched, and repeats back what was typed', async () => {
    const { user } = await openPalette()

    await user.type(searchBox(), 'zzzz')

    const message = await screen.findByText(/Nothing matches/)
    // A blank panel is indistinguishable from a broken one. Echoing the query
    // is also how somebody spots their own typo.
    expect(message).toHaveTextContent('zzzz')
    expect(options()).toHaveLength(0)

    // With no rows there is no row to point at. Leaving the pointer on the
    // last id makes a screen reader announce a row that is no longer in the
    // document while the panel reads as empty to everybody else.
    expect(searchBox()).not.toHaveAttribute('aria-activedescendant')
  })

  it('counts the results out loud, in the singular when there is one', async () => {
    const { user } = await openPalette()

    await user.type(searchBox(), 'Warehouse lease')

    // The result list is silent to a screen reader as it re-filters; the live
    // region is the only thing that says the search did anything. "1 results"
    // is the sound of a count nobody proof-read.
    const count = await screen.findByText('1 result')

    // ...and a count that is not in a live region is never spoken at all, so
    // the wording alone is only half the contract.
    expect(count).toHaveAttribute('aria-live', 'polite')
  })

  it('reports zero results rather than going quiet', async () => {
    const { user } = await openPalette()

    await user.type(searchBox(), 'zzzz')

    expect(await screen.findByText('0 results')).toBeInTheDocument()
  })

  it('re-aims Enter at the top match when the query moves the list under it', async () => {
    const { user } = await openPalette({
      documents: [
        makeDoc({ id: '11111111-0000-0000-0000-000000000000', title: 'Routine memo one' }),
        makeDoc({ id: '22222222-0000-0000-0000-000000000000', title: 'Routine memo two' }),
        makeDoc({ id: '33333333-0000-0000-0000-000000000000', title: 'Routine memo three' }),
      ],
    })

    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(selected()).toHaveTextContent('Routine memo three')

    await user.type(searchBox(), 'memo')
    await waitFor(() => expect(options()).toHaveLength(3))

    // Typing starts the list again from the top. A highlight left where the
    // arrows put it still has three rows under it, so nothing clamps it back -
    // the eye is on the first row and Enter opens the third.
    expect(selected()).toHaveTextContent('Routine memo one')

    await user.keyboard('{Enter}')

    expect(
      screen.getByText('Now at /documents/11111111-0000-0000-0000-000000000000'),
    ).toBeInTheDocument()
  })

  it('does nothing on Enter when nothing matched, and stays open', async () => {
    const { user } = await openPalette()

    await user.type(searchBox(), 'zzzz')
    await screen.findByText(/Nothing matches/)
    await user.keyboard('{Enter}')

    // Closing on Enter with no match would look exactly like having run
    // something - the palette vanishes and the screen has not changed.
    expect(dialog()).toBeInTheDocument()
    expect(screen.getByText(`Now at ${HERE}`)).toBeInTheDocument()
  })

  function manyDocuments() {
    return Array.from({ length: 45 }, (_, position) =>
      makeDoc({
        id: `${String(position).padStart(8, '0')}-0000-0000-0000-000000000000`,
        title: position === 44 ? 'Sealed bid for the Karachi depot' : `Routine memo ${position}`,
      }),
    )
  }

  it('shows a readable slice of a long list rather than every document at once', async () => {
    await openPalette({ documents: manyDocuments() })

    const documents = screen.getByRole('group', { name: 'Documents' })

    // Also the guard on the expected failure below: `it.fails` cannot tell a
    // missing feature from a broken fixture, so the 45 documents being
    // rendered at all is asserted here.
    expect(within(documents).getAllByRole('option')).toHaveLength(40)
    expect(within(documents).getByRole('option', { name: /Routine memo 0/ })).toBeInTheDocument()
  })

  it('finds a document that sits past the fortieth in the list', async () => {
    // The list used to be cut to the first forty *before* the query was
    // applied, so searching for the forty-fifth told a person their document
    // did not exist. The cap is a display decision and belongs after the
    // filter, never in the answer.
    const documents = manyDocuments()
    const { user } = await openPalette({ documents })

    await user.type(searchBox(), 'Sealed bid')

    expect(
      await screen.findByRole('option', { name: /Sealed bid/ }),
    ).toBeInTheDocument()
  })

  it('says how many matches it is not showing, rather than dropping them silently', async () => {
    // Forty drawn out of forty-five matched. A reader who cannot see their
    // document needs to know the list is partial - otherwise this is the same
    // lie as before, told more quietly.
    const { user } = await openPalette({ documents: manyDocuments() })

    await user.type(searchBox(), 'Routine memo')

    expect(await screen.findByText(/4 more match/)).toBeInTheDocument()
  })
})

describe('driving it from the keyboard', () => {
  it('moves the highlight down into the next group', async () => {
    const { user } = await openPalette({ commands: [makeCommand()] })

    const action = screen.getByRole('option', { name: /Sign & approve this document/ })
    const documents = screen.getByRole('group', { name: 'Documents' })
    const docRow = within(documents).getByRole('option', { name: /Warehouse lease extension/ })

    await user.keyboard('{ArrowDown}')

    // Groups are a visual grouping, not a boundary. An arrow key that stopped
    // at the end of ACTIONS would strand every document below it.
    expect(selected()).toBe(docRow)

    // The light has to MOVE, not spread. A row left marked selected behind the
    // highlight still satisfies "the document row is selected" while two rows
    // look armed and only one of them is what Enter will run.
    expect(action).toHaveAttribute('aria-selected', 'false')

    // The pointer follows, or the row a screen reader announces and the row
    // the eye sees drift apart as soon as the arrows are used.
    expect(searchBox()).toHaveAttribute(
      'aria-activedescendant',
      'cmd-doc:3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c',
    )
  })

  it('moves back up again', async () => {
    const { user } = await openPalette({ commands: [makeCommand()] })

    await user.keyboard('{ArrowDown}{ArrowUp}')

    expect(selected()).toHaveTextContent('Sign & approve this document')
  })

  it('stays on the first row when the list is already at the top', async () => {
    const { user } = await openPalette({ commands: [makeCommand()] })

    await user.keyboard('{ArrowUp}{ArrowUp}')

    // A highlight that walked off the top would leave nothing selected, and
    // Enter would then do nothing at all.
    expect(selected()).toHaveTextContent('Sign & approve this document')
  })

  it('stays on the last row at the bottom of the list', async () => {
    const { user } = await openPalette({ documents: [] })

    const all = options()
    await user.keyboard('{ArrowDown}'.repeat(all.length + 3))

    expect(selected()).toBe(all[all.length - 1])
  })

  it('runs the highlighted command once, and only once, on Enter', async () => {
    const run = vi.fn()
    const other = vi.fn()
    const { user } = await openPalette({
      commands: [
        makeCommand({ run }),
        makeCommand({ id: 'doc:revision', label: 'Request a revision', run: other }),
      ],
    })

    await user.keyboard('{Enter}')

    // Twice is not academic: these commands raise sign-and-approve modals and
    // post comments. One keypress has to mean one action.
    expect(run).toHaveBeenCalledTimes(1)

    // And exactly one command, not the group. "Sign & approve" and "Request a
    // revision" sit next to each other and are opposites; an Enter that fired
    // the section would satisfy the line above too.
    expect(other).not.toHaveBeenCalled()
  })

  it('closes the palette when a command runs', async () => {
    const { user } = await openPalette({ commands: [makeCommand()] })

    await user.keyboard('{Enter}')

    // The command usually opens something. A palette left over the top of it
    // swallows the next keystroke.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens the document under the highlight, not the one already on screen', async () => {
    const { user } = await openPalette({
      commands: [makeCommand()],
      documents: [
        makeDoc({ id: 'aaaaaaaa-1111-2222-3333-444444444444', title: 'Fleet insurance renewal' }),
      ],
    })

    await user.keyboard('{ArrowDown}{Enter}')

    // Enter has to open the row that is lit, not the row the palette happens
    // to have been opened from.
    expect(
      screen.getByText('Now at /documents/aaaaaaaa-1111-2222-3333-444444444444'),
    ).toBeInTheDocument()
  })

  it('goes to the screen a Go to row names', async () => {
    const { user } = await openPalette({ documents: [] })

    await user.type(searchBox(), 'Audit ledger')
    await screen.findByText('1 result')
    await user.keyboard('{Enter}')

    expect(screen.getByText('Now at /audit-ledger')).toBeInTheDocument()
  })

  it('closes on Escape without running anything', async () => {
    const run = vi.fn()
    const { user } = await openPalette({ commands: [makeCommand({ run })] })

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Escape is the "I did not mean to" key. It must never be mistaken for
    // Enter on whatever happened to be highlighted.
    expect(run).not.toHaveBeenCalled()
    // ...including the rows the spy cannot see: a Go to or document row run on
    // the way out navigates, and `run` would still read as untouched.
    expect(screen.getByText(`Now at ${HERE}`)).toBeInTheDocument()
  })

  it('stops the page behind from scrolling, and gives it back on the way out', async () => {
    const { user } = await openPalette()

    // Otherwise the wheel scrolls the dashboard underneath the panel, which on
    // a long list looks exactly like the palette's own list refusing to move.
    expect(document.body.style.overflow).toBe('hidden')

    await user.keyboard('{Escape}')

    // And a lock that is never released leaves the whole app unscrollable for
    // the rest of the session - a far worse bug than the one it fixed.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.body.style.overflow).toBe('')
  })

  it('hands focus back to the control that opened it', async () => {
    const { user, trigger } = await openPalette()

    await user.keyboard('{Escape}')

    // DEFECT: focus is dropped on the body instead. `autoFocus` on the search
    // input runs during the commit, before `useDialogA11y`'s effect reads
    // `document.activeElement` - so the dialog memorises its own input as the
    // element to restore, and restores focus to a node that has just been
    // unmounted. A keyboard-only user is returned to the top of the document
    // and has to tab back down to where they were.
    expect(trigger).toHaveFocus()
  })
})

describe('driving it with the mouse', () => {
  it('moves the highlight to the row under the pointer', async () => {
    const { user } = await openPalette({ commands: [makeCommand()] })

    const documents = screen.getByRole('group', { name: 'Documents' })
    await user.hover(within(documents).getByRole('option', { name: /Warehouse lease extension/ }))

    // The keyboard and the pointer have to agree on what Enter will run.
    // Otherwise the row that looks armed and the row that fires are different.
    expect(selected()).toHaveTextContent('Warehouse lease extension')
  })

  it('runs a row on click, once, and closes', async () => {
    const run = vi.fn()
    const { user } = await openPalette({ commands: [makeCommand({ run })] })

    await user.click(screen.getByRole('option', { name: /Sign & approve this document/ }))

    expect(run).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes when the page behind is clicked, without running the lit row', async () => {
    const run = vi.fn()
    const { user } = await openPalette({ commands: [makeCommand({ run })] })

    /* The backdrop is found by position rather than by name on purpose: it is
       the one element here that MUST NOT be in the accessibility tree, so
       there is no role or label to ask for. A scrim a screen reader can land
       on is a dead end - an unlabelled node that covers the whole viewport. */
    const scrim = dialog().parentElement?.firstElementChild
    expect(scrim).toBeInTheDocument()
    expect(scrim).not.toBe(dialog())
    expect(scrim).toHaveAttribute('aria-hidden', 'true')

    await user.click(scrim as Element)

    // Clicking away is "no thanks", the same as Escape - not Enter on
    // whatever the highlight happened to be resting on.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(run).not.toHaveBeenCalled()
    expect(screen.getByText(`Now at ${HERE}`)).toBeInTheDocument()
  })
})
