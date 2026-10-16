import { render, type RenderOptions, type RenderResult } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { AuthContext, type AuthContextValue } from '../contexts/auth'
import {
  CurrentUserContext,
  type CurrentUser,
  type CurrentUserContextValue,
} from '../contexts/currentUser'
import type { Capability } from '../types/capability'

/**
 * The providers a screen cannot render without, supplied as plain values
 * rather than by mounting the real providers. The real ones fetch on mount;
 * a component test that had to serve `/api/auth/me` before it could assert on
 * a button would be testing the provider, and would fail for reasons that
 * have nothing to do with the component under test.
 *
 * Every default here is the *unremarkable* case - signed in, checked, an
 * ordinary USER with a signature on file. A test that cares about any of
 * those states says so at its call site, which is also where a reader looks
 * to find out why the assertion is what it is.
 */

export const TEST_USER_ID = 'user-0000-0000-0000-000000000001'

/**
 * What an ordinary member of staff holds, as the server grants it.
 *
 * Written out rather than left empty so the default user in every test is a
 * real one: a screen that reads a capability would otherwise render its
 * signed-out shape in tests and its real shape in the product, and the test
 * would pass. `ADMIN_CAPABILITIES` is these plus the administration ones.
 */
export const STAFF_CAPABILITIES: Capability[] = [
  'memos.prepare',
  'memos.view.own',
  'memos.view.assigned',
  'memos.comment',
  'approvals.act',
  'approvals.delegate',
  'audit.view',
]

export const ADMIN_CAPABILITIES: Capability[] = [
  ...STAFF_CAPABILITIES,
  'audit.verify',
  'approvals.oversee',
  'sessions.view',
  'users.manage',
  'departments.manage',
  'workflows.manage',
  'workflows.policy',
  'mail.configure',
  'sso.configure',
]

export function makeUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  const role = overrides.role ?? 'USER'

  return {
    id: TEST_USER_ID,
    email: 'ayesha.khan@example.com',
    firstName: 'Ayesha',
    lastName: 'Khan',
    role,
    // What is printed under this person's signature. A designation is the
    // ordinary case, so the fixture carries one: the signing editor sizes the
    // name block from it, and a fixture with none would exercise the shorter
    // block every time.
    designation: 'Deputy Manager',
    department: 'Finance',
    hasSignature: true,
    // Follows the role unless a test says otherwise, so `makeUser({ role:
    // 'ADMINISTRATOR' })` keeps meaning what it has always meant.
    capabilities: role === 'ADMINISTRATOR' ? ADMIN_CAPABILITIES : STAFF_CAPABILITIES,
    // An administrator fixture is a Super Administrator, as every test written
    // before the two tiers expects.
    isSuperAdmin: role === 'ADMINISTRATOR',
    viewOnly: [],
    /*
     * Off, which is what every deployment ships with: skipping an approver is
     * a hole in the one claim the workflow makes, so it stays shut until an
     * administrator opens it. A test about the Skip control says otherwise
     * explicitly, which is the right way round - the default must not be the
     * permissive one.
     */
    workflowPolicy: { allowStepSkip: false, preparerSignsOnSubmit: true },
    // Not gated: the fixture's people have whatever they need to use the app.
    twoFactorEnrolmentRequired: false,
    hasPassword: true,
    hasAuthenticator: true,
    ...overrides,
  }
}

export interface ProviderOptions {
  /** Initial history entries, exactly as `MemoryRouter` takes them. */
  route?: string | { pathname: string; state?: unknown }
  auth?: Partial<AuthContextValue>
  currentUser?: Partial<CurrentUserContextValue>
  /** Omit the router when the component under test is mounted inside one. */
  router?: boolean
}

function authValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    authChecked: true,
    loggedIn: true,
    sessionUser: makeUser(),
    sessionKey: 1,
    sessionExpired: false,
    login: () => {},
    logout: () => {},
    ...overrides,
  }
}

function currentUserValue(
  overrides: Partial<CurrentUserContextValue> = {},
): CurrentUserContextValue {
  return {
    user: makeUser(),
    loading: false,
    error: null,
    refetch: async () => {},
    ...overrides,
  }
}

export function Providers({
  children,
  route = '/',
  auth,
  currentUser,
  router = true,
}: ProviderOptions & { children: ReactNode }) {
  const tree = (
    <AuthContext.Provider value={authValue(auth)}>
      <CurrentUserContext.Provider value={currentUserValue(currentUser)}>
        {children}
      </CurrentUserContext.Provider>
    </AuthContext.Provider>
  )

  if (!router) return tree
  return <MemoryRouter initialEntries={[route]}>{tree}</MemoryRouter>
}

export function renderWithProviders(
  ui: ReactElement,
  { route, auth, currentUser, router, ...options }: ProviderOptions & RenderOptions = {},
): RenderResult {
  return render(ui, {
    wrapper: ({ children }) => (
      <Providers route={route} auth={auth} currentUser={currentUser} router={router}>
        {children}
      </Providers>
    ),
    ...options,
  })
}
