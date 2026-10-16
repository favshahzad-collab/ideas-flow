/**
 * Extracted from DocDetailPage, which had grown to 1,725 lines — seven
 * components and the screen itself in one file.
 */
import {
  CheckCircle,
  Download,
  Loader2,
  RotateCcw,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import PdfDocumentViewer from '../PdfDocumentViewer'
import PdfPageStack from '../PdfPageStack'
import { PHONE_QUERY, useMediaQuery } from '../../hooks/useMediaQuery'
import Button from '../ui/Button'
import { fetchDocumentFile } from '../../services/documentDetailApi'
import type { PdfPlacement } from '../../utils/pdfCoordinates'

export default function DocumentPreview({
  documentId,
  fileName,
  versionNumber,
  isDeleted = false,
  canApprove,
  canResubmit,
  resubmitLoading,
  resubmitLabel = 'Upload, sign & resubmit',
  pendingActionType,
  onSignClick,
  onRequestRevision,
  onReject,
  onResubmit,
  onDownload,
  page,
  onPageChange,
  signHere = null,
}: {
  documentId: string
  fileName: string
  versionNumber: number
  isDeleted?: boolean
  canApprove?: boolean
  canResubmit?: boolean
  resubmitLoading?: boolean
  /**
   * What the upload control says.
   *
   * A memo typed in the portal is corrected in the editor above this card, so
   * an upload button reading "Upload, sign & resubmit" competes with it and
   * looks like the way the job is done. It is still offered - a preparer with
   * a signed scan to put up instead should not be stuck - but it says what it
   * is: the other option.
   */
  resubmitLabel?: string
  pendingActionType?: string | null
  onSignClick?: () => void
  onRequestRevision?: () => void
  onReject?: () => void
  onResubmit?: (file: File) => void
  onDownload?: () => void
  /** Controlled paging, so the detail screen's thumbnail rail can drive
      the viewer. Omit both and the viewer keeps its own controls. */
  page?: number
  onPageChange?: (page: number) => void
  /** Where the reader signs, marked on the page while it is their turn. */
  signHere?: { placement: PdfPlacement; name: string; onSign: () => void } | null
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  // One state slot tagged with the version it belongs to, so "loading" and
  // "stale" are derived rather than reset by the effect before it refetches.
  const versionKey = `${documentId}:${versionNumber}`
  const [loaded, setLoaded] = useState<{
    key: string
    blob: Blob | null
    error: string | null
  } | null>(null)

  const isCurrent = loaded?.key === versionKey
  const pdfFile = isCurrent ? loaded.blob : null
  const error = isCurrent ? loaded.error : null
  const loading = !isDeleted && !isCurrent
  const isPhone = useMediaQuery(PHONE_QUERY)

  useEffect(() => {
    if (isDeleted) return

    let cancelled = false

    fetchDocumentFile(documentId, 'view')
      .then(blob => {
        if (!cancelled) setLoaded({ key: versionKey, blob, error: null })
      })
      .catch(err => {
        if (cancelled) return
        setLoaded({
          key: versionKey,
          blob: null,
          error: err instanceof Error ? err.message : 'Failed to load PDF',
        })
      })

    return () => {
      cancelled = true
    }
  }, [documentId, versionKey, isDeleted])

  if (isDeleted) {
    return (
      <section className="card overflow-hidden">
        <div className="px-4 sm:px-5 py-10 text-center">
          <Trash2 size={32} className="mx-auto text-content-subtle mb-3" />
          <h2 className="text-section font-semibold text-content">
            Document deleted by preparer
          </h2>
          <p className="mt-2 text-meta sm:text-ui text-content-muted max-w-md mx-auto">
            The previous file was removed. The record and its audit ledger entries remain.
            {canResubmit
              ? ' Upload a new PDF to restart the same approval workflow.'
              : ''}
          </p>
          {canResubmit && onResubmit && (
            <div className="mt-5 flex flex-col items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={event => {
                  const file = event.target.files?.[0]
                  if (file) onResubmit(file)
                  event.target.value = ''
                }}
              />
          <Button
            size="lg"
            icon={<Upload size={15} aria-hidden="true" />}
            pending={resubmitLoading}
            onClick={() => fileInputRef.current?.click()}
          >
            {resubmitLoading ? 'Uploading…' : resubmitLabel}
          </Button>
        </div>
          )}
        </div>
      </section>
    )
  }

  return (
    <section className="card overflow-hidden">
      <div className="px-4 sm:px-5 py-3.5 sm:py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-line-soft">
        <div className="min-w-0">
          <h2 className="text-section font-semibold text-content">
            Preview
          </h2>
          <span className="text-meta text-content-subtle">
            {fileName} · v{versionNumber}
              </span>
            </div>
        <div className="flex flex-wrap gap-2 flex-shrink-0">
          {canApprove && onSignClick && (
            <Button icon={<CheckCircle size={15} aria-hidden="true" />} onClick={onSignClick}>
              {pendingActionType === 'REVIEWER' ? 'Sign & complete review' : 'Sign & approve'}
            </Button>
          )}
          {canApprove && onRequestRevision && (
            <button
              type="button"
              onClick={onRequestRevision}
              className="inline-flex items-center justify-center gap-2 h-9 px-4 rounded-control border border-revision-line bg-revision-soft text-revision-ink text-meta sm:text-ui font-medium hover:bg-revision-soft"
            >
              <RotateCcw size={15} />
              Request Revision
            </button>
          )}
          {canApprove && onReject && (
            <button
              type="button"
              onClick={onReject}
              className="inline-flex items-center justify-center gap-2 h-9 px-4 rounded-control border border-danger-line bg-danger-soft text-danger-ink text-meta sm:text-ui font-medium hover:bg-danger-line"
            >
              <XCircle size={15} />
              Reject
            </button>
          )}
          {canResubmit && onResubmit && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={event => {
                  const file = event.target.files?.[0]
                  if (file) onResubmit(file)
                  event.target.value = ''
                }}
              />
              <Button
                icon={<Upload size={15} aria-hidden="true" />}
                pending={resubmitLoading}
                onClick={() => fileInputRef.current?.click()}
              >
                {resubmitLoading ? 'Uploading…' : resubmitLabel}
              </Button>
            </>
          )}
          {onDownload && (
              <Button
                variant="secondary"
                aria-label="Download document"
                icon={<Download size={15} aria-hidden="true" />}
                onClick={onDownload}
              />
          )}
            </div>
          </div>

      <div className="p-4 bg-sunken">
        {loading ? (
          <div className="flex items-center justify-center min-h-[280px] gap-2 text-ui text-content-muted">
            <Loader2 size={18} className="animate-spin text-accent-ink" />
            Loading preview...
          </div>
        ) : error ? (
          <div className="flex items-center justify-center min-h-[280px] text-ui text-danger-ink">
            {error}
          </div>
        ) : isPhone && pdfFile ? (
          /* A phone reads the memo by scrolling it; signing happens in the
             signing dialog, which keeps the full viewer. */
          <PdfPageStack file={pdfFile} title={fileName} />
        ) : (
          <PdfDocumentViewer
            file={pdfFile}
            page={page}
            onPageChange={onPageChange}
            signHere={signHere}
          />
        )}
        </div>
      </section>
  )
}
