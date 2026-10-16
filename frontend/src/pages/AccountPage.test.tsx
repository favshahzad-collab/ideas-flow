import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { changeMyPassword } from '../services/accountApi'
import { makeUser, renderWithProviders } from '../test/render'
import AccountPage from './AccountPage'

/**
 * The screen that stopped a password being somebody else's property.
 *
 * There was no route by which a person could change their own: the only one
 * was an administrator setting it through the user-admin form. At the scale
 * this product deploys at that is not an inconvenience but a policy — every
 * account arrives from a spreadsheet import carrying a password somebody else
 * chose, and it stays that way, so the administrator who wrote the spreadsheet
 * permanently holds the credentials of everybody whose signature carries
 * approval authority.
 *
 * The tests below are mostly about the refusals, because this form's job is to
 * be hard to use wrongly: it must not send a change it knows is wrong, and it
 * must not pretend to have succeeded when the session it is running in is
 * about to end.
 */

vi.mock('../services/accountApi', () => ({
  changeMyPassword: vi.fn(),
}))

/*
 * The page also carries the two-step sign-in card now, which asks the server
 * what this account has switched on. Stubbed to "off" so it settles quietly:
 * unmocked it throws in jsdom and puts a second alert on the page, which is
 * how these tests first noticed the card had arrived. Its own behaviour is in
 * TwoFactorCard.test.tsx.
 */
vi.mock('../services/authApi', () => ({
  fetchTwoFactorStatus: vi.fn().mockResolvedValue({
    enabled: false,
    activatedAt: null,
    pending: false,
    recoveryCodesRemaining: 0,
    recoveryCodesUsed: 0,
    secretUnreadable: false,
  }),
  startTwoFactorSetup: vi.fn(),
  activateTwoFactor: vi.fn(),
  replaceRecoveryCodes: vi.fn(),
  disableTwoFactor: vi.fn(),
}))

/*
 * And the out-of-office card, for the same reason and with the same symptom:
 * unmocked, `fetchDelegations` throws in jsdom and the card says so in an
 * alert, so every assertion here about "the" alert finds two. Stubbed to
 * "nobody is covering for you"; its own behaviour is in
 * OutOfOfficeCard.test.tsx.
 */
vi.mock('../services/delegationApi', () => ({
  fetchDelegations: vi.fn().mockResolvedValue({ given: [], held: [] }),
  createDelegation: vi.fn(),
  revokeDelegation: vi.fn(),
}))

const change = vi.mocked(changeMyPassword)

// The submit path ends the session by navigating away, so the assignment is
// stubbed rather than allowed to tear the test environment down.
const assign = vi.fn()

beforeEach(() => {
  change.mockReset()
  assign.mockReset()
  change.mockResolvedValue({ message: 'Your password has been changed. Sign in again.' })
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign, href: 'http://localhost/account' },
  })
})

const fill = async (
  user: ReturnType<typeof userEvent.setup>,
  values: { current?: string; next?: string; confirm?: string },
) => {
  if (values.current !== undefined) {
    await user.type(screen.getByLabelText('Current password'), values.current)
  }
  if (values.next !== undefined) {
    await user.type(screen.getByLabelText('New password'), values.next)
  }
  if (values.confirm !== undefined) {
    await user.type(screen.getByLabelText('Confirm new password'), values.confirm)
  }
}

describe('who you are', () => {
  it('shows the details printed under your signature', async () => {
    // Name and job title are stamped on every memo this person approves, so
    // the screen has to let them check what will be printed.
    renderWithProviders(<AccountPage />, {
      currentUser: { user: makeUser({ firstName: 'Ayesha', lastName: 'Khan' }) },
    })

    expect(await screen.findByText('Ayesha Khan')).toBeInTheDocument()
    expect(screen.getByText('ayesha.khan@example.com')).toBeInTheDocument()
  })

  it('names the role in words rather than in the API spelling', async () => {
    renderWithProviders(<AccountPage />, {
      currentUser: { user: makeUser({ role: 'ADMINISTRATOR', isSuperAdmin: false }) },
    })

    expect(await screen.findByText('Administrator')).toBeInTheDocument()
  })

  it('names the top tier of administrator as such', async () => {
    renderWithProviders(<AccountPage />, {
      currentUser: { user: makeUser({ role: 'ADMINISTRATOR' }) },
    })

    expect(await screen.findByText('Super Administrator')).toBeInTheDocument()
  })

  it('says whether a signature has been saved', async () => {
    renderWithProviders(<AccountPage />, {
      currentUser: { user: makeUser({ hasSignature: false }) },
    })

    expect(await screen.findByText('None saved')).toBeInTheDocument()
    expect(screen.getByText(/have not saved one/i)).toBeInTheDocument()
  })
  it('asks somebody who signs in only with Microsoft to set up the app as a fallback', async () => {
    renderWithProviders(<AccountPage />, {
      currentUser: { user: makeUser({ hasPassword: false, hasAuthenticator: false }) },
    })

    expect(await screen.findByRole('note')).toHaveTextContent(/Set up an authenticator app/)
  })

  it('does not ask somebody who already has a password', async () => {
    renderWithProviders(<AccountPage />, {
      currentUser: { user: makeUser({ hasSignature: false }) },
    })

    await screen.findByText('None saved')
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })
})

describe('changing the password', () => {
  it('sends it once all three fields agree', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<AccountPage />, { currentUser: { user: makeUser() } })

    await fill(user, { current: 'old-one', next: 'a-new-long-phrase', confirm: 'a-new-long-phrase' })
    await user.click(screen.getByRole('button', { name: 'Change password' }))

    await waitFor(() =>
      expect(change).toHaveBeenCalledWith({
        currentPassword: 'old-one',
        newPassword: 'a-new-long-phrase',
      }),
    )
  })

  it('will not send while the two new fields differ', async () => {
    // Answerable without a round trip, and the server never sees the
    // confirmation field - so it has to be caught here or not at all.
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<AccountPage />, { currentUser: { user: makeUser() } })

    await fill(user, { current: 'old-one', next: 'a-new-long-phrase', confirm: 'another-long-phrase' })

    expect(screen.getByText('These two do not match.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled()
    expect(change).not.toHaveBeenCalled()
  })

  it('will not send a new password that is too short', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<AccountPage />, { currentUser: { user: makeUser() } })

    await fill(user, { current: 'old-one', next: 'abc', confirm: 'abc' })

    expect(screen.getByText('Use at least 12 characters.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled()
    expect(change).not.toHaveBeenCalled()
  })

  it('will not send without the current password', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<AccountPage />, { currentUser: { user: makeUser() } })

    await fill(user, { next: 'a-new-long-phrase', confirm: 'a-new-long-phrase' })

    expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled()
    expect(change).not.toHaveBeenCalled()
  })

  it('sends the person to sign in again rather than saying "saved"', async () => {
    /*
     * The change ends every session it opened, this one included. A success
     * message followed by the next click landing on the sign-in screen reads
     * as a fault, so the screen goes there itself.
     */
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<AccountPage />, { currentUser: { user: makeUser() } })

    await fill(user, { current: 'old-one', next: 'a-new-long-phrase', confirm: 'a-new-long-phrase' })
    await user.click(screen.getByRole('button', { name: 'Change password' }))

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'))
  })

  it("hands over the server's refusal rather than a generic failure", async () => {
    // "Your current password is not correct" is actionable. "Request failed"
    // sends somebody to the administrator for a password they already know.
    const user = userEvent.setup({ delay: null })
    change.mockRejectedValue(new Error('Your current password is not correct.'))
    renderWithProviders(<AccountPage />, { currentUser: { user: makeUser() } })

    await fill(user, { current: 'wrong', next: 'a-new-long-phrase', confirm: 'a-new-long-phrase' })
    await user.click(screen.getByRole('button', { name: 'Change password' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your current password is not correct.',
    )
    expect(assign).not.toHaveBeenCalled()
  })

  it('lets a refused attempt be corrected without reloading', async () => {
    const user = userEvent.setup({ delay: null })
    change.mockRejectedValueOnce(new Error('Your current password is not correct.'))
    renderWithProviders(<AccountPage />, { currentUser: { user: makeUser() } })

    await fill(user, { current: 'wrong', next: 'a-new-long-phrase', confirm: 'a-new-long-phrase' })
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    await screen.findByRole('alert')

    await user.clear(screen.getByLabelText('Current password'))
    await user.type(screen.getByLabelText('Current password'), 'right-one')
    await user.click(screen.getByRole('button', { name: 'Change password' }))

    await waitFor(() =>
      expect(change).toHaveBeenLastCalledWith({
        currentPassword: 'right-one',
        newPassword: 'a-new-long-phrase',
      }),
    )
  })

  it('warns that the change signs you out everywhere', async () => {
    // The consequence is stated before the button, not discovered after it.
    renderWithProviders(<AccountPage />, { currentUser: { user: makeUser() } })

    expect(
      await screen.findByText(/signed out everywhere, on this device too/i),
    ).toBeInTheDocument()
  })
})
