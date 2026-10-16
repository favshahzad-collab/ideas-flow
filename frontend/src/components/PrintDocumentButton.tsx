import { Printer } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import type { DocumentStatus } from '../types/document'
import { recordDocumentPrint } from '../services/documentDetailApi'
import { printDocumentFile } from '../utils/downloadDocument'
import Button from './ui/Button'

/**
 * Printing the final signed memo, and nothing else.
 *
 * A memo on paper leaves the system: once it is in a folder, the file copy is
 * the record and nobody reading it can tell which version it was taken from.
 * So this refuses anything but an approved document - a half-signed draft
 * printed and filed looks exactly like an approved one - and it asks the
 * server to note who printed it.
 */

/** The reason shown while the memo is still moving through its approvals. */
const NOT_APPROVED_REASON = 'Not printable until every approver has signed'
/** The caller's own veto: the version has no file behind it yet. */
const NO_FILE_REASON = 'File not available'

export default function PrintDocumentButton({
  documentId,
  status,
  disabled = false,
  className = '',
  label = 'Print',
}: {
  documentId: string
  /** The document's status, in the normalized form every screen already holds. */
  status: DocumentStatus
  disabled?: boolean
  className?: string
  label?: string
}) {
  const [loading, setLoading] = useState(false)
  const printingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [auditWarning, setAuditWarning] = useState<string | null>(null)
  const reasonId = useId()

  const awaitingApproval = status !== 'approved'
  const blocked = disabled || awaitingApproval
  const reason = awaitingApproval ? NOT_APPROVED_REASON : NO_FILE_REASON

  const handlePrint = async (event: React.MouseEvent) => {
    event.stopPropagation()

    /*
     * The guard has to be a ref, not state.
     *
     * Two activations landing in the same tick - a double press, a stuck key,
     * an assistive tool firing twice - both ran before React re-rendered the
     * button as disabled, so both closed over `loading === false` and both
     * went through. That is two print dialogs and two DOCUMENT_PRINTED rows
     * for one memo somebody meant to print once, which an auditor reads as
     * two copies in circulation. A ref changes on the spot.
     */
    if (blocked || printingRef.current) return
    printingRef.current = true

    setLoading(true)
    setError(null)
    setAuditWarning(null)

    try {
      await printDocumentFile(documentId)
      // Recorded once the dialog is actually up, so a DOCUMENT_PRINTED row
      // means somebody was handed the memo to print rather than that they
      // pressed a button that then failed. Deliberately not awaited and never
      // fatal: a person holding an approved memo must still be able to print
      // it while the audit service is down. They are told, though - the trail
      // is what a filed copy gets checked against months later, and a print
      // missing from it is a copy nobody can account for.
      recordDocumentPrint(documentId).catch((err: unknown) => {
        setAuditWarning(
          err instanceof Error
            ? `Printed, but this print was not recorded: ${err.message}`
            : 'Printed, but this print was not recorded',
        )
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Print failed')
    } finally {
      setLoading(false)
      printingRef.current = false
    }
  }

  return (
    <div className={className}>
      <Button
        variant="ghost"
        size="sm"
        onClick={handlePrint}
        disabled={blocked}
        pending={loading}
        title={blocked ? reason : 'Print the approved memo'}
        aria-describedby={blocked ? reasonId : undefined}
        icon={<Printer size={14} aria-hidden="true" />}
      >
        {label}
      </Button>
      {blocked && (
        // Visible, not only a tooltip: a disabled button takes no focus and
        // no hover from a keyboard, so a `title` alone leaves the person who
        // most needs the reason with a dead control and no explanation.
        <p id={reasonId} className="mt-1 max-w-[180px] text-2xs text-content-muted">
          {reason}
        </p>
      )}
      <div aria-live="polite" aria-atomic="true">
        {error && (
          <p className="mt-1 max-w-[180px] truncate text-2xs text-danger-ink" title={error}>
            {error}
          </p>
        )}
        {auditWarning && (
          <p
            className="mt-1 max-w-[180px] truncate text-2xs text-warning-ink"
            title={auditWarning}
          >
            {auditWarning}
          </p>
        )}
      </div>
    </div>
  )
}
