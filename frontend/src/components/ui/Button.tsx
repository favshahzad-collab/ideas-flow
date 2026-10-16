import { Loader2 } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'subtle'
  | 'danger'
  | 'dangerSolid'
  | 'dark'
type Size = 'sm' | 'md' | 'lg'

/**
 * No shadow on any variant. In this design borders carry the structure and
 * elevation is reserved for things that genuinely float above the page —
 * the command palette, a dialog, the document paper.
 */
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-active',
  secondary:
    'bg-surface text-content-muted border border-line hover:bg-sunken hover:text-content active:bg-line-soft',
  ghost: 'text-content-muted hover:bg-sunken hover:text-content active:bg-line-soft',
  subtle:
    'bg-accent-soft text-accent-ink border border-accent-line hover:bg-accent-line/50',
  /* The quiet destructive action — Reject on an approval, where it sits
     beside two other buttons and must not shout over the primary. */
  danger:
    'bg-surface text-danger-ink border border-danger-line hover:bg-danger-soft active:bg-danger-soft',
  /* The loud one, for a confirm dialog where the button IS the decision.
     Kept as a separate variant so an outline Reject and a solid Delete
     cannot be confused for each other. */
  dangerSolid:
    'bg-danger text-content-inverse hover:bg-danger-hover active:bg-danger-hover',
  /* Reads the same in both themes: these tokens are the fixed dark surface
     the monitoring screens use, not the theme-dependent `content`. */
  dark: 'bg-dark-surface text-dark-content hover:bg-dark-header active:bg-dark-canvas',
}

const SIZES: Record<Size, string> = {
  sm: 'h-7.5 px-2.5 text-meta gap-1.5',
  md: 'h-8.5 px-3 text-ui gap-1.75',
  lg: 'h-10 px-3.5 text-section gap-1.75',
}

const ICON_SIZE: Record<Size, number> = { sm: 14, md: 15, lg: 15 }

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  /** Shows a spinner and blocks input while a request is in flight. */
  pending?: boolean
  icon?: ReactNode
}

/**
 * The single primary-action treatment. Replaces the four different
 * greens the same button used to render in across the app.
 */
export default function Button({
  variant = 'primary',
  size = 'md',
  pending = false,
  icon,
  disabled,
  className = '',
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={`inline-flex items-center justify-center rounded-control font-medium
                  whitespace-nowrap transition-colors
                  disabled:cursor-not-allowed disabled:opacity-50
                  ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
    >
      {pending ? (
        <Loader2
          size={ICON_SIZE[size]}
          className="animate-spin flex-shrink-0"
          aria-hidden="true"
        />
      ) : (
        icon
      )}
      {children}
    </button>
  )
}
