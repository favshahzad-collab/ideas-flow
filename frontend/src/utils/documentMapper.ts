import type {
  ApiDocument,
  ApiDocumentStatus,
  ApiDocumentCurrentStep,
  DashboardDocument,
  DocumentStatus,
} from '../types/document'
import { formatDisplayDate } from './format'
import { formatFullName, getInitials } from './user'

export function mapApiStatusToUi(
  status: ApiDocumentStatus,
  currentStep?: ApiDocumentCurrentStep | null,
): DocumentStatus {
  switch (status) {
    case 'DRAFT':
      return 'draft'
    case 'PENDING_REVIEW':
      if (
        currentStep?.approvalType === 'APPROVER' ||
        currentStep?.approvalType === 'FINAL_APPROVER'
      ) {
        return 'pending_approval'
      }
      return 'pending_review'
    case 'REVISION_REQUESTED':
      return 'revision_requested'
    case 'APPROVED':
      return 'approved'
    case 'REJECTED':
      return 'rejected'
    case 'DELETED':
      return 'deleted'
  }
}

function resolveCurrentHolder(document: ApiDocument): string {
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
    const { firstName, lastName } = document.currentStep.assignedUser
    return formatFullName(firstName, lastName)
  }

  return formatFullName(document.preparer.firstName, document.preparer.lastName)
}

/**
 * Initials for whoever is actually holding the document, or null when the
 * holder slot carries a status word instead of a person.
 */
function resolveCurrentHolderInitials(document: ApiDocument): string | null {
  if (
    document.status === 'APPROVED' ||
    document.status === 'REJECTED' ||
    document.status === 'DELETED'
  ) {
    return null
  }

  if (
    document.status !== 'REVISION_REQUESTED' &&
    document.currentStep?.assignedUser
  ) {
    const { firstName, lastName } = document.currentStep.assignedUser
    return getInitials(firstName, lastName)
  }

  return getInitials(document.preparer.firstName, document.preparer.lastName)
}

function resolveActionLabel(
  approvalType: ApiDocumentCurrentStep['approvalType'] | undefined,
): string {
  if (approvalType === 'APPROVER' || approvalType === 'FINAL_APPROVER') {
    return 'Approval Required'
  }
  return 'Review Required'
}

export function mapApiDocumentToDashboard(document: ApiDocument): DashboardDocument {
  /*
   * The server's answer, not one worked out here. `currentStep` names the
   * person the step is assigned to, which for somebody covering it is not
   * them - so a check against it left delegated memos out of My queue while
   * the sidebar badge, counted on the server, included them.
   */
  const isAwaitingMyAction = document.awaitingMyAction

  return {
    id: document.id,
    referenceNumber: document.referenceNumber ?? null,
    title: document.title,
    description: document.description?.trim() || 'No description provided.',
    status: mapApiStatusToUi(document.status, document.currentStep),
    preparerId: document.preparerId,
    submittedBy: formatFullName(document.preparer.firstName, document.preparer.lastName),
    submittedByInitials: getInitials(document.preparer.firstName, document.preparer.lastName),
    currentHolder: resolveCurrentHolder(document),
    currentHolderInitials: resolveCurrentHolderInitials(document),
    currentStep: document.workflow?.currentStepOrder ?? 0,
    totalSteps: document.workflow?.totalSteps ?? 0,
    lastUpdated: formatDisplayDate(document.updatedAt),
    submittedDate: formatDisplayDate(document.submittedAt ?? document.createdAt),
    submittedAt: document.submittedAt ?? document.createdAt,
    updatedAt: document.updatedAt,
    versionNumber: document.currentVersionNumber,
    approvalType: document.currentStep?.approvalType ?? null,
    actionLabel: resolveActionLabel(document.currentStep?.approvalType),
    nextHolder: document.nextStep
      ? formatFullName(
          document.nextStep.assignedUser.firstName,
          document.nextStep.assignedUser.lastName,
        )
      : null,
    fileType: 'pdf',
    isAwaitingMyAction,
    // Carried through as-is, including the null: the table decides between a
    // countdown and an age from exactly this, and a fabricated fallback here
    // would put a deadline on a screen that nobody agreed to.
    dueAt: document.dueAt ?? null,
  }
}
