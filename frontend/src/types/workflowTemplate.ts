import type { ApiApprovalType } from './document'

export type WorkflowNodeType = 'start' | 'approval' | 'decision' | 'end'

export type DecisionField = 'title' | 'description'
export type DecisionOperator = 'contains' | 'equals' | 'startsWith'
export type EdgeBranch = 'yes' | 'no' | 'default'

export interface DecisionCondition {
  field: DecisionField
  operator: DecisionOperator
  value: string
}

export interface WorkflowNodeData {
  label?: string
  approverId?: string
  approvalType?: ApiApprovalType
  condition?: DecisionCondition
}

export interface WorkflowNode {
  id: string
  type: WorkflowNodeType
  position: { x: number; y: number }
  data: WorkflowNodeData
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
  label?: string
  branch?: EdgeBranch
}

export interface WorkflowGraph {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface WorkflowTemplateSummary {
  id: string
  name: string
  description: string | null
  isActive: boolean
  /** Set once the template is retired. Archived templates are switched off too. */
  archivedAt: string | null
  createdById: string | null
  createdAt: string
  updatedAt: string
}

export interface WorkflowTemplate extends WorkflowTemplateSummary {
  graph: WorkflowGraph
}

export interface CreateWorkflowTemplateInput {
  name: string
  description?: string
  isActive?: boolean
  graph: WorkflowGraph
}

export type UpdateWorkflowTemplateInput = Partial<CreateWorkflowTemplateInput>
