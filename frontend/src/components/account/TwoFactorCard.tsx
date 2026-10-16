import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { AlertTriangle, Check, Copy, Download, Smartphone } from 'lucide-react'
import {
  activateTwoFactor,
  disableTwoFactor,
  fetchTwoFactorStatus,
  replaceRecoveryCodes,
  startTwoFactorSetup,
  type TwoFactorStatus,
} from '../../services/authApi'
import { Card, CardHeader } from '../ui/Card'
import Button from '../ui/Button'
import ConfirmDialog from '../ui/ConfirmDialog'

/**
 * Two-step sign-in, from the point of view of the person turning it on.
 *
 * Three screens in one card, because they are one task: scan this, type what
 * it shows, keep these. Splitting them across routes would put a
 * half-finished enrolment behind a back button, and a half-finished enrolment
 * is the state where somebody's phone holds a secret the server has replaced.
 *
 * The recovery codes are shown exactly once. That is not a UI decision to
 * soften - the server stores them hashed, so there is no screen that could
 * show them again without keeping a table of live credentials in the clear.
 * The copy says so rather than leaving somebody to find out.
 */
export default function TwoFactorCard() {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  /*
   * The house pattern: a promise chain with a cancelled flag, never a state
   * setter called straight from the effect body. `react-hooks/set-state-in-
   * effect` is an error in this project, and a retry is a counter in the
   * dependency array rather than a second code path.
   */
  useEffect(() => {
    let cancelled = false

    fetchTwoFactorStatus()
      .then(result => {
        if (!cancelled) {
          setStatus(result)
          setLoadError(null)
        }
      })
      .catch((problem: unknown) => {
        if (!cancelled) {
          setLoadError(
            problem instanceof Error
              ? problem.message
              : 'Could not read your two-step sign-in settings.'
          )
        }
      })

    return () => {
      cancelled = true
    }
  }, [attempt])

  const reload = () => setAttempt(n => n + 1)

  if (loadError) {
    return (
      <Card>
        <CardHeader
          icon={Smartphone}
          tone="warning"
          title="Two-step sign-in"
          hint="Asking for a code from your phone as well as your password."
        />
        <div className="space-y-3 p-3.5 sm:p-4">
          <p role="alert" className="field-error">
            {loadError}
          </p>
          <Button variant="secondary" onClick={reload}>
            Try again
          </Button>
        </div>
      </Card>
    )
  }

  if (!status) {
    return (
      <Card>
        <CardHeader
          icon={Smartphone}
          title="Two-step sign-in"
          hint="Asking for a code from your phone as well as your password."
        />
        <div className="p-3.5 text-ui text-content-muted sm:p-4">…</div>
      </Card>
    )
  }

  return <Settled status={status} onChanged={reload} />
}

function Settled({
  status,
  onChanged,
}: {
  status: TwoFactorStatus
  onChanged: () => void
}) {
  const [enrolling, setEnrolling] = useState<{
    secret: string
    otpauthUri: string
  } | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const begin = async () => {
    setBusy(true)
    setProblem(null)
    try {
      setEnrolling(await startTwoFactorSetup())
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  // The codes are on screen and nowhere else. Dismissing them is what tells
  // the rest of the card to refresh, so it never happens behind somebody's
  // back while they are still copying them down.
  if (codes) {
    return (
      <RecoveryCodes
        codes={codes}
        onDone={() => {
          setCodes(null)
          setEnrolling(null)
          onChanged()
        }}
      />
    )
  }

  if (enrolling) {
    return (
      <Enrol
        secret={enrolling.secret}
        otpauthUri={enrolling.otpauthUri}
        onGiveUp={() => setEnrolling(null)}
        onActivated={setCodes}
      />
    )
  }

  return (
    <Card>
      <CardHeader
        icon={Smartphone}
        tone={status.enabled ? 'accent' : 'warning'}
        title="Two-step sign-in"
        hint="Asking for a code from your phone as well as your password."
        meta={status.enabled ? 'On' : 'Off'}
      />
      <div className="space-y-3.5 p-3.5 sm:p-4">
        {status.secretUnreadable && (
          <p
            role="alert"
            className="flex items-start gap-2 border border-danger-line bg-danger-soft px-3 py-2.5 text-ui leading-relaxed text-content"
          >
            <AlertTriangle
              size={15}
              aria-hidden="true"
              className="mt-0.5 flex-shrink-0 text-danger-mark"
            />
            <span>
              Your authenticator secret cannot be read on this server, so codes
              from your phone will not be accepted. This happens when the
              server's <span className="font-mono text-data">JWT_SECRET</span>{' '}
              is changed. Use a recovery code to sign in, or ask an
              administrator to turn two-step sign-in off for you.
            </span>
          </p>
        )}

        {status.enabled ? (
          <OnState status={status} onChanged={onChanged} />
        ) : (
          <>
            <p className="text-ui leading-relaxed text-content-muted">
              {status.pending
                ? 'You started setting this up and did not finish. Start again to get a fresh code to scan — the one your phone already holds will not work.'
                : 'Your password alone gets you in today. With this on, signing in also asks for a six-digit code from an app on your phone, so a password on its own is not enough.'}
            </p>

            {problem && (
              <p role="alert" className="field-error">
                {problem}
              </p>
            )}

            <Button onClick={() => void begin()} pending={busy}>
              {status.pending ? 'Start again' : 'Set up two-step sign-in'}
            </Button>
          </>
        )}
      </div>
    </Card>
  )
}

/** Scan, then type what it shows. */
function Enrol({
  secret,
  otpauthUri,
  onGiveUp,
  onActivated,
}: {
  secret: string
  otpauthUri: string
  onGiveUp: () => void
  onActivated: (codes: string[]) => void
}) {
  const [qr, setQr] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    QRCode.toDataURL(otpauthUri, { margin: 1, width: 320 })
      .then(url => {
        if (!cancelled) setQr(url)
      })
      .catch(() => {
        // The typed secret below is the fallback, and every authenticator app
        // accepts one. A missing image is a smaller problem than it looks.
        if (!cancelled) setQr(null)
      })

    return () => {
      cancelled = true
    }
  }, [otpauthUri])

  const confirm = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const { recoveryCodes } = await activateTwoFactor(code.trim())
      onActivated(recoveryCodes)
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : 'That code was not accepted.'
      )
      setCode('')
      setBusy(false)
    }
  }

  return (
    <Card accent="accent">
      <CardHeader
        icon={Smartphone}
        title="Set up two-step sign-in"
        hint="Scan this with Microsoft Authenticator, Google Authenticator, or any app that takes a QR code."
      />
      <div className="space-y-4 p-3.5 sm:p-4">
        <ol className="space-y-4">
          <li className="space-y-2">
            <Step n={1}>Scan this with your authenticator app.</Step>
            <div className="flex flex-wrap items-start gap-4">
              {qr && (
                <img
                  src={qr}
                  /*
                    Not decorative: for somebody who cannot see it, this names
                    the alternative rather than describing the squares.
                  */
                  alt="QR code for this account. If you cannot scan it, use the setup key below."
                  width={160}
                  height={160}
                  /*
                    No background class, and deliberately none: the PNG the
                    encoder produces is already black on white, which is what
                    a scanner needs. Letting the theme tint it would make the
                    code unreadable in dark mode - the one place a helpful
                    -looking `bg-surface` would actively break the feature.
                  */
                  className="border border-line"
                />
              )}
              <div className="min-w-0 flex-1 space-y-1.5">
                <p className="text-meta text-content-subtle">
                  Or enter this setup key by hand
                </p>
                <p className="break-all font-mono text-data text-content">
                  {secret.match(/.{1,4}/g)?.join(' ')}
                </p>
                <p className="text-meta leading-relaxed text-content-subtle">
                  Account: IdeasFlow. Type: time-based. Everything else can
                  stay as the app suggests.
                </p>
              </div>
            </div>
          </li>

          <li className="space-y-2">
            <Step n={2}>Type the six digits it starts showing.</Step>
            <form
              className="space-y-2.5"
              onSubmit={event => {
                event.preventDefault()
                if (code.trim() && !busy) void confirm()
              }}
            >
              <label htmlFor="totp-confirm" className="field-label">
                Code from the app
              </label>
              <input
                id="totp-confirm"
                value={code}
                onChange={event => {
                  setCode(event.target.value)
                  setProblem(null)
                }}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                aria-invalid={problem ? true : undefined}
                aria-describedby={problem ? 'totp-confirm-error' : undefined}
                className="field w-40 text-center font-mono text-data tracking-[0.3em]"
              />

              {problem && (
                <p id="totp-confirm-error" role="alert" className="field-error">
                  {problem}
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  disabled={!code.trim() || busy}
                  pending={busy}
                >
                  Turn it on
                </Button>
                <Button type="button" variant="secondary" onClick={onGiveUp}>
                  Cancel
                </Button>
              </div>
            </form>
          </li>
        </ol>

        <p className="text-meta leading-relaxed text-content-subtle">
          Nothing changes about how you sign in until you have typed a code
          that works. If you close this now, two-step sign-in stays off.
        </p>
      </div>
    </Card>
  )
}

/** Shown once, and the copy has to be honest about that. */
function RecoveryCodes({
  codes,
  onDone,
}: {
  codes: string[]
  onDone: () => void
}) {
  const [copied, setCopied] = useState(false)
  const text = codes.join('\n')

  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false)
    )
  }

  const download = () => {
    const blob = new Blob(
      [`IdeasFlow recovery codes\n\nEach code works once.\n\n${text}\n`],
      { type: 'text/plain' }
    )
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'ideasflow-recovery-codes.txt'
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card accent="warning">
      <CardHeader
        icon={AlertTriangle}
        tone="warning"
        title="Save these recovery codes"
        hint="This is the only time they are shown. They are stored hashed, so nobody — including an administrator — can read them back to you."
      />
      <div className="space-y-3.5 p-3.5 sm:p-4">
        <p className="text-ui leading-relaxed text-content">
          Two-step sign-in is now on. If you lose your phone, one of these gets
          you back in. Each one works once.
        </p>

        <ul className="grid gap-1.5 border border-line bg-sunken p-3 font-mono text-data sm:grid-cols-2">
          {codes.map(code => (
            <li key={code}>{code}</li>
          ))}
        </ul>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={copy}>
            {copied ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <Copy size={14} aria-hidden="true" />
            )}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button variant="secondary" onClick={download}>
            <Download size={14} aria-hidden="true" />
            Download
          </Button>
          <Button onClick={onDone}>I have saved them</Button>
        </div>

        <div aria-live="polite" className="sr-only">
          {copied ? 'Recovery codes copied to the clipboard.' : ''}
        </div>
      </div>
    </Card>
  )
}

function OnState({
  status,
  onChanged,
}: {
  status: TwoFactorStatus
  onChanged: () => void
}) {
  const [askingOff, setAskingOff] = useState(false)
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [fresh, setFresh] = useState<string[] | null>(null)

  const turnOff = async () => {
    setBusy(true)
    setProblem(null)
    try {
      await disableTwoFactor(password)
      setAskingOff(false)
      setPassword('')
      onChanged()
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : 'That password is not correct.'
      )
      setBusy(false)
    }
  }

  const regenerate = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const { recoveryCodes } = await replaceRecoveryCodes(code.trim())
      setFresh(recoveryCodes)
      setCode('')
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : 'That code was not accepted.'
      )
    } finally {
      setBusy(false)
    }
  }

  if (fresh) {
    return (
      <RecoveryCodesInline
        codes={fresh}
        onDone={() => {
          setFresh(null)
          onChanged()
        }}
      />
    )
  }

  const low = status.recoveryCodesRemaining <= 3

  return (
    <div className="space-y-3.5">
      <p className="text-ui leading-relaxed text-content-muted">
        Signing in asks for your password and then a code from your phone.
      </p>

      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <div>
          <dt className="text-meta text-content-subtle">Turned on</dt>
          <dd className="mt-0.5 text-ui text-content">
            {status.activatedAt
              ? new Date(status.activatedAt).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })
              : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-meta text-content-subtle">Recovery codes left</dt>
          <dd
            className={`mt-0.5 text-ui tabular-nums ${low ? 'text-danger-ink' : 'text-content'}`}
          >
            {status.recoveryCodesRemaining} of{' '}
            {status.recoveryCodesRemaining + status.recoveryCodesUsed}
            {/* Never colour alone: the words carry the warning too. */}
            {low && ' — running low'}
          </dd>
        </div>
      </dl>

      <form
        className="space-y-2.5 border-t border-line-soft pt-3.5"
        onSubmit={event => {
          event.preventDefault()
          if (code.trim() && !busy) void regenerate()
        }}
      >
        <label htmlFor="totp-regen" className="field-label">
          New recovery codes
        </label>
        <p className="text-meta leading-relaxed text-content-subtle">
          Replaces every code you have now, used or not. Type a current code
          from your app to prove it is you.
        </p>
        <input
          id="totp-regen"
          value={code}
          onChange={event => {
            setCode(event.target.value)
            setProblem(null)
          }}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          className="field w-40 text-center font-mono text-data tracking-[0.3em]"
        />

        {problem && !askingOff && (
          <p role="alert" className="field-error">
            {problem}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant="secondary"
            disabled={!code.trim() || busy}
            pending={busy}
          >
            Generate new codes
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              setAskingOff(true)
              setProblem(null)
            }}
          >
            Turn off
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={askingOff}
        title="Turn off two-step sign-in?"
        confirmLabel="Turn it off"
        destructive
        pending={busy}
        onCancel={() => {
          setAskingOff(false)
          setPassword('')
          setProblem(null)
        }}
        onConfirm={() => void turnOff()}
      >
        <div className="space-y-2.5">
          <p>
            Your password alone will get into this account again, and your
            recovery codes stop working.
          </p>
          <label htmlFor="totp-off-password" className="field-label">
            Your password
          </label>
          <input
            id="totp-off-password"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={event => {
              setPassword(event.target.value)
              setProblem(null)
            }}
            className="field w-full"
          />
          {problem && (
            <p role="alert" className="field-error">
              {problem}
            </p>
          )}
        </div>
      </ConfirmDialog>
    </div>
  )
}

/** The same codes panel, inside the card rather than replacing it. */
function RecoveryCodesInline({
  codes,
  onDone,
}: {
  codes: string[]
  onDone: () => void
}) {
  return (
    <div className="space-y-3">
      <p className="text-ui leading-relaxed text-content">
        Here are your new codes. The old ones no longer work. This is the only
        time these are shown.
      </p>
      <ul className="grid gap-1.5 border border-line bg-sunken p-3 font-mono text-data sm:grid-cols-2">
        {codes.map(code => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <Button onClick={onDone}>I have saved them</Button>
    </div>
  )
}

function Step({ n, children }: { n: number; children: string }) {
  return (
    <p className="flex items-baseline gap-2 text-ui font-medium text-content">
      <span
        aria-hidden="true"
        className="font-mono text-meta text-content-subtle"
      >
        {String(n).padStart(2, '0')}
      </span>
      {children}
    </p>
  )
}
