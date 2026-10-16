import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { exchangeSsoCode } from '../services/authApi'
import { renderWithProviders } from '../test/render'
import SsoCallbackPage from './SsoCallbackPage'

/**
 * The half second between Microsoft and somebody's workspace.
 *
 * Nobody reads this screen when it works, so the tests are almost entirely
 * about when it does not: a link with no code, a code already spent, a code
 * that went stale. Each of those has to end somewhere a person can act from,
 * because the alternative is a spinner that never stops on the one screen
 * where they have no other option.
 */

vi.mock('../services/authApi', () => ({ exchangeSsoCode: vi.fn() }))

const exchange = vi.mocked(exchangeSsoCode)
const completeLogin = vi.fn()

const session = {
  accessToken: 'an-access-token',
  refreshToken: 'a-refresh-token',
  user: { id: 'a-user', email: 'adnan@ideas.com.pk', role: 'USER' as const },
}

const render = (search: string) =>
  renderWithProviders(<SsoCallbackPage />, {
    route: `/login/sso${search}`,
    auth: { login: completeLogin },
  })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a code that works', () => {
  it('trades it for a session, once', async () => {
    exchange.mockResolvedValue(session)
    render('?code=a-handover-code')

    await waitFor(() => expect(exchange).toHaveBeenCalledWith('a-handover-code'))
    expect(exchange).toHaveBeenCalledTimes(1)
  })

  it('hands the role to the session, exactly as the password form does', async () => {
    exchange.mockResolvedValue(session)
    render('?code=a-handover-code')

    // No navigation of its own: flipping the session is enough, and
    // `PublicOnlyRoute` moves off this screen.
    await waitFor(() => expect(completeLogin).toHaveBeenCalledWith('USER'))
  })

  it('says what is happening while it happens', () => {
    exchange.mockReturnValue(new Promise(() => {}))
    render('?code=a-handover-code')

    expect(screen.getByText(/signing you in/i)).toBeInTheDocument()
  })
})

describe('a code that does not', () => {
  it('says so, and offers the way back', async () => {
    exchange.mockRejectedValue(
      new Error('That sign-in has already been used or has expired.'),
    )
    render('?code=a-spent-code')

    expect(
      await screen.findByText(/already been used or has expired/i),
    ).toBeInTheDocument()
    // The important half: somewhere to go. A refusal with no way out strands
    // somebody on the one screen they cannot get past.
    expect(screen.getByRole('link', { name: /back to sign in/i })).toHaveAttribute(
      'href',
      '/login',
    )
  })

  it('announces the refusal rather than only drawing it', async () => {
    exchange.mockRejectedValue(new Error('Nope.'))
    render('?code=a-code')

    expect(await screen.findByRole('alert')).toHaveTextContent('Nope.')
  })

  it('stops spinning', async () => {
    exchange.mockRejectedValue(new Error('Nope.'))
    render('?code=a-code')

    await screen.findByRole('alert')
    expect(screen.queryByText(/signing you in/i)).not.toBeInTheDocument()
  })
})

describe('a link with no code in it', () => {
  it('says that, without asking the server anything', async () => {
    render('')

    expect(
      await screen.findByText(/missing its code/i),
    ).toBeInTheDocument()
    expect(exchange).not.toHaveBeenCalled()
  })
})
