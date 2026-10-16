import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { ROUTES, safeReturnPath } from '../types/routes'
import RouteFallback from './ui/RouteFallback'

export function ProtectedRoute() {
  const { authChecked, loggedIn } = useAuth()
  const location = useLocation()

  if (!authChecked) {
    return <RouteFallback full label="Checking your session" />
  }

  if (!loggedIn) {
    // Carry where they were headed so signing in returns them there instead
    // of dumping them on the home page. Opening a link to a document while
    // signed out used to lose the document.
    return (
      <Navigate
        to={ROUTES.login}
        replace
        state={{ from: location.pathname + location.search }}
      />
    )
  }

  return <Outlet />
}

export function PublicOnlyRoute() {
  const { authChecked, loggedIn } = useAuth()
  const location = useLocation()

  if (!authChecked) {
    return <RouteFallback full label="Checking your session" />
  }

  if (loggedIn) {
    // This guard is the ONLY thing that redirects away from sign-in.
    // LoginPage used to call `navigate(from)` itself, but react-router v7
    // wraps navigation in startTransition, so the urgent `setLoggedIn(true)`
    // committed first, this guard fired with the old location and sent the
    // user to the home page, and the low-priority navigation was superseded.
    // Reading `from` here instead removes the race rather than reordering it.
    return (
      <Navigate to={safeReturnPath(location.state?.from) ?? ROUTES.home} replace />
    )
  }

  return <Outlet />
}
