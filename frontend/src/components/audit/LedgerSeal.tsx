import { useEffect, useState } from 'react'
import { AlertTriangle, Download, Loader2, Lock, ShieldCheck, ShieldQuestion } from 'lucide-react'
import Button from '../ui/Button'
import Eyebrow from '../ui/Eyebrow'
import { downloadLedgerExport, fetchLedgerSummary, verifyLedger } from '../../services/auditApi'
import type { LedgerReport, LedgerSummary } from '../../services/auditApi'
import { formatRelativeTime } from '../../utils/format'

/**
 * What the seal on the audit trail actually says.
 *
 * The screen this sits on is headed "Audit ledger" and its whole value is
 * being believed, so it has to be careful about the difference between two
 * claims that look alike:
 *
 *   "sealed"   - every record carries a digest over its own contents and the
 *                digest before it. This is known from a count.
 *   "verified" - those digests were read back and recomputed, just now, and
 *                they still agree. This is only known after doing the work.
 *
 * At rest it says the first. It says the second only after somebody has
 * pressed the button, and it names the moment it was checked - because a
 * verification is a statement about a point in time, and a page that goes on
 * showing a green tick from an hour ago is asserting something it does not
 * know.
 */

const DIGEST_HEAD = 16

function Digest({ hash }: { hash: string }) {
  return (
    <span className="min-w-0">
      <Eyebrow as="span" className="mr-1.5">
        Tip
      </Eyebrow>
      {/* Truncated to the head, full value in the title: sixteen hex
          characters is enough to compare two by eye, and a reader who needs
          all of it needs to copy it rather than read it. */}
      <span
        className="font-mono text-data tabular-nums text-content-muted"
        title={hash}
      >
        {hash.slice(0, DIGEST_HEAD)}…
      </span>
    </span>
  )
}

function Verdict({ report }: { report: LedgerReport }) {
  if (!report.intact && report.break) {
    return (
      <p
        role="alert"
        className="mt-3 flex gap-2 rounded-control border border-danger-line bg-danger-soft px-3 py-2.5 text-meta leading-relaxed text-danger-ink"
      >
        <AlertTriangle size={14} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
        <span>
          <strong className="font-semibold">
            The trail has been altered at position {report.break.seq}.
          </strong>{' '}
          {report.break.detail}
          {report.break.recordId && (
            <>
              {' '}
              Record <span className="font-mono">{report.break.recordId}</span>.
            </>
          )}{' '}
          Everything before it still reads clean: {report.checked} record
          {report.checked === 1 ? '' : 's'} were recomputed and matched.
        </span>
      </p>
    )
  }

  return (
    <p className="mt-3 flex gap-2 rounded-control bg-canvas px-3 py-2.5 text-meta leading-relaxed text-content-muted">
      <ShieldCheck size={14} aria-hidden="true" className="mt-0.5 flex-shrink-0 text-accent-ink" />
      <span>
        {report.checked} record{report.checked === 1 ? '' : 's'} read back and
        recomputed, and every one matched what was sealed. Checked{' '}
        {formatRelativeTime(report.checkedAt)}, in {report.durationMs}ms.
        {report.unsealed > 0 && (
          <> {report.unsealed} written since are not sealed yet.</>
        )}
      </span>
    </p>
  )
}

export default function LedgerSeal({
  canVerify,
  canExport = canVerify,
}: {
  canVerify: boolean
  /** The export is its own power, given separately from verifying. */
  canExport?: boolean
}) {
  const [summary, setSummary] = useState<LedgerSummary | null>(null)
  const [report, setReport] = useState<LedgerReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    let cancelled = false

    fetchLedgerSummary()
      .then(result => {
        if (!cancelled) setSummary(result)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not read the ledger seal.')
      })

    return () => {
      cancelled = true
    }
  }, [])

  const handleVerify = async () => {
    setError(null)
    setVerifying(true)
    try {
      const result = await verifyLedger()
      setReport(result)
      // The verification sealed anything outstanding on its way through, so
      // the counts it came back with are newer than the ones on screen.
      setSummary(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not verify the chain.')
    } finally {
      setVerifying(false)
    }
  }

  const handleExport = async () => {
    setError(null)
    setExporting(true)
    try {
      await downloadLedgerExport()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not export the ledger.')
    } finally {
      setExporting(false)
    }
  }

  const sealed = summary?.sealed ?? 0
  const unsealed = summary?.unsealed ?? 0

  return (
    <section className="card mb-4 px-3.5 py-3" aria-label="Ledger seal">
      <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
          {!summary && !error && (
            <span className="text-meta text-content-subtle">Reading the seal…</span>
          )}

          {summary && (
            <>
              <span className="flex items-center gap-1.5">
                {/* Never the colour alone: the icon and the word carry it, and
                    the tone only reinforces what both already say. */}
                {report?.intact === false ? (
                  <AlertTriangle size={14} aria-hidden="true" className="text-danger-ink" />
                ) : report?.intact ? (
                  <ShieldCheck size={14} aria-hidden="true" className="text-accent-ink" />
                ) : sealed === 0 ? (
                  <ShieldQuestion size={14} aria-hidden="true" className="text-content-subtle" />
                ) : (
                  <Lock size={14} aria-hidden="true" className="text-content-subtle" />
                )}
                <span className="text-ui font-medium text-content">
                  {report?.intact === false
                    ? 'Ledger broken'
                    : report?.intact
                      ? 'Ledger verified'
                      : sealed === 0
                        ? 'Nothing sealed yet'
                        : `Sealed to ${sealed}`}
                </span>
              </span>

              {sealed > 0 && (
                <span className="text-meta text-content-subtle">
                  {sealed} record{sealed === 1 ? '' : 's'} chained
                  {unsealed > 0 && (
                    <span
                      title="Records are sealed by a sweep shortly after they are written, not in the transaction that wrote them."
                    >
                      {' '}
                      · {unsealed} waiting
                    </span>
                  )}
                  {summary.tip?.sealedAt && (
                    <> · last sealed {formatRelativeTime(summary.tip.sealedAt)}</>
                  )}
                </span>
              )}

              {summary.tip && <Digest hash={summary.tip.hash} />}
            </>
          )}
        </div>

        {(canVerify || canExport) && (
          <div className="flex flex-wrap items-center gap-2">
            {canVerify && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleVerify()}
              disabled={verifying}
              icon={
                verifying ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <ShieldCheck size={14} />
                )
              }
            >
              {verifying ? 'Reading the ledger…' : 'Verify ledger'}
            </Button>
            )}
            {/* For an auditor: the whole chain as a file they check with a
                standalone script, without this application. */}
            {canExport && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleExport()}
              pending={exporting}
              icon={<Download size={14} aria-hidden="true" />}
            >
              Export for auditor
            </Button>
            )}
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-meta text-danger-ink">
          {error}
        </p>
      )}

      {report && !error && <Verdict report={report} />}

      {!report && !error && summary && sealed === 0 && unsealed > 0 && (
        <p className="mt-3 text-meta leading-relaxed text-content-subtle">
          {unsealed} record{unsealed === 1 ? '' : 's'} are written and waiting
          for the next sweep. Nothing is lost: sealing is what ties them to each
          other, and it runs every half minute.
        </p>
      )}
    </section>
  )
}
