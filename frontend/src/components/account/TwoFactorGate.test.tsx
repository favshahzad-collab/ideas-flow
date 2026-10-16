import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchTwoFactorStatus } from '../../services/authApi'
import { UntilTwoFactorIsSetUp } from '../AppLayout'
import { makeUser, renderWithProviders } from '../../test/render'

/**
 * The setup screen an administrator without two-step sign-in sees in place of
 * the app. The server refuses everything else they ask for - that is proven in
 * admin-two-step.itest.ts - so what matters here is that nothing of the app
 * mounts behind it, that the way out is there, and that it lifts only once
 * the server says the factor is on.
 */

vi.mock('../../services/authApi', () => ({
  fetchTwoFactorStatus: vi.fn(),
  startTwoFactorSetup: vi.fn(),
  activateTwoFactor: vi.fn(),
  replaceRecoveryCodes: vi.fn(),
  disableTwoFactor: vi.fn(),
}))

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,AAA') },
}))

beforeEach(() => {
  vi.mocked(fetchTwoFactorStatus).mockResolvedValue({
    enabled: false,
    activatedAt: null,
    pending: false,
    recoveryCodesRemaining: 0,
    recoveryCodesUsed: 0,
    secretUnreadable: false,
  })
})

const renderGate = (
  twoFactorEnrolmentRequired: boolean,
  { refetch = vi.fn(async () => {}), onSignOut = vi.fn() } = {},
) => {
  renderWithProviders(
    <UntilTwoFactorIsSetUp onSignOut={onSignOut}>
      <h1>The app</h1>
    </UntilTwoFactorIsSetUp>,
    {
      currentUser: {
        user: makeUser({ role: 'ADMINISTRATOR', twoFactorEnrolmentRequired }),
        refetch,
      },
    },
  )
  return { refetch, onSignOut }
}

describe('an administrator who has not set up two-step sign-in', () => {
  it('sees the setup screen, and nothing of the app behind it', async () => {
    renderGate(true)

    expect(
      screen.getByRole('heading', { name: 'Set up two-step sign-in', level: 1 }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'The app' })).not.toBeInTheDocument()
    // The same card as on Your account, so there is one way to do this.
    expect(await screen.findByRole('button', { name: /set up two-step sign-in/i })).toBeInTheDocument()
  })

  it('can sign out instead', async () => {
    const user = userEvent.setup({ delay: null })
    const { onSignOut } = renderGate(true)

    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  it('asks the server again when they carry on, and says so if it is still off', async () => {
    const user = userEvent.setup({ delay: null })
    const { refetch } = renderGate(true)

    await user.click(
      screen.getByRole('button', { name: 'Continue to Ideas Flow' }),
    )

    expect(refetch).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/Two-step sign-in is not on yet/)).toBeInTheDocument()
  })
})

describe('before it is known who is signed in', () => {
  it('holds the app back, so nothing behind the gate fetches in the meantime', () => {
    renderWithProviders(
      <UntilTwoFactorIsSetUp onSignOut={vi.fn()}>
        <h1>The app</h1>
      </UntilTwoFactorIsSetUp>,
      { currentUser: { user: null, loading: true } },
    )

    expect(screen.queryByRole('heading', { name: 'The app' })).not.toBeInTheDocument()
  })
})

describe('everybody else', () => {
  it('gets the app', () => {
    renderGate(false)

    expect(screen.getByRole('heading', { name: 'The app' })).toBeInTheDocument()
    expect(screen.queryByText('Set up two-step sign-in')).not.toBeInTheDocument()
  })
})
