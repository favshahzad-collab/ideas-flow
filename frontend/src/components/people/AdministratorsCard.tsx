import { useCallback, useEffect, useState } from 'react'
import { Crown, ShieldCheck } from 'lucide-react'
import { Card, CardHeader } from '../ui/Card'
import Button from '../ui/Button'
import AdminPowersDialog from './AdminPowersDialog'
import TransferSuperAdminDialog from './TransferSuperAdminDialog'
import { fetchUsers, type AccessControlMatrix } from '../../services/AdminApi'
import { useCurrentUser } from '../../contexts/currentUser'
import type { User } from '../../types/admin'

/**
 * Who administers the system, and what each of them may do.
 *
 * The Super Administrator - one at a time - holds everything and decides the
 * rest: they hand the role over with Transfer, and choose every other
 * administrator's rights area by area. Somebody becomes an administrator by
 * having their role changed on People & delegation; this is where what that
 * buys them is decided.
 *
 * Shown to the Super Administrator. Anybody else on this screen sees what
 * they themselves may do, and who to ask for more.
 */
export default function AdministratorsCard({ matrix }: { matrix: AccessControlMatrix }) {
  const { user: me, refetch } = useCurrentUser()
  const [people, setPeople] = useState<User[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<User | null>(null)
  const [transferring, setTransferring] = useState(false)
  const isSuper = Boolean(me?.isSuperAdmin)

  const load = useCallback(() => {
    fetchUsers()
      .then(setPeople)
      .catch((problem: unknown) =>
        setLoadError(problem instanceof Error ? problem.message : 'Could not load the administrators.'),
      )
  }, [])

  useEffect(() => {
    if (isSuper) load()
  }, [isSuper, load])

  if (!me) return null

  const title = (id: string) => matrix.capabilities.find(capability => capability.id === id)?.title ?? id

  if (!isSuper) {
    const changes = me.capabilities.filter(id =>
      matrix.capabilities.some(capability => capability.id === id && capability.grantable),
    )
    return (
      <Card>
        <CardHeader
          icon={ShieldCheck}
          title="Your rights as an administrator"
          hint="Chosen by the Super Administrator. Ask them if your job needs more."
        />
        <div className="space-y-2 px-3.5 py-3 text-meta text-content">
          <p>
            <span className="font-medium">Can change:</span>{' '}
            {changes.length ? changes.map(title).join('; ') : 'nothing beyond what everybody can do'}
          </p>
          {me.viewOnly.length > 0 && (
            <p>
              <span className="font-medium">Can see only:</span> {me.viewOnly.map(title).join('; ')}
            </p>
          )}
        </div>
      </Card>
    )
  }

  const admins = (people ?? []).filter(
    person => person.loginRole === 'ADMINISTRATOR' && !person.deactivatedAt,
  )
  const supers = admins.filter(person => person.isSuperAdmin)
  const others = admins.filter(person => person.id !== me.id)

  const summary = (person: User) => {
    if (person.isSuperAdmin) return 'Also a Super Administrator - make them limited'
    const powers = person.adminPowers ?? []
    const full = powers.filter(power => !power.endsWith(':view')).length
    const seen = powers.filter(power => power.endsWith(':view')).length
    if (!full && !seen) return 'No administration rights'
    return [full && `${full} to change`, seen && `${seen} to see only`].filter(Boolean).join(' · ')
  }

  return (
    <Card accent="accent">
      <CardHeader
        icon={Crown}
        title="Administrators and their rights"
        hint="One Super Administrator at a time. Every other administrator can do only what you give them."
      />

      <div className="flex flex-col gap-3 border-b border-line-soft px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-meta text-content-muted">Super Administrator</p>
          <p className="truncate text-ui font-medium text-content">
            {me.firstName} {me.lastName} <span className="text-content-muted">(you)</span>
          </p>
        </div>
        <Button variant="secondary" onClick={() => setTransferring(true)} disabled={!people}>
          Transfer…
        </Button>
      </div>

      {supers.length > 1 && (
        <p
          role="note"
          className="border-b border-line-soft bg-warning-soft px-3.5 py-2.5 text-meta text-warning-ink"
        >
          {supers.length} people are Super Administrators, left from before there was one at a time.
          Make the others limited below, or transfer the role.
        </p>
      )}

      {loadError && (
        <p role="alert" className="px-3.5 py-3 text-meta text-danger-ink">
          {loadError}
        </p>
      )}

      {!people && !loadError && (
        <p className="px-3.5 py-3 text-meta text-content-muted">Loading the administrators…</p>
      )}

      {people && (
        <ul className="divide-y divide-line-soft">
          {others.length === 0 && (
            <li className="px-3.5 py-3 text-meta text-content-muted">
              Nobody else is an administrator. To make somebody one, change their role on People
              &amp; delegation, then choose their rights here.
            </li>
          )}
          {others.map(person => (
            <li
              key={person.id}
              className="flex flex-col gap-2 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate text-ui font-medium text-content">
                  {person.firstName} {person.lastName}
                </p>
                <p
                  className={`text-meta ${person.isSuperAdmin ? 'text-warning-ink' : 'text-content-muted'}`}
                >
                  {summary(person)}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setEditing(person)}
                aria-label={`Edit rights for ${person.firstName} ${person.lastName}`}
              >
                Edit rights
              </Button>
            </li>
          ))}
        </ul>
      )}

      <AdminPowersDialog person={editing} onClose={() => setEditing(null)} onDone={load} />
      <TransferSuperAdminDialog
        open={transferring}
        people={people ?? []}
        currentUserId={me.id}
        onClose={() => setTransferring(false)}
        onDone={() => {
          load()
          void refetch()
        }}
      />
    </Card>
  )
}
