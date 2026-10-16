import { screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAccessControl, fetchUsers, type AccessControlMatrix } from '../services/AdminApi'
import type { User } from '../types/admin'
import { makeUser, renderWithProviders } from '../test/render'
import AccessControlPage from './AccessControlPage'

/**
 * The screen that says what a role buys.
 *
 * The risk it carries is specific: it is a page people will quote when
 * deciding who to make an administrator, so the one thing it must never do is
 * describe a rule of its own. Every assertion below is about it reciting the
 * server rather than knowing anything.
 */

vi.mock('../services/AdminApi', () => ({
  fetchAccessControl: vi.fn(),
  fetchUsers: vi.fn(),
  setAdminPowers: vi.fn(),
  transferSuperAdmin: vi.fn(),
}))

const read = vi.mocked(fetchAccessControl)
const people = vi.mocked(fetchUsers)

const person = (overrides: Partial<User>): User =>
  ({
    id: 'u-x',
    email: 'x@example.com',
    firstName: 'X',
    lastName: 'Person',
    designation: null,
    loginRole: 'ADMINISTRATOR',
    isSuperAdmin: false,
    adminPowers: [],
    department: null,
    openApprovals: 0,
    deactivatedAt: null,
    coveredBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }) as User

const matrix = (overrides: Partial<AccessControlMatrix> = {}): AccessControlMatrix => ({
  roles: ['ADMINISTRATOR', 'USER'],
  capabilities: [
    {
      id: 'memos.prepare',
      group: 'Memos',
      title: 'Prepare and submit memos',
      detail: 'Create a memo, attach files, choose its chain and submit it.',
      roles: ['ADMINISTRATOR', 'USER'],
    },
    {
      id: 'mail.configure',
      group: 'Administration',
      title: 'Configure mail',
      detail: 'Choose the provider, hold the credentials and send a test.',
      roles: ['ADMINISTRATOR'],
    },
  ],
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  read.mockResolvedValue(matrix())
  people.mockResolvedValue([])
})

const asAdmin = () =>
  renderWithProviders(<AccessControlPage />, {
    currentUser: { user: makeUser({ role: 'ADMINISTRATOR' }) },
  })

describe('the matrix', () => {
  it('groups capabilities the way the server groups them', async () => {
    asAdmin()

    expect(await screen.findByRole('heading', { name: 'Memos' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Administration' })).toBeInTheDocument()
  })

  it('shows the limits, not only the name', async () => {
    // The detail is the half that matters when somebody is deciding: the name
    // says "see memos assigned to them", the detail says when.
    asAdmin()

    expect(
      await screen.findByText('Choose the provider, hold the credentials and send a test.')
    ).toBeInTheDocument()
  })

  it('never says yes or no by colour alone', async () => {
    asAdmin()

    const row = (await screen.findByText('Configure mail')).closest('tr')
    expect(row).not.toBeNull()
    // A word in the cell, and a sentence for a screen reader naming the role.
    expect(within(row!).getByText('Administrator: can configure mail')).toBeInTheDocument()
    expect(within(row!).getByText('Staff: cannot configure mail')).toBeInTheDocument()
  })

  it('renders a column for every role the server sends', async () => {
    // A role added to the schema and forgotten in the matrix must appear as a
    // visibly empty column, not silently vanish.
    read.mockResolvedValue(matrix({ roles: ['ADMINISTRATOR', 'USER', 'AUDITOR'] }))
    asAdmin()

    expect(await screen.findAllByText('AUDITOR')).not.toHaveLength(0)
  })

  it('says reviewer and approver are positions on a memo, not roles', async () => {
    /*
     * The question that prompted this screen. Someone looking for a "Reviewer"
     * role has to find out here that there is not one, and why - otherwise the
     * absence reads as something missing rather than as the design.
     */
    asAdmin()

    expect(
      await screen.findByRole('heading', { name: /not system roles/i })
    ).toBeInTheDocument()
    expect(screen.getByText(/reached their step/i)).toBeInTheDocument()
  })

  it('reports a refusal rather than showing an empty matrix', async () => {
    read.mockRejectedValue(new Error('Admin access required'))
    asAdmin()

    expect(await screen.findByRole('alert')).toHaveTextContent('Admin access required')
  })
})

describe('where it sits', () => {
  it('offers the way back to the people it describes', async () => {
    /*
     * This is the half of one screen that says what a role buys; the other
     * half is where a role is actually set. It used to be a separate row in
     * the sidebar, so the two were a navigation away from each other while
     * being read together.
     */
    asAdmin()

    const tabs = await screen.findByRole('navigation', { name: 'People sections' })

    expect(
      within(tabs).getByRole('link', { name: 'People & delegation' })
    ).toHaveAttribute('href', '/admin/people')
    expect(within(tabs).getByRole('link', { name: 'Access control' })).toBeInTheDocument()
  })
})

describe('administrators and their rights', () => {
  it('shows the Super Administrator the transfer, and every other administrator with what they may do', async () => {
    people.mockResolvedValue([
      person({ id: 'u-lina', firstName: 'Lina', adminPowers: ['users.manage', 'workflows.manage:view'] }),
      person({ id: 'u-omar', firstName: 'Omar', loginRole: 'USER' }),
    ])
    asAdmin()

    expect(await screen.findByRole('button', { name: 'Transfer…' })).toBeInTheDocument()
    expect(await screen.findByText('1 to change · 1 to see only')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit rights for Lina Person' })).toBeInTheDocument()
    // Staff are not administrators, so they have no rights to edit here.
    expect(screen.queryByRole('button', { name: /Edit rights for Omar/ })).not.toBeInTheDocument()
  })

  it('says so when more than one Super Administrator is left from before', async () => {
    people.mockResolvedValue([
      person({ id: 'test-user', isSuperAdmin: true }),
      person({ id: 'u-xena', firstName: 'Xena', isSuperAdmin: true }),
    ])
    renderWithProviders(<AccessControlPage />, {
      currentUser: { user: makeUser({ id: 'test-user', role: 'ADMINISTRATOR' }) },
    })

    expect(await screen.findByText(/2 people are Super Administrators/)).toBeInTheDocument()
    expect(screen.getByText(/Also a Super Administrator/)).toBeInTheDocument()
  })

  it('shows any other administrator only their own rights, and no transfer', async () => {
    renderWithProviders(<AccessControlPage />, {
      currentUser: {
        user: makeUser({
          role: 'ADMINISTRATOR',
          isSuperAdmin: false,
          capabilities: ['memos.prepare', 'users.manage'],
          viewOnly: ['mail.configure'],
        }),
      },
    })

    expect(await screen.findByText('Your rights as an administrator')).toBeInTheDocument()
    expect(screen.getByText(/Configure mail/, { selector: 'p' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Transfer…' })).not.toBeInTheDocument()
    expect(people).not.toHaveBeenCalled()
  })
})
