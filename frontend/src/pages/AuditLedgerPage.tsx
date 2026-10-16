import { holdsCapability } from '../types/capability'
import { useMemo, useState } from 'react'
import {
  ChevronDown,
  Download,
  FileText,
  Loader2,
  Minus,
  Plus,
  Search,
} from 'lucide-react'
import { useAuditLedger } from '../hooks/useAuditLedger'
import { useCurrentUser } from '../contexts/currentUser'
import { downloadAuditCsv, downloadDocumentAuditCsv } from '../services/auditApi'
import { filterAuditRecords, groupAuditRecordsByDocument } from '../utils/auditFilters'
import { Page, PageHeader, EmptyState } from '../components/ui/Page'
import Button from '../components/ui/Button'
import { Avatar } from '../components/ui/Card'
import ActionBadge from '../components/audit/ActionBadge'
import LedgerSeal from '../components/audit/LedgerSeal'
import { FEATURES } from '../config/features'
import {
  LoadingAnnouncer,
  Skeleton,
  SkeletonPageHeader,
  SkeletonTableRows,
} from '../components/ui/Skeleton'
import type { AuditDocumentGroup, AuditRecord } from '../types/audit'

function Timestamp({ record }: { record: AuditRecord }) {
  return (
    <span className="block whitespace-nowrap">
      <span className="block text-ui text-content-muted">{record.date}</span>
      <time
        dateTime={record.occurredAt}
        className="block font-mono text-data tabular-nums text-content-subtle"
      >
        {record.time}
      </time>
    </span>
  )
}

function Actor({ record }: { record: AuditRecord }) {
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <Avatar initials={record.initials} size="xs" />
      <span className="min-w-0">
        <span className="block text-ui text-content-muted">{record.user}</span>
        {/* A delegated approval is one act by two people: the signature is
            this person's, the authority was somebody else's, and a ledger
            that shows only one of them cannot be reconciled with the page. */}
        {record.onBehalfOf && (
          <span className="block text-meta text-content-subtle">
            for {record.onBehalfOf}
          </span>
        )}
      </span>
    </span>
  )
}

function DownloadRowButton({
  onClick,
  loading,
  label,
}: {
  onClick: () => void
  loading: boolean
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      aria-label={label}
      title={label}
      className="inline-flex h-6.5 w-6.5 items-center justify-center rounded-control text-content-subtle transition-colors hover:bg-sunken hover:text-content disabled:opacity-50"
    >
      {loading ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <Download size={14} aria-hidden="true" />
      )}
    </button>
  )
}

/** 28px square, per the redesign — a hairline box, not a filled button. */
function ExpandButton({
  expanded,
  onClick,
  actionCount,
  document,
}: {
  expanded: boolean
  onClick: () => void
  actionCount: number
  document: string
}) {
  if (actionCount <= 1) {
    return <span className="inline-block h-7 w-7" aria-hidden="true" />
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      aria-label={`${expanded ? 'Hide' : 'Show'} all ${actionCount} entries for ${document}`}
      className="inline-flex h-7 w-7 items-center justify-center rounded-chip border border-line text-content-subtle transition-colors hover:bg-sunken hover:text-content"
    >
      {expanded ? <Minus size={13} aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}
    </button>
  )
}

function LedgerRow({
  record,
  showDocument,
  nested = false,
  actionCount = 1,
  expanded = false,
  onToggle,
  onDownload,
  downloading = false,
}: {
  record: AuditRecord
  showDocument: string | null
  /** A child entry under an expanded group — indented and on the sunken tint. */
  nested?: boolean
  actionCount?: number
  expanded?: boolean
  onToggle?: () => void
  onDownload?: () => void
  downloading?: boolean
}) {
  return (
    <tr
      className={`border-b border-line-soft transition-colors last:border-0 ${
        nested ? 'bg-sunken/60' : 'hover:bg-sunken/50'
      }`}
    >
      <td className={`py-2.5 pr-2 ${nested ? 'pl-7' : 'pl-3.5'}`}>
        {onToggle ? (
          <ExpandButton
            expanded={expanded}
            onClick={onToggle}
            actionCount={actionCount}
            document={record.document}
          />
        ) : (
          <span className="inline-block h-7 w-7" aria-hidden="true" />
        )}
      </td>

      <td className="px-3 py-2.5">
        <Timestamp record={record} />
      </td>

      <td className="px-3 py-2.5">
        <Actor record={record} />
      </td>

      <td className="whitespace-nowrap px-3 py-2.5 text-ui text-content-muted">
        {record.role}
      </td>

      <td className="px-3 py-2.5">
        <ActionBadge action={record.action} />
      </td>

      <td className="max-w-60 px-3 py-2.5">
        {showDocument ? (
          <span className="block min-w-0">
            <span className="block truncate text-ui font-medium text-content" title={showDocument}>
              {showDocument}
            </span>
            <span className="block font-mono text-data text-content-subtle">
              {record.documentReference}
              {actionCount > 1 && ` · ${actionCount} entries`}
            </span>
          </span>
        ) : (
          /* A child entry under an expanded group. It still names its own
             document — as an id rather than the title the row above already
             carries — because an audit row read on its own, or lifted out of
             the page, must say what it is about. An em dash said nothing. */
          <span className="block truncate font-mono text-data text-content-subtle">
            <span aria-hidden="true">&#8627; </span>{record.documentReference}
          </span>
        )}
      </td>

      <td className="max-w-45 px-3 py-2.5">
        <span className="block truncate text-meta text-content-muted" title={record.comments}>
          {record.comments}
        </span>
      </td>

      <td className="px-3 py-2.5">
        {onDownload && (
          <DownloadRowButton
            onClick={onDownload}
            loading={downloading}
            label={`Download the audit CSV for ${record.document}`}
          />
        )}
      </td>
    </tr>
  )
}

function LedgerGroup({
  group,
  expanded,
  onToggle,
  onDownload,
  downloading,
}: {
  group: AuditDocumentGroup
  expanded: boolean
  onToggle: () => void
  onDownload: (documentId: string) => void
  downloading: boolean
}) {
  return (
    <>
      <LedgerRow
        record={group.latestAction}
        showDocument={group.document}
        actionCount={group.actions.length}
        expanded={expanded}
        onToggle={onToggle}
        onDownload={() => onDownload(group.documentId)}
        downloading={downloading}
      />
      {expanded &&
        group.actions
          .slice(1)
          .map(record => (
            <LedgerRow key={record.id} record={record} showDocument={null} nested />
          ))}
    </>
  )
}

function LedgerCard({
  group,
  expanded,
  onToggle,
  onDownload,
  downloading,
}: {
  group: AuditDocumentGroup
  expanded: boolean
  onToggle: () => void
  onDownload: (documentId: string) => void
  downloading: boolean
}) {
  const { latestAction, actions } = group
  const shown = expanded ? actions : actions.slice(0, 1)

  return (
    <article className="card overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-line-soft px-3.5 py-3">
        <div className="min-w-0">
          <p className="truncate text-ui font-medium text-content">{group.document}</p>
          <p className="font-mono text-data text-content-subtle">
            {latestAction.documentReference} &middot; {actions.length}{' '}
            {actions.length === 1 ? 'entry' : 'entries'}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <DownloadRowButton
            onClick={() => onDownload(group.documentId)}
            loading={downloading}
            label={`Download the audit CSV for ${group.document}`}
          />
          <ExpandButton
            expanded={expanded}
            onClick={onToggle}
            actionCount={actions.length}
            document={group.document}
          />
        </div>
      </div>

      <ul>
        {shown.map(record => (
          <li
            key={record.id}
            className="border-b border-line-soft px-3.5 py-3 last:border-b-0"
          >
            <div className="flex items-start justify-between gap-3">
              <Actor record={record} />
              <ActionBadge action={record.action} />
            </div>
            <p className="mt-1.5 font-mono text-data text-content-subtle">
              {record.date} &middot; {record.time} &middot; {record.role}
            </p>
            {record.comments !== '—' && (
              <p className="mt-1.5 text-meta leading-relaxed text-content-muted">
                {record.comments}
              </p>
            )}
          </li>
        ))}
      </ul>

      {!expanded && actions.length > 1 && (
        <p className="px-3.5 py-2 text-meta text-content-subtle">
          {actions.length - 1} earlier{' '}
          {actions.length - 1 === 1 ? 'entry' : 'entries'} hidden
        </p>
      )}

      <span className="sr-only">{latestAction.action}</span>
    </article>
  )
}

export default function AuditLedgerPage() {
  const { records, actionFilterOptions, loading, error, refetch } = useAuditLedger()
  const { user } = useCurrentUser()
  const [search, setSearch] = useState('')
  const [actionFilter, setActionFilter] = useState('All Actions')
  const [expandedDocuments, setExpandedDocuments] = useState<Set<string>>(new Set())
  const [exportingAll, setExportingAll] = useState(false)
  const [exportingDocumentId, setExportingDocumentId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const filteredGroups = useMemo(() => {
    const filteredRecords = filterAuditRecords(records, search, actionFilter)
    return groupAuditRecordsByDocument(filteredRecords)
  }, [records, search, actionFilter])

  const toggleDocument = (documentId: string) => {
    setExpandedDocuments(current => {
      const next = new Set(current)
      if (next.has(documentId)) next.delete(documentId)
      else next.add(documentId)
      return next
    })
  }

  const handleExportAll = async () => {
    setActionError(null)
    setExportingAll(true)
    try {
      await downloadAuditCsv()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to export CSV')
    } finally {
      setExportingAll(false)
    }
  }

  const handleExportDocument = async (documentId: string) => {
    setActionError(null)
    setExportingDocumentId(documentId)
    try {
      await downloadDocumentAuditCsv(documentId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to download audit CSV')
    } finally {
      setExportingDocumentId(null)
    }
  }

  if (loading) {
    return (
      <Page>
        <SkeletonPageHeader titleWidth="9rem" description={false} />

        <section aria-hidden="true" className="card mb-4 px-3.5 py-3">
          <div className="flex flex-col gap-2.5 lg:flex-row">
            <Skeleton className="h-8.5 flex-1 rounded-control" />
            <Skeleton className="h-8.5 w-full rounded-control lg:w-47.5" />
          </div>
        </section>

        <div aria-hidden="true" className="block space-y-2.5 lg:hidden">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-card" />
          ))}
        </div>

        <div aria-hidden="true" className="card hidden overflow-hidden lg:block">
          <table className="w-full">
            <tbody>
              <SkeletonTableRows rows={8} columns={8} />
            </tbody>
          </table>
        </div>

        <LoadingAnnouncer loading label="Loading the audit ledger" />
      </Page>
    )
  }

  if (error) {
    return (
      <Page>
        <div className="card flex flex-col items-center gap-3 px-6 py-16 text-center">
          <p className="text-ui text-danger-ink">{error}</p>
          <Button variant="secondary" size="sm" onClick={refetch}>
            Try again
          </Button>
        </div>
      </Page>
    )
  }

  return (
    <Page>
      <PageHeader
        title="Audit ledger"
        /* The design's kicker was "APPEND-ONLY · HASH CHAINED". Both halves are
           true now, and neither is said here: an eyebrow is not where a claim
           about integrity belongs, because there is nothing beside it a reader
           could check it against. The strip below says it with the numbers. */
        eyebrow={`Append-only · ${records.length} ${records.length === 1 ? 'entry' : 'entries'}`}
        actions={
          <>
            <Button
              variant="secondary"
              icon={
                exportingAll ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Download size={15} />
                )
              }
              onClick={handleExportAll}
              disabled={exportingAll || records.length === 0}
            >
              Export CSV
            </Button>
          </>
        }
      />

      {actionError && (
        <p role="alert" className="mb-3 text-ui text-danger-ink">
          {actionError}
        </p>
      )}

      {/* Anyone signed in can see how far the seal has reached; walking the
          whole chain is administrators only, because on a long trail it is
          minutes of work - not because the answer is theirs alone. */}
      {FEATURES.ledgerIntegrity && (
        <LedgerSeal
          canVerify={holdsCapability(user, 'audit.verify')}
          canExport={holdsCapability(user, 'audit.export')}
        />
      )}

      <section className="card mb-4 px-3.5 py-3">
        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <label htmlFor="audit-search" className="sr-only">
              Search the ledger
            </label>
            <Search
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-subtle"
            />
            <input
              id="audit-search"
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by document, person or ID…"
              className="field h-8.5 bg-sunken pl-8.5"
            />
          </div>

          <div className="relative w-full lg:w-47.5">
            <label htmlFor="audit-action-filter" className="sr-only">
              Filter by action
            </label>
            <select
              id="audit-action-filter"
              value={actionFilter}
              onChange={e => setActionFilter(e.target.value)}
              className="field h-8.5 appearance-none pr-8"
            >
              {actionFilterOptions.map(action => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>
            <ChevronDown
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-content-subtle"
            />
          </div>

          <p className="whitespace-nowrap font-mono text-data uppercase tracking-eyebrow text-content-subtle lg:px-1">
            {filteredGroups.length} document{filteredGroups.length === 1 ? '' : 's'}
          </p>
        </div>
      </section>

      {filteredGroups.length > 0 ? (
        <>
          <div className="block space-y-2.5 lg:hidden">
            {filteredGroups.map(group => (
              <LedgerCard
                key={group.documentId}
                group={group}
                expanded={expandedDocuments.has(group.documentId)}
                onToggle={() => toggleDocument(group.documentId)}
                onDownload={handleExportDocument}
                downloading={exportingDocumentId === group.documentId}
              />
            ))}
          </div>

          <div className="card hidden overflow-hidden lg:block">
            <div className="relative overflow-x-auto">
      {/* `relative` on the scroller above is load-bearing: the sr-only spans
          in the header row are absolutely positioned, and with no positioned
          ancestor they escape this scroller's clip and stretch the whole
          document sideways once the table is wider than the viewport. */}
              <table className="w-full min-w-262.5 border-collapse">
                <caption className="sr-only">
                  Ledger entries grouped by document, newest first
                </caption>
                <thead>
                  <tr className="border-b border-line bg-canvas">
                    <th scope="col" className="table-head w-12 pl-3.5">
                      <span className="sr-only">Expand</span>
                    </th>
                    <th scope="col" className="table-head">
                      Timestamp
                    </th>
                    <th scope="col" className="table-head">
                      Actor
                    </th>
                    <th scope="col" className="table-head">
                      Role
                    </th>
                    <th scope="col" className="table-head">
                      Action
                    </th>
                    <th scope="col" className="table-head">
                      Document
                    </th>
                    <th scope="col" className="table-head">
                      Note
                    </th>
                    <th scope="col" className="table-head w-10">
                      <span className="sr-only">Download</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredGroups.map(group => (
                    <LedgerGroup
                      key={group.documentId}
                      group={group}
                      expanded={expandedDocuments.has(group.documentId)}
                      onToggle={() => toggleDocument(group.documentId)}
                      onDownload={handleExportDocument}
                      downloading={exportingDocumentId === group.documentId}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="card">
          <EmptyState
            icon={FileText}
            title="No ledger entries"
            description={
              records.length === 0
                ? 'Every approval, rejection and upload is recorded here as it happens.'
                : 'Try changing your search or action filter.'
            }
          />
        </div>
      )}
    </Page>
  )
}
