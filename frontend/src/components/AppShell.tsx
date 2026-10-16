import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Bell,
  ChevronRight,
  ClipboardList,
  Clock,
  Command,
  GitBranch,
  History,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Mailbox,
  Menu,
  Activity,
  Radar,
  Search,
  Ruler,
  SpellCheck,
  TextQuote,
  Timer,
  Upload,
  UserCog,
  Users,
  X,
} from 'lucide-react'
import { useCurrentUser } from '../contexts/currentUser'
import { seesCapability, type Capability } from '../types/capability'
import { useUnreadNotificationCount } from '../hooks/useNotifications'
import { usePendingApprovalCount } from '../hooks/usePendingApprovalCount'
import { useDialogA11y } from '../hooks/useDialogA11y'
import { NAV_PATHS, PAGE_LABELS, ROUTES, pathToPage, type AppPage } from '../types/routes'
import { FEATURES } from '../config/features'
import ThemeToggle from './ui/ThemeToggle'
import Eyebrow from './ui/Eyebrow'
/* Lazily imported, not just lazily rendered. A static import would put the
   palette and the documents hook it searches into the entry chunk, which is
   the bundle the sign-in page waits on — and nobody presses ⌘K before they
   have signed in. */
const CommandPalette = lazy(() => import('./CommandPalette'))
import { useCommandPalette } from '../contexts/commandPalette'
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts'
import { Avatar } from './ui/Card'
import Keycap from './ui/Keycap'

interface AppShellProps {
  children: React.ReactNode
  onLogout: () => void
  showSidebar?: boolean
}

/**
 * No `label`: the text comes from `PAGE_LABELS`, the same source the
 * breadcrumbs and the tab title use. Carrying a second copy here is how the
 * sidebar came to call `/audit-trail` "Approval Log" while the page it opens
 * is headed "Audit Trail" — and "Approval Log" is already the name of a
 * different thing, the per-document history on the document detail page.
 */
type NavItem = {
  id: Exclude<AppPage, 'document-details' | 'workflow-designer'>
  icon: typeof LayoutDashboard
  /** Which count, if any, rides on this row. */
  count?: 'pending' | 'unread'
  /** A red pill rather than the neutral one. */
  urgent?: boolean
  /**
   * The capability that opens this screen, as the server names it.
   *
   * The rows used to be split into two lists and the second shown when
   * `role === 'ADMINISTRATOR'` — the client deciding for itself what a role
   * implies. Naming the capability instead means the sidebar shows a link
   * exactly when the server would honour it, and a capability that moves
   * between roles moves the link with it, here and nowhere else.
   */
  needs?: Capability
  /**
   * Other paths this row owns — a tab of the same screen living at its own
   * URL. Without it the rail goes dark the moment somebody opens the tab.
   */
  alsoOwns?: string[]
}

/**
 * Your own queue sits second, directly under the list of everything. This
 * reverses the previous lifecycle ordering (see everything, start one, act
 * on one): in daily use this is an inbox, and the thing an approver opens
 * the app to do is clear their own queue, not file a new document.
 */
const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', icon: LayoutDashboard },
  { id: 'pending-approvals', icon: Clock, count: 'pending', urgent: true },
  { id: 'submit-document', icon: Upload },
  { id: 'audit-ledger', icon: ClipboardList },
  { id: 'inbox', icon: Bell, count: 'unread' },
]

/**
 * The four places a phone user goes most, as tabs along the foot of the
 * screen - the pattern every phone app they use already has. The menu still
 * holds everything, the ledger and administration included; this is the
 * short way to the daily work, one tap instead of two.
 */
const TAB_ITEMS: NavItem[] = [
  { id: 'dashboard', icon: LayoutDashboard },
  { id: 'pending-approvals', icon: Clock, count: 'pending', urgent: true },
  { id: 'submit-document', icon: Upload },
  { id: 'inbox', icon: Bell, count: 'unread' },
]

/**
 * Whether a screen keeps the foot of a phone for its own controls: a memo
 * (its Sign bar) and the submit form (its Continue). Tabs there would sit on
 * top of the one button the screen is for.
 */
function ownsTheFoot(pathname: string): boolean {
  return pathname.startsWith('/documents/') || pathname === ROUTES.submitDocument
}

function BottomTabs({
  pendingCount,
  unreadCount,
}: {
  pendingCount: number
  unreadCount: number
}) {
  return (
    <nav
      aria-label="Quick navigation"
      className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] sm:hidden"
    >
      {TAB_ITEMS.map(({ id, icon: Icon, count }) => {
        const value = count === 'pending' ? pendingCount : count === 'unread' ? unreadCount : 0
        const label = PAGE_LABELS[id]
        return (
          <NavLink
            key={id}
            to={NAV_PATHS[id]}
            end
            aria-label={
              value > 0
                ? `${label}, ${value} ${count === 'unread' ? 'unread' : 'waiting on you'}`
                : undefined
            }
            className={({ isActive }) =>
              `relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-2xs font-medium transition-colors ${
                isActive ? 'text-accent-ink' : 'text-content-subtle hover:text-content'
              }`
            }
          >
            <span className="relative">
              <Icon size={20} aria-hidden="true" />
              {value > 0 && (
                <span
                  aria-hidden="true"
                  className={`absolute -right-2.5 -top-1.5 min-w-4 rounded-pill px-1 text-center text-2xs leading-4 tabular-nums ${
                    count === 'pending' ? 'bg-danger-mark text-on-accent' : 'bg-content text-surface'
                  }`}
                >
                  {value > 99 ? '99+' : value}
                </span>
              )}
            </span>
            <span className="max-w-full truncate px-1">{label}</span>
          </NavLink>
        )
      })}
    </nav>
  )
}

/**
 * Admin screens used to be reachable only by typing the URL: the shell hid
 * the sidebar on every `/admin` route, so an administrator landed on a page
 * with no links at all. They are ordinary nav items now, shown to admins.
 */
const ADMIN_NAV_ITEMS: NavItem[] = [
  { id: 'control-room', icon: Radar, needs: 'approvals.oversee' },
  { id: 'login-activity', icon: Activity, needs: 'sessions.view' },
  { id: 'change-history', icon: History, needs: 'audit.administration' },
  { id: 'workflow-studio', icon: GitBranch, needs: 'workflows.manage' },
  { id: 'workflow-policy', icon: Timer, needs: 'workflows.policy' },
  { id: 'page-setup', icon: Ruler, needs: 'documents.pageSetup' },
  { id: 'standard-wording', icon: TextQuote, needs: 'documents.clauses' },
  { id: 'dictionary', icon: SpellCheck, needs: 'documents.dictionary' },
  /*
   * Access control used to be a row of its own, directly under this one and
   * opened by the same capability — so the two never appeared apart, and the
   * rail spent two lines on one subject. It is a tab of this screen now
   * (`PeopleTabs`), which is why this row owns its path as well: the row has
   * to stay lit while somebody is reading the matrix, or the sidebar would
   * say nothing is open.
   */
  {
    id: 'people',
    icon: Users,
    needs: 'users.manage',
    alsoOwns: [ROUTES.accessControl],
  },
  // Last, because it is the one an administrator visits twice: once at
  // installation and once when notices stop arriving.
  { id: 'mail', icon: Mailbox, needs: 'mail.configure' },
  { id: 'sso', icon: KeyRound, needs: 'sso.configure' },
]

/**
 * Whether the Administration group is unfolded, remembered between sessions.
 *
 * Open is the default and the fallback: a group folded away by a storage
 * failure is a group an administrator cannot find, whereas one left open
 * costs a few rows of rail. Only a deliberate fold is ever written.
 */
const ADMIN_GROUP_KEY = 'daws-admin-nav'

function readAdminGroupOpen(): boolean {
  try {
    return window.localStorage.getItem(ADMIN_GROUP_KEY) !== 'closed'
  } catch {
    return true
  }
}

/**
 * Placeholder data. Saved views are a per-user CRUD resource that does not
 * exist yet (`GET /api/saved-views`), so every name and count below is
 * invented. Replace the constant, not the markup, when the endpoint lands.
 *
 * `FEATURES.savedViews` now defaults OFF everywhere rather than on while
 * building. It used to be on in development, which meant anybody shown the
 * app before release — including the people deciding whether to deploy it —
 * saw "Breaching SLA 3" beside a real queue and had no way to tell that
 * three was a number somebody typed. A fabricated figure next to real ones
 * is worse than an absent feature.
 */
const SAVED_VIEWS = [
  { id: 'breaching', name: 'Breaching SLA', dot: 'bg-danger-mark', count: 3 },
  { id: 'capex', name: 'Capex over ₨ 5M', dot: 'bg-warning-mark', count: 9 },
  { id: 'procurement', name: 'Waiting on Procurement', dot: 'bg-info-mark', count: 11 },
  { id: 'signed', name: 'Signed by me this month', dot: 'bg-accent-mark', count: 27 },
] as const

/** The four corners of the mark, in the order they light. */
const PETALS = ['tl', 'tr', 'br', 'bl'] as const

/**
 * The company mark on the workspace row.
 *
 * Each petal is a window onto one quarter of `/ideas-mark.png` - the symbol
 * cut out of the supplied logo rather than traced, so what sits on the rail is
 * the artwork itself. Splitting it into four elements is what lets the corners
 * light one after another; `.ideas-mark-petal` in index.css owns the geometry
 * and the timing.
 *
 * Hidden from assistive technology, and it has to be: "Ideas Flow" is spelt
 * out in the text immediately beside it, so an accessible name here would
 * announce the workspace twice.
 */
function IdeasMark({ className = '' }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`ideas-mark ${className}`}>
      {PETALS.map(petal => (
        <span key={petal} className={`ideas-mark-petal ideas-mark-${petal}`} />
      ))}
    </span>
  )
}

function GroupLabel({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <Eyebrow id={id} tone="shell" className="px-2 pb-1.5 pt-4.5">
      {children}
    </Eyebrow>
  )
}

function CountPill({ value, urgent }: { value: number; urgent?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-5 min-w-5 flex-shrink-0 items-center justify-center rounded-pill px-1.5 font-mono text-2xs font-medium tabular-nums ${
        urgent ? 'bg-danger text-content-inverse' : 'bg-shell-pill text-shell-pill-ink'
      }`}
    >
      {value > 99 ? '99+' : value}
    </span>
  )
}

function NavRow({
  item,
  count,
  onNavigate,
}: {
  item: NavItem
  count: number
  onNavigate: () => void
}) {
  const Icon = item.icon
  const label = PAGE_LABELS[item.id]
  const { pathname } = useLocation()
  const ownsThisPath = item.alsoOwns?.includes(pathname) ?? false

  const content = (
    <>
      <Icon size={16} aria-hidden="true" className="flex-shrink-0" />
      <span className="flex-1 truncate">{label}</span>
      {count > 0 && <CountPill value={count} urgent={item.urgent} />}
    </>
  )

  // The count goes in the name rather than being read as a stray number
  // after it — the same treatment the header's unread bell uses. And it says
  // what it counts: the Inbox counts unread notices, which are updates, and
  // calling them "waiting on you" sent people there to look for work that is
  // in My queue.
  const accessibleName =
    count > 0
      ? `${label}, ${count} ${item.count === 'unread' ? 'unread' : 'waiting on you'}`
      : undefined

  /*
   * A plain Link when one of this row's tabs is open, because NavLink owns
   * `aria-current`: it drops any value passed to it unless its own matcher
   * says the link is active, so a tab at a different URL would be painted as
   * the current page for sighted people and announced as not current. One
   * row, one answer — so the highlight and the attribute are set together.
   */
  if (ownsThisPath) {
    return (
      <Link
        to={NAV_PATHS[item.id]}
        onClick={onNavigate}
        aria-label={accessibleName}
        aria-current="page"
        className="sidebar-nav-item active w-full text-left"
      >
        {content}
      </Link>
    )
  }

  return (
    <NavLink
      to={NAV_PATHS[item.id]}
      onClick={onNavigate}
      aria-label={accessibleName}
      className={({ isActive }) =>
        `sidebar-nav-item w-full text-left ${isActive ? 'active' : ''}`
      }
    >
      {content}
    </NavLink>
  )
}

/**
 * Who is signed in, at the foot of the rail.
 *
 * There used to be an account menu behind a MoreHorizontal here, holding
 * exactly the two items the avatar menu in the header holds - so every screen
 * carried two triggers with the same accessible name, "Account menu", both
 * announcing a menu, both opening the same two things. Somebody tabbing the
 * page met the same control twice.
 *
 * The header's is the one that stayed. It is where an account menu lives in
 * every product these people already use, it is visible on a narrow screen
 * where this rail is a drawer, and it is the ONLY one on the workflow
 * designer, which hides the sidebar entirely - so the rail's copy could never
 * be the only way to sign out, while the header's already was.
 *
 * What is left is identity, which is the thing a rail foot is actually for.
 */
function PresenceFooter({
  fullName,
  firstName,
  lastName,
}: {
  fullName: string
  firstName?: string
  lastName?: string
}) {
  return (
    <div className="flex-shrink-0 border-t border-white/10 p-3">
      <div className="flex items-center gap-2.5 rounded-control bg-white/5 p-2">
        <Avatar
          firstName={firstName}
          lastName={lastName}
          size="lg"
          tone="accentSolid"
          presence="available"
          presenceRing="shell"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui font-semibold text-shell-text">
            {fullName || 'Signed in'}
          </div>
          {/* Availability is real: the signed-in user is by definition
              present. The "Away until <date> · delegating" variant needs
              `user.outOfOffice`, which the API does not return yet. */}
          <div className="truncate text-meta text-accent-mark">Available</div>
        </div>
      </div>
    </div>
  )
}

/**
 * Declared at module scope, not inside AppShell's render. Defining it
 * inline remounted the whole sidebar on every parent render, which
 * dropped focus and restarted transitions.
 */
function SidebarContent({
  pendingCount,
  unreadCount,
  currentUser,
  onNavigate,
}: {
  /** The signed-in person, for `holdsCapability` - which needs the role as
      well as the list, so that a server too old to report capabilities keeps
      behaving the way it did before they existed. */
  currentUser: {
    role: string
    capabilities: Capability[]
    viewOnly?: Capability[]
    firstName?: string
    lastName?: string
    email?: string
  } | null
  pendingCount: number
  unreadCount: number
  onNavigate: () => void
}) {
  const workGroupId = useId()
  const viewsGroupId = useId()
  const adminGroupId = useId()
  const adminToggleId = useId()
  const { pathname } = useLocation()

  /*
   * A row appears when the server says this person holds what it needs, and
   * `AdminOnly` asks the same question of the same list — so a row can never
   * open a screen that turns the person away. The group heading disappears
   * with its last row, so an ordinary user sees no empty "Administration"
   * label rather than a heading over nothing.
   */
  const adminItems = ADMIN_NAV_ITEMS.filter(
    item => !item.needs || seesCapability(currentUser, item.needs)
  )

  const onAdminScreen = adminItems.some(
    item => NAV_PATHS[item.id] === pathname || item.alsoOwns?.includes(pathname)
  )

  /*
   * A folded group must never hide the screen somebody is looking at, so
   * arriving at an administration page unfolds it — including on a cold load
   * straight into one, which is why the first render consults the path too.
   *
   * Adjusted during render rather than in an effect: an effect would paint
   * the folded rail first and correct it a frame later, and the correction
   * would be a second render every reader of this file has to reason about.
   * The comparison is against ARRIVING, not against being there, so folding
   * the group while reading an administration screen sticks.
   */
  const [adminOpen, setAdminOpen] = useState(() => readAdminGroupOpen() || onAdminScreen)
  const [wasOnAdminScreen, setWasOnAdminScreen] = useState(onAdminScreen)

  if (onAdminScreen !== wasOnAdminScreen) {
    setWasOnAdminScreen(onAdminScreen)
    if (onAdminScreen) setAdminOpen(true)
  }

  const toggleAdminGroup = () => {
    const next = !adminOpen
    setAdminOpen(next)
    try {
      window.localStorage.setItem(ADMIN_GROUP_KEY, next ? 'open' : 'closed')
    } catch {
      // A refused write costs the preference, not the fold. The group is
      // already open or closed on screen; it just will not be tomorrow.
    }
  }

  const countFor = (item: NavItem) =>
    item.count === 'pending' ? pendingCount : item.count === 'unread' ? unreadCount : 0

  const fullName = currentUser
    ? `${currentUser.firstName ?? ''} ${currentUser.lastName ?? ''}`.trim()
    : ''

  return (
    <div className="flex h-full flex-col">
      {/*
        Whose workspace this is. Not a switcher: there is one workspace, and
        no endpoint that could list a second.

        A ChevronDown used to sit at the end of this row, aria-hidden, on a
        plain div - careful about the accessibility tree and careless about
        everybody else, because a chevron is a picture of a control. Somebody
        clicks it on their first day, nothing happens, and they have learnt
        that this product's controls sometimes do not work. The comment
        beside it said "presentational for now", which is the same sentence
        the disabled Export button was carrying.
      */}
      <div className="flex-shrink-0 border-b border-white/10 p-4">
        <div className="flex items-center gap-2.5 rounded-control bg-white/5 p-2">
          <IdeasMark className="h-7 w-7 flex-shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-section font-semibold leading-tight text-shell-text">
              Ideas Flow
            </span>
            <span className="block truncate font-mono text-data leading-tight text-shell-label">
              IDEAS PVT LTD
            </span>
          </span>
        </div>
      </div>

      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 pb-4">
        {/* Group labels are divs named via aria-labelledby, not headings: a
            heading here would sit before every page's <h1> in DOM order and
            break the heading hierarchy. */}
        <div role="group" aria-labelledby={workGroupId}>
          <GroupLabel id={workGroupId}>Work</GroupLabel>
          <div className="space-y-0.5">
            {NAV_ITEMS.map(item => (
              <NavRow
                key={item.id}
                item={item}
                count={countFor(item)}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </div>

        {FEATURES.savedViews && (
          <div role="group" aria-labelledby={viewsGroupId}>
            <GroupLabel id={viewsGroupId}>Saved views</GroupLabel>
            <div className="space-y-0.5">
              {SAVED_VIEWS.map(view => (
                <button
                  key={view.id}
                  type="button"
                  onClick={onNavigate}
                  className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-ui text-shell-muted transition-colors hover:bg-white/10 hover:text-shell-text"
                >
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 flex-shrink-0 rounded-pill ${view.dot}`}
                  />
                  <span className="flex-1 truncate">{view.name}</span>
                  <span className="flex-shrink-0 font-mono text-2xs tabular-nums text-shell-label">
                    {view.count}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Everything administrative, behind one fold.
            The rows below are the ones a person uses on the day they set the
            system up and then rarely again, and there are more of them than
            of the five used hourly, sitting permanently underneath. Folding
            them away is the difference between a rail somebody scans and a
            rail somebody searches. The
            label is the button, so there is nothing to hit but the heading,
            and the rows leave the accessibility tree with `hidden` rather
            than merely going invisible. */}
        {adminItems.length > 0 && (
          <div className="pt-4.5">
            <button
              type="button"
              id={adminToggleId}
              onClick={toggleAdminGroup}
              aria-expanded={adminOpen}
              aria-controls={adminGroupId}
              className="sidebar-group-toggle"
            >
              <ChevronRight
                size={12}
                aria-hidden="true"
                className={`flex-shrink-0 text-shell-label transition-transform ${
                  adminOpen ? 'rotate-90' : ''
                }`}
              />
              <Eyebrow as="span" tone="shell">
                Administration
              </Eyebrow>
              {!adminOpen && (
                <span className="ml-auto font-mono text-2xs tabular-nums text-shell-label">
                  {adminItems.length}
                </span>
              )}
            </button>
            <div
              id={adminGroupId}
              role="group"
              aria-labelledby={adminToggleId}
              hidden={!adminOpen}
              className="space-y-0.5 pt-1.5"
            >
              {adminItems.map(item => (
                <NavRow key={item.id} item={item} count={0} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        )}
      </nav>

      <PresenceFooter
        fullName={fullName}
        firstName={currentUser?.firstName}
        lastName={currentUser?.lastName}
      />
    </div>
  )
}

export default function AppShell({
  children,
  onLogout,
  showSidebar = true,
}: AppShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const { user: currentUser } = useCurrentUser()
  const navigate = useNavigate()
  const { unreadCount } = useUnreadNotificationCount()
  const { count: pendingCount, reload: reloadPendingCount } = usePendingApprovalCount()
  const { pathname } = useLocation()

  // Refresh on navigation so approving something updates the badge. The
  // request cache collapses this into the page load its own screen makes.
  useEffect(() => {
    reloadPendingCount()
  }, [pathname, reloadPendingCount])

  const menuId = useId()
  const profileWrapRef = useRef<HTMLDivElement>(null)
  const profileButtonRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useDialogA11y(mobileOpen, () => setMobileOpen(false))

  const { open: paletteOpen, setOpen: setPaletteOpen } = useCommandPalette()
  useGlobalShortcuts()


  const fullName = currentUser
    ? `${currentUser.firstName} ${currentUser.lastName}`
    : ''
  const page = pathToPage(pathname)

  // The profile menu closes on Escape and on any click outside it, and
  // returns focus to its trigger so keyboard users are not stranded.
  useEffect(() => {
    if (!profileOpen) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setProfileOpen(false)
        profileButtonRef.current?.focus()
      }
    }
    function onPointerDown(event: MouseEvent) {
      if (!profileWrapRef.current?.contains(event.target as Node)) {
        setProfileOpen(false)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [profileOpen])

  const handleLogout = () => {
    onLogout()
    navigate(ROUTES.login, { replace: true })
  }

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      {/* A keyboard user otherwise traverses the whole sidebar and header
          before reaching the first action on any page — twelve stops on the
          approvals queue. Visible only when focused. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-accent focus:px-4 focus:py-2 focus:text-ui focus:font-semibold focus:text-on-accent"
      >
        Skip to main content
      </a>

      {showSidebar && (
        <aside className="hidden w-62 flex-shrink-0 flex-col bg-shell lg:flex">
          <SidebarContent
            
            pendingCount={pendingCount}
            unreadCount={unreadCount}
            currentUser={currentUser ?? null}
            onNavigate={() => setMobileOpen(false)}
          />
        </aside>
      )}

      {showSidebar && mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-scrim/50"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Main menu"
            tabIndex={-1}
            className="absolute inset-y-0 left-0 flex w-62 flex-col bg-shell shadow-overlay outline-none"
          >
            <button
              type="button"
              className="absolute right-3 top-4 z-10 rounded-control p-1.5 text-shell-muted transition-colors hover:bg-white/10 hover:text-shell-text"
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
            >
              <X size={18} aria-hidden="true" />
            </button>
            <SidebarContent
              
              pendingCount={pendingCount}
              unreadCount={unreadCount}
              currentUser={currentUser ?? null}
              onNavigate={() => setMobileOpen(false)}
            />
          </aside>
        </div>
      )}

      <div className="main-content-offset flex flex-1 flex-col overflow-hidden">
        <header className="z-10 flex h-15 flex-shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:gap-4 sm:px-5">
          {showSidebar && (
            <button
              type="button"
              className="inline-flex h-8.5 w-8.5 flex-shrink-0 items-center justify-center rounded-control text-content-muted transition-colors hover:bg-sunken hover:text-content lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
              aria-expanded={mobileOpen}
            >
              <Menu size={20} aria-hidden="true" />
            </button>
          )}

          {/* Breadcrumb. Two segments is the whole hierarchy, so it is a
              plain nav rather than a list of links to nowhere. */}
          <nav aria-label="Breadcrumb" className="hidden min-w-0 md:block">
            <ol className="flex items-center gap-1.5 text-ui">
              <li className="text-content-subtle">Workspace</li>
              <li aria-hidden="true" className="text-line-strong">
                /
              </li>
              <li className="truncate font-semibold text-content" aria-current="page">
                {page ? PAGE_LABELS[page] : 'Ideas Flow'}
              </li>
            </ol>
          </nav>

          {/* Command trigger. The same palette ⌘K opens, so there is one
              implementation behind both entry points. */}
          <div className="mx-auto hidden w-full max-w-115 md:block">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-haspopup="dialog"
              className="flex h-8.5 w-full items-center gap-2.5 rounded-control border border-line bg-canvas px-3 text-left transition-colors hover:border-line-strong hover:bg-surface"
            >
              <Search size={15} className="flex-shrink-0 text-content-subtle" aria-hidden="true" />
              <span className="flex-1 truncate text-ui text-content-subtle">
                Search documents, people, actions&hellip;
              </span>
              <Keycap className="flex-shrink-0">
                <Command size={10} aria-hidden="true" />
                <span className="ml-0.5">K</span>
              </Keycap>
            </button>
          </div>

          <div className="ml-auto flex flex-shrink-0 items-center gap-1 sm:gap-2">
            {FEATURES.liveIndicator && (
              <span className="hidden h-7.5 items-center gap-1.5 rounded-pill border border-line px-2.5 text-meta font-medium text-content-muted lg:inline-flex">
                <span
                  aria-hidden="true"
                  className="livedot h-1.5 w-1.5 rounded-pill bg-accent-mark"
                />
                Live
              </span>
            )}

            {/* Wrapped, because the switch sets its own display and a `hidden`
                passed to it lost to that - it showed on phones all along.
                On a phone it lives in the account menu instead. */}
            <div className="hidden sm:block">
              <ThemeToggle />
            </div>

            {showSidebar && (
              <NavLink
                to={ROUTES.inbox}
                className="relative flex h-8.5 w-8.5 items-center justify-center rounded-control text-content-muted transition-colors hover:bg-sunken hover:text-content"
                aria-label={
                  unreadCount > 0
                    ? `Inbox, ${unreadCount} unread`
                    : 'Inbox'
                }
              >
                <Bell size={17} aria-hidden="true" />
                {unreadCount > 0 && (
                  /* A dot, not a number: the count is already in the link's
                     accessible name and in the rail's own pill. */
                  <span
                    aria-hidden="true"
                    className="absolute right-1 top-1 h-1.75 w-1.75 rounded-pill bg-danger-mark ring-2 ring-surface"
                  />
                )}
              </NavLink>
            )}

            <div className="relative" ref={profileWrapRef}>
              <button
                ref={profileButtonRef}
                type="button"
                onClick={() => setProfileOpen(open => !open)}
                aria-expanded={profileOpen}
                aria-haspopup="menu"
                aria-controls={profileOpen ? menuId : undefined}
                aria-label="Account menu"
                className="flex items-center rounded-pill transition-opacity hover:opacity-90"
              >
                <Avatar
                  firstName={currentUser?.firstName}
                  lastName={currentUser?.lastName}
                  size="lg"
                  tone="accentSolid"
                />
              </button>

              {profileOpen && (
                <div
                  id={menuId}
                  role="menu"
                  aria-label="Account"
                  className="absolute right-0 top-full z-50 mt-1.5 w-52 rounded-card border border-line bg-surface py-1 shadow-overlay"
                >
                  <div className="mb-1 border-b border-line-soft px-3 py-2">
                    <div className="truncate text-ui font-semibold text-content">
                      {fullName || 'Signed in'}
                    </div>
                    <div className="truncate font-mono text-data text-content-subtle">
                      {currentUser?.email}
                    </div>
                  </div>
                  {/* The same two items as the sidebar's account menu. Two
                      menus with the same name that offer different things is
                      how somebody concludes a feature does not exist. */}
                  <Link
                    to={ROUTES.account}
                    role="menuitem"
                    onClick={() => setProfileOpen(false)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui text-content transition-colors hover:bg-sunken"
                  >
                    <UserCog size={14} aria-hidden="true" /> Your account
                  </Link>
                  {/* On a phone the header has no room for the theme switch,
                      so it lives here; wider screens keep it in the header. */}
                  <div className="flex items-center justify-between gap-2 px-3 py-1.5 sm:hidden">
                    <span className="text-ui text-content">Theme</span>
                    <ThemeToggle inMenu />
                  </div>
                  <div className="my-1 border-t border-line-soft" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={handleLogout}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui text-danger-ink transition-colors hover:bg-danger-soft"
                  >
                    <LogOut size={14} aria-hidden="true" /> Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className={`flex-1 overflow-y-auto ${
            showSidebar && !ownsTheFoot(pathname) ? 'max-sm:pb-16' : ''
          }`}
        >
          {children}
        </main>
      </div>

      {showSidebar && !ownsTheFoot(pathname) && (
        <BottomTabs pendingCount={pendingCount} unreadCount={unreadCount} />
      )}

      {/* Mounted only while open, so the documents it searches are fetched on
          the first ⌘K rather than on every page load. No fallback: the panel
          appearing a frame later is better than a spinner over the page. */}
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>
      )}
    </div>
  )
}
