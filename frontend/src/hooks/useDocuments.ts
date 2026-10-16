import { useCallback, useEffect, useState } from 'react'
import { useCurrentUser } from '../contexts/currentUser'
import { fetchDocumentsCached, invalidateDocumentsCache } from '../services/documentsApi'
import type { ApiDocument, DashboardDocument } from '../types/document'
import { mapApiDocumentToDashboard } from '../utils/documentMapper'
import { formatFullName } from '../utils/user'

interface UseDocumentsResult {
  documents: DashboardDocument[]
  currentUserId: string
  userName: string
  loading: boolean
  error: string | null
  refetch: () => void
}

export function useDocuments(): UseDocumentsResult {
  const { user, loading: userLoading, error: userError } = useCurrentUser()
  const [documents, setDocuments] = useState<ApiDocument[]>([])
  const [documentsLoading, setDocumentsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (force = false) => {
    setDocumentsLoading(true)
    setError(null)

    try {
      const { documents: apiDocuments } = await fetchDocumentsCached(force)
      setDocuments(apiDocuments)
    } catch (err) {
      setDocuments([])
      setError(err instanceof Error ? err.message : 'Failed to load documents')
    } finally {
      setDocumentsLoading(false)
    }
  }, [])

  useEffect(() => {
    // See `useAssignableUsers`: state is written only from the callbacks, and
    // only while this hook is still mounted.
    let cancelled = false

    fetchDocumentsCached()
      .then(({ documents: apiDocuments }) => {
        if (cancelled) return
        setDocuments(apiDocuments)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setDocuments([])
        setError(err instanceof Error ? err.message : 'Failed to load documents')
      })
      .finally(() => {
        if (!cancelled) setDocumentsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const refetch = useCallback(() => {
    invalidateDocumentsCache()
    load(true)
  }, [load])

  const currentUserId = user?.id ?? ''
  const userName = user ? formatFullName(user.firstName, user.lastName) : ''
  const mappedDocuments = currentUserId
    ? documents.map(doc => mapApiDocumentToDashboard(doc))
    : []

  return {
    documents: mappedDocuments,
    currentUserId,
    userName,
    loading: userLoading || documentsLoading,
    error: userError ?? error,
    refetch,
  }
}
