import { Loader2, Maximize2, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { pdfjs } from '../utils/pdfjs'
import { useDialogA11y } from '../hooks/useDialogA11y'

/**
 * Every page of a PDF, one under the other, for reading on a phone.
 *
 * The full viewer pages through one page at a time with Previous and Next,
 * which is what placing a signature needs and what a desktop reader is used
 * to. On a phone it meant tapping Next to read a memo people expect to
 * scroll. This is the reading half only - nothing is placed or drawn here -
 * so it can simply lay the pages out and leave zooming to the phone's own
 * pinch. "Full screen" gives the pages the whole screen to be read in.
 */
export default function PdfPageStack({ file, title }: { file: Blob; title: string }) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fullScreen, setFullScreen] = useState(false)

  useEffect(() => {
    let cancelled = false
    let task: pdfjs.PDFDocumentLoadingTask | null = null
    file
      .arrayBuffer()
      .then(buffer => {
        if (cancelled) return null
        task = pdfjs.getDocument({ data: buffer })
        return task.promise
      })
      .then(next => {
        if (next && !cancelled) setDoc(next)
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load PDF')
      })
    return () => {
      cancelled = true
      // Frees the worker's copy of the file when the version changes or the
      // page is left.
      void task?.destroy()
    }
  }, [file])

  if (error) {
    return <p className="py-10 text-center text-ui text-danger-ink">{error}</p>
  }
  if (!doc) {
    return (
      <div className="flex min-h-[280px] items-center justify-center gap-2 text-ui text-content-muted">
        <Loader2 size={18} className="animate-spin text-accent-ink" aria-hidden="true" />
        Loading preview...
      </div>
    )
  }

  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          <span className="tabular-nums">{doc.numPages}</span>{' '}
          {doc.numPages === 1 ? 'page' : 'pages'} &middot; pinch to zoom
        </p>
        <button
          type="button"
          onClick={() => setFullScreen(true)}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-control border border-line bg-surface px-3 text-meta font-medium text-content hover:bg-sunken"
        >
          <Maximize2 size={14} aria-hidden="true" />
          Full screen
        </button>
      </div>
      <Pages doc={doc} />
      {fullScreen && (
        <FullScreen title={title} onClose={() => setFullScreen(false)}>
          <Pages doc={doc} />
        </FullScreen>
      )}
    </>
  )
}

function Pages({ doc }: { doc: pdfjs.PDFDocumentProxy }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: doc.numPages }, (_, index) => (
        <PageCanvas key={index} doc={doc} pageNumber={index + 1} />
      ))}
    </div>
  )
}

/** One page, drawn to the width it is given and sharp on a high-density screen. */
function PageCanvas({ doc, pageNumber }: { doc: pdfjs.PDFDocumentProxy; pageNumber: number }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const observer = new ResizeObserver(entries => {
      const next = Math.round(entries[0].contentRect.width)
      setWidth(previous => (previous === next ? previous : next))
    })
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!width || !canvasRef.current) return
    let task: pdfjs.RenderTask | null = null
    let cancelled = false
    void doc.getPage(pageNumber).then(page => {
      if (cancelled || !canvasRef.current) return
      const ratio = window.devicePixelRatio || 1
      const fitted = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width })
      const viewport = page.getViewport({ scale: fitted.scale * ratio })
      const canvas = canvasRef.current
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.style.width = `${Math.floor(fitted.width)}px`
      canvas.style.height = `${Math.floor(fitted.height)}px`
      const context = canvas.getContext('2d')
      if (!context) return
      task = page.render({ canvasContext: context, viewport, canvas })
      task.promise.catch(() => {
        /* A cancelled render (resize, unmount) throws; nothing to show. */
      })
    })
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, pageNumber, width])

  return (
    <div ref={wrapRef} className="w-full">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Page ${pageNumber} of ${doc.numPages}`}
        className="mx-auto block rounded-control shadow-paper"
      />
    </div>
  )
}

function FullScreen({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const panelRef = useDialogA11y(true, onClose)
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${title}, full screen`}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-sunken outline-none"
    >
      <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2.5">
        <p className="min-w-0 truncate text-ui font-semibold text-content">{title}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close full screen"
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-control text-content-subtle hover:bg-sunken"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-3">{children}</div>
    </div>
  )
}
