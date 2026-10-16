import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAccessControl, setAdminPowers } from '../../services/AdminApi'
import type { User } from '../../types/admin'
import AdminPowersDialog from './AdminPowersDialog'

/**
 * The Super Administrator choosing what another administrator may do. Least
 * privilege: only the rights chosen, an area can be given to see but not
 * change, and the Super Administrator's own powers are named but never given.
 */

vi.mock('../../services/AdminApi', () => ({
  fetchAccessControl: vi.fn(),
  setAdminPowers: vi.fn(),
}))

const matrix = vi.mocked(fetchAccessControl)
const save = vi.mocked(setAdminPowers)

const LINA: User = {
  id: 'u-lina',
  email: 'lina@example.com',
  firstName: 'Lina',
  lastName: 'Hasan',
  designation: null,
  loginRole: 'ADMINISTRATOR',
  isSuperAdmin: false,
  adminPowers: ['approvals.oversee'],
  department: { id: 'dep-1', name: 'Finance' },
  openApprovals: 0,
  deactivatedAt: null,
  coveredBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as User

beforeEach(() => {
  vi.clearAllMocks()
  matrix.mockResolvedValue({
    roles: ['ADMINISTRATOR', 'USER'],
    capabilities: [
      { id: 'approvals.oversee', group: 'Oversight', title: 'See everything in flight', detail: '', roles: ['ADMINISTRATOR'], grantable: true, byDefault: true },
      { id: 'users.manage', group: 'Administration', title: 'Manage people', detail: '', roles: ['ADMINISTRATOR'], grantable: true, viewable: true },
      { id: 'sso.configure', group: 'Administration', title: 'Configure single sign-on', detail: '', roles: ['ADMINISTRATOR'], superAdminOnly: true },
    ],
  } as never)
  save.mockResolvedValue({ id: 'u-lina', isSuperAdmin: false, adminPowers: [] })
})

const dialog = () =>
  render(<AdminPowersDialog person={LINA} onClose={vi.fn()} onDone={vi.fn()} />)

const radio = (power: RegExp, level: string) =>
  within(screen.getByRole('radiogroup', { name: power })).getByLabelText(level)

describe("setting an administrator's rights", () => {
  it('shows what they hold, and sends exactly the rights chosen', async () => {
    const user = userEvent.setup()
    dialog()

    await screen.findByRole('radiogroup', { name: /See everything in flight/ })
    expect(radio(/See everything in flight/, 'Yes')).toBeChecked()
    await user.click(radio(/Manage people/, 'See and change'))
    await user.click(screen.getByRole('button', { name: 'Save rights' }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('u-lina', {
        isSuperAdmin: false,
        powers: ['approvals.oversee', 'users.manage'],
      }),
    )
  })

  it('gives an area to see but not change', async () => {
    const user = userEvent.setup()
    dialog()

    await user.click(await screen.findByLabelText('See only', { selector: 'input' }))
    await user.click(screen.getByRole('button', { name: 'Save rights' }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('u-lina', {
        isSuperAdmin: false,
        powers: ['approvals.oversee', 'users.manage:view'],
      }),
    )
  })

  it('sets every right at once from a preset', async () => {
    const user = userEvent.setup()
    dialog()

    await user.click(await screen.findByRole('button', { name: 'See only' }))
    await user.click(screen.getByRole('button', { name: 'Save rights' }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('u-lina', {
        isSuperAdmin: false,
        powers: ['approvals.oversee', 'users.manage:view'],
      }),
    )
  })

  it("names the Super Administrator's own powers, but offers no choice for them", async () => {
    dialog()

    expect(await screen.findByText(/configure single sign-on/)).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: /Configure single sign-on/ })).not.toBeInTheDocument()
  })

  it('never offers to make another Super Administrator - that is a transfer', async () => {
    dialog()

    await screen.findByRole('radiogroup', { name: /Manage people/ })
    expect(screen.queryByRole('switch', { name: /Super Administrator/ })).not.toBeInTheDocument()
  })

  it('makes an extra Super Administrator, left from before, limited', async () => {
    const user = userEvent.setup()
    render(
      <AdminPowersDialog
        person={{ ...LINA, isSuperAdmin: true, adminPowers: [] }}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Save rights' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Make limited' }))
    await user.click(await screen.findByRole('button', { name: 'See only' }))
    await user.click(screen.getByRole('button', { name: 'Save rights' }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('u-lina', {
        isSuperAdmin: false,
        powers: ['approvals.oversee', 'users.manage:view'],
      }),
    )
  })

  it('keeps the dialog open and says why when the server refuses', async () => {
    const user = userEvent.setup()
    save.mockRejectedValue(new Error('You cannot change your own powers.'))
    dialog()

    await screen.findByRole('radiogroup', { name: /Manage people/ })
    await user.click(screen.getByRole('button', { name: 'Save rights' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('You cannot change your own powers.')
  })
})
