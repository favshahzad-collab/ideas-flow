import { useEffect, useId, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  Plus,
  Search,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { ROUTES } from '../types/routes'
import { Page, PageHeader, EmptyState } from '../components/ui/Page'
import MemoTypeRoutesCard from '../components/workflow/MemoTypeRoutesCard'
import Modal from '../components/Modal'
import Button from '../components/ui/Button'
import { Badge } from '../components/ui/Card'
import RowMenu, { MenuItem } from '../components/ui/RowMenu'
import { SkeletonTableRows } from '../components/ui/Skeleton'
import { formatDisplayDate } from '../utils/format'
import {
  archiveAdminTemplate,
  fetchAdminTemplates,
  restoreAdminTemplate,
  updateAdminTemplate,
} from '../services/workflowTemplateApi'
import type { WorkflowTemplateSummary } from '../types/workflowTemplate'

export default function WorkflowStudioPage() {
  const navigate = useNavigate()
  const searchId = useId()
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  /*
   * Templates are archived, never deleted: an archived one is kept, with its
   * design and its history, and can be restored. "In use" is the everyday
   * list; the archive is somewhere you go to look.
   */
  const [view, setView] = useState<'current' | 'archived'>('current')
  const [archiving, setArchiving] = useState<WorkflowTemplateSummary | null>(null)
  const [archiveError, setArchiveError] = useState('')
  const [archiveLoading, setArchiveLoading] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  /*
   * What was last read, and for which view and attempt. Loading is derived
   * from it rather than set: a list read for the other view, or before the
   * latest change, is a list still loading. Bumping `attempt` reloads.
   */
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<{
    view: typeof view
    attempt: number
    templates: WorkflowTemplateSummary[]
    error: string | null
  } | null>(null)

  useEffect(() => {
    let cancelled = false

    fetchAdminTemplates({ archived: view === 'archived' })
      .then(templates => {
        if (!cancelled) setLoaded({ view, attempt, templates, error: null })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoaded({
            view,
            attempt,
            templates: [],
            error: err instanceof Error ? err.message : 'Failed to load templates',
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [view, attempt])

  const loading = loaded?.view !== view || loaded.attempt !== attempt
  const templates = loading ? [] : loaded.templates
  const loadError = loading ? null : loaded.error

  // Re-reads whichever list is showing, so a reload after archiving or
  // restoring stays on the view the person was looking at.
  const loadTemplates = () => {
    setError(null)
    setAttempt(n => n + 1)
  }

  const query = search.trim().toLowerCase()
  const filtered = query
    ? templates.filter(
        t =>
          t.name.toLowerCase().includes(query) ||
          (t.description ?? '').toLowerCase().includes(query)
      )
    : templates

  const activeCount = templates.filter(t => t.isActive).length

  async function handleToggleActive(template: WorkflowTemplateSummary) {
    setTogglingId(template.id)
    try {
      await updateAdminTemplate(template.id, { isActive: !template.isActive })
      loadTemplates()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update template')
    } finally {
      setTogglingId(null)
    }
  }

  async function confirmArchive() {
    if (!archiving) return
    setArchiveLoading(true)
    setArchiveError('')
    try {
      await archiveAdminTemplate(archiving.id)
      setArchiving(null)
      loadTemplates()
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : 'The template could not be archived')
    } finally {
      setArchiveLoading(false)
    }
  }

  async function handleRestore(template: WorkflowTemplateSummary) {
    setTogglingId(template.id)
    try {
      await restoreAdminTemplate(template.id)
      loadTemplates()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The template could not be restored')
    } finally {
      setTogglingId(null)
    }
  }

  const isArchiveView = view === 'archived'

  return (
    <Page>
      <PageHeader
        /* "Workflow studio", matching the sidebar and the tab title. This
           page said "Workflow Templates" while the nav item that reaches it
           said something else — the same drift the admin screen had. */
        title="Workflow studio"
        eyebrow={
          loading
            ? 'Workflow studio'
            : isArchiveView
              ? `${templates.length} archived`
              : `${templates.length} template${templates.length === 1 ? '' : 's'} · ${activeCount} active`
        }
        /* One New template on screen, never two — the same rule the
           documents list follows. With no templates at all the empty state
           below carries the only copy, because that is the state where it is
           the focal point and where its copy explains what a template is
           for; with templates listed, the header carries it. A search that
           matches nothing offers "Clear search" instead, so the header keeps
           its button. */
        actions={
          !loading && !isArchiveView && templates.length === 0 ? undefined : (
            <Button
              onClick={() => navigate(ROUTES.workflowStudioNew)}
              icon={<Plus size={15} aria-hidden="true" />}
            >
              New template
            </Button>
          )
        }
      />

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-3.5 py-3">
          <div className="relative w-full sm:w-72">
            <label htmlFor={searchId} className="sr-only">
              Search templates
            </label>
            <Search
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-subtle"
            />
            <input
              id={searchId}
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search templates…"
              className="field h-8.5 bg-sunken pl-8.5"
            />
          </div>
          <div role="group" aria-label="Which templates" className="flex gap-1">
            {(['current', 'archived'] as const).map(option => (
              <Button
                key={option}
                variant={view === option ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={view === option}
                onClick={() => {
                  setSearch('')
                  setView(option)
                }}
              >
                {option === 'current' ? 'In use' : 'Archived'}
              </Button>
            ))}
          </div>
          <p className="font-mono text-data uppercase tracking-eyebrow text-content-subtle">
            {filtered.length} shown
          </p>
        </div>

        <div aria-live="polite" aria-atomic="true">
          {(error ?? loadError) && (
            <p
              role="alert"
              className="m-3.5 flex items-center gap-2 rounded-control border border-danger-line bg-danger-soft px-3 py-2 text-ui text-danger-ink"
            >
              <AlertCircle size={15} className="flex-shrink-0" aria-hidden="true" />
              {error ?? loadError}
            </p>
          )}
        </div>

        {!loading && filtered.length === 0 ? (
          <EmptyState
            icon={WorkflowIcon}
            title={
              search
                ? 'No templates match your search'
                : isArchiveView
                  ? 'No archived templates'
                  : 'No workflow templates yet'
            }
            description={
              search
                ? 'Try a different search term.'
                : isArchiveView
                  ? 'A template you archive is kept here, with its design and its history, and can be restored.'
                  : 'Create your first template to standardise how documents get approved across the organisation.'
            }
            action={
              isArchiveView && !search ? undefined : search ? (
                <Button variant="secondary" size="sm" onClick={() => setSearch('')}>
                  Clear search
                </Button>
              ) : (
                /* "New template", the same name the header gives it. The
                   two used to be "New template" and "Create template" - one
                   action under two names, which leaves somebody wondering
                   what the other one does. */
                <Button
                  onClick={() => navigate(ROUTES.workflowStudioNew)}
                  icon={<Plus size={15} aria-hidden="true" />}
                >
                  New template
                </Button>
              )
            }
          />
        ) : (
          <div className="relative overflow-x-auto">
            {/* `relative` keeps the sr-only header cell from escaping this
                scroller and stretching the document — see PeopleTable. */}
            <table className="w-full min-w-160 border-collapse">
              <caption className="sr-only">
                Workflow templates, with status and last update time
              </caption>
              <thead>
                <tr className="border-b border-line bg-canvas">
                  <th scope="col" className="table-head pl-3.5">
                    Template
                  </th>
                  <th scope="col" className="table-head">
                    Status
                  </th>
                  <th scope="col" className="table-head hidden md:table-cell">
                    Last updated
                  </th>
                  <th scope="col" className="table-head w-10">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <SkeletonTableRows rows={5} columns={4} />
                ) : (
                  filtered.map(template => (
                    <tr
                      key={template.id}
                      className="border-b border-line-soft transition-colors last:border-0 hover:bg-sunken"
                    >
                      <td className="max-w-95 py-2.5 pl-3.5 pr-3">
                        <button
                          type="button"
                          onClick={() => navigate(ROUTES.workflowTemplate(template.id))}
                          className="block w-full min-w-0 text-left"
                        >
                          <span className="block truncate text-ui font-medium text-content">
                            {template.name}
                          </span>
                          {template.description && (
                            <span
                              className="block truncate text-meta text-content-subtle"
                              title={template.description}
                            >
                              {template.description}
                            </span>
                          )}
                        </button>
                      </td>

                      <td className="px-3 py-2.5">
                        <Badge
                          tone={template.archivedAt ? 'neutral' : template.isActive ? 'accent' : 'neutral'}
                          dot
                        >
                          {template.archivedAt ? 'Archived' : template.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </td>

                      <td className="hidden whitespace-nowrap px-3 py-2.5 font-mono text-data tabular-nums text-content-subtle md:table-cell">
                        {formatDisplayDate(template.updatedAt)}
                      </td>

                      <td className="px-3 py-2.5">
                        <RowMenu label={`Actions for ${template.name}`} width="w-48">
                          {close => (
                            <>
                              <MenuItem
                                onSelect={() => {
                                  close()
                                  navigate(ROUTES.workflowTemplate(template.id))
                                }}
                              >
                                {template.archivedAt ? 'Open (read only)' : 'Open in the designer'}
                              </MenuItem>
                              {template.archivedAt ? (
                                <MenuItem
                                  disabled={togglingId === template.id}
                                  onSelect={() => {
                                    close()
                                    void handleRestore(template)
                                  }}
                                >
                                  Restore
                                </MenuItem>
                              ) : (
                                <>
                                  <MenuItem
                                    disabled={togglingId === template.id}
                                    onSelect={() => {
                                      close()
                                      void handleToggleActive(template)
                                    }}
                                  >
                                    {template.isActive ? 'Deactivate' : 'Activate'}
                                  </MenuItem>
                                  <MenuItem
                                    onSelect={() => {
                                      close()
                                      setArchiving(template)
                                    }}
                                  >
                                    Archive template
                                  </MenuItem>
                                </>
                              )}
                            </>
                          )}
                        </RowMenu>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={Boolean(archiving)}
        onClose={() => {
          if (!archiveLoading) {
            setArchiving(null)
            setArchiveError('')
          }
        }}
        title="Archive this template?"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-ui leading-relaxed text-content-muted">
            {archiving ? (
              <>
                &ldquo;<strong className="text-content">{archiving.name}</strong>&rdquo;
                stops being offered to preparers and moves to Archived. It is
                kept, with its design and its history, and can be restored.
                Memos already sent down it are not affected.
              </>
            ) : null}
          </p>

          <div aria-live="polite" aria-atomic="true">
            {archiveError && (
              <p
                role="alert"
                className="flex items-start gap-1.5 rounded-control border border-danger-line bg-danger-soft px-3 py-2 text-ui text-danger-ink"
              >
                <AlertCircle
                  size={14}
                  className="mt-0.5 flex-shrink-0"
                  aria-hidden="true"
                />
                {archiveError}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setArchiving(null)
                setArchiveError('')
              }}
              disabled={archiveLoading}
            >
              Cancel
            </Button>
            <Button onClick={confirmArchive} pending={archiveLoading}>
              Archive
            </Button>
          </div>
        </div>
      </Modal>

      {/* Which of these each kind of memo starts from. Only in the main list:
          an archived workflow is not offered as a route. */}
      {!isArchiveView && (
        <div className="mt-5">
          <MemoTypeRoutesCard />
        </div>
      )}
    </Page>
  )
}
