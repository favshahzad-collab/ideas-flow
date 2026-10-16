import { useEffect, useState } from 'react'
import Modal from '../Modal'
import Button from '../ui/Button'
import AdminRightsEditor from './AdminRightsEditor'
import {
  fetchAccessControl,
  setAdminPowers,
  type AccessControlMatrix,
} from '../../services/AdminApi'
import type { User } from '../../types/admin'

/**
 * What one administrator may do, as the Super Administrator decides it.
 *
 * There is one Super Administrator at a time, handed over from the Access
 * control screen rather than ticked here. Every other administrator holds
 * only what is chosen here - least privilege: they start with seeing where
 * work is, and the Super Administrator adds what the job needs, area by area,
 * as "see only" or "see and change".
 *
 * An install upgraded from when every administrator was a Super
 * Administrator still has extra ones; for them this offers to make them
 * limited, which is how it gets down to one.
 *
 * Saving asks the Super Administrator to confirm it is them, and is recorded.
 * It takes effect on the administrator's next request.
 */
export default function AdminPowersDialog({
  person,
  onClose,
  onDone,
}: {
  person: User | null
  onClose: () => void
  onDone: () => void
}) {
  const [matrix, setMatrix] = useState<AccessControlMatrix | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** The choice being edited, stamped with whose it is. */
  const [draft, setDraft] = useState<{ id: string; makeLimited: boolean; powers: string[] } | null>(
    null,
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!person) return
    let cancelled = false
    fetchAccessControl()
      .then(result => {
        if (!cancelled) setMatrix(result)
      })
      .catch((problem: unknown) => {
        if (cancelled) return
        setLoadError(problem instanceof Error ? problem.message : 'Could not read the list of powers.')
      })
    return () => {
      cancelled = true
    }
  }, [person])

  if (!person) return null

  const isSuper = Boolean(person.isSuperAdmin)
  const current =
    draft?.id === person.id
      ? draft
      : { id: person.id, makeLimited: false, powers: person.adminPowers ?? [] }
  const editing = !isSuper || current.makeLimited

  const save = async () => {
    setPending(true)
    setError(null)
    try {
      await setAdminPowers(person.id, {
        isSuperAdmin: isSuper && !current.makeLimited,
        powers: editing ? current.powers : [],
      })
      setDraft(null)
      onDone()
      onClose()
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not save the powers.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      title={`Rights for ${person.firstName} ${person.lastName}`}
      size="md"
    >
      <div className="space-y-4">
        {isSuper && !current.makeLimited && (
          <div className="space-y-2 rounded-control border border-warning-line bg-warning-soft px-3 py-2.5">
            <p className="text-meta text-warning-ink">
              {person.firstName} is also a Super Administrator, left from before there was
              one at a time. Make them a limited administrator and choose what they may do.
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setDraft({ ...current, makeLimited: true })}
            >
              Make limited
            </Button>
          </div>
        )}

        {loadError && (
          <p role="alert" className="text-meta text-danger-ink">
            {loadError}
          </p>
        )}

        {editing && matrix && (
          <>
            <p className="text-meta text-content-muted">
              Choose only what this administrator&rsquo;s job needs. To hand over the Super
              Administrator role, use Transfer on the Access control screen.
            </p>
            <AdminRightsEditor
              matrix={matrix}
              powers={current.powers}
              onChange={powers => setDraft({ ...current, powers })}
              disabled={pending}
            />
          </>
        )}

        {error && (
          <p
            role="alert"
            className="rounded-control border border-danger-line bg-danger-soft px-3 py-2 text-ui text-danger-ink"
          >
            {error}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:gap-3">
          <Button
            size="lg"
            className="flex-1"
            onClick={() => void save()}
            pending={pending}
            disabled={!editing}
          >
            Save rights
          </Button>
          <Button size="lg" variant="secondary" className="flex-1" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  )
}
