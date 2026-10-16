/**
 * Extracted from DocDetailPage, which had grown to 1,725 lines — seven
 * components and the screen itself in one file.
 */
import { Download, Eye, FileText, Loader2, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import PdfDocumentViewer from '../PdfDocumentViewer'
import {
  downloadSupportingDocument,
  fetchSupportingDocumentFile,
} from '../../services/documentDetailApi'
import type { SupportingDocumentView } from '../../types/documentDetail'
import { useDialogA11y } from '../../hooks/useDialogA11y'
import Button from '../ui/Button'

/** Which attachments the browser can render inline. */

function isPreviewableImage(contentType: string, fileName: string): boolean {
  if (contentType.startsWith('image/')) return true
  return /\.(png|jpe?g|gif|webp)$/i.test(fileName)
}

function isPreviewablePdf(contentType: string, fileName: string): boolean {
  if (contentType === 'application/pdf' || contentType.includes('pdf')) return true
  return /\.pdf$/i.test(fileName)
}

function isPreviewableText(contentType: string, fileName: string): boolean {
  if (contentType.startsWith('text/')) return true
  return /\.(txt|csv)$/i.test(fileName)
}



export default function SupportingDocsTab({
  documentId,
  documents,
  earlier = [],
}: {
  documentId: string
  documents: SupportingDocumentView[]
  /**
   * Files an earlier version carried and the current one does not. Kept, and
   * readable: they are what that version was decided on.
   */
  earlier?: SupportingDocumentView[]
}) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [previewDoc, setPreviewDoc] = useState<SupportingDocumentView | null>(null)
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewText, setPreviewText] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      if (previewUrl) window.URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const closePreview = () => {
    setPreviewDoc(null)
    setPreviewBlob(null)
    setPreviewText(null)
    setPreviewError(null)
    setPreviewLoading(false)
    if (previewUrl) {
      window.URL.revokeObjectURL(previewUrl)
      setPreviewUrl(null)
    }
  }

  const previewPanelRef = useDialogA11y(Boolean(previewDoc), closePreview)

  const handlePreview = async (doc: SupportingDocumentView) => {
    setPreviewDoc(doc)
    setPreviewBlob(null)
    setPreviewText(null)
    setPreviewError(null)
    setPreviewLoading(true)
    if (previewUrl) {
      window.URL.revokeObjectURL(previewUrl)
      setPreviewUrl(null)
    }

    try {
      const { blob, contentType } = await fetchSupportingDocumentFile(
        documentId,
        doc.id,
      )
      const resolvedType = contentType || doc.contentType

      if (isPreviewableText(resolvedType, doc.fileName)) {
        setPreviewText(await blob.text())
        return
      }

      if (
        isPreviewablePdf(resolvedType, doc.fileName) ||
        isPreviewableImage(resolvedType, doc.fileName)
      ) {
        setPreviewBlob(blob)
        setPreviewUrl(window.URL.createObjectURL(blob))
        return
      }

      // Office / unsupported — keep modal open with download fallback
      setPreviewBlob(blob)
      setPreviewUrl(window.URL.createObjectURL(blob))
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to load preview')
    } finally {
      setPreviewLoading(false)
    }
  }

  const handleDownload = async (doc: SupportingDocumentView) => {
    setDownloadingId(doc.id)
    setDownloadError(null)
    try {
      await downloadSupportingDocument(documentId, doc.id, doc.fileName)
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setDownloadingId(null)
    }
  }

  if (documents.length === 0 && earlier.length === 0) {
    return (
      <section className="card p-8 text-center">
        <FileText size={28} className="mx-auto text-content-subtle mb-3" />
        <h2 className="text-ui font-semibold text-content">No supporting documents</h2>
        <p className="mt-1 text-meta sm:text-ui text-content-muted">
          The preparer did not attach any supporting files to this submission.
        </p>
      </section>
    )
  }

  const previewContentType = previewDoc
    ? previewBlob?.type || previewDoc.contentType
    : ''
  const canShowPdf =
    previewDoc &&
    previewBlob &&
    isPreviewablePdf(previewContentType, previewDoc.fileName)
  const canShowImage =
    previewDoc &&
    previewUrl &&
    isPreviewableImage(previewContentType, previewDoc.fileName)
  const canShowText = previewDoc && previewText !== null
  const unsupportedPreview =
    previewDoc &&
    !previewLoading &&
    !previewError &&
    !canShowPdf &&
    !canShowImage &&
    !canShowText

  return (
    <>
      <section className="card overflow-hidden">
        <div className="px-4 sm:px-5 py-3.5 border-b border-line-soft">
          <h2 className="text-section font-semibold text-content">
            Supporting Documents
          </h2>
          <p className="text-meta text-content-subtle mt-0.5">
            {documents.length} file{documents.length === 1 ? '' : 's'} attached by the preparer · click a file to preview
          </p>
        </div>

        {/* An alert, not a coloured strip. A plain div above the list
            never reached anybody who was not looking at that part of the
            page at the moment it appeared - which, having just pressed a
            button further down, is most people. */}
        {downloadError && (
          <div
            role="alert"
            className="px-4 sm:px-5 py-2 text-ui text-danger-ink border-b border-danger-line bg-danger-soft"
          >
            {downloadError}
          </div>
        )}

        <ul className="divide-y divide-line-soft">
          {[...documents, ...earlier].map(doc => (
            <li key={doc.id}>
              <div className="px-4 sm:px-5 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <button
                  type="button"
                  onClick={() => handlePreview(doc)}
                  className="min-w-0 flex items-start gap-3 text-left rounded-control hover:bg-sunken -mx-1 px-1 py-1 transition-colors"
                >
                  <div className="w-9 h-9 rounded-control bg-info-soft flex items-center justify-center flex-shrink-0">
                    <FileText size={16} className="text-info-ink" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-ui font-medium text-content truncate group-hover:text-accent-ink">
                      {doc.fileName}
                    </p>
                    <p className="text-meta text-content-subtle mt-0.5">
                      {doc.sizeLabel} · uploaded {doc.uploadedAt}
                      {doc.versionsLabel ? ` · ${doc.versionsLabel}` : ''}
                      {earlier.includes(doc) ? ' · not on the current version' : ''}
                    </p>
                  </div>
                </button>
                <div className="flex items-center gap-2 self-start sm:self-auto">
                  {/* Named per file. Every row rendered "Preview" and
                      "Download" with nothing to tell them apart, so somebody
                      hearing "Preview, Download, Preview, Download" had to
                      count list items to know which attachment they were
                      about to fetch. The visible text stays short; only the
                      accessible name carries the file. */}
                  <Button
                    variant="subtle"
                    icon={<Eye size={15} aria-hidden="true" />}
                    aria-label={`Preview ${doc.fileName}`}
                    onClick={() => handlePreview(doc)}
                  >
                    Preview
                  </Button>
                  <Button
                    variant="secondary"
                    icon={<Download size={15} aria-hidden="true" />}
                    aria-label={`Download ${doc.fileName}`}
                    pending={downloadingId === doc.id}
                    onClick={() => handleDownload(doc)}
                  >
                    Download
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {previewDoc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 p-3 backdrop-blur-[2px] sm:p-6"
          onClick={closePreview}
        >
          <div
            ref={previewPanelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="supporting-preview-title"
            tabIndex={-1}
            className="flex max-h-[92vh] w-full max-w-5xl flex-col card shadow-overlay outline-none"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-line-soft px-4 py-4 sm:px-6">
              <div className="min-w-0">
                <h2
                  id="supporting-preview-title"
                  className="truncate text-pane font-semibold text-content"
                >
                  {previewDoc.fileName}
                </h2>
                <p className="mt-0.5 text-meta text-content-muted">
                  {previewDoc.sizeLabel} · Supporting document
                </p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button
                  variant="secondary"
                  icon={<Download size={14} aria-hidden="true" />}
                  pending={downloadingId === previewDoc.id}
                  onClick={() => handleDownload(previewDoc)}
                >
                  Download
                </Button>
                {/* Icon-only, so without a name it announced as "button"
                    and nothing else. Escape works, but a pointer-only screen
                    reader user - or anyone on a switch - had no named way out
                    of a modal covering the page. */}
                <button
                  type="button"
                  onClick={closePreview}
                  aria-label="Close preview"
                  className="w-8 h-8 rounded-pill flex items-center justify-center text-content-subtle hover:bg-line-soft"
                >
                  <XCircle size={16} aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-4 sm:p-6 bg-sunken min-h-[280px]">
              {previewLoading ? (
                <div className="flex items-center justify-center min-h-[280px] gap-2 text-ui text-content-muted">
                  <Loader2 size={18} className="animate-spin text-accent-ink" />
                  Loading preview...
                </div>
              ) : previewError ? (
                <div className="text-center py-16 text-ui text-danger-ink">{previewError}</div>
              ) : canShowPdf && previewBlob ? (
                <PdfDocumentViewer file={previewBlob} />
              ) : canShowImage && previewUrl ? (
                <div className="flex items-center justify-center">
                  <img
                    src={previewUrl}
                    alt={previewDoc.fileName}
                    className="max-w-full max-h-[70vh] rounded-control border border-line bg-surface object-contain"
                  />
                </div>
              ) : canShowText ? (
                <pre className="whitespace-pre-wrap break-words text-meta sm:text-ui text-content-muted bg-surface border border-line rounded-control p-4 max-h-[70vh] overflow-auto">
                  {previewText}
                </pre>
              ) : unsupportedPreview ? (
                <div className="text-center py-16 px-4">
                  <FileText size={32} className="mx-auto text-content-subtle mb-3" />
                  <p className="text-ui font-medium text-content">
                    Preview not available for this file type
                  </p>
                  <p className="text-meta text-content-muted mt-1 max-w-sm mx-auto">
                    Word and Excel files can be downloaded and opened on your device.
                  </p>
                  <Button
                    className="mt-4"
                    icon={<Download size={15} aria-hidden="true" />}
                    onClick={() => handleDownload(previewDoc)}
                  >
                    Download file
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
