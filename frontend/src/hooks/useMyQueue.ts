import { useMemo } from 'react'
import { useDocuments } from './useDocuments'
import { filterMyQueue } from '../utils/documentFilters'

export function useMyQueue() {
  const { documents, loading, error, refetch } = useDocuments()

  const pendingDocuments = useMemo(
    () => filterMyQueue(documents),
    [documents],
  )

  return { documents: pendingDocuments, loading, error, refetch }
}
