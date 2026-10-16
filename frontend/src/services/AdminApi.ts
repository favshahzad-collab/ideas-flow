import type { User, UpdateUserPayload, BulkUserImportResult } from '../types/admin.ts'
import { apiJson, jsonBody } from './apiClient'
import type { Capability } from '../types/capability'

export type Department = {
  id: string
  name: string
  /** Switched off: kept, still on the people already in it, offered to nobody new. */
  isActive: boolean
  /** How many people are in it — what makes deleting one safe or refused. */
  userCount: number
}

/**
 * The departments.
 *
 * Active only unless asked otherwise, and that default is load-bearing: every
 * caller that existed before the management screen is asking "what may I
 * assign somebody to", and a department that has been switched off is exactly
 * the answer they must not be given.
 */
export async function fetchDepartments(options: { includeInactive?: boolean } = {}) {
  const query = options.includeInactive ? '?includeInactive=true' : ''
  return apiJson<Department[]>(`/api/admin/departments${query}`)
}

export async function createDepartment(name: string) {
  return apiJson<Department>('/api/admin/departments', {
    method: 'POST',
    ...jsonBody({ name }),
  })
}

/** Rename, or switch off — which is what "delete" means for one with people in it. */
export async function updateDepartment(
  id: string,
  payload: { name?: string; isActive?: boolean },
) {
  return apiJson<Department>(`/api/admin/departments/${id}`, {
    method: 'PATCH',
    ...jsonBody(payload),
  })
}

/** Only ever succeeds while it is empty; the server refuses the rest in words. */
export async function deleteDepartment(id: string) {
  return apiJson<{ id: string; name: string }>(`/api/admin/departments/${id}`, {
    method: 'DELETE',
  })
}

/** What the email outbox holds, by state, and the last refusals. */
export type MailQueueSummary = {
  /** False when no mail server is configured: notices are queued, not sent. */
  configured: boolean
  /**
   * What this deployment will actually do with a notice.
   *
   * `configured` says two variables are set. This says which host, which
   * sender, and - the one that matters - what the links in every notice will
   * point at. The password is never here and never should be; whether one is
   * in use is reported as `authenticated`.
   */
  settings: {
    configured: boolean
    host: string | null
    port: number | null
    secure: boolean
    from: string | null
    authenticated: boolean
    appUrl: string
    /** True when links would point at the development UI. */
    appUrlIsDefault: boolean
    /**
     * Where the running configuration came from.
     *
     * Both are legitimate and they look identical from the outside, so an
     * administrator staring at a host they did not type has to be told it is
     * coming from the server - otherwise they edit the form and wonder why
     * nothing changed.
     */
    source: 'database' | 'environment' | 'none'
    /**
     * A stored secret cannot be decrypted, which in practice means
     * `JWT_SECRET` was rotated. Distinct from having no secret: this
     * deployment will fail to authenticate, and failing to authenticate looks
     * exactly like the host being unreachable.
     */
    passwordUnreadable: boolean
    /**
     * How a notice actually leaves the building.
     *
     * Graph is the one to prefer on Microsoft 365: the message goes to
     * Exchange Online through the API rather than over a relay, so SPF is not
     * something this deployment has to get right in DNS first.
     */
    provider: MailProvider
    /** The sender in two parts, because Graph will not take them as one. */
    fromName: string | null
    fromAddress: string | null
    /** Enough of each to recognise. Never enough to use. */
    tenantIdMasked: string | null
    clientIdMasked: string | null
    /** Whether a client secret is stored. Never the secret. */
    hasClientSecret: boolean
    /** The mailbox Graph sends as. */
    mailbox: string | null
    saveToSentItems: boolean
  }
  counts: {
    PENDING: number
    SENDING: number
    SENT: number
    FAILED: number
    EXPIRED: number
  }
  recentFailures: {
    id: string
    recipientEmail: string
    subject: string
    attempts: number
    lastError: string | null
    createdAt: string
  }[]
}

/**
 * How the outbox is doing.
 *
 * "Why was I never told?" is the support question this answers: what is
 * waiting, what went, and what the mail server refused - with the reason it
 * gave, which is the only part anybody can act on.
 */
export async function fetchMailQueue() {
  return apiJson<MailQueueSummary>('/api/admin/mail')
}

export type MailProvider = 'SMTP' | 'MICROSOFT_GRAPH'

/** The mail configuration, as the settings form sends it. */
export type MailSettingsInput = {
  provider: MailProvider
  /** The sender, in two parts. */
  fromName: string
  fromAddress: string
  appUrl: string

  /** SMTP only. */
  host?: string
  port?: number
  secure?: boolean
  username?: string
  /** Blank means "keep whatever is stored". */
  password?: string
  /** The only way to remove a stored password, since a blank field cannot be. */
  clearPassword?: boolean

  /** Microsoft Graph only. */
  tenantId?: string
  clientId?: string
  /** Blank means "keep whatever is stored", exactly like the password. */
  clientSecret?: string
  clearClientSecret?: boolean
  mailbox?: string
  saveToSentItems?: boolean
}

/**
 * Ask the provider whether this configuration is real, without sending.
 *
 * Worth being its own act: "can this application reach Microsoft and see the
 * mailbox" and "does a message arrive" fail for unrelated reasons and are
 * fixed in different places.
 */
export async function testMailConnection() {
  return apiJson<{ provider: MailProvider; detail: string }>(
    '/api/admin/mail/test-connection',
    { method: 'POST' },
  )
}

/**
 * Point this deployment at a mail server.
 *
 * Answers with the whole queue summary rather than an acknowledgement, so the
 * screen re-renders from what is now live instead of from what it hoped it
 * saved - the two differ whenever the server has normalised something, and the
 * trailing slash on `appUrl` is the case that actually happens.
 */
export async function saveMailSettings(input: MailSettingsInput) {
  return apiJson<MailQueueSummary>('/api/admin/mail/settings', {
    method: 'PUT',
    ...jsonBody(input),
  })
}

/** Hand mail back to the server's environment. */
export async function clearMailSettings() {
  return apiJson<MailQueueSummary>('/api/admin/mail/settings', {
    method: 'DELETE',
  })
}

/** The two workflow policies, as the form sends them. */
export type WorkflowPolicyInput = {
  /**
   * Working days an approver is given before the sweep chases them.
   *
   * `null` means no deadline - a policy, not an omission. Handing the whole
   * thing back to the environment is `clearWorkflowPolicy`.
   */
  slaDefaultDays: number | null
  allowStepSkip: boolean
  /**
   * Does submitting a document also mean signing it?
   *
   * True is how this has always worked. Off, a submitter forwards the
   * document unsigned and the first mark on it is the first approver's.
   */
  preparerSignsOnSubmit: boolean
  /**
   * Does the final approval seal the approved PDF with the organisation's
   * digital certificate? Only has an effect where the server holds one.
   */
  sealApprovedMemos: boolean
}

export type WorkflowPolicy = WorkflowPolicyInput & {
  /**
   * Whether the server holds a seal certificate, and whose name it carries.
   * Set up on the server, not here: without one, nothing is sealed.
   */
  sealCertificate: { configured: boolean; signer: string | null }
  /**
   * Memos in an approval cycle now. They keep the rules their cycle started
   * with unless a save applies the new ones to them too.
   */
  memosInProgress: number
  /** Where the answer above came from, so the screen can say rather than imply. */
  source: 'stored' | 'environment'
  /** What the server's environment alone would say, if the row were removed. */
  environment: {
    slaDefaultDays: number | null
    allowStepSkip: boolean
    preparerSignsOnSubmit: boolean
    sealApprovedMemos: boolean
  }
}

export async function fetchWorkflowPolicy() {
  return apiJson<WorkflowPolicy>('/api/admin/workflow/settings')
}

export async function saveWorkflowPolicy(
  input: WorkflowPolicyInput & {
    /** Also move memos already in progress onto these rules. */
    applyToInProgress?: boolean
  },
) {
  return apiJson<WorkflowPolicy>('/api/admin/workflow/settings', {
    method: 'PUT',
    ...jsonBody(input),
  })
}

/**
 * The paper a generated memo is drawn on.
 *
 * Margins are in points because that is what the renderer draws in and what
 * gets recorded against a filed version. The screen converts to millimetres
 * for the person typing; nobody should have to know that 43.2 is 0.6 inches.
 */
export type PaperName = 'A4' | 'LETTER'

export type PageSetup = {
  paper: PaperName
  marginLeft: number
  marginRight: number
  marginTop: number
  marginBottom: number
}

export type PageSetupResponse = {
  setup: PageSetup
  /** What the delivered default is, so "put it back" is a button. */
  default: PageSetup
  /** The sheets, with their sizes, so the preview is drawn to scale. */
  papers: { name: PaperName; width: number; height: number }[]
  /**
   * The server's own limits. Served rather than repeated here: a control that
   * stops somewhere different from where the validator refuses is a form that
   * rejects what it just let somebody set.
   */
  bounds: { minMargin: number; maxMargin: number }
}

export async function fetchPageSetup() {
  return apiJson<PageSetupResponse>('/api/admin/page-setup')
}

export async function savePageSetup(input: PageSetup) {
  return apiJson<PageSetupResponse>('/api/admin/page-setup', {
    method: 'PUT',
    ...jsonBody(input),
  })
}

/** Hand the policy back to the server's environment. */
export async function clearWorkflowPolicy() {
  return apiJson<WorkflowPolicy>('/api/admin/workflow/settings', {
    method: 'DELETE',
  })
}

/**
 * The Microsoft app registration people sign in through.
 *
 * Every identifier is optional on the way up, because none of them comes back
 * down in full: an untouched field arrives empty and the server keeps what it
 * has. That is the only rule under which somebody can correct a redirect URI
 * without knowing the client secret, which is the situation this screen exists
 * to get them out of.
 */
export type SsoSettingsInput = {
  enabled: boolean
  tenantId?: string
  clientId?: string
  clientSecret?: string
  redirectUri?: string
}

export type SsoSettings = {
  enabled: boolean
  /** Whether everything it needs is actually present. */
  configured: boolean
  /** Last six characters only. Not secrets, but together they name a target. */
  tenantIdTail: string | null
  clientIdTail: string | null
  hasClientSecret: boolean
  redirectUri: string | null
  /** A stored secret that will not decrypt — almost always a rotated JWT_SECRET. */
  secretUnreadable: boolean
}

export async function fetchSsoSettings() {
  return apiJson<SsoSettings>('/api/admin/sso/settings')
}

export async function saveSsoSettings(input: SsoSettingsInput) {
  return apiJson<SsoSettings>('/api/admin/sso/settings', {
    method: 'PUT',
    ...jsonBody(input),
  })
}

/** Turn it off and forget the registration entirely. */
export async function clearSsoSettings() {
  return apiJson<SsoSettings>('/api/admin/sso/settings', { method: 'DELETE' })
}

/**
 * Send a test notice to the signed-in administrator's own address.
 *
 * There is no recipient argument on purpose: the server reads the address off
 * the account. An endpoint that mails chosen text to a chosen address is an
 * open relay.
 */
export async function sendTestMail() {
  return apiJson<{ sentTo: string }>('/api/admin/mail/test', { method: 'POST' })
}

/**
 * The list answers with the page envelope every list endpoint now uses -
 * `{ users, total, returned }` - and every caller of this function wants the
 * rows. It used to be typed as the bare array, so when the envelope arrived
 * the People screen handed an object to `setUsers` and died on `.filter`
 * before its toolbar rendered. Unwrapping here keeps that contract in one
 * place instead of four.
 */
/** The most the server sends in one page of people. */
const USERS_PAGE_SIZE = 200

/**
 * Everybody, page by page.
 *
 * The list is paged on the server (50 by default), and this used to ask for
 * the first page only - so in an organisation of more than fifty, the people
 * added earliest were missing from People, from Access control and from the
 * Super Administrator transfer, with nothing saying so.
 */
export async function fetchUsers(): Promise<User[]> {
  const everybody: User[] = []
  for (;;) {
    const page = await apiJson<{ users: User[]; total: number; returned: number }>(
      `/api/admin/users?limit=${USERS_PAGE_SIZE}&offset=${everybody.length}`,
    )
    everybody.push(...page.users)
    if (page.users.length === 0 || everybody.length >= page.total) return everybody
  }
}

export async function createUser(payload: UpdateUserPayload) {
  return apiJson<User>('/api/admin/users', { method: 'POST', ...jsonBody(payload) })
}

export async function updateUser(id: string, payload: UpdateUserPayload) {
  return apiJson<User>(`/api/admin/users/${id}`, { method: 'PATCH', ...jsonBody(payload) })
}

/**
 * @param microsoftSignIn whether this deployment offers Microsoft sign-in.
 *
 * It decides what the example row teaches, which is the whole job of a
 * template. With Microsoft sign-in on, an account needs no password of its
 * own - it signs in through the tenant - and an example carrying
 * `password123` teaches an administrator to invent one for every person on
 * the staff list and keep the lot in a spreadsheet. Without it, a blank
 * password makes an account nobody can sign in to, so the example keeps one.
 */
export function downloadUserImportTemplate(microsoftSignIn = false) {
  /*
   * `designation` belongs here even though the import treats it as optional.
   *
   * It is the job title printed beneath this person's name on every memo they
   * sign. Left out of the template, a whole organisation gets imported without
   * one, and every signature from then on is a name with no office behind it -
   * discovered on the first signed memo, by which point the accounts exist and
   * fixing it is one form at a time.
   */
  const headers = ['firstName', 'lastName', 'email', 'password', 'department', 'role', 'designation']
  const examples = microsoftSignIn
    ? [
        // Blank password first, because it is the row that suits a staff list
        // exported from HR - and the row an administrator will copy.
        ['Jane', 'Smith', 'jane@company.com', '', 'Human Resources', 'USER', 'Manager'],
        ['Omar', 'Farooq', 'omar@company.com', 'set-a-password', 'Human Resources', 'USER', 'Contractor'],
      ]
    : [['Jane', 'Smith', 'jane@company.com', 'three-words-here', 'Human Resources', 'USER', 'Manager']]
  const lines = [headers.join(','), ...examples.map(example => example.join(','))]
  const csv = `\uFEFF${lines.join('\r\n')}`
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'user-import-template.csv'
  link.click()
  URL.revokeObjectURL(url)
}

export async function bulkCreateUsers(file: File) {
  const formData = new FormData()
  formData.append('file', file)

  return apiJson<BulkUserImportResult>('/api/admin/users/bulk', {
    method: 'POST',
    body: formData,
  })
}

// ---------------------------------------------------- access and sessions

export type AccessControlMatrix = {
  roles: string[]
  capabilities: {
    id: Capability
    group: string
    title: string
    detail: string
    roles: string[]
    /** A Super Administrator's alone, never given to anybody else. */
    superAdminOnly?: boolean
    /** A power a Super Administrator can give a limited administrator. */
    grantable?: boolean
    /** What a newly made administrator starts with. */
    byDefault?: boolean
    /** Can be given as "see, not change" - stored as `<id>:view`. */
    viewable?: boolean
  }[]
}

/**
 * What each role may do, as the server describes it.
 *
 * Fetched rather than hard-coded here on purpose: a screen that tells an
 * administrator what a role buys must be reciting the rules, not a second copy
 * of them. If this file and the server ever disagreed, this is the one that
 * would be wrong, and the one nobody would test.
 */
export async function fetchAccessControl() {
  return apiJson<AccessControlMatrix>('/api/admin/access-control')
}

/**
 * Make an administrator a Super Administrator or a limited one, and choose a
 * limited one's powers. Super Administrators only; the server asks them to
 * confirm it is them, and records it.
 */
export async function setAdminPowers(
  userId: string,
  input: { isSuperAdmin: boolean; powers: string[] },
) {
  return apiJson<{ id: string; isSuperAdmin: boolean; adminPowers: string[] }>(
    `/api/admin/users/${userId}/powers`,
    { method: 'PUT', ...jsonBody(input) },
  )
}

/**
 * Hand the Super Administrator role to somebody else. There is one at a
 * time: the current one stays an administrator with every power that can be
 * given. Theirs only; the server asks them to confirm it is them.
 */
export async function transferSuperAdmin(userId: string) {
  return apiJson<{
    superAdministrator: { id: string; firstName: string; lastName: string }
    madeLimited: string[]
  }>('/api/admin/super-admin/transfer', { method: 'POST', ...jsonBody({ userId }) })
}

export type SessionPerson = {
  id: string
  firstName: string
  lastName: string
  email: string
  loginRole: string
  department: { id: string; name: string } | null
}

export type ActiveSession = {
  id: string
  issuedAt: string
  expiresAt: string
  ipAddress: string | null
  userAgent: string | null
  user: SessionPerson
}

export type EndedSession = Omit<ActiveSession, 'expiresAt'> & {
  revokedAt: string
}

export type LoginActivity = {
  active: ActiveSession[]
  ended: EndedSession[]
  summary: {
    /** People, not sessions: one person with a laptop and a phone counts once. */
    peopleSignedIn: number
    sessionsOpen: number
    endedWithinHours: number
  }
}

export async function fetchLoginActivity() {
  return apiJson<LoginActivity>('/api/admin/sessions')
}

/**
 * Sign one person out of everywhere.
 *
 * Everywhere rather than one device, because ending a single session leaves
 * the access token in that tab working until it expires — and somebody
 * reaching for this has usually just been told about a lost laptop.
 */
export async function endUserSessions(userId: string) {
  return apiJson<{ ended: number }>(`/api/admin/users/${userId}/sessions/end`, {
    method: 'POST',
  })
}

/**
 * Take two-step sign-in off somebody else's account.
 *
 * The lost-phone-and-lost-envelope path. It does not switch anything on or
 * touch the password: that person goes back to signing in the way they did
 * before, and can enrol again from their own account page.
 */
export function resetUserTwoFactor(userId: string): Promise<{ enabled: false }> {
  return apiJson(`/api/admin/users/${userId}/two-factor`, { method: 'DELETE' })
}

/**
 * Switch an account off when somebody leaves, or back on.
 *
 * The answer to a departure. Deleting the person is refused the moment they
 * have prepared, approved or commented on anything - which is everybody worth
 * removing - so until this existed a person who left kept a working password.
 *
 * It stops them signing in and ends every session they hold. It changes
 * nothing they have signed: their name stays on every memo they approved, and
 * the steps they were holding stay theirs until an administrator moves them.
 */
export function setUserActive(
  userId: string,
  active: boolean,
  /** Who takes over their approvals when switching off somebody who has any. */
  successorId?: string,
): Promise<{ id: string; deactivatedAt: string | null; message: string }> {
  return apiJson(`/api/admin/users/${userId}/active`, {
    method: 'POST',
    ...jsonBody(successorId ? { active, successorId } : { active }),
  })
}
