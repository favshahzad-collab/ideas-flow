import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import {
  AlertCircle,
  ArrowBigUp,
  ArrowRight,
  Check,
  Clock,
  Eye,
  EyeOff,
  Lock,
  Mail,
  ShieldCheck,
  Smartphone,
} from 'lucide-react'
import {
  fetchSsoAvailable,
  login,
  needsCode,
  submitTwoFactorCode,
  type TwoFactorChallenge,
} from '../services/authApi.ts'
import { fetchSystemHealth, type SystemHealth } from '../services/healthApi'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import Button from '../components/ui/Button'
import ThemeToggle from '../components/ui/ThemeToggle'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

/**
 * The five things this system does.
 *
 * Every one has code behind it. This screen has at various points advertised
 * @mentions, real-time notifications, biometric sign-in and ISO 27001 / SOC 2
 * compliance, none of which exist here, and it is the one screen every user
 * meets before they can find out otherwise.
 */
const CAPABILITIES = [
  'Document routing',
  'Approvals',
  'E-signatures',
  'Audit ledger',
  'Tamper-evident records',
]

/**
 * Whether the service behind this form is answering.
 *
 * The handoff prints "All systems operational" as a fixed string. That is the
 * same kind of claim as an unaudited compliance badge - it is on screen
 * whether or not it is true, and it is worth least on the one morning it
 * matters. `GET /api/health` is public and reports the database and the three
 * background sweeps, so this says what that endpoint says.
 *
 * Unreachable is the case the fixed string serves worst and this one serves
 * best: somebody staring at a sign-in form that will not work is told why.
 */
function SystemStatus() {
  const [health, setHealth] = useState<SystemHealth | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchSystemHealth().then(result => {
      if (!cancelled) setHealth(result)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Nothing at all until it is known. A row that says "operational" while the
  // request is still in flight has guessed.
  if (!health) return null

  const tone =
    health.state === 'ok'
      ? 'bg-auth-status'
      : health.state === 'degraded'
        ? 'bg-warning-mark'
        : 'bg-danger-mark'

  const words =
    health.state === 'ok'
      ? 'All systems operational'
      : health.state === 'degraded'
        ? `Degraded: ${health.parts.join(', ')}`
        : 'Cannot reach the service'

  return (
    <p className="flex items-center gap-2.5 text-meta text-auth-panel-muted">
      {/* Never colour alone: the words carry it, the dot only points. */}
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 flex-shrink-0 rounded-pill ${tone}`}
      />
      {words}
    </p>
  )
}

/**
 * The lockup, which the panel carries on a wide screen and the form column
 * carries below it otherwise.
 *
 * The logo is the supplied artwork at its own proportions and its own colour -
 * no tint, no filter, no type set to imitate it. `width` and `height` are the
 * file's real pixels so the browser reserves the right box before it loads and
 * nothing on the screen jumps.
 */
function Lockup({
  className = '',
  size = 'h-10',
}: {
  className?: string
  size?: string
}) {
  return (
    <div className={`flex items-center gap-3.5 ${className}`}>
      <img
        src="/ideas-logo.png"
        alt="Ideas"
        width={936}
        height={192}
        className={`${size} w-auto`}
      />
      <span aria-hidden="true" className="h-6 w-px bg-current opacity-20" />
      <span className="font-auth-display text-pane font-semibold tracking-[-0.01em]">
        IdeasFlow
      </span>
    </div>
  )
}

/**
 * What the sign-in redirect is allowed to tell somebody.
 *
 * A fixed set, chosen here rather than carried from Microsoft: this value
 * arrives in a URL anybody can type, and reflecting supplied text into the
 * page is a habit worth not having even where React escapes it. An
 * administrator who needs the AADSTS number finds it in the server log.
 */
const SSO_PROBLEMS: Record<string, string> = {
  'no-account':
    'That Microsoft account is not set up in IdeasFlow. Ask an administrator to add you.',
  refused:
    'Microsoft did not complete that sign-in. You can try again, or use your password below.',
  failed:
    'That sign-in could not be completed. Try again, or use your password below.',
}

export default function LoginPage() {
  const { login: completeLogin, sessionExpired } = useAuth()
  const [searchParams] = useSearchParams()

  useDocumentTitle('Sign in')

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [loading, setLoading] = useState(false)
  const [emailError, setEmailError] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [formError, setFormError] = useState('')
  const [capsLock, setCapsLock] = useState(false)
  const [signedIn, setSignedIn] = useState<string | null>(null)
  const [method, setMethod] = useState<'Password' | 'Password and code'>(
    'Password'
  )
  const [ssoAvailable, setSsoAvailable] = useState(false)

  /*
   * A sign-in that stopped for a code, held here rather than in a route of
   * its own. A route would put the challenge in an address somebody can
   * reload, and a reload is exactly what a person does when they have gone to
   * find their phone - which would strand them on a screen whose challenge
   * had gone with the page.
   */
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null)
  const [code, setCode] = useState('')
  const codeRef = useRef<HTMLInputElement>(null)

  /*
   * Asked once, on the way in. An unreachable or unconfigured answer means no
   * button, and the password form below is untouched either way - whatever
   * else this screen does, it must never stop somebody signing in normally.
   */
  useEffect(() => {
    let cancelled = false

    fetchSsoAvailable()
      .then((available) => {
        if (!cancelled) setSsoAvailable(available)
      })
      .catch(() => {
        /* `fetchSsoAvailable` already answers false rather than throwing. */
      })

    return () => {
      cancelled = true
    }
  }, [])

  // Through the router rather than off `window.location`: read during render,
  // the global does not re-render anything when the address changes.
  const ssoProblem = SSO_PROBLEMS[searchParams.get('sso') ?? '']

  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  /** Both halves end the same way, so both go through here. */
  const finish = async (account: string, role: 'ADMINISTRATOR' | 'USER') => {
    setSignedIn(account)
    await new Promise(r => setTimeout(r, 700))
    // No navigation here: flipping the session is enough. `PublicOnlyRoute`
    // owns the redirect and knows where the user was originally headed.
    completeLogin(role)
  }

  /**
   * Caps Lock is the single most common reason a correct password is
   * rejected, and a masked field gives no clue. Read from the modifier state
   * of a real key event — there is no way to query it otherwise.
   */
  const readCapsLock = (e: KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(e.getModifierState?.('CapsLock') ?? false)
  }

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault()

    // Both fields in one pass, so the user sees everything that is wrong at
    // once rather than fixing one and being told about the next.
    const trimmed = email.trim()
    const nextEmailError = !trimmed
      ? 'Enter your email address.'
      : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
        ? 'Enter the work email address your administrator provisioned.'
        : ''
    const nextPasswordError = password ? '' : 'Enter your password.'

    setEmailError(nextEmailError)
    setPasswordError(nextPasswordError)
    setFormError('')

    if (nextEmailError || nextPasswordError) {
      // Announcing an error without moving focus leaves a keyboard user to
      // hunt for it.
      ;(nextEmailError ? emailRef : passwordRef).current?.focus()
      return
    }

    setLoading(true)

    try {
      const result = await login(trimmed, password)

      if (needsCode(result)) {
        // No session exists yet and nothing has been stored. The password is
        // cleared here and only here: it has done its job, and leaving it in
        // a field behind the code step is a credential sitting on a screen
        // somebody is about to walk away from to find their phone.
        setChallenge(result)
        setPassword('')
        setLoading(false)
        return
      }

      setMethod('Password')
      await finish(result.user.email, result.user.role)
    } catch (err: unknown) {
      /*
       * Whatever the server said, and nothing more.
       *
       * The handoff writes "That password is incorrect. 2 attempts remain
       * before this account is locked." There is a cap - eight tries at one
       * account - but the API does not report what is left, and it should
       * not: a counter told to whoever is guessing is a counter that tells
       * them when to pause and start again.
       */
      const msg =
        err instanceof Error
          ? err.message
          : 'Unable to sign in. Please check your credentials.'
      setFormError(msg)
      setLoading(false)
      // The password is the field they will retype. Never clear it for them:
      // that punishes a typo by making them start over.
      passwordRef.current?.focus()
      passwordRef.current?.select()
    }
  }

  const handleCode = async (e: FormEvent) => {
    e.preventDefault()

    const typed = code.trim()

    if (!typed) {
      setFormError('Enter the code from your authenticator app.')
      codeRef.current?.focus()
      return
    }

    if (!challenge) return

    setFormError('')
    setLoading(true)

    try {
      const result = await submitTwoFactorCode(challenge.challenge, typed)
      setMethod('Password and code')
      await finish(result.user.email, result.user.role)
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'That code was not accepted.'
      setFormError(msg)
      setLoading(false)
      setCode('')
      codeRef.current?.focus()
    }
  }

  /**
   * Give up and start over.
   *
   * The challenge is abandoned rather than reused. Whoever comes back has to
   * prove the password again, which is the whole point of the first step.
   */
  const abandonCode = () => {
    setChallenge(null)
    setCode('')
    setFormError('')
    setPassword('')
  }

  /* Sentence case at 13px. This was 12px uppercase on wide tracking, which is
     a technical-drawing label: it shouts a word nobody needs to read twice and
     it is the hardest size on the screen to read at a glance. */
  const label = 'block text-section font-semibold text-content'

  /* One alert treatment, so a refused password and a refused code cannot come
     out looking like two different kinds of event. */
  const alertBox =
    'flex items-start gap-2.5 rounded-control border border-auth-error ' +
    'bg-auth-error/8 px-3.5 py-3'

  return (
    <main className="auth flex min-h-screen bg-canvas text-content">
      {/* ── Brand panel ───────────────────────────────────────────────── */}
      <aside className="auth-panel relative hidden flex-col overflow-hidden px-10 pb-10 pt-12 text-auth-panel-text lg:flex lg:w-[46%] lg:max-w-152 xl:px-12">
        <Lockup size="h-11" />

        {/*
          The statement and the list are one block, centred in whatever is left
          between the lockup and the status line. Pinned to the top and bottom
          instead - which is what `justify-between` did - they left a column of
          nothing through the middle of the panel at every height above about
          900px.
        */}
        <div className="flex flex-1 flex-col justify-center gap-9 py-12">
          <div className="flex max-w-104 flex-col gap-4">
            <span className="text-eyebrow font-semibold uppercase tracking-[0.16em] text-auth-panel-faint">
              Document control platform
            </span>
            <h2 className="font-auth-display text-auth-hero font-bold tracking-[-0.03em] text-balance">
              Every document, routed and accounted for.
            </h2>
            <p className="text-auth-body text-auth-panel-muted text-pretty">
              Controlled routing, approvals and signatures on a single ledger,
              with an audit ledger that cannot be quietly edited.
            </p>
          </div>

          {/*
            Five capabilities, and that is the whole of what this panel claims.
            They were numbered 01-05 inside a ruled plate, which is brochure
            furniture - nobody signing in to their own employer's system needs
            to be sold it. A checked list says the same thing and gets out of
            the way.
          */}
          <ul className="flex max-w-104 flex-col gap-3 border-t border-auth-panel-line pt-8">
            {CAPABILITIES.map(capability => (
              <li key={capability} className="flex items-center gap-3">
                <Check
                  size={15}
                  strokeWidth={2.5}
                  aria-hidden="true"
                  className="flex-shrink-0 text-auth-accent"
                />
                <span className="text-auth-body">{capability}</span>
              </li>
            ))}
          </ul>
        </div>

        {/*
          Where the handoff puts SOC 2 TYPE II, ISO 27001 and 21 CFR PART 11.
          Nobody has audited this system against any of them, and a badge is
          not a design element - it is a statement about a legal fact, printed
          on the one screen a person reads before they have any way to check
          it. The status line stays because it is the one claim in this block
          that is actually measured.
        */}
        <SystemStatus />
      </aside>

      {/* ── Form column ───────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col px-5 py-5 sm:px-8">
        {/*
          The handoff's header also carries a "TENANT" chip. There is no
          tenancy in this build, and what the chip actually printed was
          `window.location.host` - which on every machine it has ever been
          looked at says `localhost:5173`. A hostname is developer chrome; it
          belongs in the address bar, where it already is.
        */}
        <header className="flex justify-end">
          {/* The handoff's two-up light/dark switch. The app's own toggle is
              three-up: it also has "follow the system", which is the setting
              most people actually want and which a two-up control cannot
              express. It picks up this screen's palette from `.auth`. */}
          <ThemeToggle />
        </header>

        <div className="flex flex-1 items-center justify-center py-8">
          <div className="flex w-full max-w-108 flex-col gap-6">
            <Lockup className="justify-center text-content lg:hidden" size="h-9" />

            <section className="auth-card px-6 py-7 sm:px-8 sm:py-9">
              {!signedIn && challenge ? (
                /*
                  The second step. Deliberately plain: whoever is looking at it
                  is holding a phone in one hand, and the one thing that
                  matters is that the field is focused and takes what they read
                  out.
                */
                <div className="flex animate-[fade-in_0.26s_ease-out] flex-col gap-6">
                  <div className="flex flex-col gap-2">
                    <span className="grid h-10 w-10 place-items-center rounded-control bg-accent-soft text-accent-ink">
                      <Smartphone size={20} aria-hidden="true" />
                    </span>
                    <h1 className="mt-1 font-auth-display text-auth-head font-bold tracking-[-0.02em]">
                      Enter your code
                    </h1>
                    <p className="text-auth-body text-content-muted">
                      Open your authenticator app and type the six digits it
                      shows for IdeasFlow.
                    </p>
                  </div>

                  <div className="live-region" aria-live="assertive" aria-atomic="true">
                    {formError && (
                      <div
                        role="alert"
                        className={`animate-[fade-in_0.2s_ease-out] ${alertBox}`}
                      >
                        <AlertCircle
                          size={16}
                          aria-hidden="true"
                          className="mt-0.5 flex-shrink-0 text-auth-error"
                        />
                        <p className="text-section font-medium leading-relaxed text-auth-error">
                          {formError}
                        </p>
                      </div>
                    )}
                  </div>

                  <form
                    onSubmit={handleCode}
                    className="flex flex-col gap-4"
                    noValidate
                  >
                    <div className="flex flex-col gap-2">
                      <label htmlFor="totp-code" className={label}>
                        Six-digit code
                      </label>
                      <input
                        id="totp-code"
                        name="one-time-code"
                        type="text"
                        ref={codeRef}
                        value={code}
                        onChange={e => {
                          setCode(e.target.value)
                          setFormError('')
                        }}
                        placeholder="000000"
                        /*
                          `one-time-code` is what lets iOS and Android offer the
                          digits straight from the notification, and it is the
                          single biggest difference between this step being a
                          tap and being a transcription exercise.
                        */
                        autoComplete="one-time-code"
                        // Not `inputMode="numeric"`: a recovery code goes in
                        // this same field, and a number pad cannot type one.
                        autoCapitalize="characters"
                        autoCorrect="off"
                        spellCheck={false}
                        autoFocus
                        aria-required="true"
                        aria-describedby="totp-help"
                        className="field h-12 text-center font-mono text-title tracking-[0.28em]"
                      />
                      <p
                        id="totp-help"
                        className="text-section leading-relaxed text-content-muted"
                      >
                        Lost your phone? Type one of the recovery codes you
                        saved when you set this up. Each one works once.
                      </p>
                    </div>

                    <Button
                      type="submit"
                      size="lg"
                      pending={loading}
                      className="h-11.5 w-full gap-2 text-auth-action font-semibold"
                    >
                      {loading ? 'Checking…' : 'Sign in'}
                      {!loading && <ArrowRight size={17} aria-hidden="true" />}
                    </Button>
                  </form>

                  <div className="flex flex-col gap-3 border-t border-line pt-5">
                    <button
                      type="button"
                      onClick={abandonCode}
                      className="self-start rounded-chip text-section font-medium text-accent-ink underline underline-offset-2 transition-colors hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      Use a different account
                    </button>

                    <p className="text-section leading-relaxed text-content-muted">
                      No phone and no recovery codes? An administrator can turn
                      two-step sign-in off for you.
                    </p>
                  </div>
                </div>
              ) : signedIn ? (
                <div className="flex animate-[fade-in_0.26s_ease-out] flex-col gap-5">
                  <span className="grid h-11 w-11 place-items-center rounded-control bg-accent-soft text-accent-ink">
                    <ShieldCheck size={22} aria-hidden="true" />
                  </span>
                  <div className="flex flex-col gap-2">
                    <h1 className="font-auth-display text-auth-head font-bold tracking-[-0.02em]">
                      Session established
                    </h1>
                    <p className="text-auth-body text-content-muted">
                      Taking you to your workspace…
                    </p>
                  </div>
                  {/*
                    The handoff also prints "trusted until 11 Oct 2026" and an
                    audit entry id. There is no device trust in this build, and
                    signing in writes no audit row to quote — `AuditAction` has
                    no entry for it. Both rows are gone rather than invented.
                  */}
                  <dl className="grid text-section">
                    <div className="flex justify-between gap-3 border-t border-line py-2.5">
                      <dt className="text-content-muted">Account</dt>
                      <dd className="truncate font-medium">{signedIn}</dd>
                    </div>
                    <div className="flex justify-between gap-3 border-t border-line py-2.5">
                      <dt className="text-content-muted">Method</dt>
                      <dd className="font-medium">{method}</dd>
                    </div>
                  </dl>
                  <div aria-live="polite" className="sr-only">
                    Signed in. Redirecting to your workspace.
                  </div>
                </div>
              ) : (
                <div className="flex animate-[fade-in_0.26s_ease-out] flex-col gap-6">
                  <div className="flex flex-col gap-2">
                    <h1 className="font-auth-display text-auth-head font-bold tracking-[-0.02em]">
                      Welcome back
                    </h1>
                    <p className="text-auth-body text-content-muted">
                      Sign in to continue to IdeasFlow.
                    </p>
                  </div>

                  {/*
                    Microsoft is here now, and it is real: `/api/auth/sso/start`
                    is authorization code with PKCE against one named tenant.
                    The button is drawn only when the server says sign-in is
                    configured AND switched on, because a dead control on the
                    one screen nobody can get past reads as the product being
                    broken rather than the feature being unconfigured.

                    The two-factor step is real now too, and appears only for
                    an account that switched it on - see the code form above.
                    It was held back until there was an endpoint behind it for
                    the reason that governs this whole screen: a step that
                    accepts any six digits is worse than none, because somebody
                    who believes they have 2FA behaves as though they do.

                    Still deliberately absent: Okta, "Trust this device for 30
                    days", the passkey button and "Forgot password?". There is
                    no SAML, WebAuthn, device-trust record or password-reset
                    route behind any of them.
                  */}
                  {ssoAvailable && (
                    <div className="flex flex-col gap-5">
                      <a
                        href="/api/auth/sso/start"
                        className="flex h-11 items-center justify-center gap-2.5 rounded-control border border-line-strong bg-surface px-4 text-auth-body font-semibold text-content transition-colors hover:bg-sunken active:bg-line-soft"
                      >
                        {/* Microsoft's four squares, drawn rather than fetched:
                            the CSP here does not admit an outside image, and a
                            broken one on a sign-in button is worse than none. */}
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 16 16"
                          aria-hidden="true"
                          focusable="false"
                        >
                          <path fill="#f25022" d="M0 0h7.6v7.6H0z" />
                          <path fill="#7fba00" d="M8.4 0H16v7.6H8.4z" />
                          <path fill="#00a4ef" d="M0 8.4h7.6V16H0z" />
                          <path fill="#ffb900" d="M8.4 8.4H16V16H8.4z" />
                        </svg>
                        Continue with Microsoft
                      </a>

                      <div className="flex items-center gap-3" aria-hidden="true">
                        <span className="h-px flex-1 bg-line" />
                        <span className="text-2xs font-medium uppercase tracking-[0.1em] text-content-subtle">
                          or
                        </span>
                        <span className="h-px flex-1 bg-line" />
                      </div>
                    </div>
                  )}

                  {/*
                    What the sign-in redirect came back saying. Fixed reasons
                    rather than Microsoft's own text: this arrives in a URL
                    anybody can type, and the detail an administrator needs is
                    in the server log where nobody can steer it.
                  */}
                  {ssoProblem && (
                    <div role="alert" className={alertBox}>
                      <AlertCircle
                        size={16}
                        aria-hidden="true"
                        className="mt-0.5 flex-shrink-0 text-auth-error"
                      />
                      <p className="text-section leading-relaxed text-content">
                        {ssoProblem}
                      </p>
                    </div>
                  )}

                  {sessionExpired && !formError && (
                    <div className="flex items-start gap-2.5 rounded-control border border-line bg-canvas px-3.5 py-3">
                      <Clock
                        size={16}
                        aria-hidden="true"
                        className="mt-0.5 flex-shrink-0 text-content-muted"
                      />
                      <p className="text-section leading-relaxed text-content-muted">
                        Your session timed out. Sign in again and we will take
                        you back to where you left off.
                      </p>
                    </div>
                  )}

                  <div className="live-region" aria-live="assertive" aria-atomic="true">
                    {formError && (
                      <div
                        role="alert"
                        className={`animate-[fade-in_0.2s_ease-out] ${alertBox}`}
                      >
                        <AlertCircle
                          size={16}
                          aria-hidden="true"
                          className="mt-0.5 flex-shrink-0 text-auth-error"
                        />
                        <p className="text-section font-medium leading-relaxed text-auth-error">
                          {formError}
                        </p>
                      </div>
                    )}
                  </div>

                  <form
                    onSubmit={handleLogin}
                    className="flex flex-col gap-4"
                    noValidate
                  >
                    <div className="flex flex-col gap-2">
                      <label htmlFor="email" className={label}>
                        Email address
                      </label>
                      <div className="relative flex">
                        <Mail
                          size={16}
                          aria-hidden="true"
                          className="pointer-events-none absolute left-3.5 top-3.5 text-content-subtle"
                        />
                        <input
                          id="email"
                          // `name` is what password managers key on; without it
                          // they neither fill nor offer to save the credential.
                          name="email"
                          type="email"
                          ref={emailRef}
                          value={email}
                          onChange={e => {
                            setEmail(e.target.value)
                            setEmailError('')
                            setFormError('')
                          }}
                          placeholder="you@ideas.com.pk"
                          autoComplete="username"
                          // Phone keyboards capitalise and autocorrect by
                          // default, which quietly mangles an address.
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          inputMode="email"
                          autoFocus
                          aria-required="true"
                          aria-invalid={emailError ? true : undefined}
                          aria-describedby={
                            emailError ? 'email-error' : undefined
                          }
                          className="field h-11 pl-10.5 text-auth-body"
                        />
                      </div>
                      {emailError && (
                        <p id="email-error" className="field-error">
                          <AlertCircle size={13} aria-hidden="true" />
                          {emailError}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-col gap-2">
                      <label htmlFor="password" className={label}>
                        Password
                      </label>
                      <div className="relative flex">
                        <Lock
                          size={16}
                          aria-hidden="true"
                          className="pointer-events-none absolute left-3.5 top-3.5 text-content-subtle"
                        />
                        <input
                          id="password"
                          name="password"
                          type={showPw ? 'text' : 'password'}
                          ref={passwordRef}
                          value={password}
                          onChange={e => {
                            setPassword(e.target.value)
                            setPasswordError('')
                            setFormError('')
                          }}
                          onKeyDown={readCapsLock}
                          onKeyUp={readCapsLock}
                          onBlur={() => setCapsLock(false)}
                          placeholder="Enter your password"
                          autoComplete="current-password"
                          aria-required="true"
                          aria-invalid={passwordError ? true : undefined}
                          aria-describedby={
                            [
                              passwordError ? 'password-error' : '',
                              capsLock ? 'caps-warning' : '',
                            ]
                              .filter(Boolean)
                              .join(' ') || undefined
                          }
                          className="field h-11 pl-10.5 pr-11 text-auth-body"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPw(v => !v)}
                          aria-label={showPw ? 'Hide password' : 'Show password'}
                          aria-pressed={showPw}
                          className="absolute right-1 top-1 grid h-9 w-9 place-items-center rounded-chip text-content-subtle transition-colors hover:bg-sunken hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          {showPw ? (
                            <EyeOff size={17} aria-hidden="true" />
                          ) : (
                            <Eye size={17} aria-hidden="true" />
                          )}
                        </button>
                      </div>

                      {passwordError && (
                        <p id="password-error" className="field-error">
                          <AlertCircle size={13} aria-hidden="true" />
                          {passwordError}
                        </p>
                      )}

                      {/* Polite, not assertive: a heads-up while typing, not
                          the result of an action. */}
                      <div className="live-region" aria-live="polite">
                        {capsLock && (
                          <p
                            id="caps-warning"
                            className="flex items-center gap-1.5 text-2xs font-medium text-warning-ink"
                          >
                            <ArrowBigUp size={14} aria-hidden="true" />
                            Caps Lock is on.
                          </p>
                        )}
                      </div>
                    </div>

                    <Button
                      type="submit"
                      size="lg"
                      pending={loading}
                      className="mt-1 h-11.5 w-full gap-2 text-auth-action font-semibold"
                    >
                      {loading ? 'Signing in…' : 'Sign in'}
                      {!loading && <ArrowRight size={17} aria-hidden="true" />}
                    </Button>
                  </form>

                  <p className="border-t border-line pt-5 text-section leading-relaxed text-content-muted text-pretty">
                    Forgot your password? Ask an administrator to reset it for
                    you.
                  </p>
                </div>
              )}
            </section>

            {/*
              Under the card rather than pinned to the foot of the column: two
              short lines that qualify the form belong next to it, not at the
              far end of a tall screen where nobody reads them.
            */}
            <footer className="flex flex-col gap-2 px-1 text-meta leading-relaxed text-content-muted text-pretty">
              <p className="flex items-start gap-2">
                <ShieldCheck
                  size={14}
                  aria-hidden="true"
                  className="mt-0.5 flex-shrink-0"
                />
                Passwords are hashed, never stored. Accounts are provisioned by
                an administrator, so there is no sign-up here.
              </p>
              {/*
                The handoff's footer also carries Terms, Privacy and Data
                processing links, and a build stamp reading "v4.2.1 ·
                PK-CENTRAL-1". This product has none of those three pages, and
                the stamp names a version and a region that do not exist. Three
                dead links and an invented build number under a sign-in form
                are worse than none.
              */}
              <p>© {new Date().getFullYear()} Ideas Pvt Ltd</p>
            </footer>
          </div>
        </div>
      </div>
    </main>
  )
}
