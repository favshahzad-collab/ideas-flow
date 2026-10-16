import { lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { AppLayout, AdminOnly, HomeRedirect } from './components/AppLayout'
import { ProtectedRoute, PublicOnlyRoute } from './components/RouteGuards'
import { Renamed, RenamedTemplate } from './components/RenamedRedirect'
import LoginPage from './pages/LoginPage'
import { RENAMED_PATHS, RENAMED_TEMPLATE_PREFIX, ROUTES } from './types/routes'

/**
 * Everything behind the sign-in wall is split out of the entry bundle. The
 * whole app used to ship as one 1,065 KB chunk, so signing in downloaded
 * pdf.js and the @xyflow canvas before the login form could paint — code
 * most people never reach, and nobody needs on their first request.
 *
 * `AppLayout` renders the Suspense boundary inside the shell, so switching
 * pages keeps the sidebar rather than blanking the screen.
 */
const DocumentPage = lazy(() => import('./pages/DocumentPage'))
const MyQueue = lazy(() => import('./pages/MyQueuePage'))
const SubmitDocument = lazy(() => import('./pages/SubmitDocument'))
const Inbox = lazy(() => import('./pages/InboxPage'))
const AuditLedger = lazy(() => import('./pages/AuditLedgerPage'))
const DocumentDetail = lazy(() => import('./pages/DocDetailPage'))
const People = lazy(() => import('./pages/PeoplePage'))
const ControlRoom = lazy(() => import('./pages/ControlRoomPage'))
const WorkflowStudio = lazy(() => import('./pages/WorkflowStudioPage'))
const WorkflowDesigner = lazy(() => import('./pages/WorkflowDesigner'))
const Account = lazy(() => import('./pages/AccountPage'))
const Mail = lazy(() => import('./pages/MailPage'))
const WorkflowPolicy = lazy(() => import('./pages/WorkflowPolicyPage'))
const PageSetup = lazy(() => import('./pages/PageSetupPage'))
const StandardWording = lazy(() => import('./pages/StandardWordingPage'))
const Dictionary = lazy(() => import('./pages/DictionaryPage'))
const SsoCallbackPage = lazy(() => import('./pages/SsoCallbackPage'))
const SsoConfirmPage = lazy(() => import('./pages/SsoConfirmPage'))
const Sso = lazy(() => import('./pages/SsoPage'))
const AccessControl = lazy(() => import('./pages/AccessControlPage'))
const LoginActivity = lazy(() => import('./pages/LoginActivityPage'))
const ChangeHistory = lazy(() => import('./pages/ChangeHistoryPage'))

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* A confirm-with-Microsoft window: neither signed out nor a page of the app. */}
        <Route path={ROUTES.ssoConfirm} element={<SsoConfirmPage />} />
        <Route element={<PublicOnlyRoute />}>
          <Route path={ROUTES.login} element={<LoginPage />} />
          <Route path={ROUTES.ssoCallback} element={<SsoCallbackPage />} />
        </Route>

        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route index element={<HomeRedirect />} />
            <Route path={ROUTES.dashboard} element={<DocumentPage />} />
            <Route
              path={ROUTES.pendingApprovals}
              element={<MyQueue />}
            />
            <Route
              path={ROUTES.submitDocument}
              element={<SubmitDocument />}
            />
            <Route path={ROUTES.inbox} element={<Inbox />} />
            <Route path={ROUTES.auditLedger} element={<AuditLedger />} />
            {/* Every signed-in person, administrator or not: it is their
                own password and their own signature. */}
            <Route path={ROUTES.account} element={<Account />} />
            <Route
              path={ROUTES.people}
              element={
                <AdminOnly needs="users.manage">
                  <People />
                </AdminOnly>
              }
            />
            <Route
              path={ROUTES.workflowPolicy}
              element={
                <AdminOnly needs="workflows.policy">
                  <WorkflowPolicy />
                </AdminOnly>
              }
            />
            <Route
              path={ROUTES.pageSetup}
              element={
                /* Its own capability, not the workflow policy's: the Access
                   control screen would otherwise say somebody may set the
                   approval deadline when they can also change how every memo
                   in the organisation is drawn. */
                <AdminOnly needs="documents.pageSetup">
                  <PageSetup />
                </AdminOnly>
              }
            />
            <Route
              path={ROUTES.standardWording}
              element={
                <AdminOnly needs="documents.clauses">
                  <StandardWording />
                </AdminOnly>
              }
            />
            <Route
              path={ROUTES.dictionary}
              element={
                <AdminOnly needs="documents.dictionary">
                  <Dictionary />
                </AdminOnly>
              }
            />
            <Route
              path={ROUTES.sso}
              element={
                <AdminOnly needs="sso.configure">
                  <Sso />
                </AdminOnly>
              }
            />
            <Route
              path={ROUTES.mail}
              element={
                <AdminOnly needs="mail.configure">
                  <Mail />
                </AdminOnly>
              }
            />
            <Route
              path={ROUTES.controlRoom}
              element={
                <AdminOnly needs="approvals.oversee">
                  <ControlRoom />
                </AdminOnly>
              }
            />
            <Route
              path={ROUTES.accessControl}
              element={
                <AdminOnly needs="users.manage">
                  <AccessControl />
                </AdminOnly>
              }
            />
            <Route
              path={ROUTES.loginActivity}
              element={
                <AdminOnly needs="sessions.view">
                  <LoginActivity />
                </AdminOnly>
              }
            />
            <Route
              path={ROUTES.changeHistory}
              element={
                <AdminOnly needs="audit.administration">
                  <ChangeHistory />
                </AdminOnly>
              }
            />
            <Route
              path={ROUTES.workflowStudio}
              element={
                <AdminOnly needs="workflows.manage">
                  <WorkflowStudio />
                </AdminOnly>
              }
            />
            <Route
              path={ROUTES.workflowStudioNew}
              element={
                <AdminOnly needs="workflows.manage">
                  <WorkflowDesigner />
                </AdminOnly>
              }
            />
            <Route
              path={`${ROUTES.workflowStudio}/:id`}
              element={
                <AdminOnly needs="workflows.manage">
                  <WorkflowDesigner />
                </AdminOnly>
              }
            />
            <Route path="/documents/:id" element={<DocumentDetail />} />

            {RENAMED_PATHS.map(({ from, to }) => (
              <Route key={from} path={from} element={<Renamed to={to} />} />
            ))}
            <Route path={`${RENAMED_TEMPLATE_PREFIX}:id`} element={<RenamedTemplate />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to={ROUTES.home} replace />} />
      </Routes>
    </AuthProvider>
  )
}
