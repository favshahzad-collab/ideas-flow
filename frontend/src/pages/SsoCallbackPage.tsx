import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AlertCircle, LoaderCircle } from 'lucide-react'
import { useAuth } from '../contexts/auth'
import { exchangeSsoCode } from '../services/authApi'
import { ROUTES } from '../types/routes'

/**
 * The last step of signing in with a Microsoft work account.
 *
 * Microsoft returns to a server route, and the session belongs to the browser.
 * What arrives here in the address bar is a one-time code worth nothing except
 * to whoever posts it back within the minute - the session itself never
 * travels in a URL, where it would be written into history, the referrer
 * header and any proxy log on the way.
 *
 * So this screen is one request and two outcomes, and it is deliberately
 * plain: nobody reads it. It is what somebody looks at for the half second
 * between Microsoft and their workspace, and the only thing worth designing is
 * what happens when that half second turns into a refusal.
 */
export default function SsoCallbackPage() {
  const [params] = useSearchParams()
  const { login: completeLogin } = useAuth()
  const [refusal, setRefusal] = useState<string | null>(null)
  const code = params.get('code')

  /*
   * A link with no code at all is not a state change, it is a fact about the
   * URL — so it is worked out here rather than written into state from an
   * effect, which is both a cascading render and something the lint rule
   * refuses outright.
   */
  const failure = code
    ? refusal
    : 'That sign-in link is missing its code. Start again from the sign-in screen.'

  useEffect(() => {
    if (!code) return

    let cancelled = false

    exchangeSsoCode(code)
      .then((session) => {
        if (cancelled) return
        // No navigation here: flipping the session is enough, and
        // `PublicOnlyRoute` moves off this screen on its own. The tokens are
        // already stored by `exchangeSsoCode`; what the context wants is the
        // role, exactly as the password form hands it over.
        completeLogin(session.user.role)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setRefusal(
          error instanceof Error
            ? error.message
            : 'That sign-in could not be completed.',
        )
      })

    return () => {
      cancelled = true
    }
  }, [code, completeLogin])

  return (
    <main className="auth flex min-h-dvh items-center justify-center bg-canvas px-6 py-10">
      <div className="flex w-full max-w-101 flex-col gap-5">
        {failure ? (
          <div className="flex flex-col gap-4">
            <div
              role="alert"
              className="flex items-start gap-2.25 border border-auth-error bg-auth-error/8 px-3 py-2.5"
            >
              <AlertCircle
                size={15}
                aria-hidden="true"
                className="mt-0.5 flex-shrink-0 text-auth-error"
              />
              <p className="text-[0.8125rem] leading-relaxed text-content">
                {failure}
              </p>
            </div>

            <Link
              to={ROUTES.login}
              className="self-start text-[0.8125rem] font-medium text-auth-ink underline underline-offset-2 hover:no-underline"
            >
              Back to sign in
            </Link>
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            <LoaderCircle
              size={16}
              aria-hidden="true"
              className="animate-spin text-content-muted"
            />
            {/*
              A live region rather than a heading: this is a transition, not a
              page, and a screen reader announcing "Signing you in" and then
              moving on is exactly what a sighted person sees.
            */}
            <p aria-live="polite" className="text-[0.875rem] text-content-muted">
              Signing you in…
            </p>
          </div>
        )}
      </div>
    </main>
  )
}
