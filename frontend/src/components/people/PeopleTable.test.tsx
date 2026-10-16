import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '../../types/admin'
import PeopleTable from './PeopleTable'

/**
 * The roster an administrator works from. Two things on it can do real harm
 * if they are wrong: the role column, which is the only place anybody can see
 * who can reach the admin screens, and the row menu, whose last entry removes
 * a person from the organisation for good.
 *
 * The table itself deletes nobody - it hands the person up to the page, which
 * opens a confirmation. That division is the safety mechanism, so the tests
 * below pin both halves of it: the menu asks, and it asks about the row it
 * was opened on rather than the first one.
 *
 * `FEATURES` is mocked so the column set is decided here rather than by
 * whichever mode the suite happens to run in. The real defaults are
 * delegation on while building, approver load off.
 */

const features = vi.hoisted(() => ({ delegation: true, approverLoad: false }))
vi.mock('../../config/features', () => ({ FEATURES: features }))

function person(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    email: 'priya.nair@example.com',
    firstName: 'Priya',
    lastName: 'Nair',
    designation: null,
    loginRole: 'USER',
    department: { id: 'dep-1', name: 'Procurement' },
    openApprovals: 0,
    deactivatedAt: null,
    coveredBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function renderTable({
  users = [person()],
  loading = false,
  loadError = '',
  search = '',
  selectedId = null,
  currentUserId = null,
  onSetPowers,
}: {
  users?: User[]
  loading?: boolean
  loadError?: string
  search?: string
  selectedId?: string | null
  currentUserId?: string | null
  onSetPowers?: (user: User) => void
} = {}) {
  const onSelect = vi.fn()
  const onEdit = vi.fn()
  const onResetTwoFactor = vi.fn()
  const onSetActive = vi.fn()

  return {
    // A router, because your own row links to the account screen where
    // two-step is turned on.
    ...render(
      <MemoryRouter>
        <PeopleTable
          users={users}
          loading={loading}
          loadError={loadError}
          search={search}
          selectedId={selectedId}
          currentUserId={currentUserId}
          onSelect={onSelect}
          onEdit={onEdit}
          onResetTwoFactor={onResetTwoFactor}
          onSetActive={onSetActive}
          onSetPowers={onSetPowers}
        />
      </MemoryRouter>,
    ),
    onSelect,
    onEdit,
    onSetActive,
  }
}

/**
 * The cell under a named column, in the first person's row.
 *
 * Positional indexes used to be written out here, and a column inserted
 * before Queue moved the answer one to the left while the test went on
 * asserting about whatever had taken its place. Finding the column by its
 * heading is what a person does, and it is not the component agreeing with
 * itself: the heading text is the claim.
 */
function cellUnder(columnName: string) {
  const index = screen
    .getAllByRole('columnheader')
    .findIndex(header => header.textContent?.trim() === columnName)
  if (index < 0) throw new Error(`No column headed "${columnName}"`)
  return within(screen.getAllByRole('row')[1]).getAllByRole('cell')[index]
}

/** Opens the overflow menu on a named row and returns it. */
async function openMenuFor(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: `Actions for ${name}` }))
  return screen.getByRole('menu', { name: `Actions for ${name}` })
}

beforeEach(() => {
  features.delegation = true
  features.approverLoad = false
})

describe('what a row says about a person', () => {
  it('names them and shows the address they sign in with', () => {
    renderTable()

    expect(screen.getByText('Priya Nair')).toBeInTheDocument()
    expect(screen.getByText('priya.nair@example.com')).toBeInTheDocument()
  })

  it('states the system role in words, not only as a coloured pill', () => {
    renderTable({
      users: [
        person({ id: 'u1', loginRole: 'ADMINISTRATOR' }),
        person({ id: 'u2', firstName: 'Tom', lastName: 'Becker', loginRole: 'USER' }),
      ],
    })

    // This column is the only view anybody has of who can open the admin
    // screens. A tint alone tells a colour-blind reader nothing, and tells
    // a screen reader less than that.
    expect(screen.getByText('Administrator')).toBeInTheDocument()
    expect(screen.getByText('User')).toBeInTheDocument()
  })

  it('shows a role it has no label for rather than an empty pill', () => {
    renderTable({ users: [person({ loginRole: 'REVIEWER' })] })

    // An empty pill would read as "no permissions at all", which is the one
    // thing an unrecognised role definitely does not mean.
    expect(screen.getByText('REVIEWER')).toBeInTheDocument()
  })

  it('shows an em dash for a person with no department', () => {
    renderTable({
      users: [person({ department: undefined as unknown as User['department'] })],
    })

    // In the department cell specifically. A bare `getByText('—')` would be
    // satisfied by the dash in any other column - the Queue cell prints one
    // too - and would keep passing over a department cell left blank.
    const [, departmentCell] = within(screen.getAllByRole('row')[1]).getAllByRole('cell')
    expect(departmentCell).toHaveTextContent('—')
  })

  it('describes the table to a screen reader before the first row', () => {
    renderTable()

    // As the table's own accessible name: a caption that has drifted out of
    // the table into a heading above it still answers `getByText` while
    // telling a screen reader on the first row nothing.
    expect(
      screen.getByRole('table', {
        name: /People in this organisation, with department, system role/,
      }),
    ).toBeInTheDocument()
  })
})

describe('the four states of the list', () => {
  it('shows no rows and passes no verdict while people are still loading', () => {
    renderTable({ users: [], loading: true })

    // The skeleton rows are aria-hidden, so only the header is exposed. What
    // matters is that "No people yet" does not flash first: an administrator
    // who saw it would think the import had failed.
    expect(screen.getAllByRole('row')).toHaveLength(1)
    expect(screen.queryByText(/No people yet/)).not.toBeInTheDocument()
  })

  it('shows the error it was handed, and what to do about it', () => {
    renderTable({ users: [], loadError: 'Failed to load users' })

    expect(screen.getByText('Failed to load users')).toBeInTheDocument()
    expect(screen.getByText('Reload the page to try again.')).toBeInTheDocument()
  })

  it('does not claim the organisation is empty when the load failed', () => {
    renderTable({ users: [], loadError: 'Failed to load users' })

    // "No people yet. Add one to get started." over a failed request invites
    // an administrator to re-create people who already exist.
    expect(screen.queryByText(/No people yet/)).not.toBeInTheDocument()
  })

  it('says the search matched nothing, quoting what was searched for', () => {
    renderTable({ users: [], search: 'zafar' })

    // Distinguishes "there is no Zafar" from "there is nobody at all" -
    // without the term echoed back, a typo looks like an empty directory.
    expect(screen.getByText('Nobody matches “zafar”.')).toBeInTheDocument()
  })

  it('says the directory is empty and what to do next when nothing is searched', () => {
    renderTable({ users: [], search: '' })

    expect(screen.getByText('No people yet. Add one to get started.')).toBeInTheDocument()
  })

  it('stretches the empty message across exactly the columns it renders', () => {
    // Pinned to literals rather than to `columnheader.length`. Both numbers
    // come from the same `columnCount`, so comparing them to each other is
    // the component agreeing with itself: drop a column from the header row
    // and the count it is measured against drops with it.
    const first = renderTable({ users: [], search: '' })
    expect(screen.getAllByRole('columnheader')).toHaveLength(6)
    expect(screen.getByRole('cell')).toHaveAttribute('colspan', '6')
    first.unmount()

    // The column set moves with the feature flags. A colSpan that did not
    // move with it leaves the message wedged under one column with a run of
    // empty cells beside it, which reads as a half-loaded row.
    features.approverLoad = true
    renderTable({ users: [], search: '' })
    expect(screen.getAllByRole('columnheader')).toHaveLength(7)
    expect(screen.getByRole('cell')).toHaveAttribute('colspan', '7')
  })
})

describe('the destructive row action', () => {
  it('keeps every row action behind one trigger named for that person', async () => {
    const user = userEvent.setup({ delay: null })
    renderTable({
      users: [
        person({ id: 'u1', firstName: 'Priya', lastName: 'Nair' }),
        person({ id: 'u2', firstName: 'Tom', lastName: 'Becker' }),
      ],
    })

    // Two identical 24px squares in a column. Without the name in the label,
    // nothing tells a screen reader which row a menu belongs to - and the
    // last entry in it deletes somebody.
    const tom = screen.getByRole('button', { name: 'Actions for Tom Becker' })
    expect(screen.getByRole('button', { name: 'Actions for Priya Nair' })).toBeInTheDocument()
    expect(tom).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    // The trigger has to say whether the menu it controls is open. Without
    // it a screen reader user presses the button and is told nothing
    // happened, then presses it again and closes what they just opened.
    expect(tom).toHaveAttribute('aria-expanded', 'false')

    await openMenuFor(user, 'Tom Becker')
    expect(screen.getByRole('menu', { name: 'Actions for Tom Becker' })).toBeInTheDocument()
    expect(tom).toHaveAttribute('aria-expanded', 'true')
  })

  it('opens one menu at a time, so no stale menu hangs over another row', async () => {
    const user = userEvent.setup({ delay: null })
    renderTable({
      users: [
        person({ id: 'u1', firstName: 'Priya', lastName: 'Nair' }),
        person({ id: 'u2', firstName: 'Tom', lastName: 'Becker' }),
      ],
    })

    await openMenuFor(user, 'Priya Nair')
    await user.click(screen.getByRole('button', { name: 'Actions for Tom Becker' }))

    // Two overlapping menus put two "Switch account off" entries on screen,
    // one of them belonging to a row the pointer is nowhere near.
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.getByRole('menu')).toHaveAccessibleName('Actions for Tom Becker')
    expect(
      screen.getByRole('button', { name: 'Actions for Priya Nair' }),
    ).toHaveAttribute('aria-expanded', 'false')
  })

  it('offers no way to delete a person, because switching off is the removal', async () => {
    const user = userEvent.setup({ delay: null })
    renderTable()

    const menu = await openMenuFor(user, 'Priya Nair')
    // Deleting a person broke the audit ledger, so the entry is gone and the
    // server has no route for it. Everything the menu offers, in order:
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Set delegation',
      'Edit details',
      'Switch account off',
    ])
  })

  it('closes the menu once an action is chosen, so the row is visible again', async () => {
    const user = userEvent.setup({ delay: null })
    const { onEdit } = renderTable()

    const menu = await openMenuFor(user, 'Priya Nair')
    await user.click(within(menu).getByRole('menuitem', { name: 'Edit details' }))

    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('dismisses the menu on Escape and puts focus back on the trigger', async () => {
    const user = userEvent.setup({ delay: null })
    renderTable()
    const trigger = screen.getByRole('button', { name: 'Actions for Priya Nair' })

    await user.click(trigger)
    await user.keyboard('{Escape}')

    // Focus left on a closed menu strands a keyboard user at the end of the
    // document, several tab stops from the row they were working on.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})

describe('picking the person the delegation panel shows', () => {
  it('asks the page to select the person whose name was clicked', async () => {
    const user = userEvent.setup({ delay: null })
    const people = [
      person({ id: 'u1', firstName: 'Priya', lastName: 'Nair' }),
      person({ id: 'u2', firstName: 'Tom', lastName: 'Becker' }),
    ]
    const { onSelect } = renderTable({ users: people })

    // `^` matters: "Actions for Tom Becker" is a button on the same row.
    await user.click(screen.getByRole('button', { name: /^Tom Becker/ }))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(people[1])
  })

  it('marks the selected row as pressed, so the tint is not the only signal', () => {
    renderTable({
      users: [
        person({ id: 'u1', firstName: 'Priya', lastName: 'Nair' }),
        person({ id: 'u2', firstName: 'Tom', lastName: 'Becker' }),
      ],
      selectedId: 'u2',
    })

    // Which person the delegation panel is editing is a fact worth being
    // certain of before handing their approvals to somebody else. A pale
    // background says it to sighted mouse users and to nobody else.
    expect(screen.getByRole('button', { name: /^Tom Becker/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: /^Priya Nair/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('opens the delegation panel from the row menu as well as the name', async () => {
    const user = userEvent.setup({ delay: null })
    const people = [
      person({ id: 'u1', firstName: 'Priya', lastName: 'Nair' }),
      person({ id: 'u2', firstName: 'Tom', lastName: 'Becker' }),
    ]
    const { onSelect, onEdit } = renderTable({ users: people })

    const menu = await openMenuFor(user, 'Tom Becker')
    await user.click(within(menu).getByRole('menuitem', { name: 'Set delegation' }))

    // Which person, not merely that something was called: the panel this
    // opens is where one person's approvals are handed to another, and the
    // menu entry two rows down looks exactly the same as this one.
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(people[1])
    expect(onEdit).not.toHaveBeenCalled()
    // And the menu is out of the way, rather than covering the row the panel
    // is now describing.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('drops the delegation column and its menu entry when the feature is off', async () => {
    features.delegation = false
    const user = userEvent.setup({ delay: null })
    renderTable()

    expect(
      screen.queryByRole('columnheader', { name: 'Availability' }),
    ).not.toBeInTheDocument()
    // With no delegation panel there is nothing for a selection to drive, so
    // the row button drops `aria-pressed` — see the defect report: the row
    // tint then becomes the only trace of the selection.
    expect(screen.getByRole('button', { name: /^Priya Nair/ })).not.toHaveAttribute(
      'aria-pressed',
    )

    const menu = await openMenuFor(user, 'Priya Nair')
    expect(within(menu).queryByRole('menuitem', { name: 'Set delegation' })).not.toBeInTheDocument()
    // Still editable and still switchable off - turning delegation off must
    // not take the rest of the row menu with it.
    expect(within(menu).getByRole('menuitem', { name: 'Edit details' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Switch account off' })).toBeInTheDocument()
  })
})

describe('the columns about where a person is', () => {
  it('says who is covering, rather than that everybody is at their desk', () => {
    renderTable({
      users: [
        person({
          coveredBy: {
            id: 'u9',
            firstName: 'Tom',
            lastName: 'Becker',
            endsAt: '2026-09-30T23:59:59.999Z',
          },
        }),
      ],
    })

    expect(screen.getByRole('columnheader', { name: 'Availability' })).toBeInTheDocument()
    // The name matters more than the state: "Away" tells an administrator to
    // go and find out who is signing; this tells them.
    expect(screen.getByText('Covered by Tom')).toBeInTheDocument()
    expect(screen.getByText('Covered by Tom').getAttribute('title')).toMatch(
      /Approvals go to Tom Becker until/,
    )
  })

  it('says available when nobody is covering for them', () => {
    renderTable()

    expect(screen.getByText('Available')).toBeInTheDocument()
    expect(screen.queryByText(/Covered by/)).not.toBeInTheDocument()
  })

  it('shows how many approvals are actually waiting on each person', () => {
    features.approverLoad = true
    renderTable({ users: [person({ openApprovals: 4 })] })

    // Counted by the server over every document, for a screen only
    // administrators can open - not derived from what the signed-in user can
    // see, which under-reports everybody else.
    expect(screen.getByRole('columnheader', { name: 'Queue' })).toBeInTheDocument()

    const queueCell = cellUnder('Queue')
    expect(queueCell).toHaveTextContent('4')
    expect(queueCell.textContent).not.toMatch(/—/)
  })

  it('shows a zero as a zero, not as an em dash', () => {
    features.approverLoad = true
    renderTable()

    // "Nothing waiting" and "we do not know" are different answers, and a
    // dash for the first one is what makes the column unreadable.
    const queueCell = cellUnder('Queue')
    expect(queueCell).toHaveTextContent('0')
  })
})

describe('the two-step column', () => {
  /*
   * The server has answered this for every person since two-step shipped, and
   * the screen used it only to decide whether a row menu carried a "Turn off"
   * item. So the one screen that could say who is protected did not, and the
   * way to find out was to open every menu in turn.
   */

  const row = (name: string) => screen.getByRole('row', { name: new RegExp(name) })

  it('says whether each person signs in with a code, in words', () => {
    renderTable({
      users: [
        person({ id: 'u1', firstName: 'Priya', twoFactorEnabled: true }),
        person({ id: 'u2', firstName: 'Omar', twoFactorEnabled: false }),
      ],
    })

    expect(within(row('Priya')).getByText('On')).toBeInTheDocument()
    expect(within(row('Omar')).getByText('Off')).toBeInTheDocument()
  })

  it('tells a screen reader what the word means, not just "Off"', () => {
    // "Off" alone, read out of a cell, is a word with no subject.
    renderTable({
      users: [person({ id: 'u2', firstName: 'Omar', twoFactorEnabled: false })],
    })

    expect(screen.getByText('Two-step sign-in is off')).toBeInTheDocument()
  })

  it('names the risk on an administrator who has not turned it on', () => {
    renderTable({
      users: [
        person({ id: 'u3', firstName: 'Ayesha', loginRole: 'ADMINISTRATOR', twoFactorEnabled: false }),
      ],
    })

    expect(
      screen.getByText('Two-step sign-in is off for an administrator')
    ).toBeInTheDocument()
  })

  it('offers the way to turn it on only on your own row', () => {
    /*
     * Enrolment needs the phone in somebody's hand, so an administrator
     * cannot do this for anybody else - a link on their row would be a dead
     * end. On your own row it is the answer to "where is the 2FA setting".
     */
    renderTable({
      users: [
        person({ id: 'mine', firstName: 'Priya', twoFactorEnabled: false }),
        person({ id: 'theirs', firstName: 'Omar', twoFactorEnabled: false }),
      ],
      currentUserId: 'mine',
    })

    const offered = screen.getAllByRole('link', { name: 'Turn on' })
    expect(offered).toHaveLength(1)
    expect(offered[0]).toHaveAttribute('href', '/account')
    expect(within(row('Priya')).getByRole('link', { name: 'Turn on' })).toBeInTheDocument()
  })

  it('offers nothing on your own row once two-step is on', () => {
    renderTable({
      users: [person({ id: 'mine', firstName: 'Priya', twoFactorEnabled: true })],
      currentUserId: 'mine',
    })

    expect(screen.queryByRole('link', { name: 'Turn on' })).not.toBeInTheDocument()
  })
})

/**
 * Switching an account off when somebody leaves.
 *
 * The row has to say which state the account is in, and the menu has to offer
 * the way out of it - because switching off is the only way to remove
 * somebody. There is no "Delete person": deleting a row broke the audit
 * ledger, and switching off does everything deleting did.
 */
describe('an account that has been switched off', () => {
  it('says so in a word, not only in a tint', () => {
    // The one state on the row that means the person cannot get in at all, so
    // it has to survive being read by somebody who cannot separate colours.
    renderTable({
      users: [person({ firstName: 'Priya', deactivatedAt: '2026-09-01T00:00:00.000Z' })],
    })

    expect(screen.getByText('Switched off')).toBeInTheDocument()
    expect(screen.queryByText('Available')).not.toBeInTheDocument()
  })

  it('reads as available while the account is in use', () => {
    renderTable({ users: [person({ firstName: 'Priya' })] })

    expect(screen.getByText('Available')).toBeInTheDocument()
    expect(screen.queryByText('Switched off')).not.toBeInTheDocument()
  })

  it('offers to switch it off, and asks the page to confirm', async () => {
    const user = userEvent.setup()
    const { onSetActive } = renderTable({ users: [person({ firstName: 'Priya' })] })

    await openMenuFor(user, 'Priya Nair')
    await user.click(screen.getByRole('menuitem', { name: 'Switch account off' }))

    expect(onSetActive).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Priya' }),
      false,
    )
  })

  it('offers to switch it back on once it is off', async () => {
    const user = userEvent.setup()
    const { onSetActive } = renderTable({
      users: [person({ firstName: 'Priya', deactivatedAt: '2026-09-01T00:00:00.000Z' })],
    })

    await openMenuFor(user, 'Priya Nair')
    await user.click(screen.getByRole('menuitem', { name: 'Switch account back on' }))

    expect(onSetActive).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Priya' }),
      true,
    )
  })

  it('never offers both at once, which would be two answers to one question', async () => {
    const user = userEvent.setup()
    renderTable({ users: [person({ firstName: 'Priya' })] })

    await openMenuFor(user, 'Priya Nair')

    expect(
      screen.queryByRole('menuitem', { name: 'Switch account back on' }),
    ).not.toBeInTheDocument()
  })
})

describe('the two tiers of administrator', () => {
  const admin = (overrides: Partial<User> = {}) =>
    person({ id: 'u-admin', firstName: 'Lina', lastName: 'Hasan', loginRole: 'ADMINISTRATOR', ...overrides })

  it('names a Super Administrator as such', () => {
    renderTable({ users: [admin({ isSuperAdmin: true })] })
    expect(screen.getByText('Super Administrator')).toBeInTheDocument()
  })

  it("offers a Super Administrator the way to set another administrator's powers", async () => {
    const user = userEvent.setup({ delay: null })
    const onSetPowers = vi.fn()
    renderTable({ users: [admin()], onSetPowers })

    const menu = await openMenuFor(user, 'Lina Hasan')
    await user.click(within(menu).getByRole('menuitem', { name: 'Set powers' }))

    expect(onSetPowers).toHaveBeenCalledWith(expect.objectContaining({ id: 'u-admin' }))
  })

  it('never offers it on your own row, or to somebody who is not a Super Administrator', async () => {
    const user = userEvent.setup({ delay: null })
    renderTable({ users: [admin()], onSetPowers: vi.fn(), currentUserId: 'u-admin' })
    let menu = await openMenuFor(user, 'Lina Hasan')
    expect(within(menu).queryByRole('menuitem', { name: 'Set powers' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')

    cleanup()
    renderTable({ users: [admin()] })
    menu = await openMenuFor(user, 'Lina Hasan')
    expect(within(menu).queryByRole('menuitem', { name: 'Set powers' })).not.toBeInTheDocument()
  })
})
