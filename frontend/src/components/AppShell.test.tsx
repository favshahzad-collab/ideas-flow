import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  makeUser,
  renderWithProviders,
  ADMIN_CAPABILITIES,
  STAFF_CAPABILITIES,
} from '../test/render'
import { CommandPaletteProvider } from '../contexts/CommandPaletteContext'
import AppShell from './AppShell'

/**
 * The navigation, and who sees what in it.
 *
 * The shell used to work out the Administration group for itself, by comparing
 * the role string to 'ADMINISTRATOR'. That was a fourth copy of a rule the
 * server already owns, and the failure it invites is the quiet one: a link
 * offered to somebody the route will turn away. Every row now names the
 * capability it needs, and these are the tests that it is actually consulted.
 */

const counts = vi.hoisted(() => ({ unread: 0, pending: 0 }))

vi.mock('../hooks/useNotifications', () => ({
  useUnreadNotificationCount: () => ({ unreadCount: counts.unread }),
}))
vi.mock('../hooks/usePendingApprovalCount', () => ({
  usePendingApprovalCount: () => ({ count: counts.pending, reload: vi.fn() }),
}))
vi.mock('../hooks/useGlobalShortcuts', () => ({
  useGlobalShortcuts: () => {},
}))

const shell = (
  capabilities: string[],
  role: 'USER' | 'ADMINISTRATOR' = 'USER',
  route = '/dashboard'
) =>
  renderWithProviders(
    // The shell reads the palette's open state. Wrapped here rather than added
    // to the shared providers: it is the shell's own dependency, and no other
    // screen under test has it.
    <CommandPaletteProvider>
      <AppShell onLogout={() => {}}>
        <div />
      </AppShell>
    </CommandPaletteProvider>,
    {
      route,
      currentUser: {
        user: makeUser({ role, capabilities: capabilities as never }),
      },
    }
  )

const mainNav = () => screen.getByRole('navigation', { name: 'Main' })

beforeEach(() => {
  vi.clearAllMocks()
  // The Administration fold is remembered in storage, and jsdom keeps one
  // store for the whole file. Cleared here so a test that folds the group
  // cannot decide what a later, unrelated test renders.
  window.localStorage.clear()
  counts.unread = 0
  counts.pending = 0
})

describe('the counts beside a row', () => {
  it('names each for what it counts', () => {
    // The Inbox counts unread updates; My queue counts memos to sign. Both
    // used to be announced as "waiting on you", which sent people to the
    // Inbox looking for work that is in the queue.
    counts.unread = 4
    counts.pending = 2
    shell(STAFF_CAPABILITIES)

    const nav = within(mainNav())
    expect(nav.getByRole('link', { name: 'Inbox, 4 unread' })).toBeInTheDocument()
    expect(nav.getByRole('link', { name: 'My queue, 2 waiting on you' })).toBeInTheDocument()
  })

  it('names the row alone when there is nothing to count', () => {
    shell(STAFF_CAPABILITIES)

    const nav = within(mainNav())
    expect(nav.getByRole('link', { name: 'Inbox' })).toBeInTheDocument()
    expect(nav.getByRole('link', { name: 'My queue' })).toBeInTheDocument()
  })
})

describe('the Administration group', () => {
  it('is absent entirely for somebody holding none of it', () => {
    shell(STAFF_CAPABILITIES)

    // Not an empty heading with nothing under it: the group label goes with
    // its last row.
    expect(screen.queryByText('Administration')).not.toBeInTheDocument()
    expect(within(mainNav()).queryByRole('link', { name: 'Mail' })).not.toBeInTheDocument()
  })

  it('shows only the rows whose capability the person holds', () => {
    /*
     * The case that would have been impossible before: a role that can
     * configure mail but not manage people. Nothing in the product issues one
     * today - which is exactly why the shell must not assume it never will.
     */
    shell([...STAFF_CAPABILITIES, 'mail.configure'], 'ADMINISTRATOR')

    const nav = within(mainNav())
    expect(nav.getByRole('link', { name: 'Mail' })).toBeInTheDocument()
    expect(nav.queryByRole('link', { name: /People/ })).not.toBeInTheDocument()
    expect(nav.queryByRole('link', { name: 'Login activity' })).not.toBeInTheDocument()
  })

  it('shows the administration rows to somebody holding them', () => {
    shell(
      [
        ...STAFF_CAPABILITIES,
        'approvals.oversee',
        'sessions.view',
        'users.manage',
        'workflows.manage',
        'mail.configure',
      ],
      'ADMINISTRATOR'
    )

    const nav = within(mainNav())
    expect(nav.getByRole('link', { name: 'Login activity' })).toBeInTheDocument()
    expect(nav.getByRole('link', { name: 'People & delegation' })).toBeInTheDocument()
    expect(nav.getByRole('link', { name: 'Mail' })).toBeInTheDocument()
  })

  it('shows nothing administrative while the user is still loading', () => {
    /*
     * Mid-load there is no user at all, which is a different thing from a user
     * whose capability list came back empty - that means the server did not
     * report capabilities, and is handled at the bottom of this file. Better
     * an absent group for a moment than links that bounce off the guard.
     */
    renderWithProviders(
      <CommandPaletteProvider>
        <AppShell onLogout={() => {}}>
          <div />
        </AppShell>
      </CommandPaletteProvider>,
      { currentUser: { user: null, loading: true } }
    )

    expect(screen.queryByText('Administration')).not.toBeInTheDocument()
  })
})

describe('the everyday rows', () => {
  it('are there for ordinary staff', () => {
    shell(STAFF_CAPABILITIES)

    const nav = within(mainNav())
    expect(nav.getByRole('link', { name: /Documents/ })).toBeInTheDocument()
    expect(nav.getByRole('link', { name: /My queue/ })).toBeInTheDocument()
    expect(nav.getByRole('link', { name: /Submit/ })).toBeInTheDocument()
  })
})

describe('the sidebar and the route guard agree', () => {
  /*
   * The failure this pairing exists to prevent: a row that appears because the
   * server granted a capability, opening a screen whose guard asks a different
   * question and turns the person away. The two now read the same list, and
   * this is the test that they still do.
   */
  it('names a capability on every administration row', () => {
    // Read off the rendered rows rather than the constant, so a row added
    // without a capability shows up here as an unguarded link.
    shell(ADMIN_CAPABILITIES, 'ADMINISTRATOR')

    const rows = within(mainNav()).getAllByRole('link')
    const admin = rows.filter(row =>
      ['Control room', 'Login activity', 'Workflow studio', 'People & delegation', 'Mail'].includes(
        row.textContent?.trim() ?? ''
      )
    )

    expect(admin).toHaveLength(5)
  })

  it('drops a row the moment its capability is withdrawn', () => {
    shell(ADMIN_CAPABILITIES.filter(c => c !== 'sessions.view'), 'ADMINISTRATOR')

    const nav = within(mainNav())
    expect(nav.queryByRole('link', { name: 'Login activity' })).not.toBeInTheDocument()
    // And the rest of the group is untouched.
    expect(nav.getByRole('link', { name: 'People & delegation' })).toBeInTheDocument()
  })
})

describe('against a server that does not report capabilities', () => {
  it('falls back to the role rather than hiding administration entirely', () => {
    // The alternative is an administrator with no way into any admin screen
    // and nothing on screen explaining the disappearance.
    shell([], 'ADMINISTRATOR')

    const nav = within(mainNav())
    expect(nav.getByRole('link', { name: 'Mail' })).toBeInTheDocument()
    expect(nav.getByRole('link', { name: 'Login activity' })).toBeInTheDocument()
  })

  it('shows staff nothing administrative', () => {
    shell([], 'USER')

    expect(screen.queryByText('Administration')).not.toBeInTheDocument()
  })
})

describe('the company mark on the workspace row', () => {
  /*
   * A generic document glyph on a teal chip sat here. It is the Ideas symbol
   * now - and it is the symbol itself, cut out of the supplied logo, shown as
   * four windows onto that one file so the petals can settle into place one
   * after another. Four elements is therefore not decoration: it is what the
   * entrance needs.
   *
   * Whether that entrance is allowed to repeat is a separate question with a
   * separate answer, in `motion.test.ts`.
   */

  it('is built from the four petals the entrance brings in', () => {
    const { container } = shell(STAFF_CAPABILITIES)

    const mark = container.querySelector('.ideas-mark')
    expect(mark).not.toBeNull()
    expect(mark!.querySelectorAll('.ideas-mark-petal')).toHaveLength(4)
  })

  it('draws each petal from the supplied artwork, not from a redrawing of it', () => {
    /*
     * The corners are windows onto `/ideas-mark.png`. If somebody replaces
     * them with hand-drawn SVG paths to make the animation easier, the mark
     * stops being the company's artwork and becomes an imitation of it -
     * which is the one thing a logo may not be. The class carries that
     * contract; index.css holds the `background-image` behind it.
     */
    const { container } = shell(STAFF_CAPABILITIES)

    const corners = ['tl', 'tr', 'br', 'bl']
    for (const corner of corners) {
      expect(
        container.querySelector(`.ideas-mark-petal.ideas-mark-${corner}`)
      ).not.toBeNull()
    }
  })

  it('sits in a row that promises nothing it cannot do', () => {
    /*
     * A ChevronDown used to close this row, suggesting a workspace switcher.
     * There is one workspace and no endpoint that could list a second, so
     * the chevron was a picture of a control: click it, nothing happens.
     *
     * Every other glyph in this row is a span - the mark is four of them -
     * so an <svg> here is exactly the thing this test exists to keep out.
     */
    const { container } = shell(STAFF_CAPABILITIES)

    const row = container.querySelector('.ideas-mark')!.parentElement!

    expect(row.querySelector('svg')).toBeNull()
    expect(within(row).queryByRole('button')).not.toBeInTheDocument()
    expect(within(row).getByText('IDEAS PVT LTD')).toBeInTheDocument()
  })

  it('says nothing to a screen reader, because the row already names it', () => {
    // "Ideas Flow" is spelt out in the text beside it, so the mark is
    // decorative: an accessible name here would announce the workspace twice
    // in the same row.
    const { container } = shell(STAFF_CAPABILITIES)

    const mark = container.querySelector('.ideas-mark')

    expect(mark).toHaveAttribute('aria-hidden', 'true')
    // Nothing to announce even if the attribute were dropped: four empty
    // spans, no alt text, no label.
    expect(mark).toHaveTextContent('')
    expect(mark!.querySelector('[alt], [aria-label], img')).toBeNull()

    // And the row it sits in still names the workspace exactly once.
    const row = mark!.parentElement!
    expect(within(row).getAllByText('Ideas Flow')).toHaveLength(1)
  })
})

describe('the Administration fold', () => {
  /*
   * Seven rows a person uses on the day they install the system, sitting
   * permanently above the five they use hourly. The fold is what makes the
   * rail scannable again - and what it must never do is hide the screen the
   * person is actually on.
   */

  const toggle = () => screen.getByRole('button', { name: /Administration/ })

  it('starts unfolded, so nothing administrative is hidden by default', () => {
    shell(ADMIN_CAPABILITIES, 'ADMINISTRATOR')

    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(within(mainNav()).getByRole('link', { name: 'Mail' })).toBeInTheDocument()
  })

  it('folds the rows out of the accessibility tree, not merely out of sight', async () => {
    // `hidden`, not opacity or height: a row a sighted person cannot see but
    // a screen-reader user still tabs through is worse than no fold at all.
    const user = userEvent.setup()
    shell(ADMIN_CAPABILITIES, 'ADMINISTRATOR')

    await user.click(toggle())

    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(within(mainNav()).queryByRole('link', { name: 'Mail' })).not.toBeInTheDocument()
    // And the everyday rows are untouched - this folds one group, not the nav.
    expect(within(mainNav()).getByRole('link', { name: /Documents/ })).toBeInTheDocument()
  })

  it('unfolds again on a second press', async () => {
    const user = userEvent.setup()
    shell(ADMIN_CAPABILITIES, 'ADMINISTRATOR')

    await user.click(toggle())
    await user.click(toggle())

    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(within(mainNav()).getByRole('link', { name: 'Mail' })).toBeInTheDocument()
  })

  it('remembers a deliberate fold', () => {
    window.localStorage.setItem('daws-admin-nav', 'closed')
    shell(ADMIN_CAPABILITIES, 'ADMINISTRATOR')

    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
  })

  it('unfolds rather than hide the administration screen just opened', () => {
    /*
     * The fold is a preference; the current location is a fact. Arriving at
     * an administration screen with the group folded would leave the rail
     * claiming nothing is open.
     */
    window.localStorage.setItem('daws-admin-nav', 'closed')
    shell(ADMIN_CAPABILITIES, 'ADMINISTRATOR', '/admin/mail')

    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(within(mainNav()).getByRole('link', { name: 'Mail' })).toBeInTheDocument()
  })

  it('is not offered to somebody with nothing administrative to fold', () => {
    shell(STAFF_CAPABILITIES)

    expect(screen.queryByRole('button', { name: /Administration/ })).not.toBeInTheDocument()
  })
})

describe('Access control, now a tab of People & delegation', () => {
  /*
   * It was a row of its own, immediately below People & delegation and opened
   * by the same capability, so the two never appeared apart: two lines of rail
   * for one subject, the second of them a read-only reference somebody reads
   * while setting a role. It is a tab of that screen now.
   */

  it('is no longer a row of its own', () => {
    shell(ADMIN_CAPABILITIES, 'ADMINISTRATOR')

    expect(
      within(mainNav()).queryByRole('link', { name: 'Access control' })
    ).not.toBeInTheDocument()
  })

  it('keeps the People row lit while the matrix is open', () => {
    // Without this the rail goes dark on `/admin/access-control` and the
    // person reading the matrix has no idea which screen they are inside.
    shell(ADMIN_CAPABILITIES, 'ADMINISTRATOR', '/admin/access-control')

    const row = within(mainNav()).getByRole('link', { name: 'People & delegation' })

    expect(row).toHaveAttribute('aria-current', 'page')
    expect(row).toHaveClass('active')
  })
})

describe('the account menu', () => {
  /*
   * There were two of them: the avatar in the header, and a MoreHorizontal at
   * the foot of the rail, holding the same two items under the same
   * accessible name. Somebody tabbing the page met "Account menu" twice and
   * had no way to know the second one was the first one again.
   *
   * The header's is the one that stayed - it is where every product these
   * people already use keeps it, it survives a narrow screen where the rail
   * is a drawer, and it is the only one on the workflow designer, which hides
   * the rail entirely.
   */

  it('is offered exactly once', () => {
    shell(ADMIN_CAPABILITIES, 'ADMINISTRATOR')

    expect(screen.getAllByRole('button', { name: 'Account menu' })).toHaveLength(1)
  })

  it('holds the way to your own account and the way out', async () => {
    const user = userEvent.setup()
    shell(STAFF_CAPABILITIES)

    await user.click(screen.getByRole('button', { name: 'Account menu' }))
    const menu = screen.getByRole('menu', { name: 'Account' })

    expect(within(menu).getByRole('menuitem', { name: /Your account/ })).toHaveAttribute(
      'href',
      '/account'
    )
    expect(within(menu).getByRole('menuitem', { name: /Sign out/ })).toBeInTheDocument()
  })

  it('leaves the rail still naming the person signed in', () => {
    // The menu went; identity did not. A rail foot with neither is a rail
    // that cannot answer "whose session is this" on a shared machine.
    shell(STAFF_CAPABILITIES)

    expect(screen.getAllByText('Ayesha Khan').length).toBeGreaterThan(0)
    expect(screen.getByText('Available')).toBeInTheDocument()
  })
})

describe('the tabs along the foot of a phone', () => {
  const tabs = () => screen.queryByRole('navigation', { name: 'Quick navigation' })

  it('go to the four daily places, with what is waiting on each', () => {
    counts.pending = 4
    counts.unread = 3
    shell([])
    const nav = tabs()!
    expect(within(nav).getAllByRole('link').map(link => link.textContent)).toEqual([
      expect.stringContaining('Documents'),
      expect.stringContaining('My queue'),
      expect.stringContaining('Submit'),
      expect.stringContaining('Inbox'),
    ])
    expect(within(nav).getByRole('link', { name: 'My queue, 4 waiting on you' })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Inbox, 3 unread' })).toBeInTheDocument()
  })

  it('stay off a memo and the submit form, whose own buttons hold the foot', () => {
    shell([], 'USER', '/documents/abc')
    expect(tabs()).not.toBeInTheDocument()
  })

  it('stay off the submit form too', () => {
    shell([], 'USER', '/submit-document')
    expect(tabs()).not.toBeInTheDocument()
  })
})
