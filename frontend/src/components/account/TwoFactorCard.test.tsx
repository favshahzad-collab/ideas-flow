import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateTwoFactor,
  disableTwoFactor,
  fetchTwoFactorStatus,
  replaceRecoveryCodes,
  startTwoFactorSetup,
  type TwoFactorStatus,
} from '../../services/authApi'
import { renderWithProviders } from '../../test/render'
import TwoFactorCard from './TwoFactorCard'

/**
 * Turning on two-step sign-in, from the account page.
 *
 * Most of these are about the two ways this card can lock somebody out of
 * their own approvals. The first is switching the factor on before a code has
 * actually come back from the phone - at which point the person has a secret
 * nothing can produce codes for. The second is showing the recovery codes in
 * a way that lets somebody click past them: they are stored hashed, so this
 * screen is the only time they exist in readable form anywhere.
 *
 * The QR encoder is stubbed. What it draws is `qrcode`'s business and is
 * covered by its own vectors; what matters here is that the setup key is on
 * screen beside it, because an image that fails to render must not be the
 * only way through.
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

const read = vi.mocked(fetchTwoFactorStatus)
const begin = vi.mocked(startTwoFactorSetup)
const activate = vi.mocked(activateTwoFactor)
const regenerate = vi.mocked(replaceRecoveryCodes)
const turnOff = vi.mocked(disableTwoFactor)

const status = (overrides: Partial<TwoFactorStatus> = {}): TwoFactorStatus => ({
  enabled: false,
  activatedAt: null,
  pending: false,
  recoveryCodesRemaining: 0,
  recoveryCodesUsed: 0,
  secretUnreadable: false,
  ...overrides,
})

const on = (overrides: Partial<TwoFactorStatus> = {}) =>
  status({
    enabled: true,
    activatedAt: '2026-09-12T09:00:00.000Z',
    recoveryCodesRemaining: 10,
    ...overrides,
  })

const CODES = ['AAAA-BBBB-CCCC-DDDD', 'EEEE-FFFF-GGGG-HHHH']

const render = () => renderWithProviders(<TwoFactorCard />)

beforeEach(() => {
  vi.clearAllMocks()
  read.mockResolvedValue(status())
  begin.mockResolvedValue({
    secret: 'MZXW6YTBOIMZXW6YTBOIMZXW6YTBOIMZ',
    otpauthUri: 'otpauth://totp/IdeasFlow:a%40b.c?secret=MZXW6YTBOI',
  })
  activate.mockResolvedValue({
    activatedAt: '2026-09-12T09:00:00.000Z',
    recoveryCodes: CODES,
  })
})

describe('before it is turned on', () => {
  it('says what the password alone gets you today', async () => {
    render()

    expect(
      await screen.findByText(/password alone gets you in today/i)
    ).toBeInTheDocument()
  })

  it('shows the setup key beside the QR code, not only the image', async () => {
    /*
     * The image can fail - a blocked data URI, a printed page, somebody using
     * a desktop authenticator with no camera. Every app takes a typed key, so
     * the key is always on screen rather than behind a "can't scan?" link.
     */
    const user = userEvent.setup({ delay: null })
    render()

    await user.click(
      await screen.findByRole('button', { name: /set up two-step/i })
    )

    expect(await screen.findByText(/enter this setup key/i)).toBeInTheDocument()
    // Grouped in fours, which is how anybody transcribes 32 characters.
    expect(screen.getByText(/MZXW 6YTB OIMZ/)).toBeInTheDocument()
  })

  it('names the alternative in the image alt text', async () => {
    const user = userEvent.setup({ delay: null })
    render()

    await user.click(
      await screen.findByRole('button', { name: /set up two-step/i })
    )

    expect(
      await screen.findByAltText(/if you cannot scan it, use the setup key/i)
    ).toBeInTheDocument()
  })
})

describe('confirming the code', () => {
  it('does not switch anything on until one is typed', async () => {
    /*
     * The rule the whole two-step enrolment exists for. A secret handed out is
     * a QR code drawn, not a phone that can read it - and switching the factor
     * on at that point is how somebody locks themselves out during setup.
     */
    const user = userEvent.setup({ delay: null })
    render()

    await user.click(
      await screen.findByRole('button', { name: /set up two-step/i })
    )
    await screen.findByLabelText(/code from the app/i)

    expect(activate).not.toHaveBeenCalled()
    expect(
      screen.getByText(/two-step sign-in stays off/i)
    ).toBeInTheDocument()
  })

  it('sends the code', async () => {
    const user = userEvent.setup({ delay: null })
    render()

    await user.click(
      await screen.findByRole('button', { name: /set up two-step/i })
    )
    await user.type(await screen.findByLabelText(/code from the app/i), '123456')
    await user.click(screen.getByRole('button', { name: /turn it on/i }))

    await waitFor(() => expect(activate).toHaveBeenCalledWith('123456'))
  })

  it('keeps a refusal on screen and clears the field', async () => {
    const user = userEvent.setup({ delay: null })
    activate.mockRejectedValue(
      new Error("That code was not accepted. Check your phone's clock.")
    )
    render()

    await user.click(
      await screen.findByRole('button', { name: /set up two-step/i })
    )
    await user.type(await screen.findByLabelText(/code from the app/i), '000000')
    await user.click(screen.getByRole('button', { name: /turn it on/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/clock/i)
    expect(screen.getByLabelText(/code from the app/i)).toHaveValue('')
  })
})

describe('the recovery codes', () => {
  const reach = async (user: ReturnType<typeof userEvent.setup>) => {
    render()
    await user.click(
      await screen.findByRole('button', { name: /set up two-step/i })
    )
    await user.type(await screen.findByLabelText(/code from the app/i), '123456')
    await user.click(screen.getByRole('button', { name: /turn it on/i }))
    return screen.findByText(CODES[0])
  }

  it('are shown once the factor is on', async () => {
    const user = userEvent.setup({ delay: null })

    await reach(user)

    expect(screen.getByText(CODES[1])).toBeInTheDocument()
  })

  it('say plainly that this is the only time they are shown', async () => {
    /*
     * Not softened. They are stored hashed, so there is no screen that could
     * show them again without keeping a table of live credentials in the
     * clear - and somebody who clicks past believing otherwise finds out on
     * the morning they have lost their phone.
     */
    const user = userEvent.setup({ delay: null })

    await reach(user)

    expect(
      screen.getByText(/only time they are shown/i)
    ).toBeInTheDocument()
    expect(screen.getByText(/stored hashed/i)).toBeInTheDocument()
  })

  it('are not dismissed by anything except saying so', async () => {
    // No auto-close, no timeout, no "continue" that means something else.
    const user = userEvent.setup({ delay: null })

    await reach(user)

    expect(
      screen.getByRole('button', { name: /i have saved them/i })
    ).toBeInTheDocument()
  })

  it('offer a download, because a screenshot of a password is not a plan', async () => {
    const user = userEvent.setup({ delay: null })

    await reach(user)

    expect(
      screen.getByRole('button', { name: /download/i })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument()
  })
})

describe('once it is on', () => {
  beforeEach(() => {
    read.mockResolvedValue(on())
  })

  it('says so, and how many ways back in are left', async () => {
    render()

    expect(await screen.findByText('On')).toBeInTheDocument()
    expect(screen.getByText(/10 of 10/)).toBeInTheDocument()
  })

  it('warns in words when the codes are running out, not only in colour', async () => {
    // Colour alone fails a person who cannot see it, and this is the number
    // that decides whether they can get back in at all.
    read.mockResolvedValue(on({ recoveryCodesRemaining: 2, recoveryCodesUsed: 8 }))
    render()

    expect(await screen.findByText(/running low/i)).toBeInTheDocument()
  })

  it('trades a live code for a fresh set', async () => {
    const user = userEvent.setup({ delay: null })
    regenerate.mockResolvedValue({ recoveryCodes: CODES })
    render()

    await user.type(await screen.findByLabelText(/new recovery codes/i), '123456')
    await user.click(screen.getByRole('button', { name: /generate new codes/i }))

    await waitFor(() => expect(regenerate).toHaveBeenCalledWith('123456'))
    expect(await screen.findByText(/old ones no longer work/i)).toBeInTheDocument()
  })

  it('asks for the password before turning it off, not a code', async () => {
    /*
     * The threat is an unlocked laptop somebody walked away from. A phone in
     * a pocket across the room is no obstacle to whoever sat down at it.
     */
    const user = userEvent.setup({ delay: null })
    render()

    await user.click(await screen.findByRole('button', { name: /turn off/i }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText(/your password/i)).toHaveAttribute(
      'type',
      'password'
    )
    expect(turnOff).not.toHaveBeenCalled()
  })

  it('says what turning it off costs before it happens', async () => {
    const user = userEvent.setup({ delay: null })
    render()

    await user.click(await screen.findByRole('button', { name: /turn off/i }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/recovery codes stop working/i)
  })

  it('turns it off once the password is given', async () => {
    const user = userEvent.setup({ delay: null })
    turnOff.mockResolvedValue({ enabled: false })
    read.mockResolvedValueOnce(on()).mockResolvedValue(status())
    render()

    await user.click(await screen.findByRole('button', { name: /turn off/i }))

    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/your password/i), 'a-password')
    await user.click(within(dialog).getByRole('button', { name: /turn it off/i }))

    await waitFor(() => expect(turnOff).toHaveBeenCalledWith('a-password'))
  })

  it('keeps a wrong password on screen inside the dialog', async () => {
    const user = userEvent.setup({ delay: null })
    turnOff.mockRejectedValue(new Error('That password is not correct.'))
    render()

    await user.click(await screen.findByRole('button', { name: /turn off/i }))

    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/your password/i), 'wrong')
    await user.click(within(dialog).getByRole('button', { name: /turn it off/i }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /not correct/i
    )
  })
})

describe('an unfinished setup', () => {
  it('offers to start again, and says the old QR code is dead', async () => {
    /*
     * Otherwise somebody scans a second code, the server replaces the secret,
     * and the phone quietly holds the wrong one - which shows up only as a
     * correct code being refused, with nothing on screen to explain it.
     */
    read.mockResolvedValue(status({ pending: true }))
    render()

    expect(await screen.findByText(/did not finish/i)).toBeInTheDocument()
    expect(
      screen.getByText(/one your phone already holds will not work/i)
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /start again/i })
    ).toBeInTheDocument()
  })
})

describe('a secret that will not decrypt', () => {
  it('names the cause and the way out', async () => {
    // Its own state, because otherwise it reads as "your code is wrong" at
    // somebody typing the right one.
    read.mockResolvedValue(on({ secretUnreadable: true }))
    render()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/JWT_SECRET/)
    expect(alert).toHaveTextContent(/recovery code/i)
  })
})

describe('when it cannot be read at all', () => {
  it('says so and offers to try again', async () => {
    read.mockRejectedValueOnce(new Error('Could not reach the server.'))
    render()

    expect(
      await screen.findByText('Could not reach the server.')
    ).toBeInTheDocument()

    read.mockResolvedValue(on())
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))

    expect(await screen.findByText('On')).toBeInTheDocument()
  })
})
