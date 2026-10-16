import { useCallback, useEffect, useState } from 'react'
import { useCurrentUser } from '../contexts/currentUser'
import {
  createDocumentComment,
  fetchDocumentAuditHistory,
  fetchDocumentById,
  fetchDocumentComments,
  fetchDocumentWorkflow,
} from '../services/documentDetailApi'
import type { DocumentDetailData } from '../types/documentDetail'
import { assembleDocumentDetailData } from '../utils/documentDetailMapper'
import { canSkipStep } from '../utils/documentActions'
import { isCancelledByAdministrator } from '../utils/cancellation'

function resolvePendingActionType(
  workflow: Awaited<ReturnType<typeof fetchDocumentWorkflow>>,
  userId: string,
) {
  /* Once the server has said this reader may act, the step to name is simply
     the one the memo is sitting at. Matching on their own id again would leave
     a delegate with no approval type, and the button that reads "Complete
     review" for a reviewer and "Approve" for an approver with neither. */
  const step = (workflow.workflow ?? []).find(item =>
    workflow.viewer?.canAct
      ? item.status === 'PENDING'
      : item.status === 'PENDING' && item.assignedUser.id === userId,
  )
  return step?.approvalType ?? null
}

/**
 * May this person act on the step the memo is sitting at.
 *
 * The server's answer first. It used to be worked out here, by looking for
 * the reader's own id on a pending step - which is right for everybody except
 * the one group that rule exists for: somebody covering another person's
 * approvals never matches it, so a delegate who had been emailed that a memo
 * needed them opened it and was offered nothing to press. The server would
 * have accepted their approval; the screen never asked for it.
 *
 * The old reading stays as the fallback for a client left open across a
 * deploy of the server that does not send `viewer` yet. It is wrong for a
 * delegate, which is exactly what it was before, and right for everybody else.
 */
function resolveCanApprove(
  documentStatus: string,
  preparerId: string,
  workflow: Awaited<ReturnType<typeof fetchDocumentWorkflow>>,
  userId: string,
): boolean {
  if (workflow.viewer) return workflow.viewer.canAct

  if (documentStatus !== 'PENDING_REVIEW') return false
  if (preparerId === userId) return false

  return (workflow.workflow ?? []).some(
    step => step.status === 'PENDING' && step.assignedUser.id === userId,
  )
}

export function useDocumentDetail(documentId: string) {
  const { user, loading: userLoading, error: userError } = useCurrentUser()

  // One state slot tagged with what it was loaded for. `loading` and `error`
  // are then derived, instead of being reset at the top of the loader — which
  // is what made the load a cascade of renders when called from an effect.
  const [loaded, setLoaded] = useState<{
    key: string
    data: DocumentDetailData | null
    error: string | null
  } | null>(null)
  const [commentLoading, setCommentLoading] = useState(false)

  const key = `${documentId}:${user?.id ?? ''}`

  /**
   * Pure fetch: returns the result rather than writing it. Keeping the state
   * write out of here is what lets the effect and the imperative refetch share
   * one implementation without either of them setting state indirectly.
   */
  const fetchDetail = useCallback(async (): Promise<{
    data: DocumentDetailData | null
    error: string | null
  }> => {
    if (!user) return { data: null, error: null }

    try {
      const [document, workflow, comments, auditHistory] = await Promise.all([
        fetchDocumentById(documentId),
        fetchDocumentWorkflow(documentId),
        fetchDocumentComments(documentId),
        fetchDocumentAuditHistory(documentId),
      ])

      const assembled = assembleDocumentDetailData(
        document,
        workflow,
        comments,
        auditHistory,
      )

      const canApprove = resolveCanApprove(
        workflow.documentStatus,
        document.preparerId,
        workflow,
        user.id,
      )

      return {
        error: null,
        data: {
          ...assembled,
          canApprove,
          actingFor: canApprove ? (workflow.viewer?.onBehalfOf ?? null) : null,
          pendingActionType: canApprove
            ? resolvePendingActionType(workflow, user.id)
            : null,
          canResubmit:
            document.preparerId === user.id &&
            (workflow.documentStatus === 'REVISION_REQUESTED' ||
              // A rejection closes that cycle, not the memo: it can go round
              // again as a new version - unless its preparer left it as
              // rejected, which is final.
              (workflow.documentStatus === 'REJECTED' && !document.rejectionClosedAt) ||
              // Withdrawn by the preparer, yes; cancelled by an
              // administrator, never - that is final.
              (workflow.documentStatus === 'DELETED' &&
                !isCancelledByAdministrator(document))),
          canSkipStep: canSkipStep({
            // What the server says this deployment allows, asked rather than
            // compiled in: an administrator changes it at runtime, and the
            // build-time flag that used to gate this left the Workflow policy
            // screen offering a switch that turned nothing on.
            // This memo's own rule - the one its cycle started with - so a
            // policy changed since does not offer a Skip the server refuses.
            allowStepSkip:
              workflow.policy?.allowStepSkip ?? user.workflowPolicy.allowStepSkip,
            preparerId: document.preparerId,
            userId: user.id,
            documentStatus: workflow.documentStatus,
            workflowStatus: workflow.workflowStatus,
            steps: workflow.workflow ?? [],
          }),
        },
      }
    } catch (err) {
      return {
        data: null,
        error: err instanceof Error ? err.message : 'Failed to load document',
      }
    }
  }, [documentId, user])

  useEffect(() => {
    if (userLoading || !user) return

    let cancelled = false

    void (async () => {
      const result = await fetchDetail()
      if (!cancelled) setLoaded({ key, ...result })
    })()

    return () => {
      cancelled = true
    }
  }, [fetchDetail, key, user, userLoading])

  /**
   * Clearing first is what puts the screen back into its loading state, and
   * it is safe here because every caller is an event handler — a retry click,
   * or the tail of an action that changed the document.
   */
  const refetch = useCallback(async () => {
    setLoaded(null)
    const result = await fetchDetail()
    setLoaded({ key, ...result })
  }, [fetchDetail, key])

  const addComment = useCallback(
    async (comment: string) => {
      setCommentLoading(true)
      try {
        await createDocumentComment(documentId, comment)
        await refetch()
      } finally {
        setCommentLoading(false)
      }
    },
    [documentId, refetch],
  )

  const noUser = !userLoading && !user
  const isCurrent = loaded?.key === key
  const data = isCurrent ? loaded.data : null
  const error = noUser
    ? (userError ?? 'Failed to load current user')
    : isCurrent
      ? loaded.error
      : null
  const loading = !noUser && (userLoading || !isCurrent)

  return { data, loading, error, commentLoading, refetch, addComment }
}
