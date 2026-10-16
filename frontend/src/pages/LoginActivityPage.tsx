import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Activity, ChevronDown, LogOut, MonitorSmartphone, UserX } from 'lucide-react'
import { Page, PageHeader, EmptyState } from '../components/ui/Page'
import { Card, CardHeader, Badge, Avatar } from '../components/ui/Card'
import Eyebrow from '../components/ui/Eyebrow'
import Button from '../components/ui/Button'
import ConfirmDialog from '../components/ui/ConfirmDialog'
import { useCurrentUser } from '../contexts/currentUser'
import {
  fetchLoginActivity,
  endUserSessions,
  type LoginActivity,
  type ActiveSession,
  type EndedSession,
} from '../services/AdminApi'

/**
 * Who is signed in, and who just left.
 *
 * The question an administrator could not previously ask at all: sessions were
 * listable only for the account doing the asking. It is the screen somebody
 * opens when an account is suspected, when a person has left, and when a memo
 * was approved by somebody who says they were not at their desk.
 *
 * It polls rather than holding a socket. Half a minute is fast enough for
 * every one of those questions and costs one indexed query; a live socket for
 * a screen an administrator opens twice a month would be a connection to keep
 * alive, authorise and reconnect for no gain anybody would notice.
 */

const POLL_MS = 30_000

/** "since 09:12" for today, and the date once it is not today. */
function since(iso: string): string {
  const at = new Date(iso)
  const today = new Date()
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate()

  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return sameDay ? time : `${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`
}

/** How long ago, in the coarsest unit that is still true. */
function elapsed(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * The browser and platform, from the user agent.
 *
 * Deliberately crude. A user agent string is not identity and this does not
 * pretend it is — it is here so somebody looking at two sessions for the same
 * person can tell the laptop from the phone. Anything it cannot recognise is
 * reported as unknown rather than guessed at.
 */
function device(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device'

  const platform = /Android/i.test(userAgent)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(userAgent)
      ? 'iOS'
      : /Mac OS X/i.test(userAgent)
        ? 'macOS'
        : /Windows/i.test(userAgent)
          ? 'Windows'
          : /Linux/i.test(userAgent)
            ? 'Linux'
            : null

  const browser = /Edg\//i.test(userAgent)
    ? 'Edge'
    : /OPR\//i.test(userAgent)
      ? 'Opera'
      : /Firefox\//i.test(userAgent)
        ? 'Firefox'
        : /Chrome\//i.test(userAgent)
          ? 'Chrome'
          : /Safari\//i.test(userAgent)
            ? 'Safari'
            : null

  if (browser && platform) return `${browser} on ${platform}`
  return browser ?? platform ?? 'Unknown device'
}

function fullName(user: { firstName: string; lastName: string }) {
  return `${user.firstName} ${user.lastName}`.trim()
}

/** A number that counts to its value rather than jumping to it. */
function Tally({ value, label }: { value: number; label: string }) {
  const [shown, setShown] = useState(0)
  /* Where the count is now, readable by the next effect without being state
     itself — reading `shown` there would restart the animation every tick. */
  const at = useRef(0)

  useEffect(() => {
    /*
     * From wherever it currently stands, in whichever direction. Counting from
     * zero on every poll would mean a figure that went 7 to 6 replayed the
     * whole climb, which reads as seven people arriving rather than one
     * leaving.
     *
     * Stepped rather than eased, so what animates is the number itself passing
     * through every value on the way. Nothing is set synchronously here: the
     * first change lands on the first tick, which is what keeps this out of
     * the cascading-render trap.
     */
    const distance = Math.abs(value - at.current)
    if (distance === 0) return

    const step = Math.max(1, Math.ceil(distance / 12))
    const timer = setInterval(() => {
      at.current =
        value > at.current
          ? Math.min(value, at.current + step)
          : Math.max(value, at.current - step)

      setShown(at.current)
      if (at.current === value) clearInterval(timer)
    }, 30)

    return () => {
      clearInterval(timer)
    }
  }, [value])

  return (
    <div className="px-3.5 py-3">
      <Eyebrow as="h2">{label}</Eyebrow>
      {/* The live region announces the settled figure, not every tick of the
          count-up — a screen reader should hear "7 people", once. */}
      <p className="mt-1 text-title font-semibold tabular-nums text-content" aria-hidden="true">
        {shown}
      </p>
      <p className="sr-only" aria-live="polite">
        {label}: {value}
      </p>
    </div>
  )
}

/** Every open session one person holds. */
type PersonGroup = {
  user: ActiveSession['user']
  sessions: ActiveSession[]
  /** The oldest session still open — when they have been signed in since. */
  since: string
}

/**
 * One row per person, not per session.
 *
 * The first version of this screen drew a row per session, which is what the
 * endpoint returns. On the real instance that was seventeen identical rows for
 * one person — same name, same department, same badges — each with its own
 * "Sign out" button, all seventeen of which did the same thing, because ending
 * sessions is an operation on an account and never on one row.
 *
 * "Who is signed in" is a question about people. The sessions are the detail
 * underneath, and they are worth keeping: two devices in two cities is the
 * thing somebody opens this screen to notice.
 */
function groupByPerson(sessions: ActiveSession[]): PersonGroup[] {
  const byUser = new Map<string, PersonGroup>()

  for (const session of sessions) {
    const existing = byUser.get(session.user.id)
    if (existing) {
      existing.sessions.push(session)
      if (session.issuedAt < existing.since) existing.since = session.issuedAt
    } else {
      byUser.set(session.user.id, {
        user: session.user,
        sessions: [session],
        since: session.issuedAt,
      })
    }
  }

  // Most recently active first: whoever just signed in is the row somebody
  // scanning this screen is most likely looking for.
  return [...byUser.values()].sort((a, b) =>
    b.sessions[0]!.issuedAt.localeCompare(a.sessions[0]!.issuedAt)
  )
}

function PersonRow({
  group,
  index,
  isSelf,
  isNew,
  onEnd,
}: {
  group: PersonGroup
  index: number
  isSelf: boolean
  isNew: boolean
  onEnd: () => void
}) {
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const count = group.sessions.length

  /* Distinct devices rather than a list of seventeen. Somebody scanning for
     something odd is looking for "Chrome on Windows, Safari on iOS", not for
     the same string repeated. */
  const devices = [...new Set(group.sessions.map(session => device(session.userAgent)))]

  return (
    <li
      /* The stagger is capped: past a dozen rows a per-index delay stops
         reading as a cascade and starts reading as the page being slow. */
      className={`rise-in border-b border-line-soft last:border-0 ${isNew ? 'settle-ring' : ''}`}
      style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}
    >
      <div className="flex items-center gap-3 px-3.5 py-3">
        <Avatar
          firstName={group.user.firstName}
          lastName={group.user.lastName}
          size="lg"
          tone={isSelf ? 'accentSolid' : 'accent'}
          presence="available"
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-ui font-medium text-content">
              {fullName(group.user)}
            </span>
            {isSelf && <Badge tone="accent">You</Badge>}
            {group.user.loginRole === 'ADMINISTRATOR' && (
              <Badge tone="info">Administrator</Badge>
            )}
          </div>
          <p className="mt-0.5 truncate text-meta text-content-muted">
            {group.user.department?.name ?? 'No department'}
            <span aria-hidden="true"> · </span>
            {group.user.email}
          </p>
        </div>

        <div className="hidden min-w-0 flex-shrink-0 text-right sm:block">
          <p className="truncate text-meta text-content-muted">{devices.join(', ')}</p>
          <p className="truncate font-mono text-data text-content-faint">
            {[...new Set(group.sessions.map(session => session.ipAddress ?? 'no address'))]
              .slice(0, 2)
              .join(', ')}
          </p>
        </div>

        <div className="flex-shrink-0 text-right">
          <p className="font-mono text-data tabular-nums text-content-subtle">
            {since(group.since)}
          </p>
          <p className="text-2xs text-content-faint">{elapsed(group.since)} ago</p>
        </div>

        <div className="flex flex-shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setOpen(value => !value)}
            aria-expanded={open}
            aria-controls={detailId}
            className="inline-flex h-7.5 items-center gap-1 rounded-control px-2 text-meta text-content-muted transition-colors hover:bg-sunken hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span className="tabular-nums">{count}</span>{' '}
            {/* `sr-only sm:not-sr-only` rather than `hidden sm:inline`: hiding
                the word outright left the control announcing itself as "2",
                which is not a thing anybody can act on. It is read at every
                width and shown from `sm` up. */}
            <span className="sr-only sm:not-sr-only">
              {count === 1 ? 'session' : 'sessions'}
            </span>
            <ChevronDown
              size={13}
              aria-hidden="true"
              className={`transition-transform ${open ? 'rotate-180' : ''}`}
            />
          </button>

          {isSelf ? (
            /* No button at all rather than a disabled one: ending your own
               sessions from here would sign you out mid-click, and the place
               that does it on purpose — and says so — is your account page. */
            <span className="px-1 text-2xs text-content-faint">Your session</span>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={onEnd}
              icon={<LogOut size={14} aria-hidden="true" />}
              aria-label={`Sign ${fullName(group.user)} out of everywhere`}
            >
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          )}
        </div>
      </div>

      {open && (
        <ul id={detailId} className="border-t border-line-soft bg-sunken/40 px-3.5 py-1">
          {group.sessions.map(session => (
            <li
              key={session.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5 text-meta text-content-muted"
            >
              <span className="min-w-40">{device(session.userAgent)}</span>
              <span className="font-mono text-data text-content-faint">
                {session.ipAddress ?? 'address not recorded'}
              </span>
              <span className="font-mono text-data tabular-nums">
                {since(session.issuedAt)}
              </span>
              <span className="text-2xs text-content-faint">
                expires {since(session.expiresAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function EndedRow({ session, index }: { session: EndedSession; index: number }) {
  return (
    <li
      className="rise-in flex items-center gap-3 border-b border-line-soft px-3.5 py-2.5 last:border-0"
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
    >
      <Avatar
        firstName={session.user.firstName}
        lastName={session.user.lastName}
        size="sm"
        tone="neutral"
      />
      <div className="min-w-0 flex-1">
        <span className="truncate text-meta font-medium text-content-muted">
          {fullName(session.user)}
        </span>
        <p className="truncate text-2xs text-content-faint">
          {session.user.department?.name ?? 'No department'}
          <span aria-hidden="true"> · </span>
          {device(session.userAgent)}
        </p>
      </div>
      <p className="flex-shrink-0 text-right font-mono text-data tabular-nums text-content-faint">
        {since(session.revokedAt)}
      </p>
    </li>
  )
}

export default function LoginActivityPage() {
  const { user: me } = useCurrentUser()
  const [data, setData] = useState<LoginActivity | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ending, setEnding] = useState<PersonGroup | null>(null)
  const [busy, setBusy] = useState(false)

  /*
   * Which session ids were on screen last time, so a row that has just
   * appeared can be marked as new. A ref rather than state: it is read while
   * rendering the next result and must not itself cause a render.
   */
  const seen = useRef<Set<string>>(new Set())
  const [fresh, setFresh] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      const result = await fetchLoginActivity()
      const ids = new Set(result.active.map(session => session.id))

      // Nothing is "new" on the first load — every row would be, and a whole
      // list ringing at once says nothing about what changed.
      const arrived = seen.current.size
        ? new Set([...ids].filter(id => !seen.current.has(id)))
        : new Set<string>()

      seen.current = ids
      setFresh(arrived)
      setData(result)
      setError(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load login activity')
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      clearInterval(timer)
    }
  }, [load])

  const confirmEnd = async () => {
    if (!ending) return
    setBusy(true)
    try {
      await endUserSessions(ending.user.id)
      setEnding(null)
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not end those sessions')
      setEnding(null)
    } finally {
      setBusy(false)
    }
  }

  const active = data?.active ?? []
  const ended = data?.ended ?? []
  const people = groupByPerson(active)

  return (
    <Page>
      <PageHeader
        eyebrow="Administration · Login activity"
        title="Login activity"
        description="Who is signed in right now, and who has signed out recently. Refreshes every half minute."
        actions={
          <span className="inline-flex items-center gap-2 rounded-pill border border-accent-line bg-accent-soft px-2.5 py-1 text-2xs font-medium text-accent-ink">
            <span aria-hidden="true" className="livedot h-1.5 w-1.5 rounded-pill bg-accent-mark" />
            Live
          </span>
        }
      />

      {error && (
        <Card className="mb-4">
          <p role="alert" className="px-3.5 py-3 text-ui text-danger-ink">
            {error}
          </p>
        </Card>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Card accent="accent">
          <Tally value={data?.summary.peopleSignedIn ?? 0} label="People signed in" />
        </Card>
        <Card accent="info">
          <Tally value={data?.summary.sessionsOpen ?? 0} label="Open sessions" />
        </Card>
        <Card accent="neutral">
          <Tally value={ended.length} label="Signed out this week" />
        </Card>
      </div>

      <Card className="mb-4">
        <CardHeader
          icon={Activity}
          title="Signed in now"
          hint="One row per person. Open a row to see each device they are signed in on."
          meta={`${people.length}`}
        />
        {data && active.length === 0 ? (
          <EmptyState
            icon={UserX}
            title="Nobody is signed in"
            description="Sessions appear here as people sign in, and stay until they sign out or the session expires."
          />
        ) : (
          <ul>
            {people.map((group, index) => (
              <PersonRow
                key={group.user.id}
                group={group}
                index={index}
                isSelf={group.user.id === me?.id}
                isNew={group.sessions.some(session => fresh.has(session.id))}
                onEnd={() => setEnding(group)}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          icon={MonitorSmartphone}
          tone="neutral"
          title="Recently signed out"
          hint="Kept for a week. An empty list here is what an empty list above should be read against."
          meta={`${ended.length}`}
        />
        {data && ended.length === 0 ? (
          <p className="px-3.5 py-6 text-ui text-content-muted">
            Nobody has signed out in the last week.
          </p>
        ) : (
          <ul>
            {ended.map((session, index) => (
              <EndedRow key={session.id} session={session} index={index} />
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(ending)}
        title={ending ? `Sign ${fullName(ending.user)} out of everywhere?` : ''}
        confirmLabel="Sign them out"
        destructive
        pending={busy}
        onConfirm={() => void confirmEnd()}
        onCancel={() => setEnding(null)}
      >
        {/* Everywhere, and said plainly: ending one device would leave the
            access token in that tab working until it expired, which is not
            what anybody reaching for this button means. */}
        All {ending?.sessions.length} of {ending?.user.firstName}&rsquo;s open
        sessions end immediately, on every device &mdash; not just one of them.
        They can sign in again straight away with the same password.
      </ConfirmDialog>
    </Page>
  )
}
