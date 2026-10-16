/**
 * The 4px track behind an SLA countdown or an approver's load.
 *
 * Accessibility: by default this is `aria-hidden`, because everywhere the
 * design uses it the same number is already rendered as text beside it
 * ("2d left", "80%"). A bar that is the SOLE carrier of a value must pass
 * `label` instead, which turns on real progressbar semantics — never leave
 * a value visible only as a length.
 */
const TONES = {
  accent: 'bg-accent-mark',
  warning: 'bg-warning-mark',
  danger: 'bg-danger-mark',
  neutral: 'bg-neutral-mark',
} as const

const WIDTHS = {
  /** 44px — the SLA column on the documents grid. */
  table: 'w-11',
  /** 40px — the queue-load column on the admin grids. */
  admin: 'w-10',
  full: 'w-full',
} as const

export default function MetaBar({
  pct,
  tone = 'accent',
  width = 'table',
  label,
  className = '',
}: {
  /** 0-100. Clamped, so an overdue value cannot overflow the track. */
  pct: number
  tone?: keyof typeof TONES
  width?: keyof typeof WIDTHS
  /** Supply only when no text nearby states the same value. */
  label?: string
  className?: string
}) {
  const value = Math.max(0, Math.min(100, Math.round(pct)))

  /* A 0% fill has no width and would vanish. The 3% floor keeps the mark
     visible at the start of a workflow, while the reported value stays
     honest for anything reading the semantics. */
  const drawn = value === 0 ? 3 : value

  const semantics = label
    ? ({
        role: 'progressbar' as const,
        'aria-valuenow': value,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-label': label,
      })
    : ({ 'aria-hidden': true } as const)

  return (
    <span
      {...semantics}
      className={`inline-block h-1 overflow-hidden rounded-pill bg-line ${WIDTHS[width]} ${className}`}
    >
      <span
        className={`block h-full rounded-pill transition-[width] duration-300 ease-out ${TONES[tone]}`}
        style={{ width: `${drawn}%` }}
      />
    </span>
  )
}
