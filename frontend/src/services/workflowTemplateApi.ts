import type {
  CreateWorkflowTemplateInput,
  UpdateWorkflowTemplateInput,
  WorkflowTemplate,
  WorkflowTemplateSummary,
} from '../types/workflowTemplate'
import { apiJson, jsonBody } from './apiClient'
import type { CompiledTemplateStep } from '../utils/workflowTemplateCompile'

/**
 * Admin: the templates in use, active and inactive. `archived: true` gives the
 * archived ones instead - never both at once.
 */
export async function fetchAdminTemplates(
  filter: { isActive?: boolean; archived?: boolean } = {}
): Promise<WorkflowTemplateSummary[]> {
  const qs = new URLSearchParams()
  if (typeof filter.isActive === 'boolean') {
    qs.set('isActive', String(filter.isActive))
  }
  if (filter.archived) qs.set('archived', 'true')
  const url = `/api/admin/workflow-templates${qs.toString() ? `?${qs.toString()}` : ''}`
  const data = await apiJson<{ templates: WorkflowTemplateSummary[] }>(url)
  return data.templates
}

export async function fetchAdminTemplate(id: string): Promise<WorkflowTemplate> {
  return await apiJson<WorkflowTemplate>(`/api/admin/workflow-templates/${id}`)
}

export async function createAdminTemplate(
  input: CreateWorkflowTemplateInput
): Promise<WorkflowTemplate> {
  return await apiJson<WorkflowTemplate>('/api/admin/workflow-templates', {
    method: 'POST',
    ...jsonBody(input),
  })
}

export async function updateAdminTemplate(
  id: string,
  input: UpdateWorkflowTemplateInput
): Promise<WorkflowTemplate> {
  return await apiJson<WorkflowTemplate>(`/api/admin/workflow-templates/${id}`, {
    method: 'PATCH',
    ...jsonBody(input),
  })
}

/** Retire a template. It is kept, hidden and switched off; there is no delete. */
export async function archiveAdminTemplate(id: string): Promise<WorkflowTemplate> {
  return await apiJson<WorkflowTemplate>(`/api/admin/workflow-templates/${id}/archive`, {
    method: 'POST',
  })
}

/** Bring an archived template back, switched off. */
export async function restoreAdminTemplate(id: string): Promise<WorkflowTemplate> {
  return await apiJson<WorkflowTemplate>(`/api/admin/workflow-templates/${id}/restore`, {
    method: 'POST',
  })
}

/** Public (authenticated): list only active templates — for the submit page. */
export async function fetchActiveTemplates(): Promise<WorkflowTemplateSummary[]> {
  const data = await apiJson<{ templates: WorkflowTemplateSummary[] }>(
    '/api/workflow-templates'
  )
  return data.templates
}

export async function fetchActiveTemplate(id: string): Promise<WorkflowTemplate> {
  return await apiJson<WorkflowTemplate>(`/api/workflow-templates/${id}`)
}

/**
 * The route a template gives this memo, from the compiler submission uses.
 * Decision nodes branch on the title and description, so it is asked again as
 * those change.
 */
export async function fetchTemplateRoute(
  id: string,
  memo: { title: string; description: string },
): Promise<CompiledTemplateStep[]> {
  const data = await apiJson<{ steps: CompiledTemplateStep[] }>(
    `/api/workflow-templates/${id}/route`,
    { method: 'POST', ...jsonBody(memo) },
  )
  return data.steps.map(step => ({
    assignedUserId: step.assignedUserId,
    approvalType: step.approvalType,
  }))
}
