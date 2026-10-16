import { Navigate, useLocation, useParams } from 'react-router-dom'
import { ROUTES } from '../types/routes'

/**
 * An old address, sent on to where that screen lives now. The query string
 * and hash come along, so a filtered view someone bookmarked stays filtered.
 * See `RENAMED_PATHS` for the list.
 */
export function Renamed({ to }: { to: string }) {
  const { search, hash } = useLocation()
  return <Navigate to={`${to}${search}${hash}`} replace />
}

/** `/admin/workflow-templates/<id>` - the same template, under Workflow studio. */
export function RenamedTemplate() {
  const { id = '' } = useParams<{ id: string }>()
  return <Renamed to={id === 'new' ? ROUTES.workflowStudioNew : ROUTES.workflowTemplate(id)} />
}
