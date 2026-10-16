import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, FileText, Upload } from 'lucide-react'

import Button from '../components/ui/Button'
import { Page, PageHeader, EmptyState } from '../components/ui/Page'
import {
  SkeletonCards,
  SkeletonPageHeader,
  SkeletonStats,
  SkeletonTableRows,
} from '../components/ui/Skeleton'
import KpiRow from '../components/documents/KpiRow'
import BulkActionBar from '../components/documents/BulkActionBar'
import DocumentFilters, { type SortOrder } from '../components/documents/DocumentFilters'
import DocumentsTable from '../components/documents/DocumentsTable'
import DocumentCards from '../components/documents/DocumentCards'
import { useDocuments } from '../hooks/useDocuments'
import { computeDocumentKpis } from '../utils/documentInsights'
import { filterDocuments, type DocumentStatusFilter } from '../utils/documentFilters'
import { FEATURES } from '../config/features'
import { useAuth } from '../contexts/auth'
import { holdsCapability } from '../types/capability'
import { ROUTES } from '../types/routes'

const PAGE_SIZE = 12

/** Shared, so a stale selection scope costs no allocation per render. */
const EMPTY_SELECTION: ReadonlySet<string> = new Set()

const STATUS_VALUES: DocumentStatusFilter[] = [
  'all',
  'pending',
  'pending_review',
  'pending_approval',
  'approved',
  'rejected',
  'revision_requested',
]

function readStatus(value: string | null): DocumentStatusFilter {
  return STATUS_VALUES.includes(value as DocumentStatusFilter)
    ? (value as DocumentStatusFilter)
    : 'all'
}

export default function MyDocuments() {
  const navigate = useNavigate()
  const { documents, loading, error, refetch } = useDocuments()
  const { sessionUser } = useAuth()

  // The server decides what comes back; this only decides what to call it.
  const seesEveryMemo = holdsCapability(sessionUser, 'memos.view.all')

  /**
   * Filters live in the query string, not in component state, so a filtered
   * view is a URL somebody can send to a colleague — which is also what the
   * sidebar's saved views will store once they have an endpoint.
   */
  const [params, setParams] = useSearchParams()
  const urlSearch = params.get('q') ?? ''
  const status = readStatus(params.get('status'))
  const sort: SortOrder = params.get('sort') === 'oldest' ? 'oldest' : 'newest'
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1)

  const setParam = useCallback(
    (patch: Record<string, string | null>) => {
      setParams(
        previous => {
          const next = new URLSearchParams(previous)
          for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === '') next.delete(key)
            else next.set(key, value)
          }
          // Any change to what is being shown sends you back to page one;
          // page 4 of a two-page result is an empty screen.
          if (!('page' in patch)) next.delete('page')
          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )

  /**
   * The search box is local state that writes to the URL on a delay.
   *
   * Binding the input straight to the query string dropped characters:
   * every keystroke went out through the router and came back as a new
   * `value`, and typing faster than that round-trip lost the letters in
   * between — typing "gl" left "l" in the field. The draft is what you see
   * and what filters; the URL catches up 250ms later so the view is still
   * shareable.
   */
  const [search, setSearch] = useState(urlSearch)
  const searchTimer = useRef<number | undefined>(undefined)

  const onSearchChange = useCallback(
    (value: string) => {
      setSearch(value)
      window.clearTimeout(searchTimer.current)
      searchTimer.current = window.setTimeout(() => {
        setParams(
          previous => {
            const next = new URLSearchParams(previous)
            if (value) next.set('q', value)
            else next.delete('q')
            next.delete('page')
            return next
          },
          { replace: true },
        )
      }, 250)
    },
    [setParams],
  )

  useEffect(() => () => window.clearTimeout(searchTimer.current), [])

  const filtered = useMemo(() => {
    const matched = filterDocuments(documents, search, status)
    return [...matched].sort((a, b) => {
      const left = new Date(a.updatedAt).getTime()
      const right = new Date(b.updatedAt).getTime()
      return sort === 'oldest' ? left - right : right - left
    })
  }, [documents, search, status, sort])

  const kpis = useMemo(() => computeDocumentKpis(documents), [documents])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  /**
   * Selection is scoped to what you can currently see — changing a filter or
   * turning the page must not leave rows ticked that are no longer on screen,
   * or a bulk action would reach documents nobody meant to include.
   *
   * The scope travels WITH the selection instead of being cleared from an
   * effect. Clearing in an effect costs a second render pass, and for that
   * pass the bulk bar is still showing a count for the previous filter.
   * Here a stale scope simply reads as empty, in the same render.
   */
  const selectionScope = `${search}|${status}|${sort}|${safePage}`
  const [selection, setSelection] = useState<{ scope: string; ids: Set<string> }>(
    () => ({ scope: selectionScope, ids: new Set() }),
  )
  const selectedIds: ReadonlySet<string> =
    selection.scope === selectionScope ? selection.ids : EMPTY_SELECTION

  const clearSelection = useCallback(
    () => setSelection({ scope: selectionScope, ids: new Set() }),
    [selectionScope],
  )

  const toggle = useCallback(
    (id: string) => {
      setSelection(previous => {
        const ids = new Set(previous.scope === selectionScope ? previous.ids : [])
        if (ids.has(id)) ids.delete(id)
        else ids.add(id)
        return { scope: selectionScope, ids }
      })
    },
    [selectionScope],
  )

  const togglePage = useCallback(
    (ids: string[], select: boolean) => {
      setSelection(previous => {
        const next = new Set(previous.scope === selectionScope ? previous.ids : [])
        for (const id of ids) {
          if (select) next.add(id)
          else next.delete(id)
        }
        return { scope: selectionScope, ids: next }
      })
    },
    [selectionScope],
  )

  const openDocument = useCallback(
    (id: string) => navigate(ROUTES.document(id)),
    [navigate],
  )

  const hasFilters = search !== '' || status !== 'all'
  const clearFilters = () => {
    setSearch('')
    setParam({ q: null, status: null })
  }

  /*
   * An "Export" button sat here, permanently disabled, carrying
   * `title="Needs an export endpoint"` — and there is no such endpoint. A
   * control that can never be pressed is not a roadmap, it is a screen
   * saying the product does something it does not do; the person who needs
   * the export goes looking for why it is greyed out and finds nothing.
   * It comes back the day `GET /api/documents/export` does.
   */
  const actions = (
    <Button
      size="md"
      icon={<Upload size={15} aria-hidden="true" />}
      onClick={() => navigate(ROUTES.submitDocument)}
    >
      Submit document
    </Button>
  )

  if (error) {
    return (
      <Page>
        <PageHeader
          eyebrow={
            seesEveryMemo
              ? 'Workspace · Every document'
              : 'Workspace · Your documents'
          }
          title="Documents"
        />
        <div
          role="alert"
          className="card flex flex-col items-center justify-center gap-3 px-6 py-16 text-center"
        >
          <AlertTriangle size={22} className="text-danger-ink" aria-hidden="true" />
          <div>
            <p className="text-ui font-semibold text-content">
              {/* The same rule as the eyebrow above: an administrator was
                  told their own documents had failed to load while looking
                  at every memo in the organisation. */}
              {seesEveryMemo ? 'Could not load the documents' : 'Could not load your documents'}
            </p>
            <p className="mx-auto mt-1 max-w-sm text-ui text-content-muted">{error}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={refetch}>
            Try again
          </Button>
        </div>
      </Page>
    )
  }

  if (loading) {
    return (
      <Page>
        <SkeletonPageHeader titleWidth="9rem" />
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
          <SkeletonStats count={5} />
        </div>
        <div className="card mt-4 overflow-hidden">
          <div className="md:hidden">
            <SkeletonCards count={4} />
          </div>
          <div className="hidden md:block">
            <table className="w-full min-w-225">
              <tbody>
                <SkeletonTableRows rows={8} columns={7} />
              </tbody>
            </table>
          </div>
        </div>
        <div aria-live="polite" className="sr-only">
          Loading documents
        </div>
      </Page>
    )
  }

  return (
    <Page>
      <PageHeader
        eyebrow={
          // An administrator's list is every memo in the organisation, not
          // theirs. Saying "your documents" over somebody else's memo is the
          // kind of small lie that makes a person distrust the whole screen.
          seesEveryMemo ? 'Workspace · Every document' : 'Workspace · Your documents'
        }
        title="Documents"
        /*
         * One Submit on screen, never two.
         *
         * The header action and the empty state's action are the same button,
         * and on a list with nothing in it both used to render — an identical
         * control twice in one view, which is the first thing a new person
         * sees. The empty state wins that state: it is the focal point when
         * there is nothing else, and its copy says what pressing it is for.
         * The header wins every other state, where the panel below is full of
         * documents and the action belongs in a fixed place.
         *
         * `documents.length`, not `visible.length`: a filter that matches
         * nothing offers "Clear filters" instead, so the header keeps the only
         * Submit on screen.
         */
        actions={documents.length === 0 ? undefined : actions}
      />

      <KpiRow
        kpis={kpis}
        activeFilter={status}
        onFilter={value => setParam({ status: value === 'all' ? null : value })}
      />

      <section className="card mt-4 overflow-hidden">
        {FEATURES.bulkActions && selectedIds.size > 0 && (
          <BulkActionBar count={selectedIds.size} onClear={clearSelection} />
        )}

        <DocumentFilters
          search={search}
          onSearch={onSearchChange}
          status={status}
          onStatus={value => setParam({ status: value === 'all' ? null : value })}
          sort={sort}
          onSort={value => setParam({ sort: value === 'newest' ? null : value })}
          resultCount={filtered.length}
          totalCount={documents.length}
        />

        {visible.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No documents found"
            description={
              documents.length === 0
                ? 'Submit a document to get started.'
                : 'Try changing your search or filters.'
            }
            action={
              documents.length === 0 ? (
                <Button size="sm" onClick={() => navigate(ROUTES.submitDocument)}>
                  Submit document
                </Button>
              ) : hasFilters ? (
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : null
            }
          />
        ) : (
          <>
            <div className="md:hidden">
              <DocumentCards
                documents={visible}
                onOpen={openDocument}
                showPreparer={seesEveryMemo}
              />
            </div>
            <div className="hidden md:block">
              <DocumentsTable
                documents={visible}
                selectedIds={selectedIds}
                onToggle={toggle}
                onTogglePage={togglePage}
                onOpen={openDocument}
                showPreparer={seesEveryMemo}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-canvas px-3.5 py-2.25">
              <p className="text-meta text-content-subtle tabular-nums">
                {visible.length} of {filtered.length} document
                {filtered.length === 1 ? '' : 's'}
                {kpis.waitingOverWeek > 0 && (
                  <> &middot; {kpis.waitingOverWeek} waiting 7+ days</>
                )}
              </p>

              {pageCount > 1 && (
                <nav aria-label="Pagination" className="flex items-center gap-1">
                  {Array.from({ length: pageCount }, (_, index) => index + 1).map(
                    number => (
                      <button
                        key={number}
                        type="button"
                        onClick={() => setParam({ page: String(number) })}
                        aria-current={number === safePage ? 'page' : undefined}
                        aria-label={`Page ${number}`}
                        className={`h-6 min-w-6 rounded-chip px-1.5 font-mono text-2xs tabular-nums transition-colors ${
                          number === safePage
                            ? 'bg-dark-surface text-dark-content'
                            : 'text-content-subtle hover:bg-sunken hover:text-content'
                        }`}
                      >
                        {number}
                      </button>
                    ),
                  )}
                </nav>
              )}
            </div>
          </>
        )}
      </section>
    </Page>
  )
}
