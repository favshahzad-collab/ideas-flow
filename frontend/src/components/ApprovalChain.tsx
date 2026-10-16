import { Check, Circle, CircleDot, Clock, SkipForward } from 'lucide-react'
import type { WorkflowStepView, WorkflowStepStatus } from '../types/documentDetail'

/**
 * The vertical approval chain, shared by the queue's right rail and the
 * document detail screen. One implementation, because these two drifted
 * apart before: the queue drew a flat list of names and the detail page drew
 * a timeline, and only one of them showed the comment an approver left.
 *
 * The node glyph is not decoration — it is what carries state to anyone who
 * cannot separate the tints. A tick, a clock, a hollow dot and a skip arrow
 * mean four different things without any colour at all.
 */
const NODES: Record<
  WorkflowStepStatus,
  { className: string; icon: typeof Check; label: string }
> = {
  completed: {
    className: 'bg-accent-soft text-accent-ink',
    icon: Check,
    label: 'Completed',
  },
  current: {
    className: 'bg-accent text-on-accent ring-3 ring-accent-mark/20',
    icon: Clock,
    label: 'Waiting on this step',
  },
  pending: {
    className: 'bg-sunken text-line-strong',
    icon: CircleDot,
    label: 'Not yet reached',
  },
  skipped: {
    className: 'bg-sunken text-content-subtle',
    icon: SkipForward,
    label: 'Skipped',
  },
}

/**
 * A step whose state this build has no word for.
 *
 * The API sends the approver's action as the step status - APPROVE, REJECT,
 * REQUEST_REVISION, SKIP - and only some of those are mapped here. An
 * unmapped one used to reach `undefined.icon` and take the whole document
 * screen down with it: a newer API, or a state added later, turning a memo
 * into a blank page. Reading as "unknown" is the worse-looking answer and by
 * far the better one.
 */
const UNKNOWN_STEP = {
  className: 'bg-neutral-soft text-content-muted',
  icon: Circle,
  label: 'Unknown',
} as const

export default function ApprovalChain({
  steps,
  className = '',
}: {
  steps: WorkflowStepView[]
  className?: string
}) {
  if (steps.length === 0) {
    return (
      <p className={`text-meta text-content-subtle ${className}`}>
        No approval chain on this document.
      </p>
    )
  }

  return (
    <ol className={className}>
      {steps.map((step, index) => {
        const node = NODES[step.status] ?? UNKNOWN_STEP
        const Icon = node.icon
        const isLast = index === steps.length - 1
        const upcoming = step.status === 'pending'

        return (
          <li key={step.id} className="flex gap-2.5">
            <div className="relative flex flex-col items-center">
              <span
                className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-pill ${node.className}`}
              >
                <Icon size={12} aria-hidden="true" />
              </span>
              {/* The connector runs from this node to the next. Completed
                  segments are tinted so the eye can see how far the document
                  has actually travelled. */}
              {!isLast && (
                <span
                  aria-hidden="true"
                  className={`w-0.5 flex-1 ${
                    step.status === 'completed' || step.status === 'skipped'
                      ? 'bg-accent-line'
                      : 'bg-line'
                  }`}
                />
              )}
            </div>

            <div className={`min-w-0 flex-1 ${isLast ? 'pb-0' : 'pb-4'}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className={`truncate text-meta font-semibold ${
                    upcoming ? 'text-content-subtle' : 'text-content'
                  }`}
                >
                  {/* An unassigned step arrives with an empty name -
                      formatFullName of a missing user trims to '' - and the
                      row then showed a role and a state with a blank where
                      the person goes. A reader could not tell an unassigned
                      step from a screen that failed to load. */}
                  {step.user.trim() || 'Not assigned'}
                </span>
                {step.date && (
                  <span className="flex-shrink-0 font-mono text-eyebrow text-content-subtle">
                    {step.date}
                  </span>
                )}
              </div>

              <p className="text-2xs text-content-subtle">
                {step.type}
                <span className="sr-only"> — {node.label}</span>
              </p>

              {step.comment && (
                <p className="mt-1.5 rounded-chip bg-canvas px-2.25 py-1.75 text-2xs leading-relaxed text-content-muted">
                  {step.comment}
                </p>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
