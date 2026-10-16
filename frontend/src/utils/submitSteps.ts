import type { ReadinessCheck } from './submitDocument'

/**
 * The four steps the submit form is split into.
 *
 * It used to be one long page: title, file, supporting files and the whole
 * approval chain stacked in a single scroll. Routing is where submissions go
 * wrong — the wrong approver, the wrong order, a missing final approver — and
 * it was the last thing on the page, competing with four other cards for
 * attention. Giving it a step of its own is the point of the split.
 *
 * Navigation between steps is free in both directions. Nothing is gated: a
 * preparer who wants to attach the PDF before typing the title should not be
 * argued with, and the submit button already refuses on the same rules it
 * always did.
 */

export type SubmitStepId = 'details' | 'file' | 'routing' | 'sign'

export interface SubmitStepDef {
  id: SubmitStepId
  label: string
  /** Announced when the step becomes current. */
  hint: string
}

export const SUBMIT_STEPS: SubmitStepDef[] = [
  { id: 'details', label: 'Details', hint: 'Title and description' },
  { id: 'file', label: 'File', hint: 'The PDF and any supporting files' },
  { id: 'routing', label: 'Routing', hint: 'Who approves it, and in what order' },
  { id: 'sign', label: 'Sign', hint: 'Review, sign and submit' },
]

export const SUBMIT_STEP_IDS = SUBMIT_STEPS.map(step => step.id)

/**
 * Which step a readiness check belongs to. Anything unrecognised counts as
 * routing: the routing checks vary with the mode (a template contributes
 * different ids from a hand-built chain), so an allow-list of the routing
 * ones would silently drop a new check instead of surfacing it.
 */
const STEP_FOR_CHECK: Record<string, SubmitStepId> = {
  title: 'details',
  file: 'file',
}

export function stepForCheck(checkId: string): SubmitStepId {
  return STEP_FOR_CHECK[checkId] ?? 'routing'
}

export type SubmitStepState = 'complete' | 'current' | 'upcoming' | 'problem'

/**
 * The state of every node in the stepper.
 *
 * `problem` only appears once the preparer has tried to submit. Marking a
 * step red the moment the form opens would flag all four before anything has
 * been typed, which reads as broken rather than as guidance.
 */
export function getStepStates(
  current: SubmitStepId,
  checks: ReadinessCheck[],
  attempted: boolean,
): Record<SubmitStepId, SubmitStepState> {
  const outstandingByStep = new Map<SubmitStepId, number>()
  for (const check of checks) {
    if (check.done) continue
    const step = stepForCheck(check.id)
    outstandingByStep.set(step, (outstandingByStep.get(step) ?? 0) + 1)
  }

  const allDone = checks.every(check => check.done)

  const states = {} as Record<SubmitStepId, SubmitStepState>
  for (const { id } of SUBMIT_STEPS) {
    const outstanding = id === 'sign' ? (allDone ? 0 : 1) : (outstandingByStep.get(id) ?? 0)

    if (id === current) {
      states[id] = 'current'
    } else if (outstanding === 0) {
      states[id] = 'complete'
    } else if (attempted) {
      states[id] = 'problem'
    } else {
      states[id] = 'upcoming'
    }
  }

  return states
}

/** Outstanding checks for one step, for the stepper's tooltip and count. */
export function outstandingForStep(
  step: SubmitStepId,
  checks: ReadinessCheck[],
): ReadinessCheck[] {
  if (step === 'sign') return checks.filter(check => !check.done)
  return checks.filter(check => !check.done && stepForCheck(check.id) === step)
}

/** The first step with something outstanding — where "fix it" should land. */
export function firstIncompleteStep(checks: ReadinessCheck[]): SubmitStepId {
  for (const { id } of SUBMIT_STEPS) {
    if (id === 'sign') continue
    if (outstandingForStep(id, checks).length > 0) return id
  }
  return 'sign'
}

export function nextStep(current: SubmitStepId): SubmitStepId | null {
  const index = SUBMIT_STEP_IDS.indexOf(current)
  return index < SUBMIT_STEP_IDS.length - 1 ? SUBMIT_STEP_IDS[index + 1] : null
}

export function previousStep(current: SubmitStepId): SubmitStepId | null {
  const index = SUBMIT_STEP_IDS.indexOf(current)
  return index > 0 ? SUBMIT_STEP_IDS[index - 1] : null
}

/** "STEP 3 OF 4 · ROUTING" — the page eyebrow. */
export function stepEyebrow(current: SubmitStepId): string {
  const index = SUBMIT_STEP_IDS.indexOf(current)
  const def = SUBMIT_STEPS[index]
  return `Step ${index + 1} of ${SUBMIT_STEPS.length} · ${def.label}`
}

/**
 * Moves an item within a list. Used by the chain builder's drag-to-reorder,
 * which needs to move a row to an arbitrary index rather than one place at a
 * time the way the arrow buttons do.
 */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to) return items
  if (from < 0 || from >= items.length) return items

  const clamped = Math.max(0, Math.min(items.length - 1, to))
  if (from === clamped) return items

  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(clamped, 0, moved)
  return next
}

/**
 * How a memo comes to exist.
 *
 * `upload` is the path this form has always had: somebody writes the memo in
 * Word, exports a PDF and attaches it. `typed` is the memo written here, which
 * the server draws from the template.
 *
 * The steps are the same four either way - what changes is what step two is
 * for, so a preparer switching between them is not learning a second form.
 */
export type AuthoringMode = 'upload' | 'typed'

const TYPED_STEP_COPY: Partial<Record<SubmitStepId, { label: string; hint: string }>> = {
  file: { label: 'Write', hint: 'The memo itself, and who it is to' },
}

export function stepCopy(
  step: SubmitStepDef,
  authoring: AuthoringMode,
): { label: string; hint: string } {
  if (authoring === 'typed') {
    const typed = TYPED_STEP_COPY[step.id]
    if (typed) return typed
  }
  return { label: step.label, hint: step.hint }
}

/** "STEP 2 OF 4 · WRITE" — the page eyebrow, in the mode being used. */
export function stepEyebrowFor(
  current: SubmitStepId,
  authoring: AuthoringMode,
): string {
  const index = SUBMIT_STEP_IDS.indexOf(current)
  const def = SUBMIT_STEPS[index]
  return `Step ${index + 1} of ${SUBMIT_STEPS.length} · ${stepCopy(def, authoring).label}`
}
