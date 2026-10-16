import type { UserRole } from '../types/user.ts'
import type { Capability } from '../types/capability'
import { parseApiError } from '../utils/apiError'
import { apiJson, jsonBody } from './apiClient'
import { getRefreshToken, setAuthToken, setRefreshToken } from './authTokens'

export type LoginResponse = {
  accessToken: string
  refreshToken: string
  user: {
    id: string
    email: string
    role: UserRole
  }
}

function normalizeUserRole(role: string): UserRole {
  return role?.toLowerCase() === 'administrator' ? 'ADMINISTRATOR' : 'USER'
}

/**
 * A sign-in that stopped for a code from an authenticator app.
 *
 * It names no account, carries no session and is worth nothing on its own -
 * which is why it is safe to hold in component state while somebody finds
 * their phone. No tokens are stored at this point, because none exist yet.
 */
export type TwoFactorChallenge = {
  twoFactorRequired: true
  challenge: string
  expiresAt: string
}

export type LoginResult = LoginResponse | TwoFactorChallenge

/** Which of the two came back. */
export function needsCode(result: LoginResult): result is TwoFactorChallenge {
  return 'twoFactorRequired' in result
}

export async function login(
  email: string,
  password: string
): Promise<LoginResult> {
  // Deliberately a bare `fetch`. A wrong password answers 401, and `apiFetch`
  // would read that as an expired session and try to refresh it away.
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })

  if (!res.ok) {
    throw new Error(await parseApiError(res))
  }

  const payload = (await res.json()) as
    | TwoFactorChallenge
    | Parameters<typeof keepSession>[0]

  // Nothing is stored for a challenge: there is no session to store, and the
  // password alone must not leave anything behind that looks like one.
  if ('twoFactorRequired' in payload) {
    return payload
  }

  return keepSession(payload)
}

/**
 * The second half: six digits off the phone, or one recovery code.
 *
 * A bare `fetch` for the same reason the other two use one - a refused code
 * answers 401, and `apiFetch` would read that as a session to refresh away
 * when there is no session yet at all.
 */
export async function submitTwoFactorCode(
  challenge: string,
  code: string
): Promise<LoginResponse> {
  const res = await fetch('/api/auth/2fa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge, code }),
  })

  if (!res.ok) {
    throw new Error(await parseApiError(res))
  }

  return keepSession(await res.json())
}

/**
 * Take a session payload and remember it.
 *
 * Shared by the password sign-in and the Microsoft one, which answer in the
 * same shape on purpose: the application stores a session without knowing
 * which route produced it.
 */
function keepSession(payload: {
  accessToken: string
  refreshToken: string
  user?: { id?: string; email?: string; role?: string }
}): LoginResponse {
  const result: LoginResponse = {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    user: {
      id: payload.user?.id as string,
      email: payload.user?.email as string,
      role: normalizeUserRole(payload.user?.role as string),
    },
  }

  setAuthToken(result.accessToken)
  setRefreshToken(result.refreshToken)
  return result
}

/**
 * Whether to offer "Continue with Microsoft" at all.
 *
 * A button that cannot work sits on the one screen nobody can get past, and
 * reads as the product being broken rather than the feature being
 * unconfigured - so the screen asks first. Unreachable answers no: the
 * password form below it still works, and that is the one thing the sign-in
 * screen must never get in the way of.
 */
export async function fetchSsoAvailable(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/sso/available', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })

    if (!res.ok) return false

    const payload = (await res.json()) as { available?: boolean }
    return payload.available === true
  } catch {
    return false
  }
}

/**
 * Trade the one-time code from the sign-in redirect for a session.
 *
 * A bare `fetch` for the same reason `login` uses one: a spent or expired code
 * answers 401, and `apiFetch` would read that as a session to refresh away.
 */
export async function exchangeSsoCode(code: string): Promise<LoginResponse> {
  const res = await fetch('/api/auth/sso/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })

  if (!res.ok) {
    throw new Error(await parseApiError(res))
  }

  return keepSession(await res.json())
}

/**
 * Tell the server the session is over.
 *
 * Clearing the tokens on this side only makes the browser forget them; the
 * refresh token stays good for thirty days in anybody who has a copy. This is
 * what actually ends it, and it is deliberately best-effort: a sign-out must
 * never leave somebody stuck on a screen because the network was down. The
 * local tokens are cleared either way.
 */
export async function signOut(everywhere = false): Promise<void> {
  const refreshToken = getRefreshToken()

  try {
    await apiJson('/api/auth/sign-out', {
      method: 'POST',
      ...jsonBody({ refreshToken: refreshToken ?? undefined, everywhere }),
    })
  } catch {
    // Already expired, already revoked, or unreachable. Nothing here changes
    // what happens next.
  }
}

export async function getMe() {
  const data = await apiJson<{
    id: string
    email: string
    firstName: string
    lastName: string
    loginRole: string
    designation?: string | null
    department?: { id: string; name: string } | null
    signatureStoragePath: string | null
    capabilities?: Capability[]
    viewOnly?: Capability[]
    isSuperAdmin?: boolean
    workflowPolicy?: {
      allowStepSkip?: boolean
      preparerSignsOnSubmit?: boolean
    }
    twoFactorEnrolmentRequired?: boolean
    hasPassword?: boolean
    hasAuthenticator?: boolean
  }>('/api/auth/me')

  return {
    id: data.id,
    email: data.email,
    firstName: data.firstName,
    lastName: data.lastName,
    role: normalizeUserRole(data.loginRole),
    /* Already on the wire; the client simply dropped them. The signing editor
       needs both to show - and reserve room for - the name block the backend
       draws under a signature, which is sized from exactly these. */
    designation: data.designation ?? null,
    department: data.department?.name ?? null,
    hasSignature: Boolean(data.signatureStoragePath),
    // Optional on the wire so a client that has been open across a deploy of
    // the older server does not lose its navigation. An empty list hides the
    // administration group rather than showing links that would be refused.
    capabilities: data.capabilities ?? [],
    // Which tier of administrator, for the badge. What they may do is
    // `capabilities`; this only names it.
    isSuperAdmin: data.isSuperAdmin === true,
    viewOnly: data.viewOnly ?? [],
    // Absent reads as off, which is the safe direction: the button stays
    // hidden and the API would refuse the call anyway.
    workflowPolicy: {
      allowStepSkip: data.workflowPolicy?.allowStepSkip === true,
      /* Absent reads as ON here, the opposite way round from the flag above,
         and for the same reason: safety points in a different direction. A
         client open across a deploy of the older server must keep collecting
         the preparer's signature - dropping it would file documents with a
         blank line where the author's mark belongs, and the server would
         refuse the submission anyway. */
      preparerSignsOnSubmit: data.workflowPolicy?.preparerSignsOnSubmit !== false,
    },
    /* Absent reads as not required: an older server has no gate, and would
       answer every request as it always did. */
    twoFactorEnrolmentRequired: data.twoFactorEnrolmentRequired === true,
    /* Absent reads as having both, so an older server never nags anybody. */
    hasPassword: data.hasPassword !== false,
    hasAuthenticator: data.hasAuthenticator !== false,
  } as {
    id: string
    email: string
    firstName: string
    lastName: string
    role: UserRole
    designation: string | null
    department: string | null
    hasSignature: boolean
    capabilities: Capability[]
    isSuperAdmin: boolean
    viewOnly: Capability[]
    workflowPolicy: { allowStepSkip: boolean; preparerSignsOnSubmit: boolean }
    twoFactorEnrolmentRequired: boolean
    hasPassword: boolean
    hasAuthenticator: boolean
  }
}

/** What somebody's own account screen shows about two-step sign-in. */
export type TwoFactorStatus = {
  enabled: boolean
  activatedAt: string | null
  /** Started and never confirmed. The screen offers to carry on rather than
   *  handing out a second secret the already-scanned phone would not match. */
  pending: boolean
  recoveryCodesRemaining: number
  recoveryCodesUsed: number
  /** Stored, and unreadable on this server. Its own state because the fix is
   *  different from having no secret at all: an administrator has to lift it. */
  secretUnreadable: boolean
}

export function fetchTwoFactorStatus(): Promise<TwoFactorStatus> {
  return apiJson<TwoFactorStatus>('/api/auth/2fa')
}

/**
 * Step one of enrolment.
 *
 * The secret is in this answer and nowhere else afterwards. The server keeps
 * only an encrypted copy and will never hand it back, so a screen that loses
 * it has to start again rather than ask for it a second time.
 */
export function startTwoFactorSetup(): Promise<{
  secret: string
  otpauthUri: string
}> {
  return apiJson('/api/auth/2fa/setup', { method: 'POST' })
}

/** Step two, which is what actually switches it on. Returns the codes, once. */
export function activateTwoFactor(
  code: string
): Promise<{ activatedAt: string; recoveryCodes: string[] }> {
  return apiJson('/api/auth/2fa/activate', {
    method: 'POST',
    ...jsonBody({ code }),
  })
}

/** A fresh set, in exchange for a live code. Replaces the old set entirely. */
export function replaceRecoveryCodes(
  code: string
): Promise<{ recoveryCodes: string[] }> {
  return apiJson('/api/auth/2fa/recovery-codes', {
    method: 'POST',
    ...jsonBody({ code }),
  })
}

/** Turning it off, which needs the password rather than a code. */
export function disableTwoFactor(password: string): Promise<{ enabled: false }> {
  return apiJson('/api/auth/2fa/disable', {
    method: 'POST',
    ...jsonBody({ password }),
  })
}
