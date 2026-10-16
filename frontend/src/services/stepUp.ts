/**
 * Confirming it is you before a sensitive change, on the client side.
 *
 * A handful of server routes - turning off somebody's two-step sign-in,
 * changing a role, email or password, making an administrator, importing
 * people, replacing the mail or sign-on credentials - refuse with
 * STEP_UP_REQUIRED unless the request carries a confirmation made in the last
 * five minutes. `apiFetch` handles that refusal in one place: it asks the
 * person, through the prompt registered here, and resends the request. No
 * screen needs to know which of its buttons asks.
 *
 * The confirmation lives in memory only. It is worth five minutes of
 * sensitive changes, and a copy in storage would outlive the tab.
 */

let held: { token: string; expiresAt: number } | null = null

/** The confirmation to send, while it is still good. */
export function currentStepUp(): string | null {
  if (!held) return null
  // A few seconds of margin, so a request does not leave with one that
  // expires on the way.
  if (held.expiresAt - Date.now() < 5_000) {
    held = null
    return null
  }
  return held.token
}

export function rememberStepUp(token: string, expiresAt: string): void {
  held = { token, expiresAt: new Date(expiresAt).getTime() }
}

export function forgetStepUp(): void {
  held = null
}

/**
 * What the confirmation is for, so the dialog can say so. A sensitive
 * administration change, or putting a signature on a memo - the server
 * refuses the two with different codes.
 */
export type StepUpPurpose = 'change' | 'sign' | 'decide'

/** The server's refusal codes, and the purpose each one asks about. */
export const STEP_UP_CODES: Record<string, StepUpPurpose> = {
  STEP_UP_REQUIRED: 'change',
  STEP_UP_REQUIRED_TO_SIGN: 'sign',
  // Rejecting, sending back or skipping: a decision, not a signature.
  STEP_UP_REQUIRED_TO_DECIDE: 'decide',
}

type Prompt = (purpose: StepUpPurpose) => Promise<boolean>

let prompt: Prompt | null = null
let asking: Promise<boolean> | null = null

/** The dialog registers itself here; nothing is asked while none is mounted. */
export function registerStepUpPrompt(next: Prompt | null): void {
  prompt = next
}

/**
 * Ask once, however many requests were refused at the same moment. Resolves
 * true once a confirmation has been remembered, false if the person cancelled
 * or nothing is there to ask.
 */
export function askForStepUp(purpose: StepUpPurpose = 'change'): Promise<boolean> {
  if (!prompt) return Promise.resolve(false)
  asking ??= prompt(purpose).finally(() => {
    asking = null
  })
  return asking
}

/**
 * Before sending a signature: have a confirmation in hand, asking if need be.
 *
 * The server would refuse a signed submission without one, and the app would
 * ask and send again - but a submission carries the whole PDF, up to 120 MB,
 * and sending it twice to learn that is a long wait for nothing. Resolves
 * false if the person cancelled.
 */
/** What a signing dialog shows when the confirmation was cancelled. */
export const SIGNING_NOT_CONFIRMED =
  'Signing was not confirmed. Press the button again and enter your password to sign.'

export async function confirmedToSign(): Promise<boolean> {
  return currentStepUp() !== null || askForStepUp('sign')
}
