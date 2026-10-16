import { AlertCircle, Check, GitBranch, Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  fetchActiveTemplate,
  fetchActiveTemplates,
} from '../../services/workflowTemplateApi'
import type {
  WorkflowTemplate,
  WorkflowTemplateSummary,
} from '../../types/workflowTemplate'
import Button from '../ui/Button'
import { LoadingAnnouncer, Skeleton } from '../ui/Skeleton'

/**
 * Choose a saved workflow template instead of building a chain by hand.
 *
 * The API has accepted a `templateId` on submission all along, and the admin
 * designer has always been able to author them — this is the half that was
 * missing, so a template an administrator approves could never actually be
 * used by anyone submitting a document.
 */

interface Props {
  selectedId: string | null
  onSelect: (template: WorkflowTemplate | null) => void
  /** Set when the compiled chain for this document cannot complete. */
  problem?: string | null
}

export default function TemplatePicker({ selectedId, onSelect, problem }: Props) {
  const [templates, setTemplates] = useState<WorkflowTemplateSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false

    fetchActiveTemplates()
      .then(list => {
        if (cancelled) return
        setTemplates(list)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setTemplates([])
        setError(err instanceof Error ? err.message : 'Could not load templates')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const choose = async (summary: WorkflowTemplateSummary) => {
    if (summary.id === selectedId) {
      onSelect(null)
      return
    }
    setLoadingId(summary.id)
    try {
      // The graph is only on the detail response, and the preview needs it to
      // work out where this particular document would go.
      const full = await fetchActiveTemplate(summary.id)
      onSelect(full)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that template')
    } finally {
      setLoadingId(null)
    }
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {/* The skeletons are aria-hidden, correctly - they carry nothing to
            read. That left the whole wait silent, and then a radio group
            simply appeared. `LoadingAnnouncer` exists for exactly this and is
            already used on five pages. */}
        <div aria-hidden="true" className="space-y-2">
          <Skeleton className="h-16 w-full rounded-card" />
          <Skeleton className="h-16 w-full rounded-card" />
        </div>
        <LoadingAnnouncer loading label="Loading workflow templates" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-card border border-danger-line bg-danger-soft p-4 text-center">
        <p role="alert" className="text-meta text-danger-ink">
          {error}
        </p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => {
            setLoading(true)
            setReloadToken(token => token + 1)
          }}
          icon={<RefreshCw size={13} aria-hidden="true" />}
        >
          Try again
        </Button>
      </div>
    )
  }

  if (templates.length === 0) {
    return (
      <div className="rounded-card border border-dashed border-line-strong bg-sunken/40 px-4 py-8 text-center">
        <GitBranch
          size={22}
          aria-hidden="true"
          className="mx-auto mb-2 text-content-subtle"
        />
        <p className="text-ui font-medium text-content">
          No workflow templates are published yet
        </p>
        <p className="mx-auto mt-1 max-w-sm text-2xs text-content-subtle">
          An administrator can publish reusable workflows in Workflow studio.
          Until then, build the approval chain by hand.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/*
        * `role="radiogroup"` with `role="radio"` children promises arrow-key
        * selection and a single tab stop. The keys did nothing, so a
        * screen-reader user in forms mode arrowed through the group, got no
        * response, and concluded it was broken. Claiming the role means
        * owing the behaviour.
        */}
      <ul
        className="space-y-2"
        role="radiogroup"
        aria-label="Workflow template"
        onKeyDown={event => {
          const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft']
          if (!keys.includes(event.key) || loadingId !== null) return

          const radios = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="radio"]:not([disabled])',
            ),
          )
          if (radios.length === 0) return

          const from = radios.indexOf(document.activeElement as HTMLButtonElement)
          const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
          // Wraps, as a radio group does: the last one down reaches the first.
          const next = radios[(from + step + radios.length) % radios.length]

          event.preventDefault()
          next?.focus()
          next?.click()
        }}
      >
        {templates.map(template => {
          const selected = template.id === selectedId
          return (
            <li key={template.id}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                /* Deliberately NOT a roving tabindex.
                   The strict radio-group pattern gives the group one tab stop
                   and moves within it by arrow, and that is what a screen
                   reader in forms mode expects. But it also means that if the
                   arrow handling above ever breaks, every option after the
                   first becomes unreachable by keyboard at all. Leaving each
                   one tabbable costs a few extra Tab presses and cannot
                   strand anybody; the sibling test guards it.  */
                onClick={() => void choose(template)}
                disabled={loadingId !== null}
                className={`flex w-full items-start gap-3 rounded-card border p-3.5 text-left transition-colors sm:p-4 ${
                  selected
                    ? 'border-accent bg-accent-soft'
                    : 'border-line bg-sunken/30 hover:border-accent-line hover:bg-accent-soft/30'
                } ${loadingId !== null && !selected ? 'opacity-60' : ''}`}
              >
                <span
                  aria-hidden="true"
                  className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-pill border ${
                    selected
                      ? 'border-accent bg-accent text-on-accent'
                      : 'border-line-strong bg-surface'
                  }`}
                >
                  {loadingId === template.id ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    selected && <Check size={11} strokeWidth={3} />
                  )}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block text-ui font-semibold text-content">
                    {template.name}
                  </span>
                  {template.description && (
                    <span className="mt-0.5 block text-2xs text-content-muted">
                      {template.description}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      {problem && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-control border border-warning-line bg-warning-soft px-3 py-2.5 text-2xs text-warning-ink"
        >
          <AlertCircle size={13} aria-hidden="true" className="mt-px flex-shrink-0" />
          {problem}
        </p>
      )}
    </div>
  )
}
