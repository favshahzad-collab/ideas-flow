import { useId } from 'react'

/**
 * A 38x22 toggle for a single binary setting — "Out of office" on the
 * delegation panel.
 *
 * A real `role="switch"` button, not a restyled checkbox and certainly not a
 * clickable div: it is reachable by Tab, Space and Enter activate it, and
 * `aria-checked` means a screen reader says "on"/"off" rather than reading
 * the track as decoration. The visible label is wired through
 * `aria-labelledby` so the two can never drift apart.
 */
export default function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  title,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  /** A second line under the label. */
  hint?: string
  disabled?: boolean
  /** Say why, whenever `disabled` is set. */
  title?: string
}) {
  const labelId = useId()
  const hintId = useId()

  return (
    <div className="flex items-start justify-between gap-3">
      <span className="min-w-0">
        <span id={labelId} className="block text-ui font-medium text-content">
          {label}
        </span>
        {hint && (
          <span id={hintId} className="mt-0.5 block text-meta text-content-subtle">
            {hint}
          </span>
        )}
      </span>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        /*
         * Both of these were on the wrapping div, where neither reached the
         * control. The hint is the only place the consequence is spelled out
         * - "documents assigned to you go to your delegate instead" - and a
         * screen reader announced "Out of office, switch, off" and stopped.
         * And `title` explains why the switch cannot be pressed, which was
         * offered as a hover to people who, being on a keyboard, never hover.
         */
        aria-describedby={hint ? hintId : undefined}
        title={title}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-5.5 w-9.5 flex-shrink-0 items-center rounded-pill border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          checked ? 'border-accent bg-accent' : 'border-line-strong bg-sunken'
        }`}
      >
        <span
          aria-hidden="true"
          className={`block h-4.5 w-4.5 rounded-pill bg-surface transition-transform duration-150 ease-out ${
            checked ? 'translate-x-4.25' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  )
}
