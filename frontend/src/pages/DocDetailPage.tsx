import { AlertCircle, Ban, MoreHorizontal, SkipForward, Undo2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ROUTES } from '../types/routes'
import { Page } from '../components/ui/Page'
import {
  LoadingAnnouncer,
  Skeleton,
  SkeletonPageHeader,
} from '../components/ui/Skeleton'
import Modal from '../components/Modal'
import ActionDialog, { type ActionType } from '../components/pending/ActionDialog'
import PreparerSignModal, {
  type PreparerSignaturePayload,
} from '../components/PreparerSignModal'
import SignApproveModal from '../components/SignApproveModal'
import StatusBadge from '../components/StatusBadge'
import RemindApproverButton from '../components/RemindApproverButton'
import ReassignStepButton from '../components/ReassignStepButton'
import { useCurrentUser } from '../contexts/currentUser'
import { holdsCapability } from '../types/capability'
import { useDocumentDetail } from '../hooks/useDocumentDetail'
import { rejectDocument, requestRevision, skipWorkflowStep } from '../services/approvalApi'
import { resubmitDocument } from '../services/documentDetailApi'
import { previewMemo, previewToFile } from '../services/memoApi'
import type { MemoBody } from '../types/memo'
import { slotToPlacement, type PdfPlacement } from '../utils/pdfCoordinates'
import { formatDisplayDate, todayAsDateInput } from '../utils/format'
import RewriteMemoCard from '../components/document-detail/RewriteMemoCard'
import { cancelDocument, leaveRejected, withdrawDocument } from '../services/documentsApi'
import ConfirmDialog from '../components/ui/ConfirmDialog'
import ResubmitAttachments from '../components/document-detail/ResubmitAttachments'
import { formatMemoReference } from '../utils/format'
import { workflowStage } from '../utils/workflowStage'
import { QuickInfo } from '../components/document-detail/QuickInfo'
import PageThumbnails from '../components/document-detail/PageThumbnails'
import ApprovalChain from '../components/ApprovalChain'
import Button from '../components/ui/Button'
import PrintDocumentButton from '../components/PrintDocumentButton'
import { downloadDocumentFile } from '../utils/downloadDocument'
import { isCancelledByAdministrator } from '../utils/cancellation'
import { useRegisterCommands } from '../contexts/commandPalette'
import DocumentPreview from '../components/document-detail/DocumentPreview'
import SupportingDocsTab from '../components/document-detail/SupportingDocsTab'
import CommentsTab from '../components/document-detail/CommentsTab'
import AuditLedgerTab from '../components/document-detail/AuditLedgerTab'
import ChangesTab from '../components/document-detail/ChangesTab'

type Tab = 'overview' | 'changes' | 'supporting' | 'comments' | 'audit'

/** A memo being corrected in the portal: the text and the header lines. */
type RewriteRevision = {
  body: MemoBody
  memoTo: string
  memoFrom: string
  memoDate: string
}

export default function DocumentDetail() {
  const { id: documentIdParam } = useParams<{ id: string }>()
  const documentId = documentIdParam ?? ''
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  /* Which page the viewer shows. Owned here so the thumbnail rail and
     the viewer's own Previous/Next cannot disagree. */
  const [viewerPage, setViewerPage] = useState(1)
  const [signModalOpen, setSignModalOpen] = useState(false)
  /* On a phone every action but the main one lives in a sheet behind "More",
     so the memo itself is what the screen opens on. */
  const [actionsOpen, setActionsOpen] = useState(false)
  useEffect(() => {
    if (!actionsOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActionsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actionsOpen])
  /*
   * "Open to sign" in the Inbox lands here with ?sign=1, and the signing
   * dialog opens by itself - but only once the memo has loaded and only if it
   * is actually waiting on this reader. A link kept from last week, for a memo
   * somebody else has since signed, opens the memo and nothing more. Worked
   * out while rendering rather than set from an effect, and the parameter is
   * dropped as the dialog closes, so going back does not reopen it.
   */
  const [searchParams, setSearchParams] = useSearchParams()
  const signRequested = searchParams.get('sign') === '1'
  const closeSigning = () => {
    setSignModalOpen(false)
    if (signRequested) {
      setSearchParams(
        previous => {
          const next = new URLSearchParams(previous)
          next.delete('sign')
          return next
        },
        { replace: true },
      )
    }
  }
  /* Reject or request revision: one dialog, the same one My queue uses. */
  const [activeAction, setActiveAction] = useState<ActionType | null>(null)
  const [skipModalOpen, setSkipModalOpen] = useState(false)
  const [skipReason, setSkipReason] = useState('')
  const [skipError, setSkipError] = useState<string | null>(null)
  const [skipLoading, setSkipLoading] = useState(false)
  const [resubmitLoading, setResubmitLoading] = useState(false)
  const [resubmitError, setResubmitError] = useState<string | null>(null)
  const [resubmitFile, setResubmitFile] = useState<File | null>(null)
  /*
   * A memo typed in the portal is revised by rewriting it, not by uploading a
   * corrected PDF - there is no Word file to correct. What the preparer is
   * signing is the server's redrawing of that rewrite, which is why the
   * signing step waits on a preview rather than on a file they chose.
   */
  const [rewriting, setRewriting] = useState<RewriteRevision | null>(null)
  const [preparingRewrite, setPreparingRewrite] = useState(false)
  /* The preparer's own ruled line on the drawing they are about to sign. */
  const [preparedSlot, setPreparedSlot] = useState<PdfPlacement | null>(null)
  const [preparerSignOpen, setPreparerSignOpen] = useState(false)
  /* Withdrawing (the preparer) or cancelling (an administrator): one dialog,
     always with a reason, because the memo stays on record and the record
     should say why. */
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [withdrawMode, setWithdrawMode] = useState<'withdraw' | 'cancel'>('withdraw')
  const [withdrawReason, setWithdrawReason] = useState('')
  /* Leave as rejected: the preparer's decision not to send a rejected memo
     round again. Final, so it is confirmed first. */
  const [leaveRejectedOpen, setLeaveRejectedOpen] = useState(false)
  const [leaveRejectedBusy, setLeaveRejectedBusy] = useState(false)
  const [leaveRejectedError, setLeaveRejectedError] = useState<string | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  /* The supporting files the next version carries: the current ones, less
     those unticked, plus those added (fit-gap decision 8). */
  const [removeSupportingIds, setRemoveSupportingIds] = useState<string[]>([])
  const [addedSupporting, setAddedSupporting] = useState<File[]>([])
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const { user } = useCurrentUser()
  const { data, loading, error, commentLoading, refetch, addComment } =
    useDocumentDetail(documentId)

  /* The palette's ACTIONS group is contextual: these exist only while a
     document is open, and they call the same handlers the header buttons do
     rather than being a second path to the same API. */
  const canAct = Boolean(data?.canApprove) && data?.document.status !== 'deleted'
  useRegisterCommands(
    'document-detail',
    canAct
      ? [
          {
            id: 'doc:sign',
            group: 'actions' as const,
            label:
              data?.pendingActionType === 'REVIEWER'
                ? 'Sign & complete review'
                : 'Sign & approve this document',
            hint: data?.document.title,
            shortcut: 'A',
            run: () => setSignModalOpen(true),
          },
          {
            id: 'doc:revision',
            group: 'actions' as const,
            label: 'Request revision',
            hint: data?.document.title,
            shortcut: 'R',
            run: () => setActiveAction('revision'),
          },
          {
            id: 'doc:reject',
            group: 'actions' as const,
            label: 'Reject this document',
            hint: data?.document.title,
            shortcut: 'X',
            run: () => setActiveAction('reject'),
          },
        ]
      : [],
    [canAct, data?.pendingActionType, data?.document.title],
  )

  if (!documentId) {
    return (
      <Page>
        <div className="max-w-md mx-auto text-center">
          <AlertCircle size={40} className="mx-auto text-danger-ink mb-3" />
          <h2 className="text-pane font-semibold text-content mb-2">Document not found</h2>
          <Button onClick={() => navigate(ROUTES.dashboard)}>
            Go to documents
          </Button>
        </div>
      </Page>
    )
  }

  const goBack = () => {
    if (window.history.state && window.history.state.idx > 0) {
      navigate(-1)
    } else {
      navigate(ROUTES.dashboard)
    }
  }

  const handleApproveSuccess = () => {
    closeSigning()
    goBack()
  }

  /*
   * Throws on failure rather than catching: the dialog stays open with the
   * comment intact and shows the message. This page's own revision dialog
   * used to close before sending and reopen on failure, empty-handed if the
   * page had moved on.
   */
  const handleConfirmAction = async (comment: string) => {
    if (activeAction === 'reject') {
      await rejectDocument(documentId, comment)
    } else {
      await requestRevision(documentId, comment)
    }
    setActiveAction(null)
    goBack()
  }

  const openSkipModal = () => {
    setSkipReason('')
    setSkipError(null)
    setSkipModalOpen(true)
  }

  const closeSkipModal = () => {
    if (skipLoading) return
    setSkipModalOpen(false)
    setSkipReason('')
    setSkipError(null)
  }

  const handleConfirmSkip = async () => {
    if (!skipReason.trim()) {
      setSkipError('A reason is required to skip the current step.')
      return
    }

    setSkipLoading(true)
    setSkipError(null)

    try {
      await skipWorkflowStep(documentId, skipReason.trim())
      setSkipModalOpen(false)
      setSkipReason('')
      await refetch()
    } catch (err) {
      setSkipError(err instanceof Error ? err.message : 'Skip failed')
    } finally {
      setSkipLoading(false)
    }
  }

  const handleDownload = async () => {
    setDownloadError(null)
    try {
      // The page used to build its own anchor and click it without adding it
      // to the document, which Firefox ignores outright — the file simply
      // never arrived — and then swallowed every failure, so nothing on
      // screen said so either. One implementation now, and it reports.
      await downloadDocumentFile(documentId, data?.document.fileName)
    } catch (error) {
      setDownloadError(
        error instanceof Error ? error.message : 'The memo could not be downloaded',
      )
    }
  }

  const handleResubmit = (file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setResubmitError('Please upload a PDF file.')
      return
    }

    setResubmitError(null)
    setResubmitFile(file)

    // Signed or not is the server's rule, from the memo's own type: an
    // Approval Request is always signed, whatever the organisation's switch
    // says. Only a server too old to say falls back to that switch.
    const mustSign =
      data?.document.resubmissionSigned ?? user?.workflowPolicy.preparerSignsOnSubmit !== false
    if (!mustSign) {
      void handleSignedResubmit(undefined, null, file)
      return
    }

    setPreparerSignOpen(true)
  }

  /**
   * Draw the rewritten memo, then open the signing step on that drawing.
   *
   * The chain is not sent: the server reads it off the document, so the strip
   * it draws here has the same columns in the same places as the one the
   * resubmission files. A strip assembled on this side could differ, and the
   * preparer would be signing a line that moves under them.
   */
  const handleRewriteContinue = async (revision: {
    body: MemoBody
    memoTo: string
    memoFrom: string
    memoDate: string
  }) => {
    setPreparingRewrite(true)
    setResubmitError(null)

    try {
      const preview = await previewMemo({
        documentId,
        body: revision.body,
        memoTo: revision.memoTo,
        memoFrom: revision.memoFrom,
        memoDate: revision.memoDate,
        // Drawn where they will be filed, so the signature is placed on the
        // page as it will really look.
        notes: data?.document.memoNotes ?? [],
      })

      setRewriting(revision)
      setResubmitFile(previewToFile(preview.pdfBase64, data?.document.title ?? 'memo'))
      const mine = preview.slots.find(slot => slot.key === user?.id)
      setPreparedSlot(mine ? slotToPlacement(mine) : null)

      /*
       * A memo whose author is not a signatory prints no column for them, so
       * there is nothing for the dialog to do. The corrected memo goes back
       * to the first approver as it stands.
       *
       * The answer comes from the same call that drew the page, so a drawing
       * with no line for the preparer can never arrive alongside a dialog
       * asking them to sign one.
       */
      if (preview.preparerSigns === false) {
        await handleSignedResubmit(undefined, revision)
        return
      }

      setPreparerSignOpen(true)
    } catch (err) {
      setResubmitError(
        err instanceof Error
          ? err.message
          : 'The memo could not be prepared for signing. Try again.',
      )
    } finally {
      setPreparingRewrite(false)
    }
  }

  /**
   * File the correction.
   *
   * The revision and the file can be passed in as well as read from state,
   * because the unsigned path calls this in the same tick that sets them -
   * and a `useState` setter has not landed by then. Reading only state there
   * would resubmit the *previous* correction, or refuse with "please upload a
   * PDF file" about the one just chosen.
   */
  const handleSignedResubmit = async (
    signature: PreparerSignaturePayload | undefined,
    revision: RewriteRevision | null = rewriting,
    file: File | null = resubmitFile,
  ) => {
    if (!revision && !file) {
      setResubmitError('Please upload a PDF file.')
      return
    }

    setResubmitLoading(true)
    setResubmitError(null)

    try {
      /*
       * The rewritten text, not the preview bytes. The preview was drawn so
       * there was a page to place a signature on; the filed copy is drawn
       * again at submission, from the body, and only one of those two can be
       * the artefact.
       */
      await resubmitDocument(
        documentId,
        revision
          ? {
              body: revision.body,
              memoTo: revision.memoTo,
              memoFrom: revision.memoFrom,
              memoDate: revision.memoDate,
              // Rewriting changes the text, not the notes placed on the page.
              // Left out, the server would read them as removed.
              notes: data?.document.memoNotes ?? [],
            }
          : file!,
        signature,
        addedSupporting,
        removeSupportingIds,
      )
      setRemoveSupportingIds([])
      setAddedSupporting([])
      setPreparerSignOpen(false)
      setResubmitFile(null)
      setRewriting(null)
      setPreparedSlot(null)
      await refetch()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Resubmit failed'
      setResubmitError(message)
      throw err
    } finally {
      setResubmitLoading(false)
    }
  }

  const handleDelete = async () => {
    const reason = withdrawReason.trim()
    if (!reason) {
      setDeleteError('Say why, so the record shows it.')
      return
    }
    setDeleteLoading(true)
    setDeleteError(null)

    try {
      if (withdrawMode === 'cancel') {
        await cancelDocument(documentId, reason)
      } else {
        await withdrawDocument(documentId, reason)
      }
      setDeleteModalOpen(false)
      setWithdrawReason('')
      await refetch()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Could not withdraw the memo')
    } finally {
      setDeleteLoading(false)
    }
  }

  const handleLeaveRejected = async () => {
    setLeaveRejectedBusy(true)
    setLeaveRejectedError(null)
    try {
      await leaveRejected(documentId)
      setLeaveRejectedOpen(false)
      await refetch()
    } catch (err) {
      setLeaveRejectedError(err instanceof Error ? err.message : 'Could not close the memo')
    } finally {
      setLeaveRejectedBusy(false)
    }
  }

  const openWithdraw = (mode: 'withdraw' | 'cancel') => {
    setWithdrawMode(mode)
    setWithdrawReason('')
    setDeleteError(null)
    setDeleteModalOpen(true)
  }

  if (loading) {
    return (
      <Page>
        <SkeletonPageHeader titleWidth="20rem" />

        <div
          aria-hidden="true"
          className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]"
        >
          <Skeleton className="h-[520px] rounded-card" />
          <div className="space-y-4">
            <Skeleton className="h-64 rounded-card" />
            <Skeleton className="h-40 rounded-card" />
          </div>
        </div>

        <LoadingAnnouncer loading label="Loading document" />
      </Page>
    )
  }

  if (error || !data) {
    return (
      <Page>
        <div className="max-w-md mx-auto text-center">
          <AlertCircle size={40} className="mx-auto text-danger-ink mb-3" />
          <h2 className="text-pane font-semibold text-content mb-2">Unable to load document</h2>
          <p className="text-ui text-content-muted mb-4">{error ?? 'Document not found'}</p>
          <div className="flex items-center justify-center gap-3">
            <Button variant="secondary" onClick={goBack}>
              Go back
            </Button>
          <Button onClick={refetch}>
            Retry
          </Button>
          </div>
        </div>
      </Page>
    )
  }

  const { document, workflowSteps, completedSteps, totalSteps, reviewers, approvers, workflowSummary, comments, auditRecords, supportingDocuments, earlierSupportingDocuments, canApprove, canResubmit, canSkipStep, pendingActionType, returnedReason, actingFor } = data
  const isDeleted = document.status === 'deleted'
  const signLabel =
    pendingActionType === 'REVIEWER' ? 'Sign & complete review' : 'Sign & approve'
  const cancelledByAdministrator =
    isDeleted &&
    isCancelledByAdministrator({
      preparerId: document.preparerId,
      withdrawnById: data.document.withdrawnById,
    })
  const isRejected = document.status === 'rejected'
  // An approved memo is a finished record, and the server refuses to delete
  // it, so the button is not offered for one.
  // Nor a rejected one, which is a closed cycle kept on record: the way back
  // is to resubmit it, which the server allows and deleting would not.
  const canDelete =
    user?.id === document.preparerId && !isDeleted && document.status !== 'approved' && !isRejected
  /* Cancelling an abandoned memo: an administrator with the power, on
     somebody else's memo that is still open. Their own they withdraw. */
  const canCancel =
    holdsCapability(user, 'memos.cancel') &&
    user?.id !== document.preparerId &&
    !isDeleted &&
    document.status !== 'approved' &&
    !isRejected

  /*
   * "Remind", offered to whoever is waiting rather than to whoever can see
   * this page - which is the same rule the server applies, so the button
   * appears exactly when it would be honoured.
   *
   * Not while it is with YOU: `canApprove` means the memo is at your own
   * step, and a button that reminds yourself is a button that answers "this
   * memo is waiting on you" to the one person who already knows.
   */
  const inFlight =
    document.status === 'pending_review' || document.status === 'pending_approval'
  const canRemind =
    inFlight &&
    !isDeleted &&
    !canApprove &&
    (user?.id === document.preparerId || holdsCapability(user, 'approvals.oversee'))

  /*
   * "Reassign", offered to an administrator while the memo is with somebody.
   *
   * Unlike the reminder it IS offered when the memo is at your own step: an
   * administrator who should not be the one to sign this has exactly the same
   * problem as an approver who has left, and no other way out of it.
   *
   * The control decides for itself which steps are on offer - the memo's own
   * and the ones ahead of it - and draws nothing if there are none.
   */
  /* Back with its preparer, every step is ahead of the next cycle - and a
     step held by somebody who has left must be movable, or the memo can never
     be resubmitted. */
  const betweenCycles =
    document.status === 'revision_requested' || document.status === 'rejected'
  const canReassign =
    (inFlight || betweenCycles) && !isDeleted && holdsCapability(user, 'approvals.reassign')
  const supportingCount = supportingDocuments.length

  /* The internal ids are unchanged so every existing handler keeps working;
     only the labels move to the redesign's vocabulary. Counts come from the
     loaded data — the design's "(2)" and "(5)" are examples, not constants. */
  /*
   * What changed since the version before. Only once there IS a version
   * before, and only for a memo typed in the portal - an uploaded PDF has no
   * text to compare, and a first version has nothing to compare it with.
   */
  const showChanges = Boolean(document.memoBody) && document.versionNumber > 1

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Preview' },
    ...(showChanges ? [{ id: 'changes' as const, label: 'Changes' }] : []),
    {
      id: 'supporting',
      label: supportingCount > 0 ? `Supporting (${supportingCount})` : 'Supporting',
    },
    {
      id: 'comments',
      label: comments.length > 0 ? `Comments (${comments.length})` : 'Comments',
    },
    { id: 'audit', label: 'Audit ledger' },
  ]

  return (
    <Page>
      <nav aria-label="Breadcrumb" className="mb-3">
        <ol className="flex items-center gap-1.5 text-ui">
          <li>
            <button
              type="button"
              onClick={() => navigate(ROUTES.dashboard)}
              className="rounded text-content-subtle transition-colors hover:text-content-muted"
            >
              Documents
            </button>
          </li>
          <li aria-hidden="true" className="text-line-strong">
            /
          </li>
          <li aria-current="page" className="font-mono text-data text-content">
            {formatMemoReference(data?.document.referenceNumber, documentId)}
          </li>
        </ol>
      </nav>

      <div className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge
            status={document.status}
            verbose
            stage={workflowStage(document.status, workflowSteps)}
          />
          <span className="font-mono text-data text-content-subtle">
            {formatMemoReference(document.referenceNumber, document.id)} &middot; v
            {document.versionNumber} &middot; {document.fileName}
          </span>
          {/*
            A second version is the one fact about this memo an approver
            most needs and is least likely to notice from a "v2" in mono.
            Said in words, beside it, and it opens the comparison.
          */}
          {showChanges && activeTab !== 'changes' && (
            <button
              type="button"
              onClick={() => setActiveTab('changes')}
              className="rounded-chip text-meta font-medium text-accent-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              See what changed since v{document.versionNumber - 1}
            </button>
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-title font-semibold tracking-[-0.02em] text-content">
              {document.title}
            </h1>
            {document.description && (
              <p className="mt-1.5 max-w-208 text-ui leading-relaxed text-content-muted">
                {document.description}
              </p>
            )}
            <p className="mt-1.5 text-meta text-content-subtle">
              Submitted by {document.preparerName} &middot; {document.submittedDate}
            </p>
            {/* Shown only once there is an approved copy to describe. It is
                the answer to "is the PDF in my hand the one that was signed?"
                - the whole digest is on the element, the first characters are
                what anybody actually compares. */}
            {document.checksum && (
              <p className="mt-1.5 text-meta text-content-subtle">
                Approved copy &middot;{' '}
                <span
                  className="font-mono"
                  title={`SHA-256 ${document.checksum}`}
                >
                  SHA-256 {document.checksum.slice(0, 16)}&hellip;
                </span>{' '}
                &middot;{' '}
                {/* Said on the memo, so nobody has to open the file in a PDF
                    reader to find out whether it carries the seal. */}
                {document.sealedBy
                  ? `Digitally sealed by ${document.sealedBy}`
                  : 'Not digitally sealed'}
              </p>
            )}
          </div>

          {/* Every decision the screen offers lives here now. DocumentPreview
              keeps only its resubmit upload, which belongs beside the file
              rather than in a page header. */}
          {/* max-w-full: once this row wraps under the title it is as wide
              as the screen and no wider, so its own buttons wrap too rather
              than running off a phone's edge. */}
          {/* On a phone this row is the sheet "More" opens, drawn over a scrim,
              and the main action sits in the bar fixed to the foot of the
              screen instead. Hidden rather than unmounted while closed, so a
              dialog one of these buttons owns is not torn down with it. */}
          {actionsOpen && (
            <div
              aria-hidden="true"
              className="fixed inset-0 z-30 bg-scrim/40 sm:hidden"
              onClick={() => setActionsOpen(false)}
            />
          )}
          <div
            id="memo-actions"
            className={`flex max-w-full flex-shrink-0 flex-wrap items-center gap-2 ${
              actionsOpen
                ? 'max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-40 max-sm:max-h-[80vh] max-sm:flex-col max-sm:flex-nowrap max-sm:items-stretch max-sm:overflow-y-auto max-sm:rounded-t-card max-sm:border-t max-sm:border-line max-sm:bg-surface max-sm:px-4 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))] max-sm:pt-3 max-sm:shadow-overlay'
                : 'max-sm:hidden'
            }`}
          >
            <div className="flex items-center justify-between sm:hidden">
              <p className="text-ui font-semibold text-content">Actions</p>
              <button
                type="button"
                onClick={() => setActionsOpen(false)}
                aria-label="Close actions"
                className="flex h-9 w-9 items-center justify-center rounded-control text-content-subtle hover:bg-sunken"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            {!isDeleted && (
              <Button
                variant="secondary"
                onClick={() => {
                  setActionsOpen(false)
                  void handleDownload()
                }}
              >
                Download
              </Button>
            )}
            {/* Printing is how the memo leaves the system: once it is in a
                folder, the paper is the record. So it is offered only for a
                fully approved document, and the button says why when it is
                not — a disabled control with no reason reads as broken. */}
            {!isDeleted && (
              <PrintDocumentButton
                documentId={documentId}
                status={document.status}
              />
            )}
            {downloadError && (
              <p role="alert" className="w-full text-meta text-danger-ink">
                {downloadError}
              </p>
            )}
            {canRemind && (
              <RemindApproverButton
                documentId={documentId}
                holderFirstName={document.currentHolder.split(' ')[0] || undefined}
              />
            )}
            {canReassign && (
              <ReassignStepButton
                documentId={documentId}
                preparerId={document.preparerId}
                steps={workflowSteps}
                actingUserId={user?.id}
                onDone={refetch}
                betweenCycles={betweenCycles}
              />
            )}
            {canSkipStep && (
              <Button
                variant="secondary"
                icon={<SkipForward size={15} aria-hidden="true" />}
                onClick={() => {
                  setActionsOpen(false)
                  openSkipModal()
                }}
              >
                Skip step
              </Button>
            )}
            {canDelete && (
              <Button
                variant="danger"
                icon={<Undo2 size={15} aria-hidden="true" />}
                onClick={() => {
                  setActionsOpen(false)
                  openWithdraw('withdraw')
                }}
              >
                Withdraw
              </Button>
            )}
            {canCancel && (
              <Button
                variant="danger"
                icon={<Ban size={15} aria-hidden="true" />}
                onClick={() => {
                  setActionsOpen(false)
                  openWithdraw('cancel')
                }}
              >
                Cancel memo
              </Button>
            )}
            {canApprove && !isDeleted && (
              <>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setActionsOpen(false)
                    setActiveAction('revision')
                  }}
                >
                  Revision
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    setActionsOpen(false)
                    setActiveAction('reject')
                  }}
                >
                  Reject
                </Button>
                {/* On a phone this one is in the bar at the foot instead. */}
                <Button className="max-sm:hidden" onClick={() => setSignModalOpen(true)}>
                  {signLabel}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {isDeleted && (
        <div className="mb-4 rounded-card border border-line bg-sunken px-4 py-3">
          <p className="text-ui font-medium text-content">
            {cancelledByAdministrator
              ? 'Cancelled by an administrator'
              : 'Withdrawn by its preparer'}
          </p>
          {data.document.withdrawalReason && (
            <blockquote className="mt-2 border-l-2 border-line pl-3">
              <p className="whitespace-pre-wrap text-ui text-content">
                {data.document.withdrawalReason}
              </p>
            </blockquote>
          )}
          <p className="mt-1 text-meta text-content-muted">
            The approval chain has stopped. The memo, its files and every action on it stay on record.
            {cancelledByAdministrator
              ? ' A cancelled memo is closed for good. To go ahead, submit a new memo.'
              : canResubmit
                ? ' Upload a new version below to send it round again.'
                : ' The preparer can send a new version round again later.'}
          </p>
          {canResubmit && resubmitError && (
            <p className="mt-2 text-ui text-danger-ink">{resubmitError}</p>
          )}
        </div>
      )}

      {/*
        * A rejection ends the workflow, and until now the page said so only
        * through the status badge in the header - no reason, anywhere on the
        * landing view, for the one person who most needs it. The reject dialog
        * refuses to send without a reason for exactly that reason.
        */}
      {document.status === 'rejected' && !isDeleted && (
        <div className="mb-4 rounded-card border border-danger-line bg-danger-soft px-4 py-3">
          <p className="text-ui font-medium text-danger-ink">Rejected</p>
          {returnedReason ? (
            <blockquote className="mt-2 border-l-2 border-danger-line pl-3">
              <p className="whitespace-pre-wrap text-ui text-content">
                {returnedReason.comment}
              </p>
              <footer className="mt-1 text-meta text-content-muted">
                {returnedReason.user} · {returnedReason.date}
              </footer>
            </blockquote>
          ) : (
            <p className="mt-1 text-meta text-danger-ink">
              No reason was recorded.
            </p>
          )}
          <p className="mt-2 text-meta text-danger-ink">
            This approval cycle has ended. Every action taken in it remains in
            the ledger.
            {data.document.rejectionClosedAt
              ? ` Its preparer left it as rejected on ${formatDisplayDate(data.document.rejectionClosedAt)}, so it is closed for good. To go ahead, submit a new memo.`
              : canResubmit
                ? ' Resubmit it below as a new version, or leave it as rejected to close it.'
                : ''}
          </p>
          {canResubmit && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setLeaveRejectedError(null)
                  setLeaveRejectedOpen(true)
                }}
              >
                Leave as rejected
              </Button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={leaveRejectedOpen}
        title="Leave this memo as rejected?"
        confirmLabel="Leave as rejected"
        pending={leaveRejectedBusy}
        onConfirm={() => void handleLeaveRejected()}
        onCancel={() => setLeaveRejectedOpen(false)}
      >
        It will not be sent round again, and it leaves your Needs you list. The
        memo, its files and every action on it stay on record as rejected.
        This is final: to go ahead later, you would submit a new memo.
        {leaveRejectedError && (
          <span role="alert" className="mt-2 block text-danger-ink">
            {leaveRejectedError}
          </span>
        )}
      </ConfirmDialog>

      {canResubmit && !isDeleted && (
        <div className="mb-4 rounded-card border border-revision-line bg-revision-soft px-4 py-3">
          <p className="text-ui font-medium text-revision-ink">
            {isRejected ? 'Resubmit after rejection' : 'Revision requested'}
          </p>
          {/*
            * The reviewer's own words, before the instruction.
            *
            * The dialog will not send a revision request without a reason, so
            * this is the whole reason the memo is back - and it used to live
            * two tabs away under Comments while the banner said only that
            * something needed changing.
            */}
          {/* For a rejection the reason is already in the Rejected panel above. */}
          {returnedReason && !isRejected && (
            <blockquote className="mt-2 border-l-2 border-revision-line pl-3">
              <p className="whitespace-pre-wrap text-ui text-content">
                {returnedReason.comment}
              </p>
              <footer className="mt-1 text-meta text-content-muted">
                {returnedReason.user} · {returnedReason.date}
              </footer>
            </blockquote>
          )}
          <p className="mt-2 text-meta text-revision-ink">
            {isRejected
              ? document.memoBody
                ? 'Revise the memo below and sign it again. It is filed as a new version and goes through the whole approval chain again from the first step, with the same approvers. The rejected version and the rejection stay on record.'
                : 'Upload a revised PDF. It is filed as a new version and goes through the whole approval chain again from the first step, with the same approvers. The rejected version and the rejection stay on record.'
              : document.memoBody
                ? 'Correct the memo below and sign it again. That replaces the current version and restarts the approval chain; the version that came back is kept.'
                : 'Upload a revised PDF to replace the current version and restart the approval workflow.'}
          </p>

          {/*
            * A memo nobody uploaded cannot be revised by uploading one: there
            * is no Word file to correct, which is the point of typing it here.
            * Shown only when the body was recorded - a memo typed before that
            * column existed still has its PDF and still takes an upload.
            */}
          {document.memoBody && (
            <div className="mt-4 rounded-control border border-line bg-surface p-4">
              <RewriteMemoCard
                body={document.memoBody}
                memoTo={document.memoTo ?? ''}
                memoFrom={document.memoFrom ?? ''}
                memoDate={document.memoDate ?? todayAsDateInput()}
                preparing={preparingRewrite}
                error={resubmitError}
                onContinue={handleRewriteContinue}
              />
            </div>
          )}

          {resubmitError && !document.memoBody && (
            <p className="mt-2 text-ui text-danger-ink">{resubmitError}</p>
          )}
        </div>
      )}

      {/* Three columns at xl and above. Below that the page rail is dropped
          rather than squeezed — 220px of thumbnails is the first thing worth
          losing, and the viewer's own Previous/Next still pages the file. */}
      <div className="grid items-start gap-4 xl:grid-cols-[13.75rem_minmax(0,1fr)_20rem]">
        <div className="hidden xl:block">
          <PageThumbnails
            documentId={documentId}
            page={viewerPage}
            onSelect={selectedPage => {
              setViewerPage(selectedPage)
              setActiveTab('overview')
            }}
          />
        </div>

        <section className="card overflow-hidden">
          <div
            role="tablist"
            aria-label="Document sections"
            className="flex gap-1 overflow-x-auto border-b border-line-soft bg-canvas px-2 py-1.5"
          >
            {tabs.map(tab => {
              const active = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex-shrink-0 rounded-chip px-2.75 py-1.5 text-meta transition-colors ${
                    active
                      ? 'bg-surface font-semibold text-content shadow-card'
                      : 'text-content-muted hover:text-content'
                  }`}
                >
                  {tab.label}
                </button>
              )
            })}
          </div>

          <div className="bg-canvas p-5">
            {activeTab === 'overview' && (
              <div id="document-preview">
                {canResubmit && (
                  <ResubmitAttachments
                    current={supportingDocuments}
                    removeIds={removeSupportingIds}
                    onToggleKeep={(id, keep) =>
                      setRemoveSupportingIds(ids =>
                        keep ? ids.filter(other => other !== id) : [...new Set([...ids, id])],
                      )
                    }
                    added={addedSupporting}
                    onAdd={files => setAddedSupporting(current => [...current, ...files])}
                    onRemoveAdded={index =>
                      setAddedSupporting(current => current.filter((_, at) => at !== index))
                    }
                  />
                )}
                <DocumentPreview
                  documentId={documentId}
                  fileName={document.fileName}
                  versionNumber={document.versionNumber}
                  isDeleted={isDeleted}
                  canApprove={false}
                  canResubmit={canResubmit}
                  resubmitLoading={resubmitLoading}
                  {...(document.memoBody
                    ? { resubmitLabel: 'Upload a PDF instead' }
                    : {})}
                  pendingActionType={pendingActionType}
                  onResubmit={handleResubmit}
                  page={viewerPage}
                  onPageChange={setViewerPage}
                  signHere={
                    canApprove && !isDeleted && document.mySignatureSlot && !actingFor
                      ? {
                          placement: document.mySignatureSlot,
                          name: user ? `${user.firstName} ${user.lastName}`.trim() : 'you',
                          onSign: () => setSignModalOpen(true),
                        }
                      : null
                  }
                />
              </div>
            )}

            {activeTab === 'changes' && showChanges && (
              <ChangesTab documentId={documentId} />
            )}

            {activeTab === 'supporting' && (
              <SupportingDocsTab
                documents={supportingDocuments}
                earlier={earlierSupportingDocuments ?? []}
                documentId={documentId}
              />
            )}

            {activeTab === 'comments' && (
              <CommentsTab
                comments={comments}
                onAddComment={addComment}
                commentLoading={commentLoading}
              />
            )}

            {activeTab === 'audit' && (
              <AuditLedgerTab records={auditRecords} documentId={documentId} />
            )}
          </div>
        </section>

        <div className="space-y-3">
          {/*
            The one place the approval chain is drawn. There was also a Chain
            tab, which showed the same list inside the tabs while this card
            showed it beside them. This card is kept because it is on screen
            at every width - beside the memo when there is room, below it when
            there is not - so the chain is visible while the memo is read,
            which a tab can never be.
          */}
          <section className="card p-3.5">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="text-ui font-semibold text-content">Approval chain</h2>
              <span className="font-mono text-data uppercase tracking-wide text-content-subtle tabular-nums">
                <span aria-hidden="true">
                  {completedSteps}/{totalSteps}
                </span>
                <span className="sr-only">
                  {completedSteps} of {totalSteps} steps done
                </span>
              </span>
            </div>
            <ApprovalChain steps={workflowSteps} />
            <p className="mt-3 text-meta text-content-muted">{workflowSummary}</p>
          </section>

          <QuickInfo
            reviewers={reviewers}
            approvers={approvers}
          />
        </div>
      </div>

      <SignApproveModal
        open={signModalOpen || (signRequested && canAct)}
        documentId={documentId}
        documentTitle={document.title}
        actingFor={actingFor}
        slot={document.mySignatureSlot}
        attachedPdf={document.memoType === null}
        onClose={closeSigning}
        onSuccess={handleApproveSuccess}
      />

      <PreparerSignModal
        open={preparerSignOpen}
        pdfFile={resubmitFile}
        slot={preparedSlot}
        attachedPdf={document.memoType === null}
        documentTitle={document.title}
        confirmLabel="Sign & resubmit"
        submitting={resubmitLoading}
        onClose={() => {
          if (!resubmitLoading) {
            setPreparerSignOpen(false)
            setResubmitFile(null)
            setRewriting(null)
            setPreparedSlot(null)
          }
        }}
        onConfirm={handleSignedResubmit}
      />

      <ActionDialog
        open={activeAction !== null}
        type={activeAction ?? 'reject'}
        documentTitle={document.title}
        onCancel={() => setActiveAction(null)}
        onConfirm={handleConfirmAction}
      />

      <Modal
        open={skipModalOpen}
        onClose={closeSkipModal}
        title="Skip current step"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-ui text-content-muted">
            Skip the person currently assigned to review or approve this document.
            The reason you provide will be visible to everyone on this document.
          </p>
          <label htmlFor="doc-skip-reason" className="sr-only">
            Reason for skipping this step
          </label>
          <textarea
            id="doc-skip-reason"
            value={skipReason}
            onChange={e => setSkipReason(e.target.value)}
            rows={4}
            placeholder="Reason for skipping (required)"
            className="field py-2.5 resize-none"
          />
          {skipError && (
            <p className="field-error">{skipError}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={closeSkipModal} disabled={skipLoading}>
              Cancel
            </Button>
            <Button onClick={handleConfirmSkip} pending={skipLoading}>
              Skip step
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={deleteModalOpen}
        onClose={() => !deleteLoading && setDeleteModalOpen(false)}
        title={withdrawMode === 'cancel' ? 'Cancel this memo' : 'Withdraw this memo'}
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-ui text-content-muted">
            {withdrawMode === 'cancel'
              ? 'This stops its approval chain on the preparer\'s behalf. The memo, its files and every action on it stay on record, marked cancelled with your reason, and the preparer and the chain are told.'
              : 'This stops its approval chain. The memo, its files and every action on it stay on record, marked withdrawn with your reason. You can send a new version round again later.'}
          </p>
          <div>
            <label htmlFor="withdraw-reason" className="field-label">
              Reason
            </label>
            <textarea
              id="withdraw-reason"
              value={withdrawReason}
              maxLength={1000}
              rows={3}
              onChange={event => {
                setWithdrawReason(event.target.value)
                setDeleteError(null)
              }}
              aria-invalid={deleteError ? true : undefined}
              className="field"
              data-autofocus
            />
          </div>
          {deleteError && (
            <p role="alert" className="text-ui text-danger-ink">{deleteError}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setDeleteModalOpen(false)}
              disabled={deleteLoading}
            >
              Cancel
            </Button>
            <Button
              variant="dangerSolid"
              onClick={handleDelete}
              pending={deleteLoading}
            >
              {withdrawMode === 'cancel' ? 'Cancel memo' : 'Withdraw memo'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Phone only: the main action, always in reach, and the rest behind
          More. The spacer keeps the end of the page clear of the bar. */}
      <div aria-hidden="true" className="h-20 sm:hidden" />
      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-line bg-surface px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:hidden">
        {canApprove && !isDeleted && (
          <Button className="flex-1" onClick={() => setSignModalOpen(true)}>
            {signLabel}
          </Button>
        )}
        <Button
          variant="secondary"
          className={canApprove && !isDeleted ? '' : 'flex-1'}
          icon={<MoreHorizontal size={15} aria-hidden="true" />}
          aria-expanded={actionsOpen}
          aria-controls="memo-actions"
          onClick={() => setActionsOpen(true)}
        >
          {canApprove && !isDeleted ? 'More' : 'Actions'}
        </Button>
      </div>
      </Page>
  )
}
