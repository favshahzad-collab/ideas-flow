import { useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, CheckCircle, Inbox } from 'lucide-react'
import { useMyQueue } from '../hooks/useMyQueue'
import { rejectDocument, requestRevision } from '../services/approvalApi'
import { ROUTES } from '../types/routes'
import { Page, PageHeader, EmptyState } from '../components/ui/Page'
import { LoadingAnnouncer, Skeleton, SkeletonPageHeader } from '../components/ui/Skeleton'
import Button from '../components/ui/Button'
import QueueList from '../components/pending/QueueList'
import QueueDetail from '../components/pending/QueueDetail'
import ActionDialog, { type ActionType } from '../components/pending/ActionDialog'
import { useQueueKeyboard, scrollRowIntoView } from '../hooks/useQueueKeyboard'
import { useMediaQuery, SPLIT_VIEW_QUERY } from '../hooks/useMediaQuery'
import { buildQueue, countByTab, describeEmptyQueue, type QueueTab } from '../utils/pendingQueue'

export default function MyQueuePage() {
  const navigate = useNavigate()
  const { documents, loading, error, refetch } = useMyQueue()
  const isSplit = useMediaQuery(SPLIT_VIEW_QUERY)

  const [tab, setTab] = useState<QueueTab>('all')
  const [activeAction, setActiveAction] = useState<{
    type: ActionType
    documentId: string
  } | null>(null)
  // The document currently being acted on, rather than a page-wide boolean —
  // one rejection used to disable every button on the screen.
  const [busyId, setBusyId] = useState<string | null>(null)

  const counts = useMemo(() => countByTab(documents), [documents])
  const visible = useMemo(
    () => buildQueue(documents, { tab, search: '', sort: 'oldest' }),
    [documents, tab],
  )

  /**
   * The cursor is stored as the document's id, not its index. An index goes
   * stale the moment the queue changes underneath it — approve the third of
   * five and index 2 silently becomes a different document, which is exactly
   * the row a keyboard user is about to press A on.
   */
  const [cursorId, setCursorId] = useState<string | null>(null)
  const cursor = Math.max(
    0,
    visible.findIndex(doc => doc.id === cursorId),
  )
  const selected = visible[cursor] ?? null

  const listScrollRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])
  const detailRef = useRef<HTMLDivElement>(null)

  const moveCursor = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(visible.length - 1, index))
      const next = visible[clamped]
      if (!next) return
      setCursorId(next.id)
      scrollRowIntoView(listScrollRef.current, rowRefs.current[clamped])
    },
    [visible],
  )

  const openAction = useCallback(
    (type: ActionType) => {
      if (!selected) return
      setActiveAction({ type, documentId: selected.id })
    },
    [selected],
  )

  const handlers = useMemo(
    () => ({
      onNext: () => moveCursor(cursor + 1),
      onPrevious: () => moveCursor(cursor - 1),
      // Approving means signing, and signing happens on the document.
      onApprove: () => selected && navigate(ROUTES.document(selected.id)),
      onRevision: () => openAction('revision'),
      onReject: () => openAction('reject'),
      onFocusDetail: () => detailRef.current?.focus(),
    }),
    [cursor, moveCursor, navigate, openAction, selected],
  )

  // Shortcuts are live only where there is a split view to drive and a dialog
  // is not already holding the keyboard.
  useQueueKeyboard(isSplit && visible.length > 0 && activeAction === null, handlers)

  const activeDocument = documents.find(d => d.id === activeAction?.documentId)

  const handleConfirm = async (comment: string) => {
    if (!activeAction) return
    const { type, documentId } = activeAction

    setBusyId(documentId)
    try {
      if (type === 'reject') {
        await rejectDocument(documentId, comment)
      } else {
        await requestRevision(documentId, comment)
      }
      // Only close once it has actually succeeded.
      setActiveAction(null)
      refetch()
    } finally {
      setBusyId(null)
    }
  }

  const selectRow = useCallback(
    (index: number) => {
      const doc = visible[index]
      if (!doc) return
      // Below the split-view breakpoint there is no pane to fill, so a tap
      // goes straight to the document rather than selecting invisibly.
      if (!isSplit) {
        navigate(ROUTES.document(doc.id))
        return
      }
      setCursorId(doc.id)
    },
    [isSplit, navigate, visible],
  )

  if (loading) {
    return (
      <Page>
        <SkeletonPageHeader titleWidth="12rem" />
        <div aria-hidden="true" className="space-y-3">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-20 rounded-card" />
          ))}
        </div>
        <LoadingAnnouncer loading label="Loading your queue" />
      </Page>
    )
  }

  if (error) {
    return (
      <Page>
        <PageHeader title="My queue" />
        <div className="card">
          <EmptyState
            icon={AlertCircle}
            title="Could not load your queue"
            description={error}
            action={
              <Button variant="secondary" size="sm" onClick={refetch}>
                Try again
              </Button>
            }
          />
        </div>
      </Page>
    )
  }

  if (visible.length === 0) {
    const empty = describeEmptyQueue({ tab, search: '', totalPending: documents.length })
    return (
      <Page>
        {/* Without this the page has no <h1>: the heading QueueList carries
            only exists once there is a queue to draw, so an empty one - which
            is every deployment on its first day - started at <h2>. */}
        <PageHeader title="My queue" />
        <div className="card">
          <EmptyState
            icon={documents.length === 0 ? CheckCircle : Inbox}
            title={empty.title}
            description={empty.description}
            action={
              documents.length > 0 && tab !== 'all' ? (
                <Button variant="secondary" size="sm" onClick={() => setTab('all')}>
                  Show everything
                </Button>
              ) : undefined
            }
          />
        </div>
      </Page>
    )
  }

  return (
    /* Deliberately not wrapped in <Page>: this screen fills the viewport and
       each pane scrolls on its own, which is the point of a split view. It is
       the one screen whose content column does not line up with the others. */
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <QueueList
        ref={listScrollRef}
        documents={visible}
        counts={counts}
        tab={tab}
        onTab={value => {
          setTab(value)
          setCursorId(null)
        }}
        cursor={isSplit ? cursor : -1}
        onCursor={selectRow}
        rowRefs={rowRefs}
      />

      {selected && (
        <div className="hidden min-h-0 flex-1 lg:flex">
          <QueueDetail
            ref={detailRef}
            document={selected}
            busy={busyId === selected.id}
            onApprove={id => navigate(ROUTES.document(id))}
            onRevision={id => setActiveAction({ type: 'revision', documentId: id })}
            onReject={id => setActiveAction({ type: 'reject', documentId: id })}
          />
        </div>
      )}

      <ActionDialog
        open={activeAction !== null}
        type={activeAction?.type ?? 'reject'}
        documentTitle={activeDocument?.title ?? ''}
        onCancel={() => setActiveAction(null)}
        onConfirm={handleConfirm}
      />
    </div>
  )
}
