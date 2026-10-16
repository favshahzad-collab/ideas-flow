import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiJson } from '../services/apiClient'
import { fetchSsoAvailable } from '../services/authApi'
import { confirmWithMicrosoft } from '../services/microsoftStepUp'
import { askForStepUp, currentStepUp, forgetStepUp } from '../services/stepUp'
import { CurrentUserContext, type CurrentUser } from '../contexts/currentUser'
import StepUpDialog from './StepUpDialog'

/**
 * "Confirm it's you". `apiFetch` opens this when the server refuses a
 * sensitive change and resends the change once it resolves true; that half is
 * in apiClient.test.ts. What is held here is the dialog: what it sends, what
 * it keeps, and that cancelling or a wrong answer never counts as confirmed.
 */

vi.mock('../services/apiClient', () => ({
  apiJson: vi.fn(),
  jsonBody: (payload: unknown) => ({
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }),
}))

vi.mock('../services/authApi', () => ({
  fetchSsoAvailable: vi.fn(),
}))

vi.mock('../services/microsoftStepUp', () => ({
  confirmWithMicrosoft: vi.fn(),
}))

const confirmOnServer = vi.mocked(apiJson)
const ssoAvailable = vi.mocked(fetchSsoAvailable)
const microsoft = vi.mocked(confirmWithMicrosoft)

beforeEach(() => {
  forgetStepUp()
  confirmOnServer.mockReset()
  ssoAvailable.mockReset().mockResolvedValue(false)
  microsoft.mockReset()
})

afterEach(() => {
  forgetStepUp()
})

const opened = () => {
  render(<StepUpDialog />)
  let answer!: Promise<boolean>
  act(() => {
    answer = askForStepUp()
  })
  return answer
}

describe('confirming it is you', () => {
  it('sends the password, keeps the confirmation, and says yes', async () => {
    const user = userEvent.setup({ delay: null })
    confirmOnServer.mockResolvedValue({
      stepUpToken: 'confirmation-1',
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    })
    const answer = opened()

    await user.type(await screen.findByLabelText('Your password'), 'copper kettle morning rain')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    await expect(answer).resolves.toBe(true)
    expect(confirmOnServer).toHaveBeenCalledWith(
      '/api/auth/step-up',
      expect.objectContaining({ body: JSON.stringify({ password: 'copper kettle morning rain' }) }),
    )
    expect(currentStepUp()).toBe('confirmation-1')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('can use a code from the authenticator app instead', async () => {
    const user = userEvent.setup({ delay: null })
    confirmOnServer.mockResolvedValue({
      stepUpToken: 'confirmation-2',
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    })
    const answer = opened()

    await user.click(
      await screen.findByRole('button', { name: 'Use a code from my authenticator app instead' }),
    )
    await user.type(screen.getByLabelText('Code from your authenticator app'), '123456')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    await expect(answer).resolves.toBe(true)
    expect(confirmOnServer).toHaveBeenCalledWith(
      '/api/auth/step-up',
      expect.objectContaining({ body: JSON.stringify({ code: '123456' }) }),
    )
  })

  it('stays open and says why when the answer is wrong', async () => {
    const user = userEvent.setup({ delay: null })
    confirmOnServer.mockRejectedValue(new Error('That password or code is not right.'))
    opened()

    await user.type(await screen.findByLabelText('Your password'), 'not it')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('That password or code is not right.')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(currentStepUp()).toBeNull()
  })

  it('says no when the person cancels, and keeps nothing', async () => {
    const user = userEvent.setup({ delay: null })
    const answer = opened()

    await user.click(await screen.findByRole('button', { name: 'Cancel' }))

    await expect(answer).resolves.toBe(false)
    expect(confirmOnServer).not.toHaveBeenCalled()
    expect(currentStepUp()).toBeNull()
  })
})

describe('confirming it is you to sign', () => {
  it('says the confirmation is for signing when signing asked for it', async () => {
    render(<StepUpDialog />)
    act(() => {
      void askForStepUp('sign')
    })

    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you to sign" })
    expect(dialog).toHaveAccessibleDescription(/signature is binding/)
  })

  it('keeps the administration wording for everything else', async () => {
    opened()
    expect(await screen.findByRole('dialog', { name: "Confirm it's you" })).toHaveAccessibleDescription(
      /who can sign, approve or administer/,
    )
  })

  it('says a rejection or a return is a decision on the record', async () => {
    render(<StepUpDialog />)
    act(() => {
      void askForStepUp('decide')
    })

    const dialog = await screen.findByRole('dialog', {
      name: "Confirm it's you to record this decision",
    })
    expect(dialog).toHaveAccessibleDescription(/decision on the record/)
  })
})

describe('confirming it is you with Microsoft', () => {
  /** Somebody who signs in only with Microsoft: no password, no app. */
  const microsoftOnly = {
    hasPassword: false,
    hasAuthenticator: false,
  } as CurrentUser

  const openedAs = (user: CurrentUser) => {
    render(
      <CurrentUserContext.Provider
        value={{ user, loading: false, error: null, refetch: async () => {} }}
      >
        <StepUpDialog />
      </CurrentUserContext.Provider>,
    )
    let answer!: Promise<boolean>
    act(() => {
      answer = askForStepUp()
    })
    return answer
  }

  it('offers only Microsoft to somebody with no password and no app', async () => {
    ssoAvailable.mockResolvedValue(true)
    openedAs(microsoftOnly)

    expect(await screen.findByRole('button', { name: 'Confirm with Microsoft' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Your password')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
  })

  it('keeps the confirmation a fresh Microsoft sign-in earns', async () => {
    const user = userEvent.setup({ delay: null })
    ssoAvailable.mockResolvedValue(true)
    microsoft.mockResolvedValue({
      stepUpToken: 'confirmation-ms',
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    })
    const answer = openedAs(microsoftOnly)

    await user.click(await screen.findByRole('button', { name: 'Confirm with Microsoft' }))

    await expect(answer).resolves.toBe(true)
    expect(currentStepUp()).toBe('confirmation-ms')
  })

  it('asks for the app code first from somebody with the app and no password', async () => {
    openedAs({ hasPassword: false, hasAuthenticator: true } as CurrentUser)

    expect(await screen.findByLabelText('Code from your authenticator app')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Use my password instead' }),
    ).not.toBeInTheDocument()
  })

  it('does not offer Microsoft where it is not switched on', async () => {
    openedAs({ hasPassword: true, hasAuthenticator: true } as CurrentUser)

    await screen.findByLabelText('Your password')
    expect(screen.queryByRole('button', { name: 'Confirm with Microsoft' })).not.toBeInTheDocument()
  })
})
