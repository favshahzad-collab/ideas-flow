import type { Edge, Node } from '@xyflow/react'
import type {
  DecisionField,
  DecisionOperator,
  WorkflowGraph,
} from '../types/workflowTemplate'

/**
 * The boundary between the canvas's node data and the shape the API stores.
 *
 * These two disagreed, silently. The canvas keeps a decision's condition as
 * three flat keys (`conditionField`, `conditionOperator`, `conditionValue`)
 * because that is what a form binds to; the API's node schema expects a
 * nested `condition: { field, operator, value }`. Zod strips unknown keys
 * rather than rejecting them, so saving a decision node returned 201, the
 * screen said "Template updated", and the condition was gone. Reloading then
 * showed "(no value set)" and the designer's own validation refused to save
 * the template again until the value was retyped — which would be dropped in
 * turn.
 *
 * Verified against the running API before this existed: sent
 * `{label, conditionField, conditionOperator, conditionValue}`, read back
 * `{label}`.
 */

const FIELDS: DecisionField[] = ['title', 'description']
const OPERATORS: DecisionOperator[] = ['contains', 'equals', 'startsWith']

function asField(value: unknown): DecisionField {
  return FIELDS.includes(value as DecisionField) ? (value as DecisionField) : 'title'
}

function asOperator(value: unknown): DecisionOperator {
  return OPERATORS.includes(value as DecisionOperator)
    ? (value as DecisionOperator)
    : 'contains'
}

/** API graph → React Flow, flattening `condition` for the form to bind to. */
export function graphToRf(graph: WorkflowGraph): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map(node => {
      const data: Record<string, unknown> = { ...node.data }
      const condition = (node.data as { condition?: unknown }).condition

      if (condition && typeof condition === 'object') {
        const c = condition as Record<string, unknown>
        data.conditionField = asField(c.field)
        data.conditionOperator = asOperator(c.operator)
        data.conditionValue = typeof c.value === 'string' ? c.value : ''
        delete data.condition
      }

      return {
        id: node.id,
        type: node.type,
        position: node.position,
        data,
      }
    }),
    edges: graph.edges.map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.label ? { label: edge.label } : {}),
      data: { branch: edge.branch },
      type: 'default',
    })),
  }
}

/** React Flow → API graph, nesting the condition the schema actually accepts. */
export function rfToGraph(nodes: Node[], edges: Edge[]): WorkflowGraph {
  return {
    nodes: nodes.map(node => {
      const data = { ...((node.data ?? {}) as Record<string, unknown>) }

      // `invalid` is presentation state for the canvas; it must not be persisted.
      delete data.invalid

      /* "Server default" is the absence of a value, not a zero. Sent as an
         empty string it coerces to 0, which the schema refuses - and refuses
         for the whole template, not for the step somebody was editing. */
      if (typeof data.slaDays !== 'number' || !Number.isFinite(data.slaDays) || data.slaDays < 1) {
        delete data.slaDays
      }
      /* `approverName` is derived from `approverId` on load. Sending it would
         let a renamed user keep a stale name inside the saved graph. */
      delete data.approverName

      const field = data.conditionField
      const operator = data.conditionOperator
      const value = data.conditionValue
      delete data.conditionField
      delete data.conditionOperator
      delete data.conditionValue

      /* Only a complete condition is sent. The API requires a non-empty
         value, so a half-filled decision would fail validation for the whole
         template rather than for the node the user is still editing. */
      if (typeof value === 'string' && value.trim()) {
        data.condition = {
          field: asField(field),
          operator: asOperator(operator),
          value: value.trim(),
        }
      }

      return {
        id: node.id,
        type: node.type as WorkflowGraph['nodes'][number]['type'],
        position: node.position,
        data: data as WorkflowGraph['nodes'][number]['data'],
      }
    }),
    edges: edges.map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(typeof edge.label === 'string' ? { label: edge.label } : {}),
      ...(edge.data && (edge.data as { branch?: string }).branch
        ? { branch: (edge.data as { branch: 'yes' | 'no' | 'default' }).branch }
        : {}),
    })),
  }
}
