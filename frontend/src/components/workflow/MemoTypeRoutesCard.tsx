import { useEffect, useState } from 'react'
import { Route } from 'lucide-react'
import { Card, CardHeader } from '../ui/Card'
import Button from '../ui/Button'
import { fetchMemoTypeRoutes, saveMemoTypeRoute, type MemoTypeRoute } from '../../services/memoTypeRoutesApi'
import { fetchActiveTemplates } from '../../services/workflowTemplateApi'
import type { WorkflowTemplateSummary } from '../../types/workflowTemplate'

/**
 * The route each kind of memo starts from - fit-gap decision 7.
 *
 * One row per kind of memo, uploaded PDFs included: the workflow the submit
 * screen picks first for it. The preparer can still choose another where the
 * screen allows; this is the consistent starting point. Saving asks the
 * administrator to confirm it is them, and is recorded.
 */

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

export default function MemoTypeRoutesCard() {
  const [routes, setRoutes] = useState<MemoTypeRoute[] | null>(null)
  const [templates, setTemplates] = useState<WorkflowTemplateSummary[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([fetchMemoTypeRoutes(), fetchActiveTemplates()])
      .then(([loadedRoutes, loadedTemplates]) => {
        if (cancelled) return
        setRoutes(loadedRoutes)
        setTemplates(loadedTemplates)
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(message(error, 'Could not read the routes.'))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const chosen = (route: MemoTypeRoute) =>
    choices[route.key] ?? (route.templateActive ? (route.templateId ?? '') : '')

  const save = async (route: MemoTypeRoute) => {
    setBusy(route.key)
    setProblem(null)
    setNotice(null)
    try {
      const value = chosen(route)
      const next = await saveMemoTypeRoute(route.key, value || null)
      setRoutes(next)
      setChoices(current => {
        const { [route.key]: _done, ...rest } = current
        return rest
      })
      const saved = next.find(candidate => candidate.key === route.key)
      setNotice(
        saved?.templateName
          ? `${route.label} now starts on "${saved.templateName}".`
          : `${route.label} no longer starts on a set route.`,
      )
    } catch (error) {
      setProblem(message(error, 'Could not save the route.'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader
        icon={Route}
        title="Route per kind of memo"
        hint="The workflow the submit screen picks first for each kind of memo, so the same kind always starts the same way."
      />
      <div className="space-y-3 p-4 pt-0">
        {loadError ? (
          <p role="alert" className="text-ui text-danger-ink">
            {loadError}
          </p>
        ) : !routes ? (
          <p className="text-ui text-content-muted">Reading the routes…</p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {routes.map(route => {
              const id = `route-${route.key}`
              const changed = chosen(route) !== (route.templateActive ? (route.templateId ?? '') : '')
              return (
                <li key={route.key} className="flex flex-wrap items-end gap-3 py-2.5">
                  <div className="min-w-0 flex-1 space-y-1">
                    <label htmlFor={id} className="field-label">
                      {route.label}
                    </label>
                    <select
                      id={id}
                      value={chosen(route)}
                      onChange={event =>
                        setChoices(current => ({ ...current, [route.key]: event.target.value }))
                      }
                      className="field"
                    >
                      <option value="">No set route - the preparer chooses</option>
                      {templates.map(template => (
                        <option key={template.id} value={template.id}>
                          {template.name}
                        </option>
                      ))}
                    </select>
                    {route.templateId && !route.templateActive && (
                      <p className="text-meta text-warning-ink">
                        Its workflow &ldquo;{route.templateName}&rdquo; was archived, so nothing is picked first.
                      </p>
                    )}
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => void save(route)}
                    pending={busy === route.key}
                    disabled={!changed}
                    aria-label={`Save the route for ${route.label}`}
                  >
                    Save
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
        {problem && (
          <p role="alert" className="text-ui text-danger-ink">
            {problem}
          </p>
        )}
        {notice && (
          <p role="status" className="text-ui text-success-ink">
            {notice}
          </p>
        )}
      </div>
    </Card>
  )
}
