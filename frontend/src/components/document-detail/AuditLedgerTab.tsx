/**
 * Extracted from DocDetailPage, which had grown to 1,725 lines — seven
 * components and the screen itself in one file.
 */
import { Download } from 'lucide-react'
import { useState } from 'react'
import { downloadDocumentAuditCsv } from '../../services/auditApi'
import type { DocumentAuditView } from '../../types/documentDetail'
import ActionBadge from '../audit/ActionBadge'
import Button from '../ui/Button'

export default function AuditLedgerTab({
  records,
  documentId,
}: {
  records: DocumentAuditView[]
  documentId: string
}) {
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const handleExport = async () => {
    setExportError(null)
    setExporting(true)
    try {
      await downloadDocumentAuditCsv(documentId)
    } catch (err) {
      /*
       * Without this the rejection escaped unhandled: the button stopped
       * spinning, no file appeared, and nothing on screen said why. For an
       * export of an approval log that reads as "there is nothing to export"
       * - which is the one thing a failed audit export must never imply.
       *
       * The audit page has caught this since it shipped. Same call, same
       * failure, two different answers depending on which screen you reached
       * it from.
       */
      setExportError(err instanceof Error ? err.message : 'Failed to download audit CSV')
    } finally {
      setExporting(false)
    }
  }

    return (
    <section className="card overflow-hidden">
      <div className="px-4 sm:px-5 py-4 border-b border-line-soft flex items-center justify-between gap-3">
        <div>
          <h2 className="text-section font-semibold text-content">Audit ledger</h2>
          <p className="text-meta text-content-subtle mt-1">Complete action history for this document</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon={<Download size={14} aria-hidden="true" />}
          pending={exporting}
          disabled={records.length === 0}
          onClick={handleExport}
        >
          Export CSV
        </Button>
        </div>

      {/* Under the button that caused it, and announced: the press that
          started this may have been the last thing the person did before
          looking away at their downloads folder. */}
      {exportError && (
        <div
          role="alert"
          className="px-4 sm:px-5 py-2 text-ui text-danger-ink border-b border-danger-line bg-danger-soft"
        >
          {exportError}
        </div>
      )}
  
      {records.length === 0 ? (
        <div className="px-4 sm:px-5 py-10 text-center text-ui text-content-muted">
          No audit records yet.
        </div>
      ) : (
        <>
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <caption className="sr-only">
              Audit ledger for this document
            </caption>
            <thead>
              <tr className="border-b border-line bg-canvas">
                  {['Date', 'Time', 'User', 'Role', 'Action', 'Comments'].map(col => (
                    <th scope="col" key={col} className="table-head">
                      {col}
                    </th>
                  ))}
              </tr>
            </thead>
            <tbody>
                {records.map(record => (
                  <tr key={record.id} className="border-b border-line-soft last:border-0">
                    <td className="px-4 py-3 text-meta text-content-muted">{record.date}</td>
                    <td className="px-4 py-3 text-meta font-mono text-content-muted">{record.time}</td>
                    <td className="px-4 py-3 text-meta text-content-muted">{record.user}</td>
                    <td className="px-4 py-3 text-meta text-content-muted">{record.role}</td>
                    <td className="px-4 py-3">
                      <ActionBadge action={record.action} />
                    </td>
                    <td className="px-4 py-3 text-meta text-content-muted max-w-xs">{record.comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
  
        <div className="md:hidden divide-y divide-line-soft">
            {records.map(record => (
              <div key={record.id} className="px-4 py-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-meta font-medium text-content-muted">{record.user}</span>
                  <span className="text-2xs text-content-subtle">{record.date}</span>
                </div>
                <p className="mt-1 text-meta text-content-muted">{record.role}</p>
                {/* `ActionBadge` exists because this exact bug was fixed in
                    the table above: every badge used to be drawn in accent, so
                    a rejection rendered green - the colour asserting the
                    opposite of the word beside it. The phone cards kept the
                    hardcoded tint, so the fix reached everybody on a laptop
                    and nobody on a phone. */}
                <span className="mt-2 inline-flex">
                  <ActionBadge action={record.action} />
                </span>

                {record.comment !== '—' && (
                  <p className="mt-2 text-meta text-content-muted leading-relaxed">{record.comment}</p>
                )}
                <p className="mt-2 text-2xs font-mono text-content-subtle">{record.time}</p>
            </div>
          ))}
        </div>
        </>
      )}
      </section>
  )
  }
