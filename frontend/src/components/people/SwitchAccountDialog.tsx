import { useEffect, useState } from 'react'
import Modal from '../Modal'
import Button from '../ui/Button'
import ApproverCombobox from '../submit/ApproverCombobox'
import { setUserActive } from '../../services/AdminApi'
import { fetchDelegations } from '../../services/delegationApi'
import { fetchMemosHeldBy } from '../../services/holdsApi'
import type { MemosHeld } from '../../types/holds'
import type { User } from '../../types/admin'
import type { AssignableUser } from '../../types/submitDocument'

/**
 * Switching somebody's account off when they leave, or back on.
 *
 * The answer to a departure. Deleting the person is refused the moment they
 * have prepared, approved or commented on anything - which is everybody worth
 * removing - so until this existed somebody who left kept a working password
 * for as long as the organisation used the system, and there was nothing an
 * administrator could do about it inside the application.
 *
 * What makes this a dialog rather than a menu item that just fires: the work
 * has to go somewhere. Agreed after the fit-gap review, a leaver must not leave
 * memos blocked, so whoever still has approval steps on open memos is switched
 * off with a successor, and the server hands every one of those steps to them
 * and ends the leaver's delegations. The dialog says what is waiting, asks who
 * takes it over, and suggests the person already covering for them.
 *
 * It asks even when the answer will be "nothing": an administrator who is
 * told "nothing is waiting on them" is being given the finding that makes it
 * safe, and a dialog that showed the count only when it was bad would leave
 * them guessing whether it had looked.
 */
export default function SwitchAccountDialog({
  person,
  /** True to switch the account back on. */
  active,
  onClose,
  onDone,
}: {
  person: User | null
  active: boolean
  onClose: () => void
  onDone: () => void
}) {
  const personId = person?.id ?? null
  const [holds, setHolds] = useState<{ id: string; data: MemosHeld | null } | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  /** Chosen here; stamped with the person, like the count below. */
  const [chosen, setChosen] = useState<{ id: string; user: AssignableUser } | null>(null)
  /** Whoever is covering for them now, suggested as the successor. */
  const [cover, setCover] = useState<{ id: string; user: AssignableUser } | null>(null)

  /*
   * The impact is read for the person this dialog is about, and read again
   * whenever that changes. Stamped with the id rather than cleared in an
   * effect, so a count belonging to the last person can never be shown under
   * this one's name - the number here is the one somebody decides on.
   */
  const current = holds?.id === personId ? holds : null

  useEffect(() => {
    // Only on the way off. Switching an account back on takes nothing away
    // from anybody, so there is nothing to warn about.
    if (!personId || active) return

    let cancelled = false

    fetchMemosHeldBy(personId)
      .then(data => {
        if (!cancelled) setHolds({ id: personId, data })
      })
      .catch(() => {
        // Left null, which the dialog reads as "could not find out" and says
        // so. It does not block the action: an administrator switching off a
        // leaver's account should not be stopped by a failed count.
        if (!cancelled) setHolds({ id: personId, data: null })
      })

    fetchDelegations(personId)
      .then(lists => {
        const running = lists.given.find(
          delegation => delegation.isActive && !delegation.revokedAt,
        )
        if (cancelled || !running) return
        const { delegate } = running
        setCover({
          id: personId,
          user: {
            id: delegate.id,
            email: delegate.email,
            firstName: delegate.firstName,
            lastName: delegate.lastName,
            designation: delegate.designation,
            department: null,
          },
        })
      })
      .catch(() => {
        // Only a suggestion; the administrator chooses either way.
      })

    return () => {
      cancelled = true
    }
  }, [personId, active])

  if (!person) return null

  const close = () => {
    if (pending) return
    setError(null)
    if (done) {
      setDone(null)
      onDone()
    }
    onClose()
  }

  const confirm = async () => {
    setPending(true)
    setError(null)

    try {
      const result = await setUserActive(
        person.id,
        active,
        active ? undefined : successor?.id,
      )
      setDone(result.message)
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : 'Could not change the account.',
      )
    } finally {
      setPending(false)
    }
  }

  const stopping = current?.data
  const waiting = stopping
    ? stopping.holdingNow.length + stopping.ahead.length
    : 0
  /** Steps of theirs on open memos: what a successor takes over. */
  const openSteps = stopping ? waiting + stopping.comingBack.length : 0
  const successor =
    (chosen?.id === personId ? chosen.user : null) ??
    (cover?.id === personId ? cover.user : null)
  const suggested = Boolean(
    successor && cover?.id === personId && successor.id === cover.user.id,
  )
  const needsSuccessor = !active && openSteps > 0
  const successorField = `successor-${person.id}`

  return (
    <Modal
      open
      onClose={close}
      title={active ? 'Switch account back on' : 'Switch account off'}
      size="sm"
    >
      {done ? (
        <div className="space-y-4">
          <p role="status" className="text-ui leading-relaxed text-content">
            {done}
          </p>
          <div className="flex justify-end">
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-ui leading-relaxed text-content-muted">
            {active ? (
              <>
                <span className="font-semibold text-content">
                  {person.firstName} {person.lastName}
                </span>{' '}
                will be able to sign in again, and can be chosen as an approver.
              </>
            ) : (
              <>
                <span className="font-semibold text-content">
                  {person.firstName} {person.lastName}
                </span>{' '}
                will not be able to sign in, and every session they hold ends
                now. Nothing they have already signed changes.
              </>
            )}
          </p>

          {!active && (
            <div className="rounded-control border border-line-soft bg-canvas px-3 py-2.5">
              {!current ? (
                <p className="text-meta text-content-subtle">
                  Checking what is waiting on them…
                </p>
              ) : !stopping ? (
                <p className="text-meta leading-relaxed text-warning-ink">
                  Could not check what is waiting on them. Switching the
                  account off will still work — look at the Control room
                  afterwards.
                </p>
              ) : stopping.total === 0 ? (
                <p className="text-meta leading-relaxed text-content-muted">
                  Nothing is waiting on them. No memo stops because of this.
                </p>
              ) : (
                <div className="space-y-1.5">
                  <p className="text-meta leading-relaxed text-content">
                    {waiting > 0 ? (
                      <>
                        <span className="font-semibold">
                          {waiting} {waiting === 1 ? 'memo is' : 'memos are'}
                        </span>{' '}
                        waiting on them, now or further along the chain.
                      </>
                    ) : (
                      'No approval steps wait on them.'
                    )}
                  </p>
                  {stopping.returned.length > 0 && (
                    <p className="text-meta leading-relaxed text-content-muted">
                      {stopping.returned.length}{' '}
                      {stopping.returned.length === 1 ? 'memo was' : 'memos were'}{' '}
                      sent back to them for revision. Only a preparer can
                      correct a memo, so those cannot be reassigned at all.
                    </p>
                  )}
                  {/* The case that made this dialog say "nothing is waiting on
                      them" and mean it: a memo out for correction is not in
                      flight, so nobody's step on it counted - and it comes
                      back to step one, past every one of them. */}
                  {stopping.comingBack.length > 0 && (
                    <p className="text-meta leading-relaxed text-content-muted">
                      {stopping.comingBack.length}{' '}
                      {stopping.comingBack.length === 1
                        ? 'memo is out'
                        : 'memos are out'}{' '}
                      for correction and would come back to a step of theirs.
                    </p>
                  )}
                  <p className="text-meta text-content-subtle">
                    &ldquo;What stops if they go&rdquo; on this screen lists them.
                  </p>
                </div>
              )}
            </div>
          )}

          {needsSuccessor && (
            <div>
              <label htmlFor={successorField} className="field-label">
                Who takes over their approvals
              </label>
              <ApproverCombobox
                id={successorField}
                value={successor?.id ?? ''}
                selected={successor}
                takenIds={new Set<string>()}
                excludeIds={new Set([person.id])}
                describedBy={`${successorField}-hint`}
                onChange={user => setChosen({ id: person.id, user })}
                onResolved={user => setChosen({ id: person.id, user })}
              />
              <p
                id={`${successorField}-hint`}
                className="mt-1.5 text-meta leading-relaxed text-content-muted"
              >
                {suggested && successor
                  ? `${successor.firstName} is covering for them now. `
                  : ''}
                Every step of theirs on these memos moves to this person, with
                a note on each memo, and any cover given to or by{' '}
                {person.firstName} ends.
              </p>
            </div>
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
              variant={active ? 'primary' : 'dangerSolid'}
              className="flex-1"
              onClick={confirm}
              pending={pending}
              disabled={needsSuccessor && !successor}
            >
              {active ? 'Switch it back on' : 'Switch it off'}
            </Button>
            <Button
              size="lg"
              variant="secondary"
              className="flex-1"
              onClick={close}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
