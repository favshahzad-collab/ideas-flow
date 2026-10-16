import { createContext, useContext } from 'react'
import type { CurrentUser } from './currentUser'
import type { UserRole } from '../types/user'

/**
 * The context object and its hook, kept out of `AuthContext.tsx` so the
 * provider is that file's only export and fast refresh keeps working.
 */

export interface AuthContextValue {
  authChecked: boolean
  loggedIn: boolean
  sessionUser: CurrentUser | null
  sessionKey: number
  /** True when the last session ended by expiry rather than by signing out. */
  sessionExpired: boolean
  login: (role: UserRole) => void
  /** Ends the session on the server as well as here. `true` ends every device. */
  logout: (everywhere?: boolean) => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return ctx
}
