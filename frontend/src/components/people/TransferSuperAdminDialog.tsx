import { useId, useState } from 'react'
import Modal from '../Modal'
import Button from '../ui/Button'
import { transferSuperAdmin } from '../../services/AdminApi'
import type { User } from '../../types/admin'

/**
 * Hand the Super Administrator role to somebody else.
 *
 * There is one at a time. The person handing it over stays an administrator
 * with every power that can be given - they keep doing their job - but no
 * longer manages administrators, sign-on or mail, so they are asked to say
 * they understand before the button does anything. The server asks them to
 * confirm it is them, and records it.
 */
export default function TransferSuperAdminDialog({
  open,
  people,
  currentUserId,
  onClose,
  onDone,
}: {
  open: boolean
  /** Everybody the role could go to; the switched-off are left out here. */
  people: User[]
  currentUserId: string
  onClose: () => void
  onDone: () => void
}) {
  const [targetId, setTargetId] = useState('')
  const [understood, setUnderstood] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectId = useId()
  const checkId = useId()

  if (!open) return null

  const candidates = people
    .filter(person => person.id !== currentUserId && !person.deactivatedAt)
    .sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`))
  const target = candidates.find(person => person.id === targetId)

  const close = () => {
    if (pending) return
    setTargetId('')
    setUnderstood(false)
    setError(null)
    onClose()
  }

  const transfer = async () => {
    if (!target) return
    setPending(true)
    setError(null)
    try {
      await transferSuperAdmin(target.id)
      setTargetId('')
      setUnderstood(false)
      onDone()
      onClose()
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not transfer the role.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Modal open onClose={close} title="Transfer Super Administrator" size="md">
      <div className="space-y-4">
        <p className="text-meta leading-relaxed text-content-muted">
          There is one Super Administrator at a time. The person you choose gets every power,
          including managing administrators, single sign-on and mail. You stay an administrator
          with every other power, and they can change what you may do.
        </p>

        <div>
          <label htmlFor={selectId} className="field-label">
            New Super Administrator
          </label>
          <select
            id={selectId}
            className="field"
            value={targetId}
            onChange={event => setTargetId(event.target.value)}
            disabled={pending}
          >
            <option value="">Choose a person…</option>
            {candidates.map(person => (
              <option key={person.id} value={person.id}>
                {person.firstName} {person.lastName} - {person.email}
                {person.loginRole === 'ADMINISTRATOR' ? '' : ' (becomes an administrator)'}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-start gap-2.5">
          <input
            id={checkId}
            type="checkbox"
            checked={understood}
            onChange={event => setUnderstood(event.target.checked)}
            disabled={pending}
            className="mt-0.5 h-4 w-4 flex-shrink-0 accent-accent"
          />
          <label htmlFor={checkId} className="text-meta leading-snug text-content">
            I understand I will no longer manage administrators, single sign-on or mail
            {target ? `, and that ${target.firstName} will` : ''}.
          </label>
        </div>

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
            variant="dangerSolid"
            className="flex-1"
            onClick={() => void transfer()}
            pending={pending}
            disabled={!target || !understood}
          >
            Transfer
          </Button>
          <Button size="lg" variant="secondary" className="flex-1" onClick={close} disabled={pending}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  )
}
