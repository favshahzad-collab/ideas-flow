import type { ReactNode } from 'react'

/**
 * A rendered key — the ⌘K on the command trigger, the J / K / A / R / X in
 * the queue legend, the SLA value on a queue row.
 *
 * `<kbd>` rather than a span: it is the element that means "keyboard
 * input", and screen readers and user stylesheets both act on it.
 */
export default function Keycap({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode
  /** Queue rows colour the SLA keycap by urgency. */
  tone?: 'neutral' | 'warning' | 'danger'
  className?: string
}) {
  const tones = {
    neutral: 'border-line bg-surface text-content-subtle',
    warning: 'border-warning-line bg-warning-soft text-warning-ink',
    danger: 'border-danger-line bg-danger-soft text-danger-ink',
  }

  return (
    <kbd
      className={`inline-flex items-center rounded-chip border px-1.5 py-0.5 font-mono text-data font-medium ${tones[tone]} ${className}`}
    >
      {children}
    </kbd>
  )
}
