import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Card, CardHeader } from '../ui/Card'
import Button from '../ui/Button'
import Eyebrow from '../ui/Eyebrow'
import { fetchMemosHeldBy } from '../../services/holdsApi'
import type { HeldMemo, MemosHeld } from '../../types/holds'
import type { User } from '../../types/admin'
import { formatMemoReference, formatWaitingShort } from '../../utils/format'

/**
 * What stops if this person does.
 *
 * The question an administrator has when somebody resigns, goes on long leave
 * or changes job - and the one the product could not answer. Every screen was
 * organised by memo: open a memo, see who is holding it. Nothing was organised
 * by person, so "Kazim leaves on Friday, what breaks?" could only be answered
 * by opening every memo in flight and reading its chain. In practice it was
 * answered by waiting: the memo travelled to somebody who could not act,
 * stopped, and turned up as a red row a week later.
 *
 * The four groups are kept apart because they are four different problems,
 * not four shades of one:
 *
 *   - with them now. Already stopped; move it today.
 *   - ahead of the memo. Not stopped yet and it will be, which is the whole
 *     reason for asking in advance.
 *   - sent back to them. This one has no cure in reassignment - only the
 *     preparer may correct a memo, and the server refuses anybody else - so
 *     the panel says so rather than implying a button that cannot help.
 *   - sent back to somebody else, with their step on its chain. A memo that
 *     is resubmitted starts again at step one over the same chain, so it
 *     reaches everybody named on it a second time. The panel showed none of
 *     these and said "nothing is waiting on them" over the top, which is the
 *     one answer an administrator acts on without checking.
 */

function Row({
  memo,
  showSteps,
  personId,
  when,
}: {
  memo: HeldMemo
  showSteps: boolean
  /** Whose panel this is, so their own name is not read back to them. */
  personId: string
  /**
   * What to say in place of the distance or the wait. A memo that is not in
   * flight has neither: nothing is counting down against it and nobody is
   * waiting on this person for it yet.
   */
  when?: string
}) {
  return (
    <li className="border-t border-line-soft py-2 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-2">
        <a
          href={`/documents/${memo.documentId}`}
          className="min-w-0 truncate text-meta font-medium text-content transition-colors hover:text-accent-ink"
          title={memo.title}
        >
          {memo.title}
        </a>
        <span className="flex-shrink-0 font-mono text-eyebrow text-content-subtle tabular-nums">
          {formatMemoReference(memo.referenceNumber, memo.documentId)}
        </span>
      </div>
      <p className="mt-0.5 text-2xs text-content-subtle">
        {showSteps && memo.stepOrder !== null
          ? `Step ${memo.stepOrder}${memo.totalSteps ? ` of ${memo.totalSteps}` : ''} · `
          : ''}
        {/* What the reader does with the number differs by group: "how long
            has this been stuck" for one, "how far off is it" for the other,
            and for a memo not in flight, neither. */}
        {when
          ? when
          : memo.stepsAway > 0
            ? `${memo.stepsAway} ${memo.stepsAway === 1 ? 'approval' : 'approvals'} away`
            : memo.heldSince
              ? `waiting ${formatWaitingShort(memo.heldSince)}`
              : 'waiting'}
        {/* Who is waiting for it - unless that is the person whose panel
            this is, which is the case for every memo sent back: "waiting 2m
            · Sadia Rehman" on Sadia's own card says nothing. */}
        {memo.preparer.id === personId
          ? ''
          : ` · ${memo.preparer.firstName} ${memo.preparer.lastName}`}
      </p>
    </li>
  )
}

function Group({
  label,
  hint,
  memos,
  personId,
  showSteps = true,
  when,
}: {
  label: string
  hint: string
  memos: HeldMemo[]
  personId: string
  showSteps?: boolean
  when?: string
}) {
  if (memos.length === 0) return null

  return (
    <div>
      <Eyebrow as="h3">
        {label} ({memos.length})
      </Eyebrow>
      <p className="mt-1 text-2xs leading-relaxed text-content-subtle">{hint}</p>
      <ul className="mt-2">
        {memos.map(memo => (
          <Row
            key={`${memo.documentId}-${memo.stepOrder ?? 'r'}`}
            memo={memo}
            showSteps={showSteps}
            personId={personId}
            when={when}
          />
        ))}
      </ul>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader
        icon={AlertTriangle}
        tone="warning"
        title="What stops if they go"
        hint="Memos that wait on this person, now or further down a chain."
      />
      <div className="space-y-3.5 p-3.5">{children}</div>
    </Card>
  )
}

export default function HoldsPanel({ person }: { person: User | null }) {
  const personId = person?.id ?? null
  const [attempt, setAttempt] = useState(0)

  /*
   * Key-stamped rather than cleared in an effect. The answer belongs to one
   * person, and an answer for the previous person left on screen under the
   * next person's name is the most misleading state this panel can be in -
   * so what is on screen is only ever read when its key still matches.
   */
  const key = `${personId ?? ''}:${attempt}`
  const [loaded, setLoaded] = useState<{
    key: string
    data: MemosHeld | null
    error: string | null
  } | null>(null)
  const current = loaded?.key === key ? loaded : null

  useEffect(() => {
    if (!personId) return

    let cancelled = false

    fetchMemosHeldBy(personId)
      .then(data => {
        if (!cancelled) setLoaded({ key, data, error: null })
      })
      .catch((problem: unknown) => {
        if (!cancelled) {
          setLoaded({
            key,
            data: null,
            error:
              problem instanceof Error
                ? problem.message
                : 'Could not find out what is waiting on them.',
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [key, personId])

  if (!person) return null

  if (current?.error) {
    return (
      <Shell>
        <p role="alert" className="field-error">
          {current.error}
        </p>
        <Button variant="secondary" onClick={() => setAttempt(n => n + 1)}>
          Try again
        </Button>
      </Shell>
    )
  }

  if (!current?.data) {
    return (
      <Shell>
        <p className="text-meta text-content-subtle">
          Reading what is waiting on {person.firstName}…
        </p>
      </Shell>
    )
  }

  const held = current.data

  if (held.total === 0) {
    return (
      <Shell>
        <p className="text-meta leading-relaxed text-content-muted">
          Nothing is waiting on {person.firstName}. No memo in flight has a step
          assigned to them, none has been sent back to them for revision, and no
          memo out for correction will come back to a step of theirs.
        </p>
      </Shell>
    )
  }

  return (
    <Shell>
      <Group
        label="With them now"
        hint="Already stopped. Reassign the step to move it today."
        memos={held.holdingNow}
        personId={held.person.id}
      />
      <Group
        label="Coming to them"
        hint="Not stopped yet. Move these before the memo arrives and it never stops at all."
        memos={held.ahead}
        personId={held.person.id}
      />
      <Group
        label="Sent back to them"
        hint="Only the preparer can correct a memo, so reassigning an approver does not help here. Somebody has to do the revision."
        memos={held.returned}
        personId={held.person.id}
        showSteps={false}
      />
      <Group
        label="Coming back to them"
        hint="Out for correction. A resubmitted memo starts again at step one, so it reaches every approver on the approval chain a second time. These cannot be moved until the preparer sends it back in."
        memos={held.comingBack}
        personId={held.person.id}
        when="when it is resubmitted"
      />
    </Shell>
  )
}
