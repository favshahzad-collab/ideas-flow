import type { ReactNode } from 'react'

/**
 * The mono kicker — "WORKSPACE · ALL DEPARTMENTS", "STEP 3 OF 4 · ROUTING",
 * "APPEND-ONLY · 17 ENTRIES", "NODES", "INSPECTOR".
 *
 * 10px is the smallest type in the system and it is only ever spent here:
 * uppercase, tracked out, in a mono face, on a string of two or three
 * words. The same 10px of lowercase sans would not be readable and is not
 * expressible anywhere else in the app.
 *
 * The colour is `content-subtle` rather than the handoff's #9CA3AF, which
 * measures 2.54:1 — an eyebrow carries real context and has to be read.
 * On the two dark monitoring screens the equivalent is
 * `dark-content-subtle`; `tone` picks between them so neither is written
 * out by hand.
 */

const TONES = {
  /** Light surfaces — the default. */
  default: 'text-content-subtle',
  /** Control room, workflow studio, the sign-in brand panel. */
  dark: 'text-dark-content-subtle',
  /** The navy sidebar rail. */
  shell: 'text-shell-label',
} as const

export default function Eyebrow({
  children,
  tone = 'default',
  className = '',
  id,
  as: Tag = 'p',
}: {
  children: ReactNode
  tone?: keyof typeof TONES
  className?: string
  id?: string
  /** `h2` where the kicker is genuinely the heading of a region. */
  as?: 'p' | 'h2' | 'h3' | 'dt' | 'span'
}) {
  return (
    <Tag
      id={id}
      className={`font-mono text-eyebrow uppercase tracking-eyebrow ${TONES[tone]} ${className}`}
    >
      {children}
    </Tag>
  )
}
