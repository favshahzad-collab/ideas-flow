import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchAuditHistory } from '../services/auditApi'
import type { AuditRecord } from '../types/audit'
import { getAuditActionFilterOptions, mapApiAuditEntryToRecord } from '../utils/auditMapper'

export function useAuditLedger() {
  const [records, setRecords] = useState<AuditRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const { auditHistory } = await fetchAuditHistory()
      setRecords(auditHistory.map(mapApiAuditEntryToRecord))
    } catch (err) {
      setRecords([])
      setError(err instanceof Error ? err.message : 'Could not load the audit ledger')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // See `useAssignableUsers`: state is written only from the callbacks, and
    // only while this hook is still mounted.
    let cancelled = false

    fetchAuditHistory()
      .then(({ auditHistory }) => {
        if (cancelled) return
        setRecords(auditHistory.map(mapApiAuditEntryToRecord))
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setRecords([])
        setError(err instanceof Error ? err.message : 'Could not load the audit ledger')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const actionFilterOptions = useMemo(
    () => getAuditActionFilterOptions(records),
    [records],
  )

  return { records, actionFilterOptions, loading, error, refetch: load }
}
