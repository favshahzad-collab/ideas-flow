import { useEffect, useState } from 'react'
import { CheckCircle2, Cloud, MailWarning, Send, ServerCog } from 'lucide-react'
import { Page, PageHeader } from '../components/ui/Page'
import { Card, CardHeader } from '../components/ui/Card'
import Button from '../components/ui/Button'
import Eyebrow from '../components/ui/Eyebrow'
import Switch from '../components/ui/Switch'
import {
  clearMailSettings,
  fetchMailQueue,
  saveMailSettings,
  sendTestMail,
  testMailConnection,
  type MailProvider,
  type MailQueueSummary,
} from '../services/AdminApi'

/**
 * The mail configuration, set from inside the application.
 *
 * Two providers, and the screen leads with which one rather than with a
 * hostname, because they are not variations of one thing. Microsoft Graph
 * hands the message to Exchange Online through the API; SMTP relays it in.
 * The first has no host, no port and no TLS setting, and a form that asked for
 * them anyway would be describing something that does not exist.
 *
 * Graph is the one to prefer on Microsoft 365, for a reason worth stating
 * where somebody choosing will read it: a relay has to be authorised in DNS by
 * an SPF record before anybody believes it, and the failure when it is not is
 * silent - notices land in Junk and the memos simply sit. Graph moves that
 * problem inside the tenant.
 *
 * Everything secret here is write-only. The server returns whether a
 * credential is stored, never the credential, and the tenant and client ids
 * come back with only their tails showing: not secrets, but together they name
 * a target, and this page ends up in screenshots.
 */
export default function MailPage() {
  const [summary, setSummary] = useState<MailQueueSummary | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = async () => {
    try {
      setSummary(await fetchMailQueue())
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not read the mail settings.')
    }
  }

  useEffect(() => {
    // Once, and abandoned if the screen goes away first.
    let cancelled = false

    fetchMailQueue()
      .then(result => {
        if (!cancelled) setSummary(result)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : 'Could not read the mail settings.')
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Page width="narrow">
      <PageHeader
        eyebrow="Administration · Mail"
        title="Mail"
        description="How approval notices leave the building, and what the links in them point at."
      />

      {loadError && (
        <p role="alert" className="field-error">
          {loadError}
        </p>
      )}

      {/*
        * Nothing until there is something to show. Rendering the form first and
        * filling it in afterwards means a blank form on screen for a moment,
        * and an administrator who starts typing into it loses what they typed
        * when the answer lands.
        *
        * Keyed on where the configuration comes from, so the form re-baselines
        * exactly when it should: when somebody hands mail back to the server.
        * An ordinary save leaves the key alone, so the fields keep what was
        * just saved rather than flickering.
        */}
      {summary ? (
        <>
          <SettingsCard
            key={summary.settings.source}
            summary={summary}
            onSaved={setSummary}
          />
          <QueueCard summary={summary} onReload={load} />
        </>
      ) : (
        !loadError && <p className="text-meta text-content-subtle">Reading the mail settings…</p>
      )}
    </Page>
  )
}

function SettingsCard({
  summary,
  onSaved,
}: {
  summary: MailQueueSummary
  onSaved: (summary: MailQueueSummary) => void
}) {
  const settings = summary.settings
  const fromDatabase = settings.source === 'database'

  const [provider, setProvider] = useState<MailProvider>(settings.provider)

  // Both providers.
  const [fromName, setFromName] = useState(settings.fromName ?? '')
  const [fromAddress, setFromAddress] = useState(settings.fromAddress ?? '')
  const [appUrl, setAppUrl] = useState(settings.appUrlIsDefault ? '' : settings.appUrl)

  // Microsoft Graph.
  const [tenantId, setTenantId] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [clearClientSecret, setClearClientSecret] = useState(false)
  const [mailbox, setMailbox] = useState(settings.mailbox ?? '')
  const [saveToSentItems, setSaveToSentItems] = useState(settings.saveToSentItems)

  // SMTP.
  const [host, setHost] = useState(settings.host ?? '')
  const [port, setPort] = useState(settings.port ? String(settings.port) : '587')
  const [secure, setSecure] = useState(settings.secure)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const graph = provider === 'MICROSOFT_GRAPH'
  const portNumber = Number(port)
  const portValid = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535
  const addressValid = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(fromAddress.trim())

  /*
   * What is already stored counts towards a complete form, so that changing
   * the mailbox does not mean going back to the portal for a secret we were
   * already given. Only the first save has to carry one.
   */
  const alreadyGraph = settings.provider === 'MICROSOFT_GRAPH'
  const has = (typed: string, stored: string | null) =>
    typed.trim() !== '' || (alreadyGraph && Boolean(stored))
  const secretSatisfied =
    clientSecret.trim() !== '' || (alreadyGraph && settings.hasClientSecret && !clearClientSecret)

  const ready =
    !busy &&
    addressValid &&
    (graph
      ? has(tenantId, settings.tenantIdMasked) &&
        has(clientId, settings.clientIdMasked) &&
        secretSatisfied
      : host.trim() !== '' && portValid)

  const submit = async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const next = await saveMailSettings({
        provider,
        fromName: fromName.trim(),
        fromAddress: fromAddress.trim(),
        appUrl: appUrl.trim(),
        ...(graph
          ? {
              tenantId: tenantId.trim(),
              clientId: clientId.trim(),
              clientSecret,
              clearClientSecret: clearClientSecret || undefined,
              mailbox: mailbox.trim(),
              saveToSentItems,
            }
          : {
              host: host.trim(),
              port: portNumber,
              secure,
              username: username.trim(),
              password,
              clearPassword: clearPassword || undefined,
            }),
      })
      onSaved(next)
      setClientSecret('')
      setPassword('')
      setClearClientSecret(false)
      setClearPassword(false)
      setSaved(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the mail settings.')
    } finally {
      setBusy(false)
    }
  }

  const handBack = async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      onSaved(await clearMailSettings())
      setClientSecret('')
      setPassword('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not clear the mail settings.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader
        icon={graph ? Cloud : ServerCog}
        title="Mail provider"
        hint="Approval notices are queued whatever happens here. This is what delivers them."
      />

      <form
        className="space-y-3.5 p-3.5 sm:p-4"
        onSubmit={event => {
          event.preventDefault()
          if (ready) void submit()
        }}
      >
        {settings.source === 'environment' && (
          <p className="flex gap-2 rounded-control bg-canvas px-3 py-2.5 text-meta leading-relaxed text-content-muted">
            <ServerCog size={13} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
            <span>
              These values are coming from the server&rsquo;s environment, not from
              here. They are filled in below — saving adopts them, and this screen
              takes over from then on.
            </span>
          </p>
        )}

        {settings.passwordUnreadable && (
          <p
            role="alert"
            className="flex gap-2 rounded-control bg-warning-soft px-3 py-2.5 text-meta leading-relaxed text-warning-ink"
          >
            <MailWarning size={13} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
            <span>
              A stored credential cannot be read, which happens when
              <code> JWT_SECRET</code> changes. Enter it again below. Until then this
              deployment authenticates with nothing, which is refused in a way that
              looks like the provider being unreachable.
            </span>
          </p>
        )}

        <fieldset>
          <legend className="field-label">How notices are sent</legend>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
            <ProviderChoice
              id="provider-graph"
              checked={graph}
              onSelect={() => setProvider('MICROSOFT_GRAPH')}
              icon={Cloud}
              title="Microsoft Graph"
              hint="Recommended on Microsoft 365. Sends through Exchange Online, so SPF is not in the way."
            />
            <ProviderChoice
              id="provider-smtp"
              checked={!graph}
              onSelect={() => setProvider('SMTP')}
              icon={ServerCog}
              title="SMTP relay"
              hint="Any other mail server. Needs the sending host authorised in your SPF record."
            />
          </div>
        </fieldset>

        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field
            id="mail-from-name"
            label="Sender name"
            value={fromName}
            onChange={setFromName}
            hint="Shown as the sender. Optional."
          />
          <Field
            id="mail-from-address"
            label="Sender address"
            value={fromAddress}
            onChange={setFromAddress}
            problem={
              fromAddress.trim() !== '' && !addressValid
                ? 'Just the address, like no-reply@example.com.'
                : null
            }
          />
        </div>

        <Field
          id="mail-app-url"
          label="Address people click in an email"
          value={appUrl}
          onChange={setAppUrl}
          hint="Where this application is reached. Every notice links to it."
          problem={
            appUrl.trim() !== '' && !/^https?:\/\/\S+$/.test(appUrl.trim())
              ? 'Start it with http:// or https://.'
              : null
          }
        />

        {graph ? (
          <fieldset className="space-y-3.5 border-t border-line-soft pt-3.5">
            <legend className="sr-only">Microsoft Graph</legend>
            <Eyebrow as="h3">Microsoft 365 application</Eyebrow>
            <p className="text-meta leading-relaxed text-content-subtle">
              From the app registration in Entra ID. The only permission it needs is{' '}
              <strong className="font-medium text-content">Mail.Send</strong>, of type
              Application, with admin consent granted — nothing else, and in particular no
              directory read. Authentication is application-only (OAuth&nbsp;2.0 client
              credentials), so there is no sign-in prompt and no callback URL to configure.
            </p>

            <Field
              id="mail-tenant-id"
              label="Directory (tenant) ID"
              value={tenantId}
              onChange={setTenantId}
              autoComplete="off"
              hint={
                settings.tenantIdMasked
                  ? `Currently ${settings.tenantIdMasked}. Blank keeps it.`
                  : undefined
              }
            />
            <Field
              id="mail-client-id"
              label="Application (client) ID"
              value={clientId}
              onChange={setClientId}
              autoComplete="off"
              hint={
                settings.clientIdMasked
                  ? `Currently ${settings.clientIdMasked}. Blank keeps it.`
                  : undefined
              }
            />
            <Field
              id="mail-client-secret"
              label="Client secret"
              value={clientSecret}
              onChange={setClientSecret}
              type="password"
              autoComplete="new-password"
              hint={
                settings.hasClientSecret
                  ? 'A secret is stored. It is never shown — blank keeps it.'
                  : 'The secret value from the app registration, not its ID.'
              }
            />
            {settings.hasClientSecret && (
              <Switch
                checked={clearClientSecret}
                onChange={setClearClientSecret}
                label="Remove the stored client secret"
              />
            )}

            <Field
              id="mail-mailbox"
              label="Send as mailbox"
              value={mailbox}
              onChange={setMailbox}
              hint="Blank uses the sender address above."
            />

            <Switch
              checked={saveToSentItems}
              onChange={setSaveToSentItems}
              label="Keep a copy in that mailbox's Sent Items"
              hint="A notice nobody can find afterwards is a support question nobody can answer."
            />

            <p className="flex gap-2 rounded-control bg-canvas px-3 py-2.5 text-meta leading-relaxed text-content-muted">
              <MailWarning size={13} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
              <span>
                <strong className="font-medium text-content">Restrict this in Exchange.</strong>{' '}
                The Mail.Send application permission is tenant-wide: it allows sending as
                any mailbox in the directory, and naming one above does not change that.
                Scope the app registration with an Exchange{' '}
                <code>ApplicationAccessPolicy</code> so it can only use this mailbox.
              </span>
            </p>
          </fieldset>
        ) : (
          <fieldset className="space-y-3.5 border-t border-line-soft pt-3.5">
            <legend className="sr-only">SMTP relay</legend>
            <Eyebrow as="h3">SMTP relay</Eyebrow>
            <p className="text-meta leading-relaxed text-content-subtle">
              For Microsoft 365 use <code>smtp.office365.com</code> on port <code>587</code>{' '}
              with the TLS switch <strong className="font-medium text-content">off</strong> —
              that port starts in the clear and upgrades. Turning it on there is what
              produces <code>wrong version number</code>.
            </p>

            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1">
                <Field id="mail-host" label="Hostname" value={host} onChange={setHost} />
              </div>
              <div className="w-28">
                <Field
                  id="mail-port"
                  label="Port"
                  value={port}
                  onChange={setPort}
                  inputMode="numeric"
                  problem={port !== '' && !portValid ? 'Between 1 and 65535.' : null}
                />
              </div>
            </div>

            <Switch
              checked={secure}
              onChange={setSecure}
              label="Connect over TLS immediately"
              hint="Off for ports 25 and 587, which upgrade after connecting. On for 465."
            />

            <p className="text-meta leading-relaxed text-content-subtle">
              {settings.authenticated
                ? 'An account is in use. Neither it nor its password is shown here — leave these blank and they are kept exactly as they are.'
                : 'Leave both blank for a relay that does not ask for a login.'}
            </p>
            <Field
              id="mail-username"
              label="Account"
              value={username}
              onChange={setUsername}
              autoComplete="off"
            />
            <Field
              id="mail-password"
              label="Password"
              value={password}
              onChange={setPassword}
              type="password"
              autoComplete="new-password"
            />
            {settings.authenticated && (
              <Switch
                checked={clearPassword}
                onChange={setClearPassword}
                label="Remove the stored account and password"
                hint="They go together: a relay account with no password is refused."
              />
            )}
          </fieldset>
        )}

        <div aria-live="polite" aria-atomic="true">
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
          {saved && !error && (
            <p className="text-meta text-content-subtle">
              Saved. Test the connection below, then send a test.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!ready} pending={busy}>
            Save mail settings
          </Button>
          {fromDatabase && (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void handBack()}>
              Hand back to the server
            </Button>
          )}
        </div>
      </form>
    </Card>
  )
}

function ProviderChoice({
  id,
  checked,
  onSelect,
  icon: Icon,
  title,
  hint,
}: {
  id: string
  checked: boolean
  onSelect: () => void
  icon: typeof Cloud
  title: string
  hint: string
}) {
  return (
    <label
      htmlFor={id}
      className={`flex cursor-pointer gap-2.5 rounded-control border px-3 py-2.5 transition-colors ${
        checked ? 'border-accent bg-accent-soft' : 'border-line bg-canvas hover:border-line-strong'
      }`}
    >
      <input
        id={id}
        type="radio"
        name="mail-provider"
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 accent-accent"
      />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-ui font-medium text-content">
          <Icon size={13} aria-hidden="true" />
          {title}
        </span>
        <span className="mt-0.5 block text-meta leading-relaxed text-content-subtle">{hint}</span>
      </span>
    </label>
  )
}

function QueueCard({
  summary,
  onReload,
}: {
  summary: MailQueueSummary
  onReload: () => Promise<void>
}) {
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [checking, setChecking] = useState(false)
  const [connection, setConnection] = useState<{ ok: boolean; message: string } | null>(null)

  /*
   * Not run on load, deliberately. It is an outbound call to Microsoft, and a
   * page that made one every time somebody opened it would spend a rate limit
   * on a question nobody asked. "Not tested" is also the only honest thing to
   * say before anybody has tested it.
   */
  const checkConnection = async () => {
    setChecking(true)
    setConnection(null)
    try {
      const { detail } = await testMailConnection()
      setConnection({ ok: true, message: detail })
    } catch (error) {
      setConnection({
        ok: false,
        message: error instanceof Error ? error.message : 'Could not reach the mail provider.',
      })
    } finally {
      setChecking(false)
    }
  }

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const { sentTo } = await sendTestMail()
      setTestResult({ ok: true, message: `Sent to ${sentTo}. If it does not arrive, check Junk.` })
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error ? error.message : 'The mail provider refused it.',
      })
    } finally {
      setTesting(false)
      await onReload()
    }
  }

  return (
    <Card>
      <CardHeader
        icon={Send}
        title="Delivery"
        hint={summary.configured ? 'Sent when a memo reaches somebody' : 'Not configured'}
      />

      <div className="flex flex-col gap-3 p-3.5 sm:p-4">
        {!summary.configured && (
          <p className="flex gap-2 rounded-control bg-canvas px-3 py-2.5 text-meta leading-relaxed text-content-muted">
            <MailWarning size={13} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
            <span>
              No provider is set, so nothing is delivered. Approvers are still told
              inside the application.
            </span>
          </p>
        )}

        {/*
         * Perfectly delivered and completely useless. Mail can be configured
         * correctly and every approver still receive a link that only works on
         * the server itself; nothing else in the product would ever mention it.
         */}
        {summary.settings.configured && summary.settings.appUrlIsDefault && (
          <p
            role="alert"
            className="flex gap-2 rounded-control bg-warning-soft px-3 py-2.5 text-meta leading-relaxed text-warning-ink"
          >
            <MailWarning size={13} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
            <span>
              Links in every notice point at <code>{summary.settings.appUrl}</code>, which
              is the development default. Set the address above to the one people
              actually use.
            </span>
          </p>
        )}

        <dl className="grid grid-cols-3 gap-2">
          {(
            [
              ['Sent', summary.counts.SENT, 'text-content'],
              ['Waiting', summary.counts.PENDING + summary.counts.SENDING, 'text-content'],
              [
                'Failed',
                summary.counts.FAILED,
                summary.counts.FAILED > 0 ? 'text-danger-ink' : 'text-content',
              ],
            ] as const
          ).map(([label, value, tone]) => (
            <div key={label} className="rounded-control bg-canvas px-3 py-2.5">
              <dt className="text-meta text-content-subtle">{label}</dt>
              <dd className={`font-mono text-ui tabular-nums ${tone}`}>{value}</dd>
            </div>
          ))}
        </dl>

        {summary.recentFailures.length > 0 && (
          <div>
            <Eyebrow as="h3">Refused</Eyebrow>
            <ul className="mt-1.5 flex flex-col gap-2">
              {summary.recentFailures.slice(0, 3).map(failure => (
                <li key={failure.id} className="text-meta leading-relaxed">
                  <span className="block truncate text-content" title={failure.recipientEmail}>
                    {failure.recipientEmail}
                  </span>
                  {/* Verbatim: "550 no such mailbox" is the difference between
                      fixing an address and calling the hosting provider. */}
                  <span className="block text-content-subtle">
                    {failure.lastError ?? 'No reason recorded'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {summary.settings.configured && (
          <div className="border-t border-line-soft pt-3">
            <Eyebrow as="h3">Connection</Eyebrow>
            <p className="mt-1 text-meta text-content-subtle">
              {connection === null
                ? 'Not tested yet.'
                : connection.ok
                  ? 'Connected.'
                  : 'Not connected.'}
            </p>
            <div aria-live="polite" aria-atomic="true">
              {connection && (
                <p
                  role={connection.ok ? undefined : 'alert'}
                  className={
                    connection.ok ? 'mt-1 text-meta text-content-subtle' : 'mt-1 field-error'
                  }
                >
                  {connection.ok && (
                    <CheckCircle2
                      size={12}
                      aria-hidden="true"
                      className="mr-1 inline align-[-1px]"
                    />
                  )}
                  {connection.message}
                </p>
              )}
            </div>

            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                pending={checking}
                onClick={() => void checkConnection()}
              >
                Test connection
              </Button>
              <Button
                type="button"
                variant="secondary"
                pending={testing}
                onClick={() => void runTest()}
              >
                Send a test email
              </Button>
            </div>

            <p className="mt-2 text-meta leading-relaxed text-content-subtle">
              A test goes to your own address. There is no box to type one into, because
              an endpoint that mails chosen text to a chosen address is an open relay.
            </p>

            <div aria-live="polite" aria-atomic="true">
              {testResult && (
                <p
                  role={testResult.ok ? undefined : 'alert'}
                  className={
                    testResult.ok ? 'mt-2 text-meta text-content-subtle' : 'mt-2 field-error'
                  }
                >
                  {testResult.message}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

function Field({
  id,
  label,
  value,
  onChange,
  hint,
  problem,
  type = 'text',
  autoComplete,
  inputMode,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  problem?: string | null
  type?: 'text' | 'password'
  autoComplete?: string
  inputMode?: 'numeric'
}) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = problem ? `${id}-error` : undefined

  return (
    <div>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        inputMode={inputMode}
        autoComplete={autoComplete}
        onChange={event => onChange(event.target.value)}
        aria-invalid={problem ? true : undefined}
        aria-describedby={[errorId, hintId].filter(Boolean).join(' ') || undefined}
        className="field mt-1 w-full"
      />
      {hint && !problem && (
        <p id={hintId} className="mt-1 text-meta text-content-subtle">
          {hint}
        </p>
      )}
      {problem && (
        <p id={errorId} className="field-error">
          {problem}
        </p>
      )}
    </div>
  )
}
