import { useEffect, useState } from 'react'
import MemoScopeField from '../delegation/MemoScopeField'
import { latestDelegationEnd, MAX_DELEGATION_DAYS } from '../../utils/delegationLimits'
import { Info, UserCog } from 'lucide-react'
import Button from '../ui/Button'
import Switch from '../ui/Switch'
import Eyebrow from '../ui/Eyebrow'
import { Avatar } from '../ui/Card'
import {
  createDelegation,
  fetchDelegations,
  revokeDelegation,
} from '../../services/delegationApi'
import type { Delegation } from '../../types/delegation'
import type { User } from '../../types/admin'
import { coverStillRunning } from '../../utils/delegation'
import { formatDisplayDate } from '../../utils/format'

/**
 * Out-of-office and delegated approvals.
 *
 * While a delegation is in force the delegate may act on the steps assigned to
 * the person who gave it, and every approval they give records both names — on
 * the row, in the ledger and on the page of the memo itself. The person who is
 * away keeps their own authority: being out of office is a diary entry, not a
 * lock.
 *
 * One at a time, by design. Two overlapping delegations would make "who may
 * sign for this person on Tuesday" a question with two answers, so the panel
 * shows the arrangement in force and offers to end it, rather than letting a
 * second one be stacked on top.
 */
const NOBODY_LEFT =
  'There is nobody else to hand these approvals to.'

/** Today, as the date input spells it. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function fullName(person: { firstName: string; lastName: string }): string {
  return `${person.firstName} ${person.lastName}`
}

export default function DelegationPanel({
  person,
  colleagues,
  actingUserId,
  onChange,
}: {
  /** The row selected in the people table, or null before one is picked. */
  person: User | null
  /** Everyone else, as candidate delegates. */
  colleagues: User[]
  /** The administrator using the panel, who cannot name themselves as cover. */
  actingUserId?: string
  /** Called after a delegation is saved or ended, so the table can refresh. */
  onChange?: () => void
}) {
  const [outOfOffice, setOutOfOffice] = useState(false)
  const [awayUntil, setAwayUntil] = useState('')
  const [memoTypes, setMemoTypes] = useState<string[]>([])
  const [delegateId, setDelegateId] = useState('')
  const [current, setCurrent] = useState<Delegation | null>(null)
  const [covering, setCovering] = useState<Delegation[]>([])
  const [loading, setLoading] = useState(person !== null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const personId = person?.id ?? null
  const [shownFor, setShownFor] = useState<string | null>(personId)

  /*
   * Everything on this panel belongs to one person, so selecting somebody else
   * clears all of it before the API is asked about them. Without the reset the
   * panel reads as though the new person is already marked away with a
   * delegate assigned, which is the most misleading state this screen can be
   * in.
   *
   * Adjusted during the render that brings the new person in, rather than in
   * an effect afterwards: an effect would let one frame paint with the
   * previous person's answers under the new person's name.
   */
  if (personId !== shownFor) {
    setShownFor(personId)
    setOutOfOffice(false)
    setAwayUntil('')
    setDelegateId('')
    setError(null)
    setCurrent(null)
    setCovering([])
    setLoading(personId !== null)
  }

  useEffect(() => {
    if (!personId) return

    let cancelled = false

    fetchDelegations(personId)
      .then(lists => {
        if (cancelled) return
        setCurrent(lists.given.find(delegation => delegation.isActive) ?? null)
        setCovering(coverStillRunning(lists.held))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(
          err instanceof Error ? err.message : 'Could not read their delegation.',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [personId])

  if (!person) {
    return (
      <aside className="card overflow-hidden" aria-label="Delegation">
        <div className="border-b border-line-soft bg-canvas px-3.75 py-3.25">
          <h2 className="text-ui font-semibold text-content">Delegation</h2>
          <p className="mt-0.5 text-meta text-content-subtle">Nobody selected</p>
        </div>
        <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-card bg-accent-soft text-accent-ink"
          >
            <UserCog size={19} />
          </span>
          <p className="text-ui font-medium text-content">Pick a person</p>
          <p className="max-w-50 text-meta leading-relaxed text-content-muted">
            Choose a name in the table to set their out-of-office and hand their
            approvals to someone else.
          </p>
        </div>
      </aside>
    )
  }

  // Nobody delegates to themselves, and the API refuses it. Filtering here as
  // well means the option is never offered, whatever list this is handed. The
  // same goes for the administrator using this panel: arranging somebody's
  // cover and naming yourself as it would let one person decide both that an
  // approver is away and who signs instead, so the API refuses that too.
  const candidates = colleagues.filter(
    candidate => candidate.id !== person.id && candidate.id !== actingUserId,
  )
  const delegate = candidates.find(candidate => candidate.id === delegateId) ?? null
  const awayUntilIsPast = awayUntil !== '' && awayUntil < todayIso()
  const waiting = person.openApprovals ?? 0
  const waitingLabel = `${waiting} ${waiting === 1 ? 'approval' : 'approvals'}`

  const save = async () => {
    if (!delegateId || awayUntilIsPast) return

    setSaving(true)
    setError(null)

    try {
      setCurrent(
        await createDelegation({
          delegatorId: person.id,
          delegateId,
          endsAt: awayUntil || null,
          ...(memoTypes.length > 0 ? { memoTypes } : {}),
        }),
      )
      setOutOfOffice(false)
      setAwayUntil('')
      setMemoTypes([])
      setDelegateId('')
      onChange?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the delegation.')
    } finally {
      setSaving(false)
    }
  }

  const end = async () => {
    if (!current) return

    setSaving(true)
    setError(null)

    try {
      await revokeDelegation(current.id)
      setCurrent(null)
      onChange?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not end the delegation.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <aside className="card overflow-hidden" aria-label="Delegation">
      <div className="border-b border-line-soft bg-canvas px-3.75 py-3.25">
        <h2 className="text-ui font-semibold text-content">Delegation</h2>
        <p className="mt-0.5 truncate text-meta text-content-subtle">
          {person.firstName} {person.lastName} &middot; {person.department?.name ?? '—'}
        </p>
      </div>

      <div className="flex flex-col gap-3.5 px-3.75 py-3.75">
        {loading && (
          <p className="text-meta text-content-subtle">Reading their delegation…</p>
        )}

        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}

        {!loading && current ? (
          <>
            <div>
              <Eyebrow as="h3">In force</Eyebrow>
              <p className="mt-1.5 flex items-center gap-2">
                <Avatar
                  firstName={current.delegate.firstName}
                  lastName={current.delegate.lastName}
                  size="xs"
                  tone="info"
                />
                <span className="min-w-0 truncate text-ui text-content">
                  {fullName(current.delegate)}
                </span>
              </p>
              <p className="mt-1.5 text-meta leading-relaxed text-content-muted">
                {current.endsAt
                  ? `Approving for ${person.firstName} until ${formatDisplayDate(current.endsAt)}.`
                  : `Approving for ${person.firstName} until this is ended.`}
                {current.reason ? ` ${current.reason}` : ''}
              </p>
            </div>

            <div>
              <Eyebrow as="h3">Moving now</Eyebrow>
              <p className="mt-1.5 text-meta leading-relaxed text-content-subtle">
                {waiting === 0
                  ? `Nothing is waiting on ${person.firstName} right now.`
                  : `${waitingLabel} on ${person.firstName}'s desk can be signed by ${current.delegate.firstName}.`}
              </p>
            </div>

            <Button
              className="w-full"
              variant="secondary"
              onClick={end}
              pending={saving}
            >
              End delegation
            </Button>
            <p className="text-meta leading-relaxed text-content-subtle">
              Approvals already given under it stand. They were authorised when
              they were given, and the record says so.
            </p>
          </>
        ) : !loading && covering.length > 0 ? (
          /*
           * Somebody covering for a colleague cannot route their own approvals
           * onward: the colleague's steps stay addressed to them, so whoever
           * took theirs could neither sign those steps nor know they were
           * waiting. The server refuses it, and the form would have no other
           * outcome.
           *
           * Named rather than merely refused, because an administrator reading
           * this is the person who can act on it - and "they are covering for
           * somebody" without saying who sends them through the people table
           * one row at a time to find out.
           */
          <div>
            <Eyebrow as="h3">Covering for</Eyebrow>
            <ul className="mt-1.5 space-y-1">
              {covering.map(one => (
                <li key={one.id} className="flex items-center gap-2">
                  <Avatar
                    firstName={one.delegator.firstName}
                    lastName={one.delegator.lastName}
                    size="xs"
                    tone="info"
                  />
                  <span className="min-w-0 truncate text-ui text-content">
                    {fullName(one.delegator)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2.5 text-meta leading-relaxed text-content-muted">
              {person.firstName}&rsquo;s own approvals cannot be handed on while
              they are covering.{' '}
              {covering.length === 1
                ? `End that cover from ${covering[0].delegator.firstName}’s own row first, or move it to somebody else.`
                : 'End that cover from their own rows first, or move it to somebody else.'}
            </p>
          </div>
        ) : (
          !loading && (
            <>
              <Switch
                checked={outOfOffice}
                onChange={next => {
                  setOutOfOffice(next)
                  // Marked back at their desk: the delegate goes with it,
                  // rather than sitting under a switch that says they are in.
                  if (!next) {
                    setDelegateId('')
                    setAwayUntil('')
                  }
                }}
                label="Out of office"
                hint="Route their approvals elsewhere while they are away."
              />

              <div>
                <label htmlFor="delegation-away-until" className="field-label">
                  Away until
                </label>
                <input
                  id="delegation-away-until"
                  type="date"
                  value={awayUntil}
                  min={todayIso()}
                  max={latestDelegationEnd()}
                  onChange={event => setAwayUntil(event.target.value)}
                  disabled={!outOfOffice}
                  aria-invalid={awayUntilIsPast || undefined}
                  aria-describedby={
                    awayUntilIsPast ? 'delegation-away-until-error' : undefined
                  }
                  className="field h-8.5"
                />
                {awayUntilIsPast && (
                  <p id="delegation-away-until-error" className="field-error">
                    That date has already passed, so the delegation would never
                    apply. Pick today or later.
                  </p>
                )}
                {!awayUntilIsPast && outOfOffice && (
                  <p className="mt-1 text-meta text-content-subtle">
                    At most {MAX_DELEGATION_DAYS} days. Left empty, it runs the full{' '}
                    {MAX_DELEGATION_DAYS} days. {person.firstName} is told, and can end it.
                  </p>
                )}
                <div className="mt-3">
                  <MemoScopeField
                    value={memoTypes}
                    onChange={setMemoTypes}
                    disabled={!outOfOffice}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="delegation-delegate" className="field-label">
                  Delegate approvals to
                </label>
                <select
                  id="delegation-delegate"
                  value={delegateId}
                  onChange={event => setDelegateId(event.target.value)}
                  disabled={!outOfOffice || candidates.length === 0}
                  className="field h-8.5"
                >
                  <option value="">Select a person</option>
                  {candidates.map(candidate => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.firstName} {candidate.lastName}
                    </option>
                  ))}
                </select>

                {candidates.length === 0 && (
                  <p className="mt-1 text-meta text-content-subtle">{NOBODY_LEFT}</p>
                )}

                {delegate && (
                  <p className="mt-2 flex items-center gap-2">
                    <Avatar
                      firstName={delegate.firstName}
                      lastName={delegate.lastName}
                      size="xs"
                      tone="info"
                    />
                    <span className="min-w-0 truncate text-meta text-content-muted">
                      {delegate.firstName} {delegate.lastName} &middot;{' '}
                      {delegate.department?.name ?? '—'}
                    </span>
                  </p>
                )}
              </div>

              <p className="flex gap-2 rounded-control bg-canvas px-3 py-2.5 text-meta leading-relaxed text-content-muted">
                <Info size={13} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
                <span>
                  Delegated approvals are recorded in the ledger under both names.{' '}
                  {delegate ? delegate.firstName : 'A delegate'} cannot delegate
                  onwards.
                </span>
              </p>

              <div>
                <Eyebrow as="h3">Moving now</Eyebrow>
                <p className="mt-1.5 text-meta leading-relaxed text-content-subtle">
                  {waiting === 0
                    ? `Nothing is waiting on ${person.firstName} right now.`
                    : `${waitingLabel} on ${person.firstName}'s desk would move${
                        delegate ? ` to ${delegate.firstName}` : ''
                      }.`}
                </p>
              </div>

              <Button
                className="w-full"
                onClick={save}
                pending={saving}
                disabled={!outOfOffice || !delegateId || awayUntilIsPast}
              >
                Save delegation
              </Button>
            </>
          )
        )}
      </div>
    </aside>
  )
}
