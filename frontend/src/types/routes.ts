export type AppPage =
  | 'dashboard'
  | 'pending-approvals'
  | 'submit-document'
  | 'document-details'
  | 'inbox'
  | 'audit-ledger'
  | 'people'
  | 'control-room'
  | 'workflow-studio'
  | 'workflow-designer'
  | 'workflow-policy'
  | 'page-setup'
  | 'standard-wording'
  | 'dictionary'
  | 'sso'
  | 'mail'
  | 'access-control'
  | 'login-activity'
  | 'change-history'
  | 'account'

export const ROUTES = {
  login: '/login',
  /** Where the Microsoft sign-in redirect lands. */
  ssoCallback: '/login/sso',
  ssoConfirm: '/sso/confirm',
  home: '/',
  dashboard: '/dashboard',
  pendingApprovals: '/pending-approvals',
  submitDocument: '/submit-document',
  inbox: '/inbox',
  auditLedger: '/audit-ledger',
  people: '/admin/people',
  controlRoom: '/admin/control-room',
  workflowStudio: '/admin/workflow-studio',
  workflowStudioNew: '/admin/workflow-studio/new',
  workflowTemplate: (id: string) => `/admin/workflow-studio/${id}`,
  workflowPolicy: '/admin/workflow-policy',
  pageSetup: '/admin/page-setup',
  standardWording: '/admin/standard-wording',
  dictionary: '/admin/dictionary',
  mail: '/admin/mail',
  sso: '/admin/sso',
  accessControl: '/admin/access-control',
  loginActivity: '/admin/login-activity',
  changeHistory: '/admin/change-history',
  document: (id: string) => `/documents/${id}`,
  account: '/account',
} as const

/**
 * Where each screen used to live, before its path was made to say its name.
 *
 * Bookmarks, browser history and links pasted into chat still point at
 * these, so each one redirects to the screen's current path rather than
 * falling through to the catch-all and landing on Documents. A template's
 * own address keeps its id: `/admin/workflow-templates/<id>` goes to the
 * same template under Workflow studio.
 */
export const RENAMED_PATHS: readonly { from: string; to: string }[] = [
  { from: '/notifications', to: ROUTES.inbox },
  { from: '/audit-trail', to: ROUTES.auditLedger },
  { from: '/administration', to: ROUTES.people },
  { from: '/admin/approval-oversight', to: ROUTES.controlRoom },
  { from: '/admin/workflow-templates', to: ROUTES.workflowStudio },
  { from: '/admin/clauses', to: ROUTES.standardWording },
]

/** The old prefix a template's own address sat under. */
export const RENAMED_TEMPLATE_PREFIX = '/admin/workflow-templates/'

/**
 * These labels are the ONLY copy of a screen's name: the sidebar, the
 * breadcrumb and the browser tab title all read from here, so the three
 * cannot drift apart. Each screen's route key, path, page file and component
 * are named after the same label - see `RENAMED_PATHS` for where they were.
 */
export const PAGE_LABELS: Record<AppPage, string> = {
  dashboard: 'Documents',
  'pending-approvals': 'My queue',
  'submit-document': 'Submit',
  'document-details': 'Document',
  inbox: 'Inbox',
  'audit-ledger': 'Audit ledger',
  account: 'Your account',
  people: 'People & delegation',
  'control-room': 'Control room',
  'workflow-studio': 'Workflow studio',
  'workflow-designer': 'Workflow studio',
  'workflow-policy': 'Workflow policy',
  'page-setup': 'Page setup',
  'standard-wording': 'Standard wording',
  dictionary: 'Dictionary',
  mail: 'Mail',
  sso: 'Single sign-on',
  'access-control': 'Access control',
  'login-activity': 'Login activity',
  'change-history': 'Change history',
}

/** Pages reachable from a nav item. Detail screens are opened from a list. */
export const NAV_PATHS: Record<
  Exclude<AppPage, 'document-details' | 'workflow-designer'>,
  string
> = {
  dashboard: ROUTES.dashboard,
  'pending-approvals': ROUTES.pendingApprovals,
  'submit-document': ROUTES.submitDocument,
  inbox: ROUTES.inbox,
  'audit-ledger': ROUTES.auditLedger,
  people: ROUTES.people,
  'control-room': ROUTES.controlRoom,
  'workflow-studio': ROUTES.workflowStudio,
  'workflow-policy': ROUTES.workflowPolicy,
  'page-setup': ROUTES.pageSetup,
  'standard-wording': ROUTES.standardWording,
  dictionary: ROUTES.dictionary,
  mail: ROUTES.mail,
  sso: ROUTES.sso,
  'access-control': ROUTES.accessControl,
  'login-activity': ROUTES.loginActivity,
  'change-history': ROUTES.changeHistory,
  account: ROUTES.account,
}

/** True for screens only an ADMINISTRATOR may open. */
export function isAdminPage(page: AppPage): boolean {
  return (
    page === 'people' ||
    page === 'control-room' ||
    page === 'workflow-studio' ||
    page === 'workflow-designer' ||
    page === 'workflow-policy' ||
    page === 'page-setup' ||
    page === 'standard-wording' ||
    page === 'dictionary' ||
    page === 'mail' ||
    page === 'sso' ||
    page === 'access-control' ||
    page === 'login-activity' ||
    page === 'change-history'
  )
}

export function pathToPage(pathname: string): AppPage | null {
  if (pathname.startsWith('/documents/')) return 'document-details'
  if (pathname === ROUTES.dashboard) return 'dashboard'
  if (pathname === ROUTES.pendingApprovals) return 'pending-approvals'
  if (pathname === ROUTES.submitDocument) return 'submit-document'
  if (pathname === ROUTES.inbox) return 'inbox'
  if (pathname === ROUTES.auditLedger) return 'audit-ledger'
  if (pathname === ROUTES.account) return 'account'
  if (pathname === ROUTES.people) return 'people'
  if (pathname === ROUTES.controlRoom) return 'control-room'
  if (pathname === ROUTES.workflowStudio) return 'workflow-studio'
  if (pathname === ROUTES.workflowPolicy) return 'workflow-policy'
  if (pathname === ROUTES.pageSetup) return 'page-setup'
  if (pathname === ROUTES.standardWording) return 'standard-wording'
  if (pathname === ROUTES.dictionary) return 'dictionary'
  if (pathname === ROUTES.mail) return 'mail'
  if (pathname === ROUTES.sso) return 'sso'
  if (pathname === ROUTES.accessControl) return 'access-control'
  if (pathname === ROUTES.loginActivity) return 'login-activity'
  if (pathname === ROUTES.changeHistory) return 'change-history'
  if (pathname.startsWith(`${ROUTES.workflowStudio}/`)) {
    return 'workflow-designer'
  }
  return null
}

/**
 * Only ever send a signed-in user to a path inside this app. `from` arrives
 * as router state rather than a query string so it cannot be set by a
 * crafted link, but the check costs nothing and stops a protocol-relative
 * `//host` from becoming an off-site redirect if that ever changes.
 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (!value.startsWith('/') || value.startsWith('//')) return null
  return value
}
