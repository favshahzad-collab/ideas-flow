import { createContext, useContext } from 'react'
import type { UserRole } from '../types/user'
import type { Capability } from '../types/capability'

/**
 * The context object and its hook, kept out of `CurrentUserContext.tsx`.
 * A file that exports both a component and something else loses fast refresh,
 * so the provider now lives alone in the `.tsx`.
 */

export interface CurrentUser {
  id: string
  email: string
  firstName: string
  lastName: string
  role: UserRole
  /**
   * What is printed under this person's signature on a memo.
   *
   * Both come from `/api/auth/me`, which has always sent them. The signing
   * editor needs them to draw the name block over the page and to reserve the
   * height the backend will reserve for it - without the designation the
   * reserved height is a line short, and a signature placed near the foot of a
   * page comes back higher in the PDF than where it was put.
   */
  designation: string | null
  department: string | null
  hasSignature: boolean
  /** What the server says this person may do. Rendering only - see the type. */
  capabilities: Capability[]
  /**
   * A Super Administrator: every power, and alone manages administrators.
   * Any other administrator holds only the powers in `capabilities`.
   */
  isSuperAdmin: boolean
  /** Areas given to see but not change. Not in `capabilities`. */
  viewOnly: Capability[]
  /**
   * Deployment policy the screens have to agree with.
   *
   * `allowStepSkip` is asked rather than compiled in because an administrator
   * changes it from the Workflow policy screen at runtime. A build-time flag
   * cannot follow that, and the version that tried left the switch turning
   * nothing on.
   */
  workflowPolicy: {
    allowStepSkip: boolean
    /**
     * Does submitting a document also mean signing it?
     *
     * The answer for an uploaded file, which has no memo type to ask. A typed
     * memo is told by the server when its page is drawn, because the memo
     * type can overrule this either way.
     */
    preparerSignsOnSubmit: boolean
  }
  /**
   * An administrator who has not set up two-step sign-in, where the
   * deployment requires it. The server refuses everything else they ask for,
   * so the app shows the setup screen in place of every page.
   */
  twoFactorEnrolmentRequired: boolean
  /**
   * How this person can confirm it is them. Without a password - somebody
   * who signs in only with Microsoft - they confirm with a fresh Microsoft
   * sign-in, and are asked to set up an authenticator app as a fallback.
   */
  hasPassword: boolean
  hasAuthenticator: boolean
}

export interface CurrentUserContextValue {
  user: CurrentUser | null
  loading: boolean
  error: string | null
  refetch: () => Promise<void>
}


export const CurrentUserContext = createContext<CurrentUserContextValue | null>(null)

export function useCurrentUser(): CurrentUserContextValue {
  const ctx = useContext(CurrentUserContext)
  if (!ctx) {
    throw new Error('useCurrentUser must be used within a CurrentUserProvider')
  }
  return ctx
}
