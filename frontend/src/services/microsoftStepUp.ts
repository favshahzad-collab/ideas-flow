import { apiJson, jsonBody } from './apiClient'

/**
 * Confirming it is you with a fresh Microsoft sign-in.
 *
 * For people who sign in with Microsoft and have no password here. A small
 * window goes to Microsoft, which asks for the credentials again (and runs
 * its own two-step check); it comes back to `/sso/confirm`, which hands this
 * window a one-time code and closes. The code is spent here, by the signed-in
 * page, for the same five-minute confirmation a password would have earned.
 */

/** What the small window posts back. Checked, because any page can post. */
export const STEP_UP_MESSAGE = 'ideasflow-step-up'

export type StepUpMessage = { type: typeof STEP_UP_MESSAGE; code?: string; result?: string }

export async function confirmWithMicrosoft(): Promise<{ stepUpToken: string; expiresAt: string }> {
  // Opened before anything is awaited: a window opened after a network round
  // trip is no longer "in response to a click", and browsers block it.
  const popup = window.open('', 'ideasflow-confirm', 'width=520,height=680')
  if (!popup) {
    throw new Error('Your browser blocked the Microsoft window. Allow pop-ups for this site and try again.')
  }

  try {
    const { url } = await apiJson<{ url: string }>('/api/auth/step-up/microsoft/start', {
      method: 'POST',
    })
    popup.location.href = url

    const code = await new Promise<string>((resolve, reject) => {
      const watch = window.setInterval(() => {
        if (popup.closed) {
          cleanup()
          reject(new Error('The Microsoft window was closed before you finished.'))
        }
      }, 500)

      const onMessage = (event: MessageEvent<unknown>) => {
        if (event.origin !== window.location.origin) return
        const data = event.data as Partial<StepUpMessage> | null
        if (!data || data.type !== STEP_UP_MESSAGE) return
        cleanup()
        if (data.code) resolve(data.code)
        else reject(new Error('Microsoft did not confirm it was you. Try again.'))
      }

      const cleanup = () => {
        window.clearInterval(watch)
        window.removeEventListener('message', onMessage)
      }

      window.addEventListener('message', onMessage)
    })

    return await apiJson<{ stepUpToken: string; expiresAt: string }>(
      '/api/auth/step-up/microsoft',
      { method: 'POST', ...jsonBody({ code }) },
    )
  } finally {
    if (!popup.closed) popup.close()
  }
}
