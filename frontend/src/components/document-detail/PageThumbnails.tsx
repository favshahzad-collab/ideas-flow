import { useEffect, useRef, useState } from 'react'
import { pdfjs } from '../../utils/pdfjs'
import { fetchDocumentFile } from '../../services/documentDetailApi'
import { Skeleton } from '../ui/Skeleton'
import Eyebrow from '../ui/Eyebrow'

/**
 * The page rail beside the viewer.
 *
 * These are real rendered pages, not the prototype's grey placeholder boxes —
 * a thumbnail that does not resemble its page is worse than no rail, because
 * it invites you to navigate by a picture that is lying.
 *
 * It fetches the file itself rather than sharing the viewer's blob. That is
 * one extra request for a URL the browser has just cached, and it keeps this
 * component independent of how `DocumentPreview` happens to load its copy.
 * The worker is already configured by `PdfDocumentViewer`, which the same
 * route always loads.
 */
const THUMB_WIDTH = 96

export default function PageThumbnails({
  documentId,
  page,
  onSelect,
  signedPages = [],
}: {
  documentId: string
  page: number
  onSelect: (page: number) => void
  /** Pages carrying a signature — marked with a dot. */
  signedPages?: number[]
}) {
  const [thumbs, setThumbs] = useState<{ key: string; images: string[] }>({
    key: '',
    images: [],
  })
  const [failed, setFailed] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    let cancelled = false

    async function render() {
      try {
        const blob = await fetchDocumentFile(documentId, 'view')
        const buffer = await blob.arrayBuffer()
        if (cancelled) return

        const doc = await pdfjs.getDocument({ data: buffer }).promise
        if (cancelled) return

        const canvas = canvasRef.current ?? window.document.createElement('canvas')
        canvasRef.current = canvas
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('no 2d context')

        const images: string[] = []
        for (let number = 1; number <= doc.numPages; number++) {
          const pdfPage = await doc.getPage(number)
          const base = pdfPage.getViewport({ scale: 1 })
          const viewport = pdfPage.getViewport({ scale: THUMB_WIDTH / base.width })

          canvas.width = Math.ceil(viewport.width)
          canvas.height = Math.ceil(viewport.height)
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          await pdfPage.render({ canvasContext: ctx, viewport, canvas }).promise
          if (cancelled) return
          images.push(canvas.toDataURL('image/png'))
        }

        if (!cancelled) setThumbs({ key: documentId, images })
      } catch {
        if (!cancelled) setFailed(documentId)
      }
    }

    void render()
    return () => {
      cancelled = true
    }
  }, [documentId])

  const ready = thumbs.key === documentId

  if (failed === documentId) return null

  return (
    <div className="card p-3">
      <Eyebrow className="mb-2">Pages</Eyebrow>

      {!ready ? (
        <div className="grid grid-cols-2 gap-2" aria-hidden="true">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="aspect-[1/1.3] rounded-chip" />
          ))}
        </div>
      ) : (
        <ol className="grid grid-cols-2 gap-2">
          {thumbs.images.map((src, index) => {
            const number = index + 1
            const current = number === page
            return (
              <li key={number}>
                <button
                  type="button"
                  onClick={() => onSelect(number)}
                  aria-current={current ? 'true' : undefined}
                  aria-label={`Page ${number}${signedPages.includes(number) ? ', signed' : ''}`}
                  className={`relative block w-full overflow-hidden rounded-chip border bg-canvas transition-colors ${
                    current
                      ? 'border-accent ring-1 ring-accent-line'
                      : 'border-line hover:border-line-strong'
                  }`}
                >
                  <img
                    src={src}
                    alt=""
                    className="block aspect-[1/1.3] w-full object-cover object-top"
                  />
                  {signedPages.includes(number) && (
                    <span
                      aria-hidden="true"
                      className="absolute bottom-1 left-1 h-1.5 w-1.5 rounded-pill bg-accent-mark"
                    />
                  )}
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0.5 right-1 font-mono text-eyebrow text-content-subtle"
                  >
                    {number}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
