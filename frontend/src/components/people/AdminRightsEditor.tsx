import { useId } from 'react'
import type { AccessControlMatrix } from '../../services/AdminApi'

/**
 * What one limited administrator may do, chosen power by power.
 *
 * An area with a screen behind it - people, workflows, the memo page - has
 * three answers: no access, see only, or see and change. Seeing is stored as
 * `<power>:view`, and the server opens that screen's reading routes for it
 * and nothing that changes anything. A power that is a single action or a
 * single view has two: no, or yes.
 *
 * The Super Administrator's own powers (administrators, sign-on, mail) are
 * listed so it is clear they exist, and cannot be given.
 */

type Level = 'none' | 'view' | 'full'

/*
 * The powers that only ever show something, so "see only" can include them.
 * Exporting the ledger is a read too, but it hands over every record - that
 * stays a deliberate choice rather than part of a preset.
 */
const READING_POWERS = new Set([
  'memos.view.all',
  'approvals.oversee',
  'approvals.holders',
  'audit.administration',
])

function levelOf(powers: string[], id: string): Level {
  if (powers.includes(id)) return 'full'
  if (powers.includes(`${id}:view`)) return 'view'
  return 'none'
}

function withLevel(powers: string[], id: string, level: Level): string[] {
  const rest = powers.filter(power => power !== id && power !== `${id}:view`)
  if (level === 'full') return [...rest, id]
  if (level === 'view') return [...rest, `${id}:view`]
  return rest
}

export default function AdminRightsEditor({
  matrix,
  powers,
  onChange,
  disabled = false,
}: {
  matrix: AccessControlMatrix
  powers: string[]
  onChange: (powers: string[]) => void
  disabled?: boolean
}) {
  const baseId = useId()
  const grantable = matrix.capabilities.filter(capability => capability.grantable)
  const reserved = matrix.capabilities.filter(capability => capability.superAdminOnly)
  const groups = [...new Set(grantable.map(capability => capability.group))]

  const presets: { label: string; powers: () => string[] }[] = [
    { label: 'Nothing', powers: () => [] },
    {
      label: 'See only',
      powers: () =>
        grantable.flatMap(capability =>
          capability.viewable
            ? [`${capability.id}:view`]
            : READING_POWERS.has(capability.id)
              ? [capability.id]
              : [],
        ),
    },
    { label: 'Everything', powers: () => grantable.map(capability => capability.id) },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-meta text-content-muted">Quick set:</span>
        {presets.map(preset => (
          <button
            key={preset.label}
            type="button"
            disabled={disabled}
            onClick={() => onChange(preset.powers())}
            className="min-h-8 rounded-pill border border-line-strong px-3 text-meta font-medium text-content transition-colors hover:bg-sunken disabled:opacity-50"
          >
            {preset.label}
          </button>
        ))}
      </div>

      {groups.map(group => (
        <fieldset key={group} className="space-y-1" disabled={disabled}>
          <legend className="mb-1 text-meta font-semibold text-content">{group}</legend>
          {grantable
            .filter(capability => capability.group === group)
            .map(capability => {
              const level = levelOf(powers, capability.id)
              const options: { value: Level; label: string }[] = capability.viewable
                ? [
                    { value: 'none', label: 'No access' },
                    { value: 'view', label: 'See only' },
                    { value: 'full', label: 'See and change' },
                  ]
                : [
                    { value: 'none', label: 'No' },
                    { value: 'full', label: 'Yes' },
                  ]
              const name = `${baseId}-${capability.id}`
              return (
                <div
                  key={capability.id}
                  role="radiogroup"
                  aria-label={capability.title}
                  className="flex flex-col gap-1.5 border-b border-line-soft py-2 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                >
                  <span className="text-meta leading-snug text-content">
                    {capability.title}
                    {capability.byDefault && (
                      <span className="ml-1.5 text-2xs text-content-subtle">default</span>
                    )}
                  </span>
                  <span className="inline-flex flex-shrink-0 rounded-control border border-line bg-sunken p-0.5">
                    {options.map(option => {
                      const id = `${name}-${option.value}`
                      const chosen = level === option.value
                      return (
                        <label
                          key={option.value}
                          htmlFor={id}
                          className={`cursor-pointer rounded-[6px] px-2.5 py-1 text-2xs font-medium transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-accent ${
                            chosen
                              ? option.value === 'none'
                                ? 'bg-surface text-content shadow-sm'
                                : 'bg-accent text-on-accent shadow-sm'
                              : 'text-content-muted hover:text-content'
                          }`}
                        >
                          <input
                            id={id}
                            type="radio"
                            name={name}
                            value={option.value}
                            checked={chosen}
                            onChange={() => onChange(withLevel(powers, capability.id, option.value))}
                            className="sr-only"
                          />
                          {option.label}
                        </label>
                      )
                    })}
                  </span>
                </div>
              )
            })}
        </fieldset>
      ))}

      {reserved.length > 0 && (
        <p className="text-2xs leading-relaxed text-content-subtle">
          The Super Administrator&rsquo;s alone, never given to anybody else:{' '}
          {reserved.map(capability => capability.title.toLowerCase()).join('; ')}.
        </p>
      )}
    </div>
  )
}
