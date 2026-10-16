import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearSsoSettings,
  fetchSsoSettings,
  saveSsoSettings,
  type SsoSettings,
} from '../services/AdminApi'
import { renderWithProviders } from '../test/render'
import SsoPage from './SsoPage'

/**
 * The screen that registers a directory to sign in against.
 *
 * Most of these are about the two things this form can quietly get wrong. A
 * blank secret has to mean "keep the one you have", or correcting a redirect
 * URI requires knowing a secret Microsoft only ever showed once - which is
 * exactly the hole somebody would be in when they came here. And the secret
 * must never come back down: the server does not send it, and nothing here
 * may invent a field that looks like it did.
 *
 * The rest is about the mistake the screen exists to head off: arriving from
 * the Mail screen with the wrong application's credentials in the clipboard.
 */

vi.mock('../services/AdminApi', () => ({
  fetchSsoSettings: vi.fn(),
  saveSsoSettings: vi.fn(),
  clearSsoSettings: vi.fn(),
}))

const read = vi.mocked(fetchSsoSettings)
const save = vi.mocked(saveSsoSettings)
const forget = vi.mocked(clearSsoSettings)

const settings = (overrides: Partial<SsoSettings> = {}): SsoSettings => ({
  enabled: false,
  configured: false,
  tenantIdTail: null,
  clientIdTail: null,
  hasClientSecret: false,
  redirectUri: null,
  secretUnreadable: false,
  ...overrides,
})

const configured = (overrides: Partial<SsoSettings> = {}) =>
  settings({
    enabled: true,
    configured: true,
    tenantIdTail: '…555555',
    clientIdTail: '…000000',
    hasClientSecret: true,
    redirectUri: 'https://flow.ideas.com.pk/api/auth/sso/callback',
    ...overrides,
  })

const render = () => renderWithProviders(<SsoPage />)

beforeEach(() => {
  vi.clearAllMocks()
  read.mockResolvedValue(settings())
})

describe('before anything is registered', () => {
  it('warns that this is not the application that sends mail', async () => {
    /*
     * The mistake the screen exists to head off. Somebody arriving from the
     * Mail screen has a tenant id and a client id in their clipboard and they
     * are the wrong ones: that registration is app-only and has no redirect
     * URI, so the sign-in it produces fails with a message about neither.
     */
    render()

    expect(await screen.findByText(/second/i)).toBeInTheDocument()
    expect(
      screen.getByText(/separate from the one on the Mail screen/i),
    ).toBeInTheDocument()
  })

  it('shows the exact redirect URI to paste into Entra', async () => {
    // Entra compares it character for character, and a mismatch is the single
    // most common way for this to fail. Shown, not described.
    render()

    await screen.findByLabelText(/redirect uri/i)

    expect(
      screen.getAllByText(/\/api\/auth\/sso\/callback/).length,
    ).toBeGreaterThan(0)
  })

  it('fills the field in when asked', async () => {
    render()

    await userEvent.click(await screen.findByRole('button', { name: /use it/i }))

    expect(screen.getByLabelText(/redirect uri/i)).toHaveValue(
      `${window.location.origin}/api/auth/sso/callback`,
    )
  })

  it('says the registration is incomplete', async () => {
    render()

    expect(await screen.findByText('Incomplete')).toBeInTheDocument()
  })
})

describe('saving', () => {
  it('sends what was typed', async () => {
    save.mockResolvedValue(configured())
    render()

    await userEvent.type(
      await screen.findByLabelText(/directory \(tenant\) id/i),
      'a-tenant',
    )
    await userEvent.type(
      screen.getByLabelText(/application \(client\) id/i),
      'a-client',
    )
    await userEvent.type(screen.getByLabelText(/client secret/i), 'a-secret')
    await userEvent.type(
      screen.getByLabelText(/redirect uri/i),
      'https://flow.ideas.com.pk/api/auth/sso/callback',
    )
    await userEvent.click(screen.getByRole('button', { name: /save registration/i }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        enabled: false,
        tenantId: 'a-tenant',
        clientId: 'a-client',
        clientSecret: 'a-secret',
        redirectUri: 'https://flow.ideas.com.pk/api/auth/sso/callback',
      }),
    )
  })

  it('leaves out a field nobody touched, so the stored one survives', async () => {
    /*
     * The rule that lets somebody correct a redirect URI without knowing the
     * secret. An empty field is never sent, so the server keeps what it has -
     * rather than the form telling it to delete a credential on the way past.
     */
    read.mockResolvedValue(configured())
    save.mockResolvedValue(configured())
    render()

    await userEvent.clear(await screen.findByLabelText(/redirect uri/i))
    await userEvent.type(
      screen.getByLabelText(/redirect uri/i),
      'https://new.ideas.com.pk/api/auth/sso/callback',
    )
    await userEvent.click(screen.getByRole('button', { name: /save registration/i }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        enabled: true,
        redirectUri: 'https://new.ideas.com.pk/api/auth/sso/callback',
      }),
    )
  })

  it('says what changed for the people signing in', async () => {
    save.mockResolvedValue(configured())
    render()

    await userEvent.click(
      await screen.findByRole('button', { name: /save registration/i }),
    )

    expect(
      await screen.findByText(/now offers Continue with Microsoft/i),
    ).toBeInTheDocument()
  })

  it('keeps a refusal on screen', async () => {
    save.mockRejectedValue(
      new Error('Sign-in with Microsoft needs the directory ID.'),
    )
    render()

    await userEvent.click(
      await screen.findByRole('button', { name: /save registration/i }),
    )

    expect(
      await screen.findByText(/needs the directory ID/i),
    ).toBeInTheDocument()
  })
})

describe('a registration already in place', () => {
  beforeEach(() => {
    read.mockResolvedValue(configured())
  })

  it('never shows the secret back, only that there is one', async () => {
    render()

    const secret = await screen.findByLabelText(/client secret/i)

    expect(secret).toHaveValue('')
    expect(screen.getByText(/never shown here/i)).toBeInTheDocument()
  })

  it('shows only the tail of the identifiers', async () => {
    // Not secrets, but a tenant and a client id together name a target, and
    // this screen ends up in screenshots.
    render()

    expect(await screen.findByText(/ending …555555/)).toBeInTheDocument()
    expect(screen.getByText(/ending …000000/)).toBeInTheDocument()
  })

  it('asks before forgetting it, and says what that does to everyone', async () => {
    render()

    await userEvent.click(await screen.findByRole('button', { name: /forget it/i }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/signs? in with a password again/i)
    expect(forget).not.toHaveBeenCalled()
  })

  it('forgets it once confirmed', async () => {
    forget.mockResolvedValue(settings())
    render()

    await userEvent.click(await screen.findByRole('button', { name: /forget it/i }))

    // Two buttons carry that name once the dialog is open - the one that asks
    // and the one that acts. Scoped, or this clicks whichever comes first.
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(
      within(dialog).getByRole('button', { name: /forget it/i }),
    )

    await waitFor(() => expect(forget).toHaveBeenCalledTimes(1))
  })
})

describe('a secret that will not decrypt', () => {
  it('says so, and says what causes it', async () => {
    // Its own state because otherwise it looks exactly like "no secret", and
    // the fix is different: enter it again.
    read.mockResolvedValue(
      configured({ secretUnreadable: true, configured: false }),
    )
    render()

    expect(await screen.findByRole('alert')).toHaveTextContent(/JWT_SECRET/)
  })
})

describe('when it cannot be read at all', () => {
  it('says so and offers to try again', async () => {
    read.mockRejectedValueOnce(new Error('Could not reach the server.'))
    render()

    expect(
      await screen.findByText('Could not reach the server.'),
    ).toBeInTheDocument()

    read.mockResolvedValue(configured())
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))

    expect(await screen.findByText('Complete')).toBeInTheDocument()
  })
})
