import { Link } from 'react-router-dom'
import { ShieldCheck, ShieldOff } from 'lucide-react'
import { Avatar } from '../ui/Card'
import MetaBar from '../ui/MetaBar'
import RowMenu, { MenuItem } from '../ui/RowMenu'
import { SkeletonTableRows } from '../ui/Skeleton'
import { FEATURES } from '../../config/features'
import type { User } from '../../types/admin'
import { ROUTES } from '../../types/routes'
import { formatDisplayDate } from '../../utils/format'

/**
 * The system role pill. `loginRole` only ever holds USER or ADMINISTRATOR —
 * the approval roles (Reviewer, Approver, Final Approver) belong to a
 * workflow step, not to a person — so Approver has no row to land on here.
 * Its tint stays defined because the same map is what a step-role pill would
 * use, and two ramps for one idea is how palettes drift apart.
 */
const ROLE_STYLES: Record<string, string> = {
  ADMINISTRATOR: 'border-accent-line bg-accent-soft text-accent-ink',
  APPROVER: 'border-info-line bg-info-soft text-info-ink',
  USER: 'border-line bg-sunken text-content-muted',
}

const ROLE_LABELS: Record<string, string> = {
  ADMINISTRATOR: 'Administrator',
  APPROVER: 'Approver',
  USER: 'User',
}

function RolePill({ role, superAdmin = false }: { role: string; superAdmin?: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-pill border px-2 py-0.5 text-2xs font-medium ${
        ROLE_STYLES[role] ?? ROLE_STYLES.USER
      }`}
    >
      {role === 'ADMINISTRATOR' && superAdmin
        ? 'Super Administrator'
        : (ROLE_LABELS[role] ?? role)}
    </span>
  )
}

/**
 * Whether this person signs in with a code as well as a password.
 *
 * The server has answered this for every person since two-step shipped, and
 * the only thing the screen did with the answer was decide whether to offer
 * "Turn off two-step sign-in" in the row menu - so the one place an
 * administrator would look to find out who is protected could not tell them,
 * and the way to find out was to open seven menus.
 *
 * Off is tinted for an administrator and left plain for everybody else. That
 * is a judgement and it is deliberate: an account that can reach every
 * administration screen, read every memo and change anybody's role is the one
 * where a stolen password costs the most, so it is the row worth noticing.
 * Nobody is shouted at - the tint is the same warning ink the rest of the app
 * uses for "worth your attention", not an alarm.
 *
 * Never colour alone: the word is there, the icon differs in shape, and a
 * screen reader is told in a sentence.
 */
function TwoStep({
  on,
  privileged,
  isSelf,
}: {
  on: boolean
  privileged: boolean
  isSelf: boolean
}) {
  if (on) {
    return (
      <span className="inline-flex items-center gap-1.5 text-meta font-medium text-accent-ink">
        <ShieldCheck size={14} aria-hidden="true" className="flex-shrink-0" />
        <span aria-hidden="true">On</span>
        <span className="sr-only">Two-step sign-in is on</span>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-flex items-center gap-1.5 text-meta font-medium ${
          privileged ? 'text-warning-ink' : 'text-content-muted'
        }`}
      >
        <ShieldOff size={14} aria-hidden="true" className="flex-shrink-0" />
        <span aria-hidden="true">Off</span>
        <span className="sr-only">
          Two-step sign-in is off{privileged ? ' for an administrator' : ''}
        </span>
      </span>
      {/* Only on your own row, because it is the only one you can act on:
          enrolment needs the phone in somebody's hand, so an administrator
          cannot turn this on for anybody else and a link offering to would
          be a dead end. This is also the answer to "where is the 2FA
          setting" - it is on your own account screen, and now the roster
          says so. */}
      {isSelf && (
        <Link
          to={ROUTES.account}
          className="text-meta font-medium text-accent-ink underline underline-offset-2 hover:text-accent"
        >
          Turn on
        </Link>
      )}
    </span>
  )
}

export default function PeopleTable({
  users,
  loading,
  loadError,
  search,
  selectedId,
  onSelect,
  onEdit,
  onResetTwoFactor,
  onSetActive,
  onSetPowers,
  currentUserId,
}: {
  users: User[]
  loading: boolean
  loadError: string
  search: string
  /** The person the delegation panel is currently showing. */
  selectedId: string | null
  onSelect: (user: User) => void
  onEdit: (user: User) => void
  onResetTwoFactor: (user: User) => void
  /** Switch the account off, or back on. The page confirms it. */
  onSetActive: (user: User, active: boolean) => void
  /**
   * Set an administrator's tier and powers. Passed only to a Super
   * Administrator; absent, the action is not offered.
   */
  onSetPowers?: (user: User) => void
  /** Whose row offers the way to turn two-step on. Nobody's, if absent. */
  currentUserId?: string | null
}) {
  const columnCount = 5 + (FEATURES.approverLoad ? 1 : 0) + (FEATURES.delegation ? 1 : 0)

  // The longest queue on the page, so the bars compare people with each other
  // rather than with a capacity nobody has set.
  const busiest = users.reduce((most, user) => Math.max(most, user.openApprovals), 0)

  return (
    <div className="relative overflow-x-auto">
      {/* `relative` on the scroller above is load-bearing: the sr-only spans
          in the header row are absolutely positioned, and with no positioned
          ancestor they escape this scroller's clip and stretch the whole
          document sideways once the table is wider than the viewport. */}
      <table className="w-full border-collapse sm:min-w-150">
        <caption className="sr-only">
          People in this organisation, with department, system role, two-step
          sign-in and availability
        </caption>
        <thead>
          <tr className="border-b border-line bg-canvas">
            <th scope="col" className="table-head pl-3.5">
              Person
            </th>
            {/* On a phone the department moves under the name, so the columns
                that are left fit the screen. */}
            <th scope="col" className="table-head max-sm:hidden">
              Department
            </th>
            <th scope="col" className="table-head">
              Role
            </th>
            <th scope="col" className="table-head">
              Two-step
            </th>
            {FEATURES.approverLoad && (
              <th scope="col" className="table-head">
                Queue
              </th>
            )}
            {FEATURES.delegation && (
              <th scope="col" className="table-head">
                Availability
              </th>
            )}
            <th scope="col" className="table-head w-10">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>

        <tbody>
          {loading && <SkeletonTableRows rows={6} columns={columnCount} />}

          {!loading && loadError && (
            <tr>
              <td colSpan={columnCount} className="px-3.5 py-10 text-center">
                <p className="text-ui font-medium text-danger-ink">{loadError}</p>
                <p className="mt-1 text-meta text-content-muted">
                  Reload the page to try again.
                </p>
              </td>
            </tr>
          )}

          {!loading && !loadError && users.length === 0 && (
            <tr>
              <td
                colSpan={columnCount}
                className="px-3.5 py-10 text-center text-ui text-content-muted"
              >
                {search
                  ? `Nobody matches “${search}”.`
                  : 'No people yet. Add one to get started.'}
              </td>
            </tr>
          )}

          {!loading &&
            users.map(user => {
              const selected = user.id === selectedId
              return (
                <tr
                  key={user.id}
                  className={`border-b border-line-soft transition-colors last:border-0 hover:bg-sunken ${
                    selected ? 'bg-accent-soft/50' : ''
                  }`}
                >
                  <td className="py-2.5 pl-3.5 pr-3">
                    <button
                      type="button"
                      onClick={() => onSelect(user)}
                      aria-pressed={FEATURES.delegation ? selected : undefined}
                      className="flex min-w-0 items-center gap-2.5 text-left"
                    >
                      <Avatar
                        firstName={user.firstName}
                        lastName={user.lastName}
                        size="md"
                        tone={user.loginRole === 'ADMINISTRATOR' ? 'accent' : 'neutral'}
                        presence={FEATURES.delegation ? 'available' : undefined}
                        presenceRing="surface"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-ui font-medium text-content">
                          {user.firstName} {user.lastName}
                        </span>
                        {user.designation && (
                          <span className="block truncate text-meta text-content-muted">
                            {user.designation}
                          </span>
                        )}
                        <span
                          className="block truncate font-mono text-data text-content-subtle"
                          title={user.email}
                        >
                          {user.email}
                        </span>
                        {user.department && (
                          <span className="block truncate text-meta text-content-muted sm:hidden">
                            {user.department.name}
                          </span>
                        )}
                      </span>
                    </button>
                  </td>

                  <td className="px-3 py-2.5 text-ui text-content-muted max-sm:hidden">
                    {user.department?.name ?? '—'}
                  </td>

                  <td className="px-3 py-2.5">
                    <RolePill role={user.loginRole} superAdmin={user.isSuperAdmin} />
                  </td>

                  <td className="whitespace-nowrap px-3 py-2.5">
                    <TwoStep
                      on={Boolean(user.twoFactorEnabled)}
                      privileged={user.loginRole === 'ADMINISTRATOR'}
                      isSelf={Boolean(currentUserId) && user.id === currentUserId}
                    />
                  </td>

                  {FEATURES.approverLoad && (
                    <td className="px-3 py-2.5">
                      {/* The bar is relative to the busiest person on the
                          page, not to an invented capacity: nobody has an
                          approvals-per-week limit, so a percentage of one
                          would be a number with nothing behind it. */}
                      <span className="inline-flex items-center gap-2 whitespace-nowrap">
                        <MetaBar
                          pct={busiest === 0 ? 0 : (user.openApprovals / busiest) * 100}
                          tone={user.openApprovals === 0 ? 'neutral' : 'accent'}
                          width="admin"
                        />
                        <span
                          className="font-mono text-2xs tabular-nums text-content-subtle"
                          title={`${user.openApprovals} waiting on them now`}
                        >
                          {user.openApprovals}
                        </span>
                      </span>
                    </td>
                  )}

                  {FEATURES.delegation && (
                    <td className="whitespace-nowrap px-3 py-2.5">
                      {/* Read off the delegation actually in force, so the
                          column says who is signing in their place rather
                          than asserting that everybody is at their desk. */}
                      {user.coveredBy ? (
                        <span
                          className="text-ui text-warning-ink"
                          title={
                            user.coveredBy.endsAt
                              ? `Approvals go to ${user.coveredBy.firstName} ${user.coveredBy.lastName} until ${formatDisplayDate(user.coveredBy.endsAt)}`
                              : `Approvals go to ${user.coveredBy.firstName} ${user.coveredBy.lastName} until this is ended`
                          }
                        >
                          Covered by {user.coveredBy.firstName}
                        </span>
                      ) : user.deactivatedAt ? (
                        /* Said in a word, not only in a tint: this is the one
                           state on the row that means the person cannot get
                           in at all, and it has to survive being read by
                           somebody who cannot separate the colours. */
                        <span
                          className="text-ui text-content-subtle"
                          title={`Switched off on ${formatDisplayDate(user.deactivatedAt)}`}
                        >
                          Switched off
                        </span>
                      ) : (
                        <span className="text-ui text-accent-ink">Available</span>
                      )}
                    </td>
                  )}

                  <td className="px-3 py-2.5">
                    <RowMenu label={`Actions for ${user.firstName} ${user.lastName}`}>
                      {close => (
                        <>
                          {FEATURES.delegation && (
                            <MenuItem
                              onSelect={() => {
                                close()
                                onSelect(user)
                              }}
                            >
                              Set delegation
                            </MenuItem>
                          )}
                          <MenuItem
                            onSelect={() => {
                              close()
                              onEdit(user)
                            }}
                          >
                            Edit details
                          </MenuItem>
                          {/* Another administrator's, never one's own:
                              nobody changes what they themselves may do. */}
                          {onSetPowers &&
                            user.loginRole === 'ADMINISTRATOR' &&
                            user.id !== currentUserId && (
                              <MenuItem
                                onSelect={() => {
                                  close()
                                  onSetPowers(user)
                                }}
                              >
                                Set powers
                              </MenuItem>
                            )}
                          {/* Only for somebody who actually has it on.
                              Offering it on every row would make an
                              administrator guess, and the server refuses
                              anyway - a menu item that usually fails is
                              worse than no menu item. */}
                          {user.twoFactorEnabled && (
                            <MenuItem
                              onSelect={() => {
                                close()
                                onResetTwoFactor(user)
                              }}
                            >
                              Turn off two-step sign-in
                            </MenuItem>
                          )}
                          {/* The answer to somebody leaving, and the only
                              one: there is no "Delete person". Deleting a row
                              broke the audit ledger, and switching off does
                              everything deleting did - no sign-in, no
                              sessions, gone from every picker - while what
                              the person did still names them. */}
                          <MenuItem
                            tone={user.deactivatedAt ? undefined : 'danger'}
                            onSelect={() => {
                              close()
                              onSetActive(user, Boolean(user.deactivatedAt))
                            }}
                          >
                            {user.deactivatedAt
                              ? 'Switch account back on'
                              : 'Switch account off'}
                          </MenuItem>
                        </>
                      )}
                    </RowMenu>
                  </td>
                </tr>
              )
            })}
        </tbody>
      </table>
    </div>
  )
}
