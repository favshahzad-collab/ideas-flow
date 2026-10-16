import { apiJson, jsonBody } from './apiClient'

/**
 * The approval route each kind of memo starts from (fit-gap decision 7):
 * the workflow the submit screen picks first. "UPLOADED" is a memo uploaded
 * as a PDF.
 */

export interface MemoTypeRoute {
  key: string
  label: string
  templateId: string | null
  templateName: string | null
  /** False where the workflow was archived since: nothing is pre-selected. */
  templateActive: boolean
}

/** For administrators: every kind of memo and its route. */
export async function fetchMemoTypeRoutes(): Promise<MemoTypeRoute[]> {
  const { routes } = await apiJson<{ routes: MemoTypeRoute[] }>('/api/admin/memo-type-routes')
  return routes
}

export async function saveMemoTypeRoute(
  key: string,
  templateId: string | null,
): Promise<MemoTypeRoute[]> {
  const { routes } = await apiJson<{ routes: MemoTypeRoute[] }>(
    `/api/admin/memo-type-routes/${encodeURIComponent(key)}`,
    { method: 'PUT', ...jsonBody({ templateId }) },
  )
  return routes
}

/** For the submit screen: memo type key (or "UPLOADED") to workflow id. */
export async function fetchStartingRoutes(): Promise<Record<string, string>> {
  const { routes } = await apiJson<{ routes: Record<string, string> }>('/api/memo-type-routes')
  return routes
}
