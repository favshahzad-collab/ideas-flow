import type { ApiApprovalType } from '../types/document'
import type { WorkflowGraph } from '../types/workflowTemplate'

/**
 * A template's route, as the submit screen previews it.
 *
 * The route itself comes from the server (`fetchTemplateRoute`), compiled by
 * the same code submission runs. A copy of the compiler used to live here, to
 * save a round trip per keystroke, and it drifted from the server's: it took
 * the Yes branch when a condition failed with no No branch, ordered branches
 * that rejoin by a plain walk, and dropped an approval with nobody on it where
 * submission refuses it. The preview could show an approver the memo would
 * never reach - so it asks now, a moment after the preparer stops typing.
 */

export interface CompiledTemplateStep {
  assignedUserId: string
  approvalType: ApiApprovalType
}

/** True when the graph contains a decision node — the preview is then title-dependent. */
export function templateHasBranching(graph: WorkflowGraph): boolean {
  return graph.nodes.some(node => node.type === 'decision')
}
