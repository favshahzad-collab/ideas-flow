import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearMailSettings,
  fetchMailQueue,
  saveMailSettings,
  sendTestMail,
  testMailConnection,
  type MailQueueSummary,
} from '../services/AdminApi'
import { renderWithProviders } from '../test/render'
import MailPage from './MailPage'

/**
 * The screen that moved mail configuration out of the server's environment.
 *
 * Most of these are about the credential, because that is the part that got
 * worse by moving and the part a form is most likely to get wrong. A blank
 * password field has to mean "keep the one you have" - otherwise changing a
 * port requires knowing the relay password, which is the exact situation this
 * screen exists to get somebody out of - and removing one has to be something
 * a person asks for rather than something an empty field does to them.
 */

vi.mock('../services/AdminApi', () => ({
  fetchMailQueue: vi.fn(),
  saveMailSettings: vi.fn(),
  clearMailSettings: vi.fn(),
  sendTestMail: vi.fn(),
  testMailConnection: vi.fn(),
}))

const read = vi.mocked(fetchMailQueue)
const save = vi.mocked(saveMailSettings)
const clear = vi.mocked(clearMailSettings)
const test = vi.mocked(sendTestMail)
const connect = vi.mocked(testMailConnection)

const summary = (overrides: Partial<MailQueueSummary['settings']> = {}): MailQueueSummary => ({
  configured: true,
  settings: {
    configured: true,
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    from: 'Ideas Flow <no-reply@example.com>',
    authenticated: false,
    appUrl: 'https://flow.example.com',
    appUrlIsDefault: false,
    source: 'database',
    passwordUnreadable: false,
    provider: 'SMTP',
    fromName: 'Ideas Flow',
    fromAddress: 'no-reply@example.com',
    tenantIdMasked: null,
    clientIdMasked: null,
    hasClientSecret: false,
    mailbox: null,
    saveToSentItems: true,
    ...overrides,
  },
  counts: { PENDING: 0, SENDING: 0, SENT: 12, FAILED: 0, EXPIRED: 0 },
  recentFailures: [],
})

const nothingConfigured = (): MailQueueSummary => ({
  configured: false,
  settings: {
    configured: false,
    host: null,
    port: null,
    secure: false,
    from: null,
    authenticated: false,
    appUrl: 'http://localhost:5173',
    appUrlIsDefault: true,
    source: 'none',
    passwordUnreadable: false,
    provider: 'SMTP',
    fromName: null,
    fromAddress: null,
    tenantIdMasked: null,
    clientIdMasked: null,
    hasClientSecret: false,
    mailbox: null,
    saveToSentItems: true,
  },
  counts: { PENDING: 0, SENDING: 0, SENT: 0, FAILED: 0, EXPIRED: 0 },
  recentFailures: [],
})

beforeEach(() => {
  read.mockReset()
  save.mockReset()
  clear.mockReset()
  test.mockReset()
  connect.mockReset()
  connect.mockResolvedValue({
    provider: 'MICROSOFT_GRAPH',
    detail: 'Connected. Sending as Ideas Flow <no-reply@example.com>.',
  })
  read.mockResolvedValue(summary())
  save.mockImplementation(input =>
    Promise.resolve(summary({ host: input.host, port: input.port }))
  )
  clear.mockResolvedValue(nothingConfigured())
  test.mockResolvedValue({ sentTo: 'admin@example.com' })
})

describe('what is already set', () => {
  it('fills the form in from the live configuration', async () => {
    renderWithProviders(<MailPage />)

    expect(await screen.findByLabelText('Hostname')).toHaveValue('smtp.example.com')
    expect(screen.getByLabelText('Port')).toHaveValue('587')
    // The sender is two fields now, because Graph will not take them as one.
    expect(screen.getByLabelText('Sender name')).toHaveValue('Ideas Flow')
    expect(screen.getByLabelText('Sender address')).toHaveValue('no-reply@example.com')
  })

  it("says when the values are the server's, not this screen's", async () => {
    // Both are legitimate and they look identical. Without this an
    // administrator edits the form and wonders why nothing changed.
    read.mockResolvedValue(summary({ source: 'environment' }))
    renderWithProviders(<MailPage />)

    expect(
      await screen.findByText(/coming from the server.s environment/i)
    ).toBeInTheDocument()
  })

  it('offers to hand mail back only when this screen owns it', async () => {
    read.mockResolvedValue(summary({ source: 'environment' }))
    renderWithProviders(<MailPage />)

    await screen.findByLabelText('Hostname')
    expect(
      screen.queryByRole('button', { name: 'Hand back to the server' })
    ).not.toBeInTheDocument()
  })
})

describe('saving it', () => {
  it('sends what was typed', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<MailPage />)

    const host = await screen.findByLabelText('Hostname')
    await user.clear(host)
    await user.type(host, 'smtp.office365.example')
    await user.click(screen.getByRole('button', { name: 'Save mail settings' }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'SMTP',
          host: 'smtp.office365.example',
          port: 587,
        })
      )
    )
  })

  it('leaves the password alone when the field is blank', async () => {
    /*
     * The whole reason the field can be blank. An administrator changing a
     * port must not have to know the relay password to do it - and on this
     * screen they cannot even see whether they have it right, because the
     * server never sends it back.
     */
    const user = userEvent.setup({ delay: null })
    read.mockResolvedValue(summary({ authenticated: true }))
    renderWithProviders(<MailPage />)

    const port = await screen.findByLabelText('Port')
    await user.clear(port)
    await user.type(port, '25')
    await user.click(screen.getByRole('button', { name: 'Save mail settings' }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ port: 25, password: '', clearPassword: undefined })
      )
    )
  })

  it('removes a password only when asked to', async () => {
    const user = userEvent.setup({ delay: null })
    read.mockResolvedValue(summary({ authenticated: true }))
    renderWithProviders(<MailPage />)

    await screen.findByLabelText('Hostname')
    await user.click(screen.getByRole('switch', { name: /Remove the stored account and password/i }))
    await user.click(screen.getByRole('button', { name: 'Save mail settings' }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ clearPassword: true }))
    )
  })

  it('does not offer to remove a password that is not there', async () => {
    renderWithProviders(<MailPage />)

    await screen.findByLabelText('Hostname')
    expect(
      screen.queryByRole('switch', { name: /Remove the stored account and password/i })
    ).not.toBeInTheDocument()
  })

  it('clears the password field once it has been sent', async () => {
    // It is write-only, so leaving it on screen after a save invites somebody
    // to think it is what is stored.
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<MailPage />)

    const password = await screen.findByLabelText('Password')
    await user.type(password, 'hunter2')
    await user.click(screen.getByRole('button', { name: 'Save mail settings' }))

    await waitFor(() => expect(password).toHaveValue(''))
  })

  it('will not send without a hostname', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<MailPage />)

    await user.clear(await screen.findByLabelText('Hostname'))

    expect(screen.getByRole('button', { name: 'Save mail settings' })).toBeDisabled()
    expect(save).not.toHaveBeenCalled()
  })

  it('refuses a port that is not one', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<MailPage />)

    const port = await screen.findByLabelText('Port')
    await user.clear(port)
    await user.type(port, '70000')

    expect(screen.getByText('Between 1 and 65535.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save mail settings' })).toBeDisabled()
  })

  it('says so when the address people click is not an address', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<MailPage />)

    const appUrl = await screen.findByLabelText('Address people click in an email')
    await user.clear(appUrl)
    await user.type(appUrl, 'flow.example.com')

    expect(screen.getByText('Start it with http:// or https://.')).toBeInTheDocument()
  })

  it("hands over the server's refusal rather than a generic failure", async () => {
    const user = userEvent.setup({ delay: null })
    save.mockRejectedValue(new Error('That account needs a password.'))
    renderWithProviders(<MailPage />)

    await screen.findByLabelText('Hostname')
    await user.click(screen.getByRole('button', { name: 'Save mail settings' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That account needs a password.'
    )
  })
})

describe('a password that cannot be read', () => {
  it('says to enter it again, rather than looking like a network fault', async () => {
    // What a rotated JWT_SECRET looks like. Authenticating with nothing
    // against a relay that expects a login is refused in a way that reads
    // like an unreachable host, and somebody goes to the firewall.
    read.mockResolvedValue(summary({ authenticated: false, passwordUnreadable: true }))
    renderWithProviders(<MailPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot be read/i)
  })
})

describe('proving it works', () => {
  it('sends a test to your own address and says where it went', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<MailPage />)

    await user.click(await screen.findByRole('button', { name: 'Send a test email' }))

    await waitFor(() =>
      expect(screen.getByText(/Sent to admin@example.com/)).toBeInTheDocument()
    )
  })

  it('offers no box to type a recipient into', async () => {
    // An endpoint that mails chosen text to a chosen address is an open relay,
    // and a field here would be the first request to add one.
    renderWithProviders(<MailPage />)

    await screen.findByLabelText('Hostname')
    expect(screen.queryByLabelText(/send.*to/i)).not.toBeInTheDocument()
  })

  it('re-reads the queue after a refused test', async () => {
    // A refused test writes a FAILED row. Leaving the old counts up left the
    // card reading "Failed 0" directly above the refusal it just printed.
    const user = userEvent.setup({ delay: null })
    test.mockRejectedValue(new Error('550 relay access denied'))
    renderWithProviders(<MailPage />)

    await user.click(await screen.findByRole('button', { name: 'Send a test email' }))

    expect(await screen.findByText('550 relay access denied')).toBeInTheDocument()
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  })

  it('does not offer a test when there is no server to test', async () => {
    read.mockResolvedValue(nothingConfigured())
    renderWithProviders(<MailPage />)

    await screen.findByLabelText('Hostname')
    expect(
      screen.queryByRole('button', { name: 'Send a test email' })
    ).not.toBeInTheDocument()
    expect(screen.getByText(/No provider is set/i)).toBeInTheDocument()
  })
})

describe('the links in every notice', () => {
  it('warns when they would point at the development default', async () => {
    /*
     * The quiet failure this screen exists to surface: mail configured
     * correctly, queue clean, and every approver receiving a link that only
     * works on the server itself.
     */
    read.mockResolvedValue(summary({ appUrl: 'http://localhost:5173', appUrlIsDefault: true }))
    renderWithProviders(<MailPage />)

    const warning = await screen.findByRole('alert')
    expect(within(warning).getByText('http://localhost:5173')).toBeInTheDocument()
  })
})

describe('handing mail back to the server', () => {
  it('clears the stored configuration', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<MailPage />)

    await user.click(
      await screen.findByRole('button', { name: 'Hand back to the server' })
    )

    await waitFor(() => expect(clear).toHaveBeenCalled())
    expect(await screen.findByText(/No provider is set/i)).toBeInTheDocument()
  })
})

describe('choosing Microsoft Graph', () => {
  /**
   * The provider this screen exists to make reachable. Graph has no host, no
   * port and no TLS setting, and the reason it is worth preferring on
   * Microsoft 365 - that SPF stops being in the way - is something an
   * administrator can only act on if the screen says it where they choose.
   */
  const graphSummary = () =>
    summary({
      provider: 'MICROSOFT_GRAPH',
      host: null,
      port: null,
      tenantIdMasked: '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u20225555',
      clientIdMasked: '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u20220000',
      hasClientSecret: true,
      mailbox: 'no-reply@example.com',
    })

  it('asks for an application rather than a hostname', async () => {
    read.mockResolvedValue(graphSummary())
    renderWithProviders(<MailPage />)

    expect(await screen.findByLabelText('Directory (tenant) ID')).toBeInTheDocument()
    expect(screen.getByLabelText('Application (client) ID')).toBeInTheDocument()
    expect(screen.getByLabelText('Client secret')).toBeInTheDocument()
    // Asking for these would be describing something that does not exist.
    expect(screen.queryByLabelText('Hostname')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Port')).not.toBeInTheDocument()
  })

  it('says the authentication is application-only, with no callback to set up', async () => {
    // The question every reader asks next, answered where they are.
    read.mockResolvedValue(graphSummary())
    renderWithProviders(<MailPage />)

    expect(await screen.findByText(/client credentials/i)).toBeInTheDocument()
    expect(screen.getByText(/no callback URL to configure/i)).toBeInTheDocument()
  })

  it('warns that the permission is tenant-wide', async () => {
    /*
     * The one thing this application cannot enforce about itself: app-only
     * Mail.Send is good for every mailbox in the directory, and naming one in
     * the form does not change that. Somebody reading this screen would
     * otherwise reasonably assume it did.
     */
    read.mockResolvedValue(graphSummary())
    renderWithProviders(<MailPage />)

    expect(await screen.findByText(/tenant-wide/i)).toBeInTheDocument()
    expect(screen.getByText(/ApplicationAccessPolicy/)).toBeInTheDocument()
  })

  it('shows the tenant and client ids masked, never in full', async () => {
    read.mockResolvedValue(graphSummary())
    renderWithProviders(<MailPage />)

    await screen.findByLabelText('Directory (tenant) ID')
    expect(screen.getByText(/Currently .*5555/)).toBeInTheDocument()
    // Fields for credentials start empty: what is stored is never sent back.
    expect(screen.getByLabelText('Directory (tenant) ID')).toHaveValue('')
    expect(screen.getByLabelText('Client secret')).toHaveValue('')
  })

  it('can be saved without retyping a secret that is already stored', async () => {
    // Otherwise changing the mailbox means going back to the portal to
    // regenerate a perfectly good secret.
    const user = userEvent.setup({ delay: null })
    read.mockResolvedValue(graphSummary())
    renderWithProviders(<MailPage />)

    const mailbox = await screen.findByLabelText('Send as mailbox')
    await user.clear(mailbox)
    await user.type(mailbox, 'notices@example.com')
    await user.click(screen.getByRole('button', { name: 'Save mail settings' }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'MICROSOFT_GRAPH',
          mailbox: 'notices@example.com',
          clientSecret: '',
        }),
      ),
    )
  })

  it('will not be saved with no secret at all the first time', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<MailPage />)

    await user.click(await screen.findByRole('radio', { name: /Microsoft Graph/i }))
    await user.type(screen.getByLabelText('Directory (tenant) ID'), 'a-tenant')
    await user.type(screen.getByLabelText('Application (client) ID'), 'a-client')

    expect(screen.getByRole('button', { name: 'Save mail settings' })).toBeDisabled()
    expect(save).not.toHaveBeenCalled()
  })

  it('switches from SMTP without carrying a hostname across', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<MailPage />)

    await user.click(await screen.findByRole('radio', { name: /Microsoft Graph/i }))
    await user.type(screen.getByLabelText('Directory (tenant) ID'), 'a-tenant')
    await user.type(screen.getByLabelText('Application (client) ID'), 'a-client')
    await user.type(screen.getByLabelText('Client secret'), 'a-secret')
    await user.click(screen.getByRole('button', { name: 'Save mail settings' }))

    await waitFor(() => expect(save).toHaveBeenCalled())
    const sent = save.mock.calls[0][0]
    expect(sent.provider).toBe('MICROSOFT_GRAPH')
    expect(sent.host).toBeUndefined()
    expect(sent.port).toBeUndefined()
  })

  it('refuses a sender address with a display name glued to it', async () => {
    // Graph will not take one, and neither will any address validator. The
    // name has a field of its own now.
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<MailPage />)

    const address = await screen.findByLabelText('Sender address')
    await user.clear(address)
    await user.type(address, 'Ideas Flow <no-reply@example.com>')

    expect(screen.getByText(/Just the address/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save mail settings' })).toBeDisabled()
  })
})

describe('testing the connection', () => {
  it('says nothing has been tested until somebody tests it', async () => {
    // Honest, and it keeps the screen from making an outbound call to
    // Microsoft every time an administrator opens it.
    renderWithProviders(<MailPage />)

    expect(await screen.findByText('Not tested yet.')).toBeInTheDocument()
    expect(connect).not.toHaveBeenCalled()
  })

  it('reports a connection without sending anything', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<MailPage />)

    await user.click(await screen.findByRole('button', { name: 'Test connection' }))

    expect(await screen.findByText('Connected.')).toBeInTheDocument()
    expect(screen.getByText(/Sending as Ideas Flow/)).toBeInTheDocument()
    expect(test).not.toHaveBeenCalled()
  })

  it('hands over the refusal from Microsoft rather than a generic failure', async () => {
    /*
     * The whole value of a separate connection test: "the secret is wrong" and
     * "nobody consented to the permission" are fixed in different places, and
     * a single "mail does not work" tells an administrator neither.
     */
    const user = userEvent.setup({ delay: null })
    connect.mockRejectedValue(
      new Error(
        'The application is not allowed to send. Grant the Mail.Send application permission and give it admin consent.',
      ),
    )
    renderWithProviders(<MailPage />)

    await user.click(await screen.findByRole('button', { name: 'Test connection' }))

    expect(await screen.findByText('Not connected.')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent(/admin consent/i)
  })
})
