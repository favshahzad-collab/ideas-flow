import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchLoginActivity, endUserSessions, type LoginActivity } from '../services/AdminApi'
import { makeUser, renderWithProviders, TEST_USER_ID } from '../test/render'
import LoginActivityPage from './LoginActivityPage'

/**
 * The screen that answers "who is signed in".
 *
 * The assertions worth having here are about the two things this screen could
 * get dangerously wrong: showing an administrator a button that would sign
 * *them* out, and saying "sign out" while ending only one device.
 */

vi.mock('../services/AdminApi', () => ({
  fetchLoginActivity: vi.fn(),
  endUserSessions: vi.fn(),
}))

const read = vi.mocked(fetchLoginActivity)
const end = vi.mocked(endUserSessions)

const person = (overrides: Partial<LoginActivity['active'][number]['user']> = {}) => ({
  id: 'user-2',
  firstName: 'Bilal',
  lastName: 'Ahmed',
  email: 'bilal.ahmed@example.com',
  loginRole: 'USER',
  department: { id: 'dept-1', name: 'Finance' },
  ...overrides,
})

const session = (overrides: Partial<LoginActivity['active'][number]> = {}) => ({
  id: 'session-1',
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  ipAddress: '10.2.4.7',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  user: person(),
  ...overrides,
})

const activity = (overrides: Partial<LoginActivity> = {}): LoginActivity => ({
  active: [session()],
  ended: [],
  summary: { peopleSignedIn: 1, sessionsOpen: 1, endedWithinHours: 168 },
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  read.mockResolvedValue(activity())
  end.mockResolvedValue({ ended: 2 })
})

afterEach(() => {
  vi.useRealTimers()
})

const asAdmin = () =>
  renderWithProviders(<LoginActivityPage />, {
    currentUser: { user: makeUser({ role: 'ADMINISTRATOR' }) },
  })

describe('who is signed in', () => {
  it('names the person and their department', async () => {
    asAdmin()

    expect(await screen.findByText('Bilal Ahmed')).toBeInTheDocument()
    // The department is the whole point of the row: "3 sessions from 10.2.4.7"
    // is not something an administrator can act on.
    expect(screen.getByText(/Finance/)).toBeInTheDocument()
  })

  it('reads the device from the user agent rather than showing the string', async () => {
    asAdmin()

    expect(await screen.findByText('Chrome on Windows')).toBeInTheDocument()
    expect(screen.queryByText(/Mozilla\/5\.0/)).not.toBeInTheDocument()
  })

  it('says so plainly when a session has no recorded address', async () => {
    const user = userEvent.setup({ delay: null })
    read.mockResolvedValue(
      activity({ active: [session({ ipAddress: null, userAgent: null })] })
    )
    asAdmin()

    // The per-device detail lives under the person, so open the row first.
    await user.click(await screen.findByRole('button', { name: /1 session/ }))

    expect(await screen.findByText('address not recorded')).toBeInTheDocument()
    expect(screen.getAllByText('Unknown device').length).toBeGreaterThan(0)
  })

  it('draws one row per person, however many sessions they hold', async () => {
    /*
     * The defect the real instance showed: seventeen sessions for one person
     * drew seventeen identical rows, each with its own "Sign out" button, all
     * of which did the same thing - because ending sessions is an operation on
     * an account, never on one row.
     */
    read.mockResolvedValue(
      activity({
        active: [session(), session({ id: 'session-2' })],
        summary: { peopleSignedIn: 1, sessionsOpen: 2, endedWithinHours: 168 },
      })
    )
    asAdmin()

    expect(await screen.findAllByText('Bilal Ahmed')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /Sign Bilal Ahmed out/i })).toHaveLength(1)
    // The sessions are still there, as the detail under the person.
    expect(screen.getByRole('button', { name: /2 sessions/ })).toBeInTheDocument()
  })

  it('counts people separately from sessions', async () => {
    // A screen that says fourteen when seven people are at work is worse than
    // no number, because it is a number that will be quoted.
    read.mockResolvedValue(
      activity({
        active: [session(), session({ id: 'session-2' })],
        summary: { peopleSignedIn: 1, sessionsOpen: 2, endedWithinHours: 168 },
      })
    )
    asAdmin()

    await screen.findByText('Bilal Ahmed')
    await waitFor(() => {
      expect(screen.getByText('People signed in: 1')).toBeInTheDocument()
    })
    expect(screen.getByText('Open sessions: 2')).toBeInTheDocument()
  })

  it('lists each device once the person is opened', async () => {
    const user = userEvent.setup({ delay: null })
    read.mockResolvedValue(
      activity({
        active: [
          session(),
          session({
            id: 'session-2',
            ipAddress: '10.9.9.9',
            userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit Version/17 Safari/605',
          }),
        ],
      })
    )
    asAdmin()

    await user.click(await screen.findByRole('button', { name: /2 sessions/ }))

    // Two devices in two places is the thing somebody opens this to notice.
    expect(await screen.findByText('10.9.9.9')).toBeInTheDocument()
    expect(screen.getAllByText(/Safari on iOS/).length).toBeGreaterThan(0)
  })

  it('says nobody is signed in rather than showing an empty panel', async () => {
    read.mockResolvedValue(
      activity({ active: [], summary: { peopleSignedIn: 0, sessionsOpen: 0, endedWithinHours: 168 } })
    )
    asAdmin()

    expect(await screen.findByText('Nobody is signed in')).toBeInTheDocument()
  })
})

describe('ending somebody else’s sessions', () => {
  it('warns that it ends every device, not the one on screen', async () => {
    const user = userEvent.setup({ delay: null })
    asAdmin()

    await user.click(await screen.findByRole('button', { name: /Sign Bilal Ahmed out/i }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/on every device/i)).toBeInTheDocument()
    // And how many, so "sign out" cannot be read as ending the one on screen.
    expect(within(dialog).getByText(/All 1 of/)).toBeInTheDocument()
  })

  it('ends them only after the confirmation', async () => {
    const user = userEvent.setup({ delay: null })
    asAdmin()

    await user.click(await screen.findByRole('button', { name: /Sign Bilal Ahmed out/i }))
    expect(end).not.toHaveBeenCalled()

    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Sign them out' }))

    await waitFor(() => {
      expect(end).toHaveBeenCalledWith('user-2')
    })
  })

  it('offers no such button against the administrator’s own session', async () => {
    /*
     * The button would sign them out by their own click. The route refuses it
     * too - this is so nobody has to find that out by pressing it.
     */
    read.mockResolvedValue(
      activity({
        active: [session({ user: person({ id: TEST_USER_ID, firstName: 'Ayesha', lastName: 'Khan' }) })],
      })
    )
    asAdmin()

    expect(await screen.findByText('Your session')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Sign Ayesha Khan out/i })).not.toBeInTheDocument()
  })
})

describe('who has just left', () => {
  it('lists recently ended sessions with the time they ended', async () => {
    read.mockResolvedValue(
      activity({
        ended: [
          {
            id: 'session-old',
            issuedAt: new Date(Date.now() - 7_200_000).toISOString(),
            revokedAt: new Date(Date.now() - 3_600_000).toISOString(),
            ipAddress: '10.2.4.9',
            userAgent: null,
            user: person({ id: 'user-3', firstName: 'Sana', lastName: 'Iqbal' }),
          },
        ],
      })
    )
    asAdmin()

    expect(await screen.findByText('Sana Iqbal')).toBeInTheDocument()
  })

  it('says the list is empty rather than leaving a blank panel', async () => {
    asAdmin()

    expect(
      await screen.findByText('Nobody has signed out in the last week.')
    ).toBeInTheDocument()
  })
})

describe('when it cannot load', () => {
  it('says so instead of showing an empty screen', async () => {
    read.mockRejectedValue(new Error('Admin access required'))
    asAdmin()

    expect(await screen.findByRole('alert')).toHaveTextContent('Admin access required')
  })
})
