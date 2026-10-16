import { useEffect, useState } from 'react'
import { AlertTriangle, KeyRound, ShieldCheck } from 'lucide-react'
import { Page, PageHeader } from '../components/ui/Page'
import { Card, CardHeader } from '../components/ui/Card'
import { LoadingAnnouncer, Skeleton } from '../components/ui/Skeleton'
import Button from '../components/ui/Button'
import ConfirmDialog from '../components/ui/ConfirmDialog'
import Switch from '../components/ui/Switch'
import {
  clearSsoSettings,
  fetchSsoSettings,
  saveSsoSettings,
  type SsoSettings,
} from '../services/AdminApi'

/**
 * The Microsoft app registration people sign in through.
 *
 * The screen leads with the thing most likely to be got wrong, which is not a
 * field at all: this is a SECOND registration, and it has nothing in common
 * with the one on the Mail screen. That one is app-only — it holds Mail.Send,
 * never sees a browser and has no redirect URI. Pasting its credentials in
 * here produces a sign-in that fails with a message about neither.
 *
 * After that, the redirect URI, because Entra compares it character for
 * character and a mismatch is the single most common way for this to fail. The
 * exact value to paste is shown rather than described.
 *
 * The secret is write-only: stored encrypted, never sent back, and an empty
 * field means "keep the one you have" so that correcting a URI does not
 * require knowing it.
 */

type Form = {
  tenantId: string
  clientId: string
  clientSecret: string
  redirectUri: string
  enabled: boolean
}

const EMPTY: Form = {
  tenantId: '',
  clientId: '',
  clientSecret: '',
  redirectUri: '',
  enabled: false,
}

const message = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback

export default function SsoPage() {
  const [settings, setSettings] = useState<SsoSettings | null>(null)
  const [form, setForm] = useState<Form>(EMPTY)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [attempt, setAttempt] = useState(0)

  /** What Entra has to be told, derived from where this screen is served. */
  const suggestedRedirect = `${window.location.origin}/api/auth/sso/callback`

  useEffect(() => {
    let cancelled = false

    fetchSsoSettings()
      .then((next) => {
        if (cancelled) return
        setSettings(next)
        setForm({
          ...EMPTY,
          enabled: next.enabled,
          redirectUri: next.redirectUri ?? '',
        })
        setLoadError(null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadError(message(error, 'Could not read the sign-on settings.'))
      })

    return () => {
      cancelled = true
    }
  }, [attempt])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setSaveError(null)
    setSaved(null)

    try {
      const next = await saveSsoSettings({
        enabled: form.enabled,
        // Blank means "keep what is stored", so nothing empty is sent at all.
        ...(form.tenantId.trim() ? { tenantId: form.tenantId.trim() } : {}),
        ...(form.clientId.trim() ? { clientId: form.clientId.trim() } : {}),
        ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
        ...(form.redirectUri.trim()
          ? { redirectUri: form.redirectUri.trim() }
          : {}),
      })

      setSettings(next)
      setForm({
        ...EMPTY,
        enabled: next.enabled,
        redirectUri: next.redirectUri ?? '',
      })
      setSaved(
        next.enabled
          ? 'Saved. The sign-in screen now offers Continue with Microsoft.'
          : 'Saved. Sign-in with Microsoft is switched off.',
      )
    } catch (error) {
      setSaveError(message(error, 'Could not save the registration.'))
    } finally {
      setPending(false)
    }
  }

  async function forget() {
    setPending(true)
    setSaveError(null)
    setSaved(null)

    try {
      const next = await clearSsoSettings()
      setSettings(next)
      setForm(EMPTY)
      setConfirmingClear(false)
      setSaved('Forgotten. Everybody signs in with a password again.')
    } catch (error) {
      setSaveError(message(error, 'Could not clear the registration.'))
    } finally {
      setPending(false)
    }
  }

  if (loadError) {
    return (
      <Page width="narrow">
        <PageHeader title="Single sign-on" />
        <Card>
          <div className="flex flex-col items-start gap-3 p-5">
            <p className="text-ui text-content">{loadError}</p>
            <Button
              variant="secondary"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </Button>
          </div>
        </Card>
      </Page>
    )
  }

  if (!settings) {
    return (
      <Page width="narrow">
        <PageHeader title="Single sign-on" />
        <LoadingAnnouncer loading label="Loading the sign-on settings" />
        <div className="flex flex-col gap-4">
          <Skeleton className="h-64 rounded-card" />
          <Skeleton className="h-32 rounded-card" />
        </div>
      </Page>
    )
  }

  const field = (
    id: keyof Form,
    label: string,
    hint: string,
    placeholder?: string,
  ) => (
    <div>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type={id === 'clientSecret' ? 'password' : 'text'}
        autoComplete="off"
        spellCheck={false}
        className="field h-8.5"
        placeholder={placeholder}
        value={form[id] as string}
        aria-describedby={`${id}-hint`}
        onChange={(event) =>
          setForm((current) => ({ ...current, [id]: event.target.value }))
        }
      />
      <p id={`${id}-hint`} className="mt-1.5 text-2xs text-content-subtle">
        {hint}
      </p>
    </div>
  )

  return (
    <Page width="narrow">
      <PageHeader
        eyebrow="Administration · Single sign-on"
        title="Single sign-on"
        description="Let people sign in with their Microsoft work account instead of a password held here."
      />

      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        {/*
          First, before any field. Somebody arriving here having just set up
          mail has a tenant id and a client id in their clipboard, and they
          are the wrong ones.
        */}
        <div className="flex items-start gap-2.5 border border-line bg-sunken px-3.5 py-3">
          <AlertTriangle
            size={15}
            aria-hidden="true"
            className="mt-0.5 flex-shrink-0 text-content-muted"
          />
          <p className="max-w-prose text-[0.8125rem] leading-relaxed text-content-muted">
            This is a <strong className="text-content">second</strong> app
            registration, separate from the one on the Mail screen. That one
            sends mail as the application and never sees a browser; this one
            signs people in and needs a redirect URI. Its credentials will not
            work here.
          </p>
        </div>

        <Card>
          <CardHeader
            icon={KeyRound}
            title="The app registration"
            hint="From Microsoft Entra ID → App registrations → your sign-in app."
            meta={settings.configured ? 'Complete' : 'Incomplete'}
          />
          <div className="flex flex-col gap-4 p-5">
            {field(
              'tenantId',
              'Directory (tenant) ID',
              settings.tenantIdTail
                ? `Stored, ending ${settings.tenantIdTail}. Leave empty to keep it.`
                : 'On the registration’s Overview page. Your own directory, never "common".',
              'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
            )}

            {field(
              'clientId',
              'Application (client) ID',
              settings.clientIdTail
                ? `Stored, ending ${settings.clientIdTail}. Leave empty to keep it.`
                : 'On the same Overview page, directly above the directory ID.',
              'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
            )}

            {field(
              'clientSecret',
              'Client secret',
              settings.hasClientSecret
                ? 'Stored. It is never shown here — leave it empty to keep it.'
                : 'The secret VALUE, not its ID. Microsoft shows it once, when you create it.',
              settings.hasClientSecret ? '•'.repeat(12) : '',
            )}

            {settings.secretUnreadable && (
              <div
                role="alert"
                className="flex items-start gap-2.25 border border-danger-line bg-danger-soft px-3 py-2.5"
              >
                <AlertTriangle
                  size={14}
                  aria-hidden="true"
                  className="mt-0.5 flex-shrink-0 text-danger-ink"
                />
                <p className="text-[0.8125rem] leading-relaxed text-content">
                  A secret is stored but cannot be read back. That is almost
                  always a changed <code>JWT_SECRET</code> on the server. Enter
                  the secret again to fix it.
                </p>
              </div>
            )}

            {field(
              'redirectUri',
              'Redirect URI',
              'Entra compares this character for character. Paste the same value into the registration under Authentication → Web.',
              suggestedRedirect,
            )}

            {form.redirectUri.trim() !== suggestedRedirect && (
              <p className="text-2xs leading-relaxed text-content-subtle">
                For this deployment that is{' '}
                <code className="text-content-muted">{suggestedRedirect}</code>.{' '}
                <button
                  type="button"
                  className="font-medium text-accent-ink underline underline-offset-2 hover:no-underline"
                  onClick={() =>
                    setForm((current) => ({
                      ...current,
                      redirectUri: suggestedRedirect,
                    }))
                  }
                >
                  Use it
                </button>
              </p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            icon={ShieldCheck}
            title="Offer it on the sign-in screen"
            hint="The button is only drawn when this is on and the registration is complete."
          />
          <div className="flex flex-col gap-4 p-5">
            <p className="max-w-prose text-ui leading-relaxed text-content-muted">
              Signing in with Microsoft never creates an account. Somebody the
              directory knows but IdeasFlow does not is refused and told to ask
              an administrator &mdash; holding a mailbox is not the same as
              belonging in an approval chain.
            </p>
            <Switch
              checked={form.enabled}
              onChange={(next) =>
                setForm((current) => ({ ...current, enabled: next }))
              }
              label="Let people sign in with a Microsoft work account"
              hint="Passwords keep working either way."
            />
          </div>
        </Card>

        <div
          className="flex flex-wrap items-center gap-3"
          aria-live="polite"
          aria-atomic="true"
        >
          <Button type="submit" pending={pending}>
            Save registration
          </Button>

          {(settings.configured || settings.hasClientSecret) && (
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => setConfirmingClear(true)}
            >
              Forget it
            </Button>
          )}

          {saved && <span className="text-meta text-accent-ink">{saved}</span>}
          {saveError && (
            <span className="text-meta text-danger-ink">{saveError}</span>
          )}
        </div>
      </form>

      <ConfirmDialog
        open={confirmingClear}
        title="Forget this registration?"
        confirmLabel="Forget it"
        destructive
        pending={pending}
        onConfirm={() => void forget()}
        onCancel={() => setConfirmingClear(false)}
      >
        The directory ID, application ID, secret and redirect URI are deleted
        from this server, and the sign-in screen stops offering Microsoft.
        Everybody signs in with a password again. Nobody is signed out.
      </ConfirmDialog>
    </Page>
  )
}
