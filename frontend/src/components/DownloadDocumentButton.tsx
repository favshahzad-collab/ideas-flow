import { Download, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { downloadDocumentFile } from '../utils/downloadDocument'

export default function DownloadDocumentButton({
  documentId,
  versionNumber,
  disabled = false,
  className = '',
  label = 'Download',
}: {
  documentId: string
  versionNumber: number
  disabled?: boolean
  className?: string
  label?: string
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleDownload = async (event: React.MouseEvent) => {
    event.stopPropagation()

    if (disabled || loading) return

    setLoading(true)
    setError(null)

    try {
      await downloadDocumentFile(
        documentId,
        `document-${documentId.slice(0, 8)}-v${versionNumber}.pdf`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={handleDownload}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        title={disabled ? 'File not available' : 'Download document'}
        className="inline-flex items-center gap-1.5 rounded-control px-2.5 py-1.5
                   text-meta font-medium text-content-muted transition-colors
                   hover:bg-sunken hover:text-content active:bg-line-soft
                   disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? (
          <Loader2 size={13} className="animate-spin" aria-hidden="true" />
        ) : (
          <Download size={13} aria-hidden="true" />
        )}
        {label}
      </button>
      <div aria-live="polite" aria-atomic="true">
        {error && (
          <p className="mt-1 max-w-[140px] truncate text-2xs text-danger-ink" title={error}>
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
