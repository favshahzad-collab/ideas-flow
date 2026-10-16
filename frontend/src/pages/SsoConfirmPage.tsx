import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { STEP_UP_MESSAGE, type StepUpMessage } from '../services/microsoftStepUp'

/**
 * Where a "confirm with Microsoft" window lands.
 *
 * It hands the one-time code to the window that opened it - same origin only
 * - and closes. Nothing here signs anybody in: the code is worth a
 * confirmation to the signed-in page that started it, and nothing else.
 */
export default function SsoConfirmPage() {
  const [params] = useSearchParams()
  const code = params.get('code')

  useEffect(() => {
    const message: StepUpMessage = code
      ? { type: STEP_UP_MESSAGE, code }
      : { type: STEP_UP_MESSAGE, result: params.get('result') ?? 'failed' }
    window.opener?.postMessage(message, window.location.origin)
    window.close()
  }, [code, params])

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface p-6 text-ui text-content">
      <p>{code ? 'Confirmed. You can close this window.' : 'That did not work. Close this window and try again.'}</p>
    </main>
  )
}
