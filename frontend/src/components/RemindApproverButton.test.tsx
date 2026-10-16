import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { remindApprover } from '../services/approvalApi'
import { renderWithProviders } from '../test/render'
import RemindApproverButton from './RemindApproverButton'

/**
 * Asking somebody to look at a memo.
 *
 * The button itself decides nothing - who may send one, who is told and how
 * often are all the server's - so what these hold shut is the reporting. A
 * control that says nothing back is a control somebody presses four times,
 * and four reminders is the thing this feature must never produce.
 */

vi.mock('../services/approvalApi', () => ({
  remindApprover: vi.fn(),
}))

const send = vi.mocked(remindApprover)

const button = (holderFirstName?: string) =>
  renderWithProviders(
    <RemindApproverButton documentId="doc-1" holderFirstName={holderFirstName} />
  )

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the label', () => {
  it('names the person waiting on it, when the page knows who that is', () => {
    button('Omar')

    expect(screen.getByRole('button', { name: 'Remind Omar' })).toBeInTheDocument()
  })

  it('falls back to the plain verb rather than a blank name', () => {
    button()

    expect(screen.getByRole('button', { name: 'Send a reminder' })).toBeInTheDocument()
  })
})

describe('when it goes', () => {
  it('says who was told, and stops offering to tell them again', async () => {
    const user = userEvent.setup()
    send.mockResolvedValue({
      message: 'Omar Haddad has been reminded.',
      remindedUserId: 'u-omar',
      recipients: 1,
    })
    button('Omar')

    await user.click(screen.getByRole('button', { name: 'Remind Omar' }))

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Omar Haddad has been reminded.'
    )
    expect(screen.queryByRole('button', { name: 'Remind Omar' })).not.toBeInTheDocument()
    expect(send).toHaveBeenCalledExactlyOnceWith('doc-1')
  })

  it('reports that the colleague covering was told as well', async () => {
    // Two people can act on the step while a delegation is in force, and the
    // person who pressed the button is entitled to know both were told.
    const user = userEvent.setup()
    send.mockResolvedValue({
      message: 'Omar Haddad and the colleague covering for them have been reminded.',
      remindedUserId: 'u-omar',
      recipients: 2,
    })
    button('Omar')

    await user.click(screen.getByRole('button', { name: 'Remind Omar' }))

    expect(await screen.findByRole('status')).toHaveTextContent(
      'and the colleague covering for them'
    )
  })
})

describe('when it does not', () => {
  it('hands over the refusal the server wrote, which is the useful half', async () => {
    /*
     * "You can send another in 9 hours" is the answer to the question the
     * person is about to ask. A generic "Could not send the reminder" would
     * replace an answer with a shrug.
     */
    const user = userEvent.setup()
    send.mockRejectedValue(
      new Error(
        'Omar was reminded about this memo less than 12 hours ago. You can send another in 9 hours.'
      )
    )
    button('Omar')

    await user.click(screen.getByRole('button', { name: 'Remind Omar' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('You can send another in 9 hours')
  })

  it('leaves the button there, because the refusal may be temporary', async () => {
    const user = userEvent.setup()
    send.mockRejectedValue(new Error('Network is down'))
    button('Omar')

    await user.click(screen.getByRole('button', { name: 'Remind Omar' }))

    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: 'Remind Omar' })).toBeEnabled()
  })

  it('clears the last refusal when it is pressed again', async () => {
    // Otherwise a stale "you can send another in 9 hours" sits beside a
    // reminder that has just gone out.
    const user = userEvent.setup()
    send.mockRejectedValueOnce(new Error('Network is down'))
    send.mockResolvedValue({
      message: 'Omar Haddad has been reminded.',
      remindedUserId: 'u-omar',
      recipients: 1,
    })
    button('Omar')

    await user.click(screen.getByRole('button', { name: 'Remind Omar' }))
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: 'Remind Omar' }))

    expect(await screen.findByRole('status')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
