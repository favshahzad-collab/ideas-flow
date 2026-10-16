import { useEffect, useId, useState } from 'react'
import { fetchMemoTypes } from '../../services/memoApi'

/**
 * Which memos a delegation covers - fit-gap decision 6.
 *
 * Every memo by default, which is what cover has always meant. Limiting it
 * to chosen kinds is least privilege: somebody covering purchase approvals
 * does not also sign the HR memos. An empty choice is sent as "every memo".
 */

const UPLOADED = { key: 'UPLOADED', label: 'Uploaded PDF' }

export default function MemoScopeField({
  value,
  onChange,
  disabled = false,
}: {
  /** The kinds chosen; empty is every memo. */
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}) {
  const [kinds, setKinds] = useState<{ key: string; label: string }[]>([UPLOADED])
  const [limited, setLimited] = useState(value.length > 0)
  const groupId = useId()

  useEffect(() => {
    let cancelled = false
    fetchMemoTypes()
      .then(loaded => {
        if (!cancelled) {
          setKinds([...loaded.memoTypes.map(type => ({ key: type.key, label: type.label })), UPLOADED])
        }
      })
      .catch(() => {
        /* The uploaded kind is always there; typed kinds just are not offered. */
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <fieldset className="space-y-2" disabled={disabled} aria-describedby={`${groupId}-hint`}>
      <legend className="field-label">Covers</legend>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-ui text-content">
          <input
            type="radio"
            name={`${groupId}-scope`}
            checked={!limited}
            onChange={() => {
              setLimited(false)
              onChange([])
            }}
            className="accent-accent"
          />
          Every memo
        </label>
        <label className="flex items-center gap-2 text-ui text-content">
          <input
            type="radio"
            name={`${groupId}-scope`}
            checked={limited}
            onChange={() => setLimited(true)}
            className="accent-accent"
          />
          Only some kinds
        </label>
      </div>
      {limited && (
        <div className="flex flex-col gap-1.5 pl-1">
          {kinds.map(kind => (
            <label key={kind.key} className="flex items-center gap-2 text-ui text-content">
              <input
                type="checkbox"
                checked={value.includes(kind.key)}
                onChange={event =>
                  onChange(
                    event.target.checked
                      ? [...new Set([...value, kind.key])]
                      : value.filter(key => key !== kind.key),
                  )
                }
                className="h-4 w-4 accent-accent"
              />
              {kind.label}
            </label>
          ))}
        </div>
      )}
      <p id={`${groupId}-hint`} className="text-meta text-content-subtle">
        {limited && value.length === 0
          ? 'Tick at least one kind, or choose every memo.'
          : 'Memos of any other kind stay with the person who is away.'}
      </p>
    </fieldset>
  )
}
