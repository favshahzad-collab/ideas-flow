import { Suspense } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import AppShell from './AppShell'
import TwoFactorGate from './account/TwoFactorGate'
import StepUpDialog from './StepUpDialog'
import ErrorBoundary from './ui/ErrorBoundary'
import RouteFallback from './ui/RouteFallback'
import { CurrentUserProvider } from '../contexts/CurrentUserContext'
import { CommandPaletteProvider } from '../contexts/CommandPaletteContext'
import { useAuth } from '../contexts/auth'
import { useCurrentUser } from '../contexts/currentUser'
import { ROUTES, PAGE_LABELS, pathToPage } from '../types/routes'
import { holdsCapability, seesCapability, type Capability } from '../types/capability'
import { ViewOnlyContext } from './ui/viewOnly'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

function HomeRedirect() {
  const { user, loading } = useCurrentUser()

  if (loading) {
    return <RouteFallback label="Loading your workspace" />
  }

  if (user?.role === 'ADMINISTRATOR') {
    return <Navigate to={ROUTES.people} replace />
  }

  return <Navigate to={ROUTES.dashboard} replace />
}

/**
 * The guard on an administration screen.
 *
 * `needs` names the capability that opens it - the same capability its sidebar
 * row names. That matters because the two were deciding differently: the row
 * appeared when the server said the person held the capability, and the guard
 * turned them away unless their role was ADMINISTRATOR. Today those agree for
 * every screen, so nothing was wrong; the day a capability moved between roles
 * they would have disagreed, and the visible result is the failure this whole
 * change set exists to prevent - a link that bounces off the page it opens.
 *
 * It is still not the enforcement. The route behind the screen refuses the
 * request on its own, and would whatever this decided; this only settles which
 * of two screens a person is shown.
 */
function AdminOnly({
  needs,
  children,
}: {
  needs?: Capability
  children: React.ReactNode
}) {
  const { user, loading } = useCurrentUser()

  if (loading) {
    return <RouteFallback label="Loading your workspace" />
  }

  const allowed = needs ? seesCapability(user, needs) : user?.role === 'ADMINISTRATOR'

  if (!allowed) {
    return <Navigate to={ROUTES.dashboard} replace />
  }

  // Given the screen to see but not change: the header says so up front.
  const viewOnly = Boolean(needs) && !holdsCapability(user, needs!)

  return <ViewOnlyContext.Provider value={viewOnly}>{children}</ViewOnlyContext.Provider>
}

export function AppLayout() {
  const { sessionUser, sessionKey, logout } = useAuth()
  const location = useLocation()

  // The shell used to hide the sidebar on `/administration` and every
  // `/admin/*` route, which left an administrator on a page with no links at
  // all — and admins land on `/administration` by default. Only the workflow
  // designer stays full-bleed: it needs the canvas width, it already has a
  // guarded back button, and its unsaved-changes prompt cannot intercept a
  // sidebar link (that needs a data router, which this app does not use).
  const page = pathToPage(location.pathname)
  const showSidebar = page !== 'workflow-designer'

  // Derived from the route rather than a second list of names, so a tab
  // title can never drift from the nav item and breadcrumb it matches.
  useDocumentTitle(page ? PAGE_LABELS[page] : undefined)

  return (
    <CurrentUserProvider key={sessionKey} initialUser={sessionUser}>
      <UntilTwoFactorIsSetUp onSignOut={() => logout()}>
      {/* Outside AppShell, because the shell itself opens the palette from
          its topbar button and so has to be able to read the context. */}
      <CommandPaletteProvider>
        <AppShell onLogout={logout} showSidebar={showSidebar}>
        {/* Inside the shell, so the sidebar and header stay put while a
            route's chunk downloads rather than the screen going blank.

            Same reason for the boundary: one page throwing should leave the
            navigation usable. Keyed by path so moving to another page clears
            the error instead of stranding the user on it. */}
        <ErrorBoundary key={location.pathname}>
          <Suspense fallback={<RouteFallback label="Loading page" />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
        </AppShell>
      </CommandPaletteProvider>
      {/* Beside the app, not in any page, so every screen that makes a
          sensitive change is covered without knowing it. */}
      <StepUpDialog />
      </UntilTwoFactorIsSetUp>
    </CurrentUserProvider>
  )
}

/**
 * The whole app, or the two-step setup screen in its place.
 *
 * In front of the shell rather than inside it: the sidebar's badges, the
 * palette and every page fetch as soon as they mount, and each of those
 * requests would be refused while the gate is up.
 */
function UntilTwoFactorIsSetUp({
  onSignOut,
  children,
}: {
  onSignOut: () => void
  children: React.ReactNode
}) {
  const { user, loading } = useCurrentUser()

  // Not the app until it is known whether this is the gate: right after
  // signing in the person is not loaded yet, and mounting the shell in that
  // moment fired its badge counts at a server that refuses them.
  if (loading && !user) {
    return <RouteFallback label="Loading your workspace" />
  }

  if (user?.twoFactorEnrolmentRequired) {
    return <TwoFactorGate onSignOut={onSignOut} />
  }

  return <>{children}</>
}

export { HomeRedirect, AdminOnly, UntilTwoFactorIsSetUp }
