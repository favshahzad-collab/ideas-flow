import type {
  ActionReasonView,
  ApiComment,
  ApiDocumentAuditEntry,
  ApiDocumentDetail,
  ApiSupportingDocument,
  ApiWorkflowResponse,
  CommentView,
  DocumentAuditView,
  DocumentDetailView,
  AssembledDocumentDetailData,
  SupportingDocumentView,
  WorkflowStepStatus,
  WorkflowStepView,
} from '../types/documentDetail.ts'
import type { ApiApprovalType } from '../types/document.ts'
import { mapApiStatusToUi } from './documentMapper'
import { formatDisplayDate } from './format'
import { mapAuditActionLabel } from './auditMapper'
import { formatFullName, getInitials } from './user'
import { slotToPlacement } from './pdfCoordinates'

function resolveCurrentHolder(document: ApiDocumentDetail): string {
  if (document.status === 'APPROVED') {
    return 'Completed'
  }
  if (document.status === 'REJECTED') {
    return 'Rejected'
  }
  if (document.status === 'DELETED') {
    return 'Withdrawn'
  }
  if (
    document.status !== 'REVISION_REQUESTED' &&
    document.currentStep?.assignedUser
  ) {
    return formatFullName(
      document.currentStep.assignedUser.firstName,
      document.currentStep.assignedUser.lastName,
    )
  }
  return formatFullName(
    document.preparer.firstName,
    document.preparer.lastName,
  )
}

/**
 * The holder as an id, or null where the holder is not a person on the chain.
 *
 * Deliberately narrower than `resolveCurrentHolder`, which falls back to the
 * preparer's NAME so the column always reads as something. An id that fell
 * back the same way would quietly hand callers the preparer where the honest
 * answer is "nobody is holding a step".
 */
function resolveCurrentHolderId(document: ApiDocumentDetail): string | null {
  if (
    document.status === 'APPROVED' ||
    document.status === 'REJECTED' ||
    document.status === 'DELETED' ||
    document.status === 'REVISION_REQUESTED'
  ) {
    return null
  }

  return document.currentStep?.assignedUser?.id ?? null
}

function mapApprovalTypeLabel(type: ApiApprovalType): string {
  switch (type) {
    case 'REVIEWER':
      return 'Reviewer'
    case 'APPROVER':
      return 'Approver'
    case 'FINAL_APPROVER':
      return 'Final Approver'
  }
}

function mapWorkflowStepStatus(status: string): WorkflowStepStatus {
  if (status === 'PENDING') return 'current'
  if (status === 'WAITING') return 'pending'
  if (status === 'SKIP') return 'skipped'
  return 'completed'
}

function formatTime(isoDate: string): string {
  return new Date(isoDate).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function latestVersionFileName(document: ApiDocumentDetail): string {
  /* The API stores an object path, not a filename — the path is a uuid, so
     it means nothing to a person and is not what a download should be
     called. Version number plus extension is what the header shows and what
     the Download button saves as. */
  return `v${document.currentVersionNumber}.pdf`
}

export function buildDocumentDetailView(
  document: ApiDocumentDetail,
): DocumentDetailView {
  const preparerName = formatFullName(
    document.preparer.firstName,
    document.preparer.lastName,
  )
  const submittedDate = formatDisplayDate(
    document.submittedAt ?? document.createdAt,
  )

  return {
    id: document.id,
    withdrawalReason: document.withdrawalReason ?? null,
    withdrawnById: document.withdrawnById ?? null,
    rejectionClosedAt: document.rejectionClosedAt ?? null,
    referenceNumber: document.referenceNumber ?? null,
    checksum: document.finalSignedChecksum ?? null,
    sealedBy: document.sealedBy ?? null,
    title: document.title,
    description: document.description ?? '',
    status: mapApiStatusToUi(document.status, document.currentStep),
    preparerId: document.preparerId,
    preparerName,
    submittedDate,
    lastUpdated: formatDisplayDate(document.updatedAt),
    currentHolder: resolveCurrentHolder(document),
    currentHolderId: resolveCurrentHolderId(document),
    fileName: latestVersionFileName(document),
    versionNumber: document.currentVersionNumber,
    memoType: document.memoType ?? null,
    memoTo: document.memoTo ?? null,
    memoFrom: document.memoFrom ?? null,
    // Trimmed to the day rather than parsed: building a Date from it and
    // formatting back would apply the reader's timezone and could show the
    // memo as dated the day before.
    memoDate: document.memoDate ? document.memoDate.slice(0, 10) : null,
    /*
     * The body of the version in flight, which during a revision cycle is not
     * the newest row - `versions` is ordered newest first and the newest is
     * the one that came back. Matching on `currentVersionNumber` picks the
     * version the document actually points at.
     */
    memoBody:
      document.versions?.find(
        (version) => version.versionNumber === document.currentVersionNumber,
      )?.bodyJson ?? null,
    /* The notes on that same version, so a rewrite opens on the page as it
       stands rather than on a blank one. */
    memoNotes:
      document.versions?.find(
        (version) => version.versionNumber === document.currentVersionNumber,
      )?.pageNotesJson ?? [],
    mySignatureSlot: document.mySignatureSlot
      ? slotToPlacement(document.mySignatureSlot)
      : null,
    resubmissionSigned:
      typeof document.resubmissionSigned === 'boolean' ? document.resubmissionSigned : null,
  }
}

/**
 * The chain as the screen reads it: the preparer first, then every approval
 * step in order.
 *
 * The preparer is a real row rather than a caption — they signed the document
 * before it moved, and a chain that starts at step 1 hides who sent it. It is
 * excluded from the reviewer/approver counts by its `type`.
 *
 * Step state comes from the workflow response when there is one; a document
 * whose run has not started yet still has an approval chain, and every step
 * on it is pending.
 */
export function buildWorkflowSteps(
  document: ApiDocumentDetail,
  workflow: ApiWorkflowResponse,
): WorkflowStepView[] {
  const preparerStep: WorkflowStepView = {
    id: `${document.id}-preparer`,
    step: 0,
    type: 'Preparer',
    userId: document.preparerId,
    user: formatFullName(
      document.preparer.firstName,
      document.preparer.lastName,
    ),
    initials: getInitials(
      document.preparer.firstName,
      document.preparer.lastName,
    ),
    date: formatDisplayDate(document.submittedAt ?? document.createdAt),
    status: 'completed',
  }

  const runSteps = workflow.workflow ?? []

  if (runSteps.length > 0) {
    return [
      preparerStep,
      ...runSteps.map(step => ({
        id: `${document.id}-step-${step.stepOrder}`,
        step: step.stepOrder,
        type: mapApprovalTypeLabel(step.approvalType),
        userId: step.assignedUser.id,
        user: formatFullName(
          step.assignedUser.firstName,
          step.assignedUser.lastName,
        ),
        initials: getInitials(
          step.assignedUser.firstName,
          step.assignedUser.lastName,
        ),
        date: step.actedAt ? formatDisplayDate(step.actedAt) : undefined,
        status: mapWorkflowStepStatus(step.status),
        comment: step.comment,
      })),
    ]
  }

  const chainSteps = document.approvalChain?.steps ?? []

  return [
    preparerStep,
    ...chainSteps.map(step => ({
      id: step.id,
      step: step.stepOrder,
      type: mapApprovalTypeLabel(step.approvalType),
      userId: step.assignedUser.id,
      user: formatFullName(
        step.assignedUser.firstName,
        step.assignedUser.lastName,
      ),
      initials: getInitials(
        step.assignedUser.firstName,
        step.assignedUser.lastName,
      ),
      status: 'pending' as WorkflowStepStatus,
    })),
  ]
}

/** One sentence under the chain: where the document is, in words. */
export function buildWorkflowSummary(
  workflow: ApiWorkflowResponse,
  steps: WorkflowStepView[],
): string {
  const chain = steps.filter(step => step.type !== 'Preparer')

  if (chain.length === 0) {
    return 'No approval chain has been set for this document.'
  }

  if (workflow.documentStatus === 'APPROVED') {
    /* "Completed", matching the requirement and the badge above it. The
       workflow stops permanently here, and a word that reads as an event
       invites the question of what happens next. */
    return `Completed. All ${chain.length} step${chain.length === 1 ? '' : 's'} approved.`
  }
  if (workflow.documentStatus === 'REJECTED') {
    const rejected = chain.find(step => step.status === 'completed' && step.comment)
    return rejected
      ? `Rejected at step ${rejected.step} by ${rejected.user}. The approval chain ended there.`
      : 'Rejected. The approval chain ended before it completed.'
  }
  if (workflow.documentStatus === 'REVISION_REQUESTED') {
    return 'Sent back to the preparer for a new version. The approval chain restarts when they resubmit.'
  }

  const current = chain.find(step => step.status === 'current')
  if (current) {
    return `Step ${current.step} of ${chain.length}, waiting on ${current.user} (${current.type}).`
  }

  return `${chain.length} approval step${chain.length === 1 ? '' : 's'}, not started yet.`
}

export function buildCommentViews(comments: ApiComment[]): CommentView[] {
  return comments.map(comment => ({
    id: comment.id,
    user: formatFullName(comment.author.firstName, comment.author.lastName),
    initials: getInitials(comment.author.firstName, comment.author.lastName),
    comment: comment.comment,
    date: formatDisplayDate(comment.createdAt),
  }))
}

export function buildDocumentAuditViews(
  entries: ApiDocumentAuditEntry[],
): DocumentAuditView[] {
  return entries.map(entry => ({
    id: entry.id,
    date: formatDisplayDate(entry.date),
    time: formatTime(entry.date),
    user: formatFullName(entry.user.firstName, entry.user.lastName),
    role: mapApprovalTypeLabel(entry.role as ApiApprovalType) || entry.role,
    action: mapAuditActionLabel(entry.action),
    comment: entry.comments?.trim() || '—',
  }))
}

/**
 * The most recent reason a memo was sent back, or refused.
 *
 * The newest wins because a memo can go round more than once, and the reason
 * that matters is the last one - an older revision request has already been
 * answered. Sorted here rather than trusted from the API: the endpoint does
 * return newest first today, but this is the sentence a preparer acts on and
 * it should not silently become the wrong one if that ordering ever changes.
 *
 * An action with no comment is skipped rather than rendered blank. The dialogs
 * will not send one, but a row written before they refused to, or by a future
 * action that does not carry a reason, would otherwise print an empty banner.
 */
export function buildLatestActionReason(
  entries: ApiDocumentAuditEntry[],
  actions: readonly string[],
): ActionReasonView | null {
  const match = (entries ?? [])
    .filter(
      entry => actions.includes(entry.action) && Boolean(entry.comments?.trim()),
    )
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0]

  if (!match) return null

  return {
    user: formatFullName(match.user.firstName, match.user.lastName),
    comment: match.comments?.trim() ?? '',
    date: formatDisplayDate(match.date),
  }
}

/** Which versions carried an attachment, in words. */
export function attachmentVersionsLabel(
  added: number | undefined,
  removed: number | null | undefined,
): string | undefined {
  if (added === undefined) return undefined
  if (removed === null || removed === undefined) return `Since version ${added}`
  const last = removed - 1
  return last <= added ? `Version ${added} only` : `Versions ${added}–${last}`
}

export function buildSupportingDocumentViews(
  documents: ApiSupportingDocument[] | undefined,
): SupportingDocumentView[] {
  return (documents ?? []).map(doc => ({
    id: doc.id,
    fileName: doc.fileName,
    contentType: doc.contentType,
    sizeLabel:
      doc.sizeBytes >= 1024 * 1024
        ? `${(doc.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.max(1, Math.round(doc.sizeBytes / 1024))} KB`,
    uploadedAt: formatDisplayDate(doc.uploadedAt),
    versionsLabel: attachmentVersionsLabel(doc.addedInVersion, doc.removedInVersion),
  }))
}

export function assembleDocumentDetailData(
  document: ApiDocumentDetail,
  workflow: ApiWorkflowResponse,
  comments: ApiComment[],
  auditEntries: ApiDocumentAuditEntry[],
): AssembledDocumentDetailData {
  const documentView = buildDocumentDetailView(document)
  const workflowSteps = buildWorkflowSteps(document, workflow)
  /*
   * Counted over the approval steps only, as every other screen counts them.
   * The preparer's row is drawn in the chain but is not a step anybody
   * approves, and counting it made the memo page say "2/4" beside a header
   * reading "Approver 2 of 3".
   */
  const chainSteps = workflowSteps.filter(step => step.type !== 'Preparer')
  const completedSteps = chainSteps.filter(
    step => step.status === 'completed' || step.status === 'skipped',
  ).length
  const reviewers = chainSteps.filter(step => step.type === 'Reviewer').length
  const approvers = chainSteps.length - reviewers

  return {
    document: documentView,
    workflowSteps,
    completedSteps,
    totalSteps: chainSteps.length,
    reviewers,
    approvers,
    workflowSummary: buildWorkflowSummary(workflow, workflowSteps),
    comments: buildCommentViews(comments),
    auditRecords: buildDocumentAuditViews(auditEntries),
    returnedReason: buildLatestActionReason(auditEntries, [
      'REQUEST_REVISION',
      'REJECT',
    ]),
    supportingDocuments: buildSupportingDocumentViews(
      document.supportingDocuments,
    ),
    earlierSupportingDocuments: buildSupportingDocumentViews(
      (document.supportingHistory ?? []).filter(
        doc => doc.removedInVersion !== null && doc.removedInVersion !== undefined,
      ),
    ),
  }
}
