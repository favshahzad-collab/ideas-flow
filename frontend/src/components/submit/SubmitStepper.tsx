import { AlertCircle, Check } from 'lucide-react'
import type { ReadinessCheck } from '../../utils/submitDocument'
import { PHONE_QUERY, useMediaQuery } from '../../hooks/useMediaQuery'
import {
  SUBMIT_STEPS,
  getStepStates,
  outstandingForStep,
  stepCopy,
  type AuthoringMode,
  type SubmitStepId,
  type SubmitStepState,
} from '../../utils/submitSteps'

/**
 * Four nodes joined by rules.
 *
 * Every node is a real button, so the whole form stays reachable in any order
 * — a preparer who has to go back and fix the title should not have to click
 * "Back" three times. State is never carried by colour alone: complete shows a
 * tick, a problem shows an alert glyph, and both spell the state out in the
 * accessible name.
 */

const NODE: Record<SubmitStepState, string> = {
  complete: 'bg-accent-soft text-accent-ink border-accent-line',
  current: 'bg-accent text-on-accent border-accent',
  upcoming: 'bg-sunken text-content-subtle border-line',
  problem: 'bg-danger-soft text-danger-ink border-danger-line',
}

const LABEL: Record<SubmitStepState, string> = {
  complete: 'text-content-muted',
  current: 'font-semibold text-content',
  upcoming: 'text-content-subtle',
  problem: 'font-medium text-danger-ink',
}

/** The rule that trails each node, coloured by what has been finished. */
const RULE: Record<SubmitStepState, string> = {
  complete: 'bg-accent-mark',
  current: 'bg-accent-mark',
  upcoming: 'bg-line',
  problem: 'bg-danger-mark',
}

const SPOKEN: Record<SubmitStepState, string> = {
  complete: 'complete',
  current: 'current step',
  upcoming: 'not started',
  problem: 'needs attention',
}

export default function SubmitStepper({
  current,
  checks,
  attempted,
  authoring = 'upload',
  onSelect,
}: {
  current: SubmitStepId
  checks: ReadinessCheck[]
  /** Only after a submit attempt does an unfinished step turn red. */
  attempted: boolean
  /** Step two is "File" when attaching one and "Write" when typing it. */
  authoring?: AuthoringMode
  onSelect: (step: SubmitStepId) => void
}) {
  const states = getStepStates(current, checks, attempted)
  const isPhone = useMediaQuery(PHONE_QUERY)

  return (
    <nav aria-label="Submission steps" className="mb-5 sm:mb-5.5">
      {/*
        * A phone: a bar of four segments. The row of four labelled nodes did
        * not fit - the fourth was cut off at the edge with nothing saying
        * there was more. Where you are is already in words in the page's
        * eyebrow ("Step 1 of 4 · Details"). Each segment is still a button,
        * so any step is one tap away as before.
        */}
      {isPhone ? (
        <ol className="flex gap-1.5">
          {SUBMIT_STEPS.map((step, index) => {
            const state = states[step.id]
            const copy = stepCopy(step, authoring)
            return (
              <li key={step.id} className="flex-1">
                <button
                  type="button"
                  onClick={() => onSelect(step.id)}
                  aria-current={state === 'current' ? 'step' : undefined}
                  aria-label={`${copy.label} — step ${index + 1} of ${SUBMIT_STEPS.length}, ${SPOKEN[state]}`}
                  className="block w-full py-2"
                >
                  <span
                    aria-hidden="true"
                    className={`block h-1.5 rounded-pill ${
                      state === 'upcoming' ? 'bg-line' : RULE[state]
                    }`}
                  />
                </button>
              </li>
            )
          })}
        </ol>
      ) : (
      <ol className="flex items-center gap-2 overflow-x-auto pb-1 sm:gap-3">
        {SUBMIT_STEPS.map((step, index) => {
          const state = states[step.id]
          const outstanding = outstandingForStep(step.id, checks)
          const isLast = index === SUBMIT_STEPS.length - 1
          const copy = stepCopy(step, authoring)

          return (
            <li key={step.id} className="flex min-w-0 flex-shrink-0 items-center gap-2 sm:gap-3">
              <button
                type="button"
                onClick={() => onSelect(step.id)}
                aria-current={state === 'current' ? 'step' : undefined}
                title={
                  outstanding.length > 0
                    ? outstanding.map(check => check.label).join(' · ')
                    : copy.hint
                }
                className="flex items-center gap-2 rounded-control px-0.5 py-1 text-left transition-colors"
              >
                <span
                  aria-hidden="true"
                  className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-pill border font-mono text-2xs font-semibold tabular-nums ${NODE[state]}`}
                >
                  {state === 'complete' ? (
                    <Check size={13} strokeWidth={3} />
                  ) : state === 'problem' ? (
                    <AlertCircle size={13} />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className={`whitespace-nowrap text-ui ${LABEL[state]}`}>
                  {copy.label}
                </span>
                <span className="sr-only">
                  {`— step ${index + 1} of ${SUBMIT_STEPS.length}, ${SPOKEN[state]}`}
                  {outstanding.length > 0 &&
                    `, ${outstanding.length} item${outstanding.length === 1 ? '' : 's'} outstanding`}
                </span>
              </button>

              {!isLast && (
                <span
                  aria-hidden="true"
                  className={`h-0.5 w-6 flex-shrink-0 rounded-pill sm:w-10 ${RULE[state]}`}
                />
              )}
            </li>
          )
        })}
      </ol>
      )}
    </nav>
  )
}
