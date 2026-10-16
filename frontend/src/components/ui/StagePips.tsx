import type { Tone } from './Card'

const PIP_TONES: Record<Tone, string> = {
  accent: 'bg-accent-mark',
  info: 'bg-info-mark',
  warning: 'bg-warning-mark',
  danger: 'bg-danger-mark',
  revision: 'bg-revision-mark',
  neutral: 'bg-neutral-mark',
}

/**
 * One 14x4px pip per workflow step, filled in the status colour up to the
 * current step, followed by `n/total` in mono.
 *
 * The pips are decorative — the `n/total` beside them states the same
 * thing, so the row is announced once, as "Step 2 of 4", rather than as a
 * run of empty spans.
 */
export default function StagePips({
  current,
  total,
  tone = 'accent',
  active = false,
  className = '',
}: {
  /** 1-based index of the step the document is sitting at. */
  current: number
  total: number
  tone?: Tone
  /**
   * Still waiting on somebody. The step it is sitting at then breathes, so a
   * glance down a list tells live work from closed work without reading the
   * status - finished, rejected and withdrawn memos sit still.
   */
  active?: boolean
  className?: string
}) {
  const steps = Math.max(0, total)
  const filled = Math.max(0, Math.min(steps, current))
  // The step being worked: the last one reached, or the first if none is.
  const working = active && steps > 0 ? Math.max(0, filled - 1) : -1

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span aria-hidden="true" className="inline-flex items-center gap-0.75">
        {Array.from({ length: steps }, (_, i) => (
          <span
            key={i}
            className={`h-1 rounded-pill ${
              i === working
                ? // Longer, as well as breathing: the step being worked reads
                  // as "here" even in a still frame or with motion turned off.
                  `w-5 ${PIP_TONES[tone]} progress-pending`
                : 'w-3.5'
            } ${
              i === working
                ? ''
                : i < filled
                  ? PIP_TONES[tone]
                  : 'bg-line'
            }`}
          />
        ))}
      </span>
      <span className="font-mono text-data tabular-nums text-content-subtle">
        <span className="sr-only">Step </span>
        {filled}
        <span aria-hidden="true">/</span>
        <span className="sr-only"> of </span>
        {steps}
      </span>
    </span>
  )
}
