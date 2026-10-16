import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchAdministrationActivity,
  type AdministrationActivity,
  type AdministrationEntry,
} from '../services/auditApi'
import { renderWithProviders } from '../test/render'
import ChangeHistoryPage from './ChangeHistoryPage'

/**
 * The screen that made the administration trail readable.
 *
 * The rows were always being written; what was missing was any way to see
 * them. So what these hold is the difference between showing the trail and
 * appearing to: that the count says how much matched rather than how much
 * came back, that a filter narrows without silently widening, and that a
 * failure to read it says so instead of rendering as an empty trail - which
 * on this screen would be a claim that nothing has ever been changed.
 */

vi.mock('../services/auditApi', () => ({
  fetchAdministrationActivity: vi.fn(),
}))

const read = vi.mocked(fetchAdministrationActivity)

const entry = (overrides: Partial<AdministrationEntry> = {}): AdministrationEntry => ({
  id: 'a1',
  at: '2026-09-15T09:30:00.000Z',
  actor: { id: 'u1', firstName: 'Ayesha', lastName: 'Khan' },
  action: 'USER_CREATED',
  area: 'People',
  entityType: 'User',
  entityId: 'u2',
  subject: 'bilal@example.com',
  changes: [{ field: 'email', from: null, to: 'bilal@example.com' }],
  ipAddress: '203.0.113.7',
  ...overrides,
})

const answer = (
  overrides: Partial<AdministrationActivity> = {},
): AdministrationActivity => ({
  entries: [entry()],
  total: 1,
  returned: 1,
  areas: ['Configuration', 'Departments', 'People', 'Workflows'],
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  read.mockResolvedValue(answer())
})

describe('what it shows', () => {
  it('lists what was changed', async () => {
    renderWithProviders(<ChangeHistoryPage />)

    expect(await screen.findByText('User created')).toBeInTheDocument()
    expect(screen.getByText('Ayesha Khan')).toBeInTheDocument()
  })

  it('says how much matched, not merely how much it drew', async () => {
    // A page that counts its own rows and calls that the total is the one
    // thing a ledger screen must never do: an action that WAS recorded then
    // reads as one that never happened.
    read.mockResolvedValue(answer({ total: 214, returned: 50 }))
    renderWithProviders(<ChangeHistoryPage />)

    expect(await screen.findByText('Showing 50 of 214 changes')).toBeInTheDocument()
  })

  it('tells the reader the values it withholds, so silence is not mistaken for absence', async () => {
    renderWithProviders(<ChangeHistoryPage />)

    expect(
      await screen.findByText(/a credential is recorded as having changed/i),
    ).toBeInTheDocument()
  })
})

describe('narrowing it', () => {
  it('asks the server for one area, and says which is chosen', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ChangeHistoryPage />)
    await screen.findByText('User created')

    await user.click(screen.getByRole('button', { name: 'Departments' }))

    await waitFor(() =>
      expect(read).toHaveBeenLastCalledWith(
        expect.objectContaining({ area: 'Departments' }),
      ),
    )
    expect(screen.getByRole('button', { name: 'Departments' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('draws the filter from the answer, so a new area needs no edit here', async () => {
    read.mockResolvedValue(answer({ areas: ['People', 'Something New'] }))
    renderWithProviders(<ChangeHistoryPage />)

    expect(await screen.findByRole('button', { name: 'Something New' })).toBeInTheDocument()
  })

  it('goes back to the first page when the area changes', async () => {
    // Otherwise choosing a filter while on page 4 asks for rows 150-200 of a
    // set that may have twelve, and answers with an empty screen.
    const user = userEvent.setup()
    read.mockResolvedValue(answer({ total: 500, returned: 50 }))
    renderWithProviders(<ChangeHistoryPage />)
    await screen.findByText('User created')

    await user.click(screen.getByRole('button', { name: 'Older' }))
    await waitFor(() =>
      expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 })),
    )

    await user.click(screen.getByRole('button', { name: 'People' }))

    await waitFor(() =>
      expect(read).toHaveBeenLastCalledWith(
        expect.objectContaining({ offset: 0, area: 'People' }),
      ),
    )
  })

  it('says so when an area has nothing in it, rather than showing a blank card', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ChangeHistoryPage />)
    await screen.findByText('User created')

    read.mockResolvedValue(answer({ entries: [], total: 0, returned: 0 }))
    await user.click(screen.getByRole('button', { name: 'Workflows' }))

    expect(
      await screen.findByText('Nothing recorded under Workflows'),
    ).toBeInTheDocument()
  })
})

describe('paging', () => {
  it('will not go back past the first page', async () => {
    renderWithProviders(<ChangeHistoryPage />)

    expect(await screen.findByRole('button', { name: 'Newer' })).toBeDisabled()
  })

  it('stops offering older once everything that matched is on screen', async () => {
    renderWithProviders(<ChangeHistoryPage />)

    expect(await screen.findByRole('button', { name: 'Older' })).toBeDisabled()
  })

  it('offers older while there is more behind', async () => {
    read.mockResolvedValue(answer({ total: 120, returned: 50 }))
    renderWithProviders(<ChangeHistoryPage />)

    expect(await screen.findByRole('button', { name: 'Older' })).toBeEnabled()
  })
})

describe('when it cannot be read', () => {
  it('says so rather than rendering as an empty trail', async () => {
    /*
     * The dangerous failure for this screen in particular. An empty table
     * where the request failed is not "nothing happened" - it is a claim that
     * nothing has ever been changed, made to the person whose job is to check.
     */
    read.mockRejectedValue(new Error('Network is down'))
    renderWithProviders(<ChangeHistoryPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Network is down')
    expect(screen.queryByText(/Nothing has been changed yet/)).not.toBeInTheDocument()
  })

  it('offers another go', async () => {
    const user = userEvent.setup()
    read.mockRejectedValue(new Error('Network is down'))
    renderWithProviders(<ChangeHistoryPage />)
    await screen.findByRole('alert')

    read.mockResolvedValue(answer())
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('User created')).toBeInTheDocument()
  })
})
