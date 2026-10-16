import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchSsoAvailable,
  login,
  submitTwoFactorCode,
} from '../services/authApi.ts'
import { fetchSystemHealth } from '../services/healthApi'
import { renderWithProviders } from '../test/render'
import LoginPage from './LoginPage'

/**
 * The sign-in screen.
 *
 * Two kinds of test here, and the second kind is the reason this file exists.
 *
 * The first is ordinary: the form validates, the errors are announced, the
 * password survives a wrong attempt. The second asserts what is *absent*.
 * This page has been handed three separate designs now, and every one of them
 * has asked for controls this product has no endpoint behind - a passkey,
 * two-factor, device trust, a password reset - plus compliance badges nobody
 * has audited. Single sign-on has since been built, so it moved from that
 * list to a harder rule: present only when a directory is actually
 * configured, absent otherwise. It is the one screen every user meets
 * before they can find out otherwise. A comment saying "no SSO button, there
 * is no endpoint" is worth nothing the day somebody pastes one in from a
 * handoff. These tests are what makes that a failure rather than a lie.
 */

vi.mock('../services/authApi.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../services/authApi.ts')>(
      '../services/authApi.ts'
    )

  return {
    // The real one: it is a pure predicate over what the server sent, and a
    // stub would let the page and the module disagree about which answer is
    // which without either test noticing.
    needsCode: actual.needsCode,
    login: vi.fn(),
    submitTwoFactorCode: vi.fn(),
    fetchSsoAvailable: vi.fn(),
  }
})
vi.mock('../services/healthApi', () => ({ fetchSystemHealth: vi.fn() }))

const signIn = vi.mocked(login)
const health = vi.mocked(fetchSystemHealth)
const ssoOffered = vi.mocked(fetchSsoAvailable)
const sendCode = vi.mocked(submitTwoFactorCode)

const SESSION = {
  accessToken: 'a',
  refreshToken: 'r',
  user: { id: 'u1', email: 'ayesha.khan@example.com', role: 'USER' as const },
}

/** What `/login` answers with for an account that has a second factor. */
const CHALLENGE = {
  twoFactorRequired: true as const,
  challenge: 'a-challenge',
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
}

/** Straight to the code step: the password half, answered with a challenge. */
async function reachCodeStep(user: ReturnType<typeof userEvent.setup>) {
  signIn.mockResolvedValue(CHALLENGE)
  render()

  await user.type(screen.getByLabelText(/email/i), 'ayesha.khan@example.com')
  await user.type(screen.getByLabelText(/^password$/i), 'a-password')
  await user.click(screen.getByRole('button', { name: /Sign in/ }))

  return screen.findByLabelText(/six-digit code/i)
}

const completeLogin = vi.fn()

const render = (auth: Parameters<typeof renderWithProviders>[1] = {}) =>
  renderWithProviders(<LoginPage />, {
    auth: { login: completeLogin, ...auth.auth },
    ...auth,
  })

beforeEach(() => {
  vi.clearAllMocks()
  health.mockResolvedValue({ state: 'ok' })
  // The default for most of this file: no directory configured, so the screen
  // is the password form and nothing else. The tests that care say otherwise.
  ssoOffered.mockResolvedValue(false)
  signIn.mockResolvedValue(SESSION)
  sendCode.mockResolvedValue(SESSION)
})

describe('an account that asks for a code as well', () => {
  /*
   * The second factor is real now. These are the rules that make it worth
   * having rather than theatre: no session until the code, the password gone
   * from the screen while somebody walks off to find their phone, and a way
   * in for a person whose phone is at the bottom of a canal.
   */

  it('asks for the code instead of signing in', async () => {
    const user = userEvent.setup({ delay: null })

    await reachCodeStep(user)

    expect(screen.getByText(/enter your code/i)).toBeInTheDocument()
    // The session is what must NOT have happened. A page that flips the auth
    // context here has already let somebody in on a password alone.
    expect(completeLogin).not.toHaveBeenCalled()
  })

  it('does not leave the password on screen behind it', async () => {
    // Somebody is about to walk away from this machine to find a phone.
    const user = userEvent.setup({ delay: null })

    await reachCodeStep(user)

    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument()
  })

  it('sends the code with the challenge it was given', async () => {
    const user = userEvent.setup({ delay: null })

    await user.type(await reachCodeStep(user), '123456')
    await user.click(screen.getByRole('button', { name: /^Sign in$/ }))

    await waitFor(() =>
      expect(sendCode).toHaveBeenCalledWith('a-challenge', '123456')
    )
  })

  it('signs in once the code is accepted', async () => {
    const user = userEvent.setup({ delay: null })

    await user.type(await reachCodeStep(user), '123456')
    await user.click(screen.getByRole('button', { name: /^Sign in$/ }))

    await waitFor(() => expect(completeLogin).toHaveBeenCalledWith('USER'))
  })

  it('says the session used both, not just the password', async () => {
    const user = userEvent.setup({ delay: null })

    await user.type(await reachCodeStep(user), '123456')
    await user.click(screen.getByRole('button', { name: /^Sign in$/ }))

    expect(await screen.findByText('Password and code')).toBeInTheDocument()
  })

  it('keeps a refused code on screen and clears the field', async () => {
    const user = userEvent.setup({ delay: null })
    sendCode.mockRejectedValue(
      new Error('That code was not accepted. 4 tries left before you have to sign in again.')
    )

    await user.type(await reachCodeStep(user), '000000')
    await user.click(screen.getByRole('button', { name: /^Sign in$/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/4 tries left/)
    // Cleared, because the next thing they type is a different code - not a
    // correction to this one.
    expect(screen.getByLabelText(/six-digit code/i)).toHaveValue('')
  })

  it('offers the recovery code as the way out, in the same field', async () => {
    /*
     * One field for both. Somebody who has reached for the envelope is
     * already having a bad morning, and a second control to find first is the
     * wrong thing to put in front of them.
     */
    const user = userEvent.setup({ delay: null })

    await reachCodeStep(user)

    expect(screen.getByText(/recovery codes you saved/i)).toBeInTheDocument()
  })

  it('says who can help when the phone and the codes are both gone', async () => {
    const user = userEvent.setup({ delay: null })

    await reachCodeStep(user)

    expect(
      screen.getByText(/administrator can turn two-step sign-in off/i)
    ).toBeInTheDocument()
  })

  it('goes back to the password form, abandoning the challenge', async () => {
    // Not reused: whoever comes back proves the password again, which is the
    // whole point of the first step.
    const user = userEvent.setup({ delay: null })

    await reachCodeStep(user)
    await user.click(screen.getByRole('button', { name: /different account/i }))

    expect(await screen.findByLabelText(/^password$/i)).toHaveValue('')
    expect(screen.queryByLabelText(/six-digit code/i)).not.toBeInTheDocument()
  })

  it('does not ask an ordinary account for one', async () => {
    // The factor is per person and off by default. Four of the five accounts
    // on this deployment must be untouched by any of the above.
    const user = userEvent.setup({ delay: null })
    render()

    await user.type(screen.getByLabelText(/email/i), 'ayesha.khan@example.com')
    await user.type(screen.getByLabelText(/^password$/i), 'a-password')
    await user.click(screen.getByRole('button', { name: /Sign in/ }))

    await waitFor(() => expect(completeLogin).toHaveBeenCalledWith('USER'))
    expect(screen.queryByLabelText(/six-digit code/i)).not.toBeInTheDocument()
  })
})

describe('signing in', () => {
  it('sends what was typed, trimmed', async () => {
    const user = userEvent.setup({ delay: null })
    render()

    await user.type(screen.getByLabelText('Email address'), '  ayesha.khan@example.com  ')
    await user.type(screen.getByLabelText('Password'), 'correct horse')
    await user.click(screen.getByRole('button', { name: /Sign in/ }))

    await waitFor(() => {
      // Trimmed: an address pasted with a trailing space is the single most
      // common way a correct credential gets refused.
      expect(signIn).toHaveBeenCalledWith('ayesha.khan@example.com', 'correct horse')
    })
  })

  it('refuses an address that is not one, without asking the server', async () => {
    const user = userEvent.setup({ delay: null })
    render()

    await user.type(screen.getByLabelText('Email address'), 'ayesha.khan')
    await user.type(screen.getByLabelText('Password'), 'correct horse')
    await user.click(screen.getByRole('button', { name: /Sign in/ }))

    expect(
      await screen.findByText(/Enter the work email address your administrator provisioned/)
    ).toBeInTheDocument()
    expect(signIn).not.toHaveBeenCalled()
  })

  it('reports both empty fields at once', async () => {
    // Fixing one and being told about the next is two round trips through the
    // same form for something the page knew all along.
    const user = userEvent.setup({ delay: null })
    render()

    await user.click(screen.getByRole('button', { name: /Sign in/ }))

    expect(await screen.findByText('Enter your email address.')).toBeInTheDocument()
    expect(screen.getByText('Enter your password.')).toBeInTheDocument()
  })

  it('announces a refusal rather than only showing it', async () => {
    const user = userEvent.setup({ delay: null })
    signIn.mockRejectedValue(new Error('Invalid email or password'))
    render()

    await user.type(screen.getByLabelText('Email address'), 'ayesha.khan@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: /Sign in/ }))

    // A sign-in failure reached a screen reader as silence before this.
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password')
  })

  it('says only what the server said about a refusal', async () => {
    /*
     * The handoff writes "That password is incorrect. 2 attempts remain
     * before this account is locked." There IS a cap - eight tries at one
     * account - but the API does not report what is left of it, and it should
     * not: a counter shown to whoever is guessing tells them exactly when to
     * pause and start again.
     */
    const user = userEvent.setup({ delay: null })
    signIn.mockRejectedValue(new Error('Invalid email or password'))
    render()

    await user.type(screen.getByLabelText('Email address'), 'ayesha.khan@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: /Sign in/ }))

    await screen.findByRole('alert')
    expect(screen.queryByText(/attempts remain|account is locked/i)).not.toBeInTheDocument()
  })

  it('keeps the password after a wrong attempt', async () => {
    /*
     * Clearing it punishes a typo by making somebody start over, and the
     * password is the field they are about to retype anyway.
     */
    const user = userEvent.setup({ delay: null })
    signIn.mockRejectedValue(new Error('Invalid email or password'))
    render()

    await user.type(screen.getByLabelText('Email address'), 'ayesha.khan@example.com')
    await user.type(screen.getByLabelText('Password'), 'nearly-right')
    await user.click(screen.getByRole('button', { name: /Sign in/ }))

    await screen.findByRole('alert')
    expect(screen.getByLabelText('Password')).toHaveValue('nearly-right')
  })

  it('shows the password only when asked, and says which state it is in', async () => {
    const user = userEvent.setup({ delay: null })
    render()

    const field = screen.getByLabelText('Password')
    expect(field).toHaveAttribute('type', 'password')

    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(field).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('says why somebody was sent back here mid-task', async () => {
    render({ auth: { sessionExpired: true } })

    expect(await screen.findByText(/Your session timed out/)).toBeInTheDocument()
  })
})

describe('once they are in', () => {
  it('says so, and names the account it signed in', async () => {
    const user = userEvent.setup({ delay: null })
    render()

    await user.type(screen.getByLabelText('Email address'), 'ayesha.khan@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct horse')
    await user.click(screen.getByRole('button', { name: /Sign in/ }))

    expect(await screen.findByText('Session established')).toBeInTheDocument()
    expect(screen.getByText('ayesha.khan@example.com')).toBeInTheDocument()
  })

  it('states no fact about the session it cannot know', async () => {
    /*
     * The handoff's session card also prints "This device is trusted until 11
     * Oct 2026" and an audit entry id, "AUTH-20260911-0417". There is no
     * device-trust record in this build, and signing in writes no audit row -
     * `AuditAction` has no entry for it - so there is nothing to quote.
     */
    const user = userEvent.setup({ delay: null })
    render()

    await user.type(screen.getByLabelText('Email address'), 'ayesha.khan@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct horse')
    await user.click(screen.getByRole('button', { name: /Sign in/ }))

    await screen.findByText('Session established')
    expect(screen.queryByText(/trusted until/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/AUTH-\d/)).not.toBeInTheDocument()
    expect(screen.queryByText(/TOTP/i)).not.toBeInTheDocument()
  })
})

describe('the status line, which is measured rather than printed', () => {
  it('says what the health endpoint says', async () => {
    render()

    expect(await screen.findByText('All systems operational')).toBeInTheDocument()
  })

  it('names what is wrong when something is', async () => {
    health.mockResolvedValue({ state: 'degraded', parts: ['mail'] })
    render()

    expect(await screen.findByText(/Degraded: mail/)).toBeInTheDocument()
  })

  it('says so when it cannot reach the service at all', async () => {
    // The case a fixed "All systems operational" serves worst: somebody
    // looking at a form that is not going to work, being told it is fine.
    health.mockResolvedValue({ state: 'unreachable' })
    render()

    expect(await screen.findByText('Cannot reach the service')).toBeInTheDocument()
    expect(screen.queryByText('All systems operational')).not.toBeInTheDocument()
  })

  it('claims nothing while it is still asking', () => {
    health.mockReturnValue(new Promise(() => undefined))
    render()

    expect(screen.queryByText(/All systems operational/)).not.toBeInTheDocument()
  })
})

describe('what the page does not offer', () => {
  /*
   * Every one of these is a control a design asked for and the server has no
   * endpoint behind. Offering one on the page nobody can get past would be
   * worse than not offering it: a dead control on a sign-in screen reads as
   * the product being broken, not as the feature being absent.
   */

  it('offers no Microsoft until a directory is actually configured', async () => {
    /*
     * The rule that replaced "there is no such endpoint". There is one now,
     * but it is inert until an administrator registers an application - and a
     * button that cannot work is worse here than on any other screen, because
     * this is the one nobody can get past.
     */
    ssoOffered.mockResolvedValue(false)
    render()

    // Waited on rather than asserted immediately: the answer arrives from the
    // server, so "not there yet" would pass whatever the answer turned out
    // to be.
    await waitFor(() => expect(ssoOffered).toHaveBeenCalled())

    expect(
      screen.queryByRole('link', { name: /Microsoft|Entra/i })
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/Continue with/i)).not.toBeInTheDocument()
  })

  it('offers it once one is, pointed at the real endpoint', async () => {
    ssoOffered.mockResolvedValue(true)
    render()

    const button = await screen.findByRole('link', {
      name: /Continue with Microsoft/i,
    })

    // A link, not a button: the flow is a full-page redirect the server
    // controls, and nothing about it is fetchable from here.
    expect(button).toHaveAttribute('href', '/api/auth/sso/start')
  })

  it('never offers Okta, which has no endpoint at all', async () => {
    ssoOffered.mockResolvedValue(true)
    render()

    await screen.findByRole('link', { name: /Continue with Microsoft/i })

    expect(
      screen.queryByRole('link', { name: /Okta/i })
    ).not.toBeInTheDocument()
  })

  it('says what a failed redirect means, in its own words', async () => {
    /*
     * The reason is read from the URL, and the copy is chosen here from a
     * fixed set rather than carried from Microsoft: anybody can type this
     * address, and reflecting supplied text into the page is a habit worth
     * not having.
     */
    render({ route: '/login?sso=no-account' })

    expect(
      await screen.findByText(/not set up in IdeasFlow/i)
    ).toBeInTheDocument()
  })

  it('ignores a reason it does not recognise', async () => {
    render({ route: '/login?sso=<script>' })

    await waitFor(() => expect(ssoOffered).toHaveBeenCalled())

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('offers no passkey', () => {
    // WebAuthn needs a challenge endpoint and a credential store. Neither
    // exists, and `navigator.credentials.get` against nothing fails silently.
    render()

    expect(screen.queryByText(/passkey/i)).not.toBeInTheDocument()
  })

  it('offers no two-factor step', () => {
    /*
     * The one that would do real harm. There is no TOTP secret on `User`, no
     * verify route and no recovery codes - so a six-digit step here could
     * only accept any six digits. Somebody who believes they have 2FA behaves
     * as though they do: they reuse the password, they worry less about the
     * laptop. Security theatre on a sign-in screen is worse than an honest
     * password field.
     */
    render()

    expect(screen.queryByText(/two-factor|verification code|authenticator/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Step 2 of 2/i)).not.toBeInTheDocument()
  })

  it('offers no forgot-password link, and says who to ask instead', () => {
    render()

    expect(screen.queryByRole('link', { name: /Forgot/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Forgot/i })).not.toBeInTheDocument()
    // The need is real even though the control is not, so the page answers it.
    expect(screen.getByText(/Ask an administrator to reset it/)).toBeInTheDocument()
  })

  it('offers no device trust', () => {
    // Session length is the refresh token's. A switch that changed nothing
    // would be a promise the server never made.
    render()

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/Trust this device|Remember me/i)).not.toBeInTheDocument()
  })

  it('offers no language selector', () => {
    render()

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('offers no sign-up, and says why', () => {
    render()

    expect(screen.getByText(/no sign-up here/)).toBeInTheDocument()
  })

  it('claims no certification nobody has audited', () => {
    /*
     * The handoff prints SOC 2 TYPE II, ISO 27001 and 21 CFR PART 11 as tags
     * on the brand panel. A badge is not a design element - it is a statement
     * about a legal fact, on the one screen a reader has no way to check it.
     */
    render()

    expect(
      screen.queryByText(/SOC 2|ISO 27001|21 CFR|bank-grade|military/i)
    ).not.toBeInTheDocument()
  })

  it('carries no link to a page this product does not have', () => {
    // Terms, Privacy and Data processing in the handoff's footer. Three dead
    // links under a sign-in form are worse than none.
    render()

    for (const name of [/Terms/i, /Privacy/i, /Data processing/i, /Status/i]) {
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument()
    }
  })

  it('stamps no build number it made up', () => {
    // "v4.2.1 · PK-CENTRAL-1" names a version and a region that do not exist.
    render()

    expect(screen.queryByText(/v4\.2\.1|PK-CENTRAL/i)).not.toBeInTheDocument()
  })

  it('claims nothing about the password it cannot show to be true', () => {
    render()

    expect(screen.getByText(/Passwords are hashed, never stored/)).toBeInTheDocument()
  })

  it('describes only capabilities this system has', () => {
    render()

    expect(screen.getByText('Document routing')).toBeInTheDocument()
    expect(screen.getByText('Audit ledger')).toBeInTheDocument()
    // "Real-time" was the phrase an earlier design used for approvals. The
    // queue is polled.
    expect(screen.queryByText(/real-time/i)).not.toBeInTheDocument()
  })

  it('shows the company logo as artwork rather than as type', () => {
    /*
     * The lockup has its own letterforms. Type set to look like them is an
     * imitation of a logo, which is the one thing a logo may not be.
     *
     * Two of them: the brand panel carries one and the form column carries
     * the other for the widths where the panel is hidden. Only ever one is in
     * the accessibility tree, because the other's container is `display:none`
     * - jsdom applies no CSS, so both are here.
     */
    render()

    const logos = screen.getAllByAltText('Ideas')

    expect(logos).toHaveLength(2)
    for (const logo of logos) {
      expect(logo).toHaveAttribute('src', '/ideas-logo.png')
      expect(logo).toHaveAttribute('width', '936')
      expect(logo).toHaveAttribute('height', '192')
    }
  })
})
