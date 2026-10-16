import type { ButtonHTMLAttributes, ComponentType, ReactNode } from 'react'

/**
 * Section accents. Components pick a role, not a colour, so a palette
 * change stays a single edit in index.css.
 */
const TONES = {
  accent: 'bg-accent-soft text-accent-ink',
  info: 'bg-info-soft text-info-ink',
  warning: 'bg-warning-soft text-warning-ink',
  danger: 'bg-danger-soft text-danger-ink',
  revision: 'bg-revision-soft text-revision-ink',
  neutral: 'bg-neutral-soft text-content-muted',
} as const

export type Tone = keyof typeof TONES

/**
 * The 2px rule across the top of an accented card — the KPI tiles on the
 * documents screen. It replaces the coloured LEFT border the old Card
 * used: a top rule reads as a category marker on a tile in a row, where a
 * left rule reads as a quote or an alert.
 */
const TOP_RULES: Record<Tone, string> = {
  accent: 'border-t-2 border-t-accent-mark',
  info: 'border-t-2 border-t-info-mark',
  warning: 'border-t-2 border-t-warning-mark',
  danger: 'border-t-2 border-t-danger-mark',
  revision: 'border-t-2 border-t-revision-mark',
  neutral: 'border-t-2 border-t-neutral-mark',
}

export function Card({
  children,
  className = '',
  accent,
}: {
  children: ReactNode
  className?: string
  /** Draws the 2px category rule across the top of the card. */
  accent?: Tone
}) {
  return (
    <section
      className={`card overflow-hidden ${accent ? TOP_RULES[accent] : ''} ${className}`}
    >
      {children}
    </section>
  )
}

/**
 * The icon-tile + title + hint bar that sits at the top of a panel. Written
 * inline on nearly every screen before this, with the tile size and padding
 * drifting between them.
 */
export function CardHeader({
  icon: Icon,
  tone = 'accent',
  title,
  hint,
  meta,
  actions,
}: {
  icon?: ComponentType<{ size?: number; className?: string }>
  tone?: Tone
  title: string
  hint?: string
  /** A mono value pushed to the right of the title — counts, elapsed time. */
  meta?: string
  actions?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line-soft px-3.5 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        {Icon && (
          <span
            aria-hidden="true"
            className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-control ${TONES[tone]}`}
          >
            <Icon size={15} />
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-section font-semibold text-content">{title}</h2>
          {hint && <p className="mt-0.5 text-meta text-content-subtle">{hint}</p>}
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        {meta && (
          <span className="font-mono text-data uppercase tracking-wide text-content-subtle">
            {meta}
          </span>
        )}
        {actions}
      </div>
    </div>
  )
}

const BADGE_TONES: Record<Tone, string> = {
  accent: 'bg-accent-soft text-accent-ink border-accent-line',
  info: 'bg-info-soft text-info-ink border-info-line',
  warning: 'bg-warning-soft text-warning-ink border-warning-line',
  danger: 'bg-danger-soft text-danger-ink border-danger-line',
  revision: 'bg-revision-soft text-revision-ink border-revision-line',
  neutral: 'bg-neutral-soft text-content-muted border-neutral-line',
}

const BADGE_DOTS: Record<Tone, string> = {
  accent: 'bg-accent-mark',
  info: 'bg-info-mark',
  warning: 'bg-warning-mark',
  danger: 'bg-danger-mark',
  revision: 'bg-revision-mark',
  neutral: 'bg-neutral-mark',
}

/**
 * A count or label pill. Around thirty of these were written by hand with
 * slightly different padding and radii. `StatusBadge` stays separate — it
 * maps document status values and carries its own dot.
 */
export function Badge({
  tone = 'neutral',
  dot = false,
  children,
  className = '',
}: {
  tone?: Tone
  /** Leading dot in the solid semantic colour. */
  dot?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-pill border px-2 py-0.5 text-2xs font-medium ${BADGE_TONES[tone]} ${className}`}
    >
      {dot && (
        <span
          aria-hidden="true"
          className={`h-1.25 w-1.25 flex-shrink-0 rounded-pill ${BADGE_DOTS[tone]}`}
        />
      )}
      {children}
    </span>
  )
}

type ChipProps = {
  active?: boolean
  /** Renders the trailing dismiss X. Filter chips that can be removed. */
  onDismiss?: () => void
  dismissLabel?: string
  children: ReactNode
  className?: string
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'>

/**
 * The filter chip on the documents and queue toolbars. Taller and quieter
 * than a Badge, and interactive: a chip is something you press, a badge is
 * something you read. The label is a real button so it is reachable by Tab
 * and announces its own pressed state; the dismiss X is a second button
 * beside it rather than nested inside, which would be invalid.
 */
export function Chip({
  active = false,
  onDismiss,
  dismissLabel,
  children,
  className = '',
  ...props
}: ChipProps) {
  return (
    <span
      className={`inline-flex h-7 items-center rounded-pill border text-meta font-medium transition-colors ${
        active
          ? 'border-accent-line bg-accent-soft text-accent-ink'
          : 'border-transparent bg-sunken text-content-muted hover:bg-line'
      } ${onDismiss ? 'pr-1' : ''} ${className}`}
    >
      <button
        {...props}
        type="button"
        aria-pressed={active}
        className="inline-flex h-7 items-center rounded-pill px-3"
      >
        {children}
      </button>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel ?? 'Remove filter'}
          className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-pill hover:bg-accent-line/60"
        >
          <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
            <path
              d="M3 3l10 10M13 3L3 13"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </span>
  )
}

const AVATAR_TONES = {
  neutral: 'bg-sunken text-content-muted',
  /* the signed-in user, deliberately louder than the tinted list avatars */
  accentSolid: 'bg-accent text-on-accent',
  accent: 'bg-accent-soft text-accent-ink',
  info: 'bg-info-soft text-info-ink',
  success: 'bg-success-soft text-success-ink',
} as const

/** 22 / 26 / 28 / 30px, with the type stepping 10 / 10.5 / 10.5 / 11px. */
const AVATAR_SIZES = {
  xs: 'h-5.5 w-5.5 text-eyebrow',
  sm: 'h-6.5 w-6.5 text-data',
  md: 'h-7 w-7 text-data',
  lg: 'h-7.5 w-7.5 text-2xs',
} as const

const PRESENCE_TONES = {
  available: 'bg-accent-mark',
  away: 'bg-warning-mark',
  deactivated: 'bg-line-strong',
} as const

const PRESENCE_RINGS = {
  surface: 'border-surface',
  shell: 'border-shell',
  sunken: 'border-sunken',
} as const

/**
 * Initials circle. Four screens each had their own — 6px, 7px and 8px
 * variants with three different greys, one of them missing `aria-hidden`
 * so the initials were read out next to the name they abbreviate.
 * Takes either a ready-made `initials` string (the list APIs return one)
 * or a first/last name to derive it from.
 *
 * `presence` draws the status ring. It is `aria-hidden` like the initials:
 * availability is never carried by the dot alone — the row beside it spells
 * out "Available" or "Away until 26 Aug".
 */
export function Avatar({
  initials,
  firstName,
  lastName,
  size = 'md',
  tone = 'neutral',
  presence,
  presenceRing = 'surface',
}: {
  initials?: string
  firstName?: string
  lastName?: string
  size?: keyof typeof AVATAR_SIZES
  tone?: keyof typeof AVATAR_TONES
  presence?: keyof typeof PRESENCE_TONES
  /** The colour the ring cuts out of — whatever sits behind the avatar. */
  presenceRing?: keyof typeof PRESENCE_RINGS
}) {
  const text =
    initials?.trim() ||
    `${firstName?.trim().charAt(0) ?? ''}${lastName?.trim().charAt(0) ?? ''}`.toUpperCase() ||
    '?'

  const disc = (
    <span
      aria-hidden="true"
      className={`flex flex-shrink-0 items-center justify-center rounded-pill font-semibold ${AVATAR_SIZES[size]} ${AVATAR_TONES[tone]}`}
    >
      {text}
    </span>
  )

  if (!presence) return disc

  return (
    <span className="relative inline-flex flex-shrink-0">
      {disc}
      <span
        aria-hidden="true"
        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-pill border-2 ${PRESENCE_RINGS[presenceRing]} ${PRESENCE_TONES[presence]}`}
      />
    </span>
  )
}
