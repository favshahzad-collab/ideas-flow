import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AuthContext, type AuthContextValue } from '../contexts/auth'
import { CurrentUserContext } from '../contexts/currentUser'
import { makeUser } from '../test/render'
import { ProtectedRoute, PublicOnlyRoute } from './RouteGuards'

/**
 * The two guards are the only thing standing between a signed-out browser and
 * every screen in the app. They are not the security boundary - the API is -
 * but they decide whether a person who follows a link to a document is sent
 * back to it after signing in, or dumped on the home page having lost it.
 *
 * Both are asserted through a real router rather than by inspecting the
 * returned element, because what matters is where the browser ends up.
 */

function auth(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    authChecked: true,
    loggedIn: false,
    sessionUser: null,
    sessionKey: 1,
    sessionExpired: false,
    login: () => {},
    logout: () => {},
    ...overrides,
  }
}

/**
 * A router carrying both guards and enough landmarks to tell where we landed.
 * `entry` may carry router state, which is how `from` reaches the guard.
 */
function renderApp(
  entry: string | { pathname: string; state?: unknown },
  overrides: Partial<AuthContextValue> = {},
) {
  return render(
    <AuthContext.Provider value={auth(overrides)}>
      <CurrentUserContext.Provider
        value={{ user: makeUser(), loading: false, error: null, refetch: async () => {} }}
      >
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route element={<PublicOnlyRoute />}>
              <Route path="/login" element={<h1>Sign in</h1>} />
            </Route>
            <Route element={<ProtectedRoute />}>
              <Route path="/" element={<h1>Home</h1>} />
              <Route path="/documents/:id" element={<h1>Document</h1>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </CurrentUserContext.Provider>
    </AuthContext.Provider>,
  )
}

describe('ProtectedRoute', () => {
  it('shows the screen to a signed-in user', () => {
    renderApp('/', { loggedIn: true })

    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument()
  })

  it('sends a signed-out user to sign in', () => {
    renderApp('/')

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Home' })).not.toBeInTheDocument()
  })

  it('waits rather than redirecting while the session is still being checked', () => {
    // This is the difference between a refresh that lands where you were and
    // one that bounces you through the login screen: until the cookie has
    // been checked, "not logged in" is not yet a fact.
    renderApp('/', { authChecked: false })

    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Home' })).not.toBeInTheDocument()
  })

  it('announces the wait to a screen reader, since the skeleton is invisible', () => {
    renderApp('/', { authChecked: false })

    expect(screen.getByText('Checking your session')).toBeInTheDocument()
  })

  it('never renders the screen behind the redirect', () => {
    // A guard that rendered its children first would have already fired their
    // effects - and their API calls - before navigating away.
    renderApp('/documents/abc')

    expect(screen.queryByRole('heading', { name: 'Document' })).not.toBeInTheDocument()
  })
})

describe('PublicOnlyRoute', () => {
  it('shows sign-in to a signed-out user', () => {
    renderApp('/login')

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('sends a signed-in user away from sign-in', () => {
    renderApp('/login', { loggedIn: true })

    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument()
  })

  it('returns them to where they were headed, not to the home page', () => {
    // The whole point of carrying `from`: following a link to a document
    // while signed out and signing in should open that document.
    renderApp(
      { pathname: '/login', state: { from: '/documents/abc' } },
      { loggedIn: true },
    )

    expect(screen.getByRole('heading', { name: 'Document' })).toBeInTheDocument()
  })

  it('refuses an off-site return path and goes home instead', () => {
    // `from` is router state rather than a query string, so it cannot be set
    // by a crafted link today. The guard still refuses it, and that refusal
    // is what keeps this safe if it ever becomes a query string.
    for (const from of ['//evil.example.com', 'https://evil.example.com', 42, null]) {
      const { unmount } = renderApp(
        { pathname: '/login', state: { from } },
        { loggedIn: true },
      )

      expect(screen.getByRole('heading', { name: 'Home' }), String(from)).toBeInTheDocument()
      unmount()
    }
  })

  it('waits rather than redirecting while the session is still being checked', () => {
    renderApp('/login', { authChecked: false, loggedIn: true })

    expect(screen.queryByRole('heading', { name: 'Home' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
  })
})
