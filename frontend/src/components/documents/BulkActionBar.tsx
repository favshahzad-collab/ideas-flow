import { Check } from 'lucide-react'

/**
 * Appears as the first row inside the table card once anything is selected.
 *
 * The three actions are present and disabled. None of them has an endpoint,
 * and "Approve all" cannot have a straightforward one: `approveDocument`
 * requires a signature placed on the rendered PDF, so approving in bulk would
 * mean either signing documents nobody looked at or inventing a second,
 * unsigned approval path. Both are worse than a disabled button that says
 * what it is waiting for. `Clear` works, because clearing is client state.
 */
const PENDING_ACTIONS = [
  { key: 'approve', label: 'Approve all', reason: 'Needs a bulk approval endpoint. Each approval currently requires a signature placed on the document.' },
  { key: 'reassign', label: 'Reassign', reason: 'Needs a reassignment endpoint.' },
  { key: 'nudge', label: 'Nudge holder', reason: 'Needs a reminder endpoint.' },
] as const

export default function BulkActionBar({
  count,
  onClear,
}: {
  count: number
  onClear: () => void
}) {
  return (
    <div
      // Announced when it appears, because it is a mode change: what the
      // buttons below now act on has changed.
      role="status"
      className="flex flex-wrap items-center gap-2 bg-accent px-3.5 py-2 text-on-accent"
    >
      <Check size={15} aria-hidden="true" className="flex-shrink-0" />
      <span className="text-ui font-semibold tabular-nums">
        {count} selected
      </span>

      <span aria-hidden="true" className="mx-1 h-4 w-px bg-white/30" />

      {PENDING_ACTIONS.map(action => (
        <button
          key={action.key}
          type="button"
          disabled
          title={action.reason}
          className="inline-flex h-6.5 items-center rounded-pill bg-white/15 px-2.5 text-2xs font-medium text-on-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          {action.label}
        </button>
      ))}

      <span className="ml-auto">
        <button
          type="button"
          onClick={onClear}
          className="inline-flex h-6.5 items-center rounded-pill px-2.5 text-2xs font-medium text-on-accent underline-offset-2 transition-colors hover:bg-white/15 hover:underline"
        >
          Clear
        </button>
      </span>
    </div>
  )
}
