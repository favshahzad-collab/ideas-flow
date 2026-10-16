import { useContext, useEffect, useRef, useState } from 'react'
import Modal from './Modal'
import Button from './ui/Button'
import { apiJson, jsonBody } from '../services/apiClient'
import { fetchSsoAvailable } from '../services/authApi'
import { confirmWithMicrosoft } from '../services/microsoftStepUp'
import { registerStepUpPrompt, rememberStepUp, type StepUpPurpose } from '../services/stepUp'
import { CurrentUserContext } from '../contexts/currentUser'

/**
 * "Confirm it's you", asked just before a sensitive change.
 *
 * Mounted once, beside the app. `apiFetch` opens it when the server refuses a
 * request with STEP_UP_REQUIRED, and resends the request once this has a
 * confirmation - so the person presses Save, types their password, and the
 * save goes through. Cancelling hands the refusal back to the screen that
 * asked, which shows it like any other.
 *
 * Three ways to answer, whichever the person has: the password, a code from
 * the authenticator app, or - for somebody who signs in with Microsoft - a
 * fresh Microsoft sign-in in a small window, which Microsoft makes them type
 * their credentials into again.
 */

const TITLES: Record<StepUpPurpose, string> = {
  change: "Confirm it's you",
  sign: "Confirm it's you to sign",
  decide: "Confirm it's you to record this decision",
}

const DESCRIPTIONS: Record<StepUpPurpose, string> = {
  change:
    "This change affects who can sign, approve or administer. Confirm it's you to carry on. You won't be asked again for five minutes.",
  sign:
    "Your signature is binding, so the app checks it's you before it goes on the memo. You won't be asked again for five minutes.",
  decide:
    "Rejecting, sending back or skipping a step is a decision on the record, so the app checks it's you first. You won't be asked again for five minutes.",
}

type Method = 'password' | 'code'

export default function StepUpDialog() {
  const signedIn = useContext(CurrentUserContext)?.user ?? null
  const hasPassword = signedIn?.hasPassword !== false
  const hasAuthenticator = signedIn?.hasAuthenticator !== false

  const [open, setOpen] = useState(false)
  const [method, setMethod] = useState<Method>('password')
  const [value, setValue] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [purpose, setPurpose] = useState<StepUpPurpose>('change')
  const [microsoft, setMicrosoft] = useState(false)
  const settle = useRef<((confirmed: boolean) => void) | null>(null)
  // Read by the prompt, which is registered once; kept current here.
  const preferred = useRef<Method>('password')
  useEffect(() => {
    preferred.current = hasPassword || !hasAuthenticator ? 'password' : 'code'
  }, [hasPassword, hasAuthenticator])

  useEffect(() => {
    let cancelled = false
    void fetchSsoAvailable().then(available => {
      if (!cancelled) setMicrosoft(available)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    registerStepUpPrompt(
      nextPurpose =>
        new Promise<boolean>(resolve => {
          settle.current = resolve
          setPurpose(nextPurpose)
          setValue('')
          setProblem(null)
          setMethod(preferred.current)
          setOpen(true)
        }),
    )
    return () => {
      registerStepUpPrompt(null)
      // Gone while asking - signed out, say - is a no. Left unanswered, the
      // shared question would hold every later request waiting on it.
      settle.current?.(false)
      settle.current = null
    }
  }, [])

  const finish = (confirmed: boolean) => {
    setOpen(false)
    settle.current?.(confirmed)
    settle.current = null
  }

  const submit = async () => {
    if (!value.trim()) return
    setBusy(true)
    setProblem(null)
    try {
      const answer = await apiJson<{ stepUpToken: string; expiresAt: string }>(
        '/api/auth/step-up',
        {
          method: 'POST',
          ...jsonBody(method === 'code' ? { code: value.trim() } : { password: value }),
        },
      )
      rememberStepUp(answer.stepUpToken, answer.expiresAt)
      finish(true)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That did not work. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const withMicrosoft = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const answer = await confirmWithMicrosoft()
      rememberStepUp(answer.stepUpToken, answer.expiresAt)
      finish(true)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That did not work. Try again.')
    } finally {
      setBusy(false)
    }
  }

  // Somebody with neither a password nor the app can only use Microsoft.
  const typed = hasPassword || hasAuthenticator
  const fieldId = method === 'code' ? 'step-up-code' : 'step-up-password'
  const other: Method | null =
    method === 'password' ? (hasAuthenticator ? 'code' : null) : hasPassword ? 'password' : null

  return (
    <Modal
      open={open}
      onClose={() => !busy && finish(false)}
      title={TITLES[purpose]}
      description={DESCRIPTIONS[purpose]}
      size="sm"
    >
      <form
        className="space-y-3"
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        {typed && (
          <div>
            <label htmlFor={fieldId} className="field-label">
              {method === 'code' ? 'Code from your authenticator app' : 'Your password'}
            </label>
            <input
              id={fieldId}
              type={method === 'code' ? 'text' : 'password'}
              inputMode={method === 'code' ? 'numeric' : undefined}
              autoComplete={method === 'code' ? 'one-time-code' : 'current-password'}
              value={value}
              onChange={event => {
                setValue(event.target.value)
                setProblem(null)
              }}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? 'step-up-error' : undefined}
              className="field h-9"
              data-autofocus
            />
          </div>
        )}

        {problem && (
          <p id="step-up-error" role="alert" className="field-error">
            {problem}
          </p>
        )}

        {typed && other && (
          <button
            type="button"
            className="text-meta font-medium text-accent-ink underline-offset-2 hover:underline"
            onClick={() => {
              setMethod(other)
              setValue('')
              setProblem(null)
            }}
          >
            {other === 'code'
              ? 'Use a code from my authenticator app instead'
              : 'Use my password instead'}
          </button>
        )}

        {microsoft && (
          <Button
            type="button"
            variant={typed ? 'secondary' : 'primary'}
            className="w-full"
            onClick={() => void withMicrosoft()}
            pending={busy && !typed}
            disabled={busy}
          >
            Confirm with Microsoft
          </Button>
        )}

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:gap-3">
          {typed && (
            <Button type="submit" className="flex-1" pending={busy} disabled={!value.trim()}>
              Confirm
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            className="flex-1"
            onClick={() => finish(false)}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  )
}
