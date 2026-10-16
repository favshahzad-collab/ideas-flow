import { useEffect, useState } from 'react'
import MemoScopeField from '../delegation/MemoScopeField'
import { latestDelegationEnd, MAX_DELEGATION_DAYS } from '../../utils/delegationLimits'
import { UserCog } from 'lucide-react'
import ApproverCombobox from '../submit/ApproverCombobox'
import { Card, CardHeader, Avatar } from '../ui/Card'
import Button from '../ui/Button'
import Eyebrow from '../ui/Eyebrow'
import { useCurrentUser } from '../../contexts/currentUser'
import { usePendingApprovalCount } from '../../hooks/usePendingApprovalCount'
import {
  createDelegation,
  fetchDelegations,
  revokeDelegation,
} from '../../services/delegationApi'
import type { Delegation, DelegationLists } from '../../types/delegation'
import type { AssignableUser } from '../../types/submitDocument'
import { coverStillRunning } from '../../utils/delegation'
import { formatDisplayDate } from '../../utils/format'

/**
 * Handing your own approvals to a colleague while you are away.
 *
 * `POST /api/delegations` has always allowed this: the delegator defaults to
 * whoever is asking, and the only thing the route refuses is arranging
 * SOMEBODY ELSE's cover without `users.manage`. The one screen that offered it
 * was the administrators' people table, so for everybody else the documented
 * instruction - record a delegation before you go, or your steps simply sit -
 * could only be carried out by asking an administrator to do it for them.
 *
 * Written in the first person, which is why it is not the admin panel with a
 * different person passed in: that one says "their approvals", "Approving for
 * Priya until", "Nobody selected". Recycling it here would have produced a
 * screen that talks about you in the third person while you are looking at it.
 *
 * One delegation at a time, as the server enforces: two overlapping would make
 * "who may sign for me on Tuesday" a question with two answers.
 */

/** Today, as the date input spells it. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function fullName(person: { firstName: string; lastName: string }): string {
  return `${person.firstName} ${person.lastName}`
}

/** One line of "whose approvals you hold, and for how long". */
function coveringUntil(one: Delegation): string {
  return one.endsAt
    ? `${fullName(one.delegator)}, until ${formatDisplayDate(one.endsAt)}.`
    : `${fullName(one.delegator)}, until they end it.`
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader
        icon={UserCog}
        title="Out of office"
        hint="Hand your approvals to a colleague while you are away."
      />
      <div className="space-y-3.5 p-3.5 sm:p-4">{children}</div>
    </Card>
  )
}

export default function OutOfOfficeCard() {
  const { user } = useCurrentUser()
  const { count: waiting } = usePendingApprovalCount()

  const [lists, setLists] = useState<DelegationLists | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const [delegate, setDelegate] = useState<AssignableUser | null>(null)
  const [endsAt, setEndsAt] = useState('')
  const [memoTypes, setMemoTypes] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /* The house pattern: a promise chain with a cancelled flag, and a retry as a
     counter in the dependency array rather than a second code path. */
  useEffect(() => {
    let cancelled = false

    fetchDelegations()
      .then(result => {
        if (!cancelled) {
          setLists(result)
          setLoadError(null)
        }
      })
      .catch((problem: unknown) => {
        if (!cancelled) {
          setLoadError(
            problem instanceof Error
              ? problem.message
              : 'Could not read your delegation.'
          )
        }
      })

    return () => {
      cancelled = true
    }
  }, [attempt])

  const reload = () => setAttempt(n => n + 1)

  if (loadError) {
    return (
      <Shell>
        <p role="alert" className="field-error">
          {loadError}
        </p>
        <Button variant="secondary" onClick={reload}>
          Try again
        </Button>
      </Shell>
    )
  }

  if (!lists) {
    return (
      <Shell>
        <p className="text-meta text-content-subtle">Reading your delegation…</p>
      </Shell>
    )
  }

  const given: Delegation | null = lists.given.find(one => one.isActive) ?? null
  const held = lists.held.filter(one => one.isActive)
  const covering = coverStillRunning(lists.held)
  /* The cover stands where the form would have been, so it is not also
     repeated underneath it. */
  const showingCover = !given && covering.length > 0
  const endsAtIsPast = endsAt !== '' && endsAt < todayIso()

  const start = async () => {
    if (!delegate || endsAtIsPast) return

    setSaving(true)
    setError(null)

    try {
      const saved = await createDelegation({
        delegateId: delegate.id,
        endsAt: endsAt || null,
        ...(memoTypes.length > 0 ? { memoTypes } : {}),
      })
      setLists({ ...lists, given: [saved, ...lists.given] })
      setDelegate(null)
      setEndsAt('')
      setMemoTypes([])
    } catch (problem) {
      setError(
        problem instanceof Error ? problem.message : 'Could not start the delegation.'
      )
    } finally {
      setSaving(false)
    }
  }

  const end = async () => {
    if (!given) return

    setSaving(true)
    setError(null)

    try {
      const ended = await revokeDelegation(given.id)
      setLists({
        ...lists,
        given: lists.given.map(one => (one.id === ended.id ? ended : one)),
      })
    } catch (problem) {
      setError(
        problem instanceof Error ? problem.message : 'Could not end the delegation.'
      )
    } finally {
      setSaving(false)
    }
  }

  /* Whoever is covering for you is not a candidate to cover for you, and
     neither are you: the server refuses both, so neither is offered. */
  const excludeIds = new Set<string>([user?.id, given?.delegateId].filter(Boolean) as string[])

  return (
    <Shell>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}

      {given ? (
        <>
          <div>
            <Eyebrow as="h3">In force</Eyebrow>
            <p className="mt-1.5 flex items-center gap-2">
              <Avatar
                firstName={given.delegate.firstName}
                lastName={given.delegate.lastName}
                size="xs"
                tone="info"
              />
              <span className="min-w-0 truncate text-ui text-content">
                {fullName(given.delegate)}
              </span>
            </p>
            <p className="mt-1.5 text-meta leading-relaxed text-content-muted">
              {given.endsAt
                ? `Your approvals are going to ${given.delegate.firstName} until ${formatDisplayDate(given.endsAt)}.`
                : `Your approvals are going to ${given.delegate.firstName} until you end this.`}
            </p>
            {/* What that means for the work sitting on your desk right now,
                which is the thing somebody about to leave for the airport
                actually wants to know. */}
            <p className="mt-1.5 text-meta leading-relaxed text-content-subtle">
              {waiting === 0
                ? 'Nothing is waiting on you at the moment.'
                : `${waiting} ${waiting === 1 ? 'approval' : 'approvals'} waiting on you can be signed by ${given.delegate.firstName}.`}
            </p>
          </div>

          <Button variant="secondary" onClick={end} pending={saving}>
            End delegation
          </Button>

          <p className="text-meta leading-relaxed text-content-subtle">
            You keep your own authority throughout — being out of office is a
            diary entry, not a lock. Approvals already given under it stand:
            they were authorised when they were given, and the record says so.
          </p>
        </>
      ) : showingCover ? (
        /* The same heading the card carries at its foot when there is a form
           above it, because it is the same fact - stated once, where the form
           would have been, so the card does not say it twice running. */
        <div>
          <Eyebrow as="h3">You are covering for</Eyebrow>
          <ul className="mt-1.5 space-y-1">
            {covering.map(one => (
              <li key={one.id} className="text-meta leading-relaxed text-content-muted">
                {coveringUntil(one)}
              </li>
            ))}
          </ul>
          <p className="mt-2.5 text-meta leading-relaxed text-content-muted">
            Your own approvals cannot be handed on while you are covering: their
            steps stay addressed to you, so whoever took yours could neither
            sign them nor know they were waiting.
          </p>
          {/* Never "end it yourself": a delegation is ended by the person who
              gave it or by an administrator, and the one covering is neither.
              Telling somebody to do what the server will refuse them is the
              same defect as offering the form. */}
          <p className="mt-1.5 text-meta leading-relaxed text-content-subtle">
            {covering.length === 1
              ? `${covering[0].delegator.firstName} can end that cover, or an administrator can move it to somebody else. Then this is yours to arrange.`
              : 'Each of them can end their cover, or an administrator can move it to somebody else. Then this is yours to arrange.'}
          </p>
        </div>
      ) : (
        <>
          <div>
            <label htmlFor="out-of-office-delegate" className="field-label">
              Hand my approvals to
            </label>
            <ApproverCombobox
              id="out-of-office-delegate"
              value={delegate?.id ?? ''}
              selected={delegate}
              takenIds={new Set<string>()}
              excludeIds={excludeIds}
              onChange={setDelegate}
              onResolved={setDelegate}
            />
          </div>

          <div>
            <label htmlFor="out-of-office-until" className="field-label">
              Until
            </label>
            <input
              id="out-of-office-until"
              type="date"
              value={endsAt}
              min={todayIso()}
              max={latestDelegationEnd()}
              onChange={event => setEndsAt(event.target.value)}
              aria-invalid={endsAtIsPast || undefined}
              aria-describedby={
                endsAtIsPast ? 'out-of-office-until-error' : 'out-of-office-until-hint'
              }
              className="field h-8.5"
            />
            {endsAtIsPast ? (
              <p id="out-of-office-until-error" className="field-error">
                That date has already passed, so the delegation would never
                apply. Pick today or later.
              </p>
            ) : (
              <p id="out-of-office-until-hint" className="mt-1 text-meta text-content-subtle">
                At most {MAX_DELEGATION_DAYS} days. Left empty, it runs the full{' '}
                {MAX_DELEGATION_DAYS} days unless you end it sooner.
              </p>
            )}
          </div>

          <MemoScopeField value={memoTypes} onChange={setMemoTypes} />

          <Button
            onClick={start}
            pending={saving}
            disabled={!delegate || endsAtIsPast}
          >
            Start delegation
          </Button>

          <p className="text-meta leading-relaxed text-content-subtle">
            While it is in force they can act on the steps assigned to you, and
            every approval they give records both names — on the memo, in the
            ledger and in the notice everybody receives.
          </p>
        </>
      )}

      {held.length > 0 && !showingCover && (
        <div className="border-t border-line-soft pt-3.5">
          <Eyebrow as="h3">You are covering for</Eyebrow>
          <ul className="mt-1.5 space-y-1">
            {held.map(one => (
              <li key={one.id} className="text-meta leading-relaxed text-content-muted">
                {coveringUntil(one)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Shell>
  )
}
