import { useState } from 'react'
import { KeyRound, PenLine, ShieldCheck } from 'lucide-react'
import { useCurrentUser } from '../contexts/currentUser'
import { changeMyPassword } from '../services/accountApi'
import { PASSWORD_MIN_LENGTH } from '../utils/passwordRule'
import { Page, PageHeader } from '../components/ui/Page'
import { Card, CardHeader } from '../components/ui/Card'
import Button from '../components/ui/Button'
import { formatFullName } from '../utils/user'
import TwoFactorCard from '../components/account/TwoFactorCard'
import OutOfOfficeCard from '../components/account/OutOfOfficeCard'

/**
 * The screen a person manages their own account from.
 *
 * There was none. Signing out was the only thing the account menu offered,
 * and the only way to change a password was for an administrator to set it
 * through the user-admin form — which at organisational scale is not an
 * inconvenience but a policy: every account arrives from a spreadsheet import
 * with a password somebody else chose, and nobody can change it afterwards.
 *
 * Deliberately not a settings page with tabs. It holds the two things a
 * person actually owns — their password and their signature — and says who
 * they are so the details printed under that signature can be checked against
 * the person reading the screen.
 */
export default function AccountPage() {
  const { user, loading } = useCurrentUser()

  return (
    <Page width="narrow">
      <PageHeader
        eyebrow="Workspace · Account"
        title="Your account"
        description="Your sign-in details and the signature printed on memos you approve."
        crumbs={[{ label: 'Workspace' }, { label: 'Account' }]}
      />

      <div className="space-y-4">
        <Card>
          <CardHeader
            icon={ShieldCheck}
            title="Who you are"
            hint="Your name and job title are printed beneath your signature on every memo you sign. An administrator changes these."
          />
          <dl className="grid gap-x-6 gap-y-3 p-3.5 sm:grid-cols-2 sm:p-4">
            <Detail label="Name" value={user ? formatFullName(user.firstName, user.lastName) : null} loading={loading} />
            <Detail label="Email" value={user?.email ?? null} loading={loading} mono />
            <Detail
              label="Role"
              value={
                user
                  ? user.role === 'ADMINISTRATOR'
                    ? user.isSuperAdmin
                      ? 'Super Administrator'
                      : 'Administrator'
                    : 'User'
                  : null
              }
              loading={loading}
            />
            <Detail
              label="Saved signature"
              value={user ? (user.hasSignature ? 'Saved' : 'None saved') : null}
              loading={loading}
            />
          </dl>
        </Card>

        <ChangePassword />

        {/* Somebody who signs in only with Microsoft confirms it is them with
            Microsoft too. If Microsoft is down they could not sign anything;
            the authenticator app is the fallback, so it is asked for here. */}
        {user && !user.hasPassword && !user.hasAuthenticator && (
          <p
            role="note"
            className="rounded-control border border-warning-line bg-warning-soft px-3 py-2 text-ui text-warning-ink"
          >
            You sign in with Microsoft. Set up an authenticator app below as a
            fallback, so you can still confirm it&rsquo;s you - and sign - if
            Microsoft is unavailable.
          </p>
        )}

        <TwoFactorCard />

        <OutOfOfficeCard />

        <Card>
          <CardHeader
            icon={PenLine}
            tone="warning"
            title="Your signature"
            hint="Saved from the signing screen the first time you use it."
          />
          <div className="p-3.5 text-ui leading-relaxed text-content-muted sm:p-4">
            {user?.hasSignature ? (
              <p>
                You have a saved signature. Open a memo waiting for you and
                choose <span className="font-medium text-content">Use my saved signature</span> to
                place it, or replace it from that same screen.
              </p>
            ) : (
              <p>
                You have not saved one. You can draw a signature on the page
                each time instead — but drawing on a phone screen at the moment
                a memo needs signing is how a memo waits a day. Save one the
                next time you sign something.
              </p>
            )}
          </div>
        </Card>
      </div>
    </Page>
  )
}

function Detail({
  label,
  value,
  loading,
  mono,
}: {
  label: string
  value: string | null
  loading: boolean
  mono?: boolean
}) {
  return (
    <div>
      <dt className="text-meta text-content-subtle">{label}</dt>
      <dd className={`mt-0.5 text-ui text-content ${mono ? 'font-mono text-data' : ''}`}>
        {loading ? '…' : (value ?? '—')}
      </dd>
    </div>
  )
}

const MIN_LENGTH = PASSWORD_MIN_LENGTH

function ChangePassword() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /*
   * Checked here as well as on the server, because this one is answerable
   * without a round trip and the server never sees the confirmation field.
   */
  const mismatch = confirm.length > 0 && next !== confirm
  const tooShort = next.length > 0 && next.length < MIN_LENGTH
  const ready =
    current.length > 0 && next.length >= MIN_LENGTH && next === confirm && !busy

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await changeMyPassword({ currentPassword: current, newPassword: next })
      /*
       * No success toast: changing the password ends every session it opened,
       * this one included, so the next request lands on the sign-in screen.
       * Saying "saved" and then throwing them out reads as a fault.
       */
      window.location.assign('/login')
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not work.')
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader
        icon={KeyRound}
        title="Change your password"
        hint="You will be signed out everywhere, on this device too."
      />
      <form
        className="space-y-3.5 p-3.5 sm:p-4"
        onSubmit={event => {
          event.preventDefault()
          if (ready) void submit()
        }}
      >
        <Field
          id="current-password"
          label="Current password"
          value={current}
          autoComplete="current-password"
          onChange={setCurrent}
        />
        <Field
          id="new-password"
          label="New password"
          value={next}
          autoComplete="new-password"
          onChange={setNext}
          hint={`At least ${MIN_LENGTH} characters.`}
          problem={tooShort ? `Use at least ${MIN_LENGTH} characters.` : null}
        />
        <Field
          id="confirm-password"
          label="Confirm new password"
          value={confirm}
          autoComplete="new-password"
          onChange={setConfirm}
          problem={mismatch ? 'These two do not match.' : null}
        />

        <div aria-live="polite" aria-atomic="true">
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
        </div>

        <Button type="submit" disabled={!ready} pending={busy}>
          Change password
        </Button>
      </form>
    </Card>
  )
}

function Field({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hint,
  problem,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  autoComplete: string
  hint?: string
  problem?: string | null
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
        type="password"
        value={value}
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
