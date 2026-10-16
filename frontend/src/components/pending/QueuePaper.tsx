import { lazy, Suspense, useEffect, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { LoadingAnnouncer, Skeleton } from '../ui/Skeleton'
import { fetchDocumentFile } from '../../services/documentDetailApi'

/**
 * pdf.js is ~440 KB. The queue is the first screen an approver opens, so it
 * is fetched only once a document is actually selected — not as part of the
 * route's own chunk. Everything above it (the list, the header, the chain)
 * renders and is usable while this is still arriving.
 */
const PdfDocumentViewer = lazy(() => import('../PdfDocumentViewer'))

export default function QueuePaper({ documentId }: { documentId: string }) {
  const [state, setState] = useState<{
    key: string
    file: Blob | null
    error: string | null
  }>({ key: '', file: null, error: null })

  useEffect(() => {
    let cancelled = false

    fetchDocumentFile(documentId, 'view')
      .then(blob => {
        if (!cancelled) setState({ key: documentId, file: blob, error: null })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({
          key: documentId,
          file: null,
          error: err instanceof Error ? err.message : 'Could not load the document file',
        })
      })

    return () => {
      cancelled = true
    }
  }, [documentId])

  const ready = state.key === documentId

  if (ready && state.error) {
    return (
      <div
        role="alert"
        className="mx-auto flex max-w-130 flex-col items-center gap-2 rounded-card border border-danger-line bg-danger-soft px-6 py-10 text-center"
      >
        <AlertCircle size={20} className="text-danger-ink" aria-hidden="true" />
        <p className="text-ui font-medium text-danger-ink">{state.error}</p>
      </div>
    )
  }

  if (!ready || !state.file) {
    return (
      <div className="mx-auto max-w-130">
        {/* The whole loading branch was aria-hidden, so a reader was told
            nothing at all while a 400 KB viewer and a file were fetched -
            silence, and then a document. Every other async screen here pairs
            its skeleton with a live region. */}
        <LoadingAnnouncer loading label="Loading the document" />
        <Skeleton
          aria-hidden="true"
          className="aspect-[1/1.294] w-full rounded-card"
        />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-130 overflow-hidden rounded-card bg-surface shadow-paper">
      <Suspense
        fallback={
          <div aria-hidden="true">
            <Skeleton className="aspect-[1/1.294] w-full" />
          </div>
        }
      >
        <PdfDocumentViewer file={state.file} />
      </Suspense>
    </div>
  )
}
