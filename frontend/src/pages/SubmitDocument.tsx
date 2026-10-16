import { holdsCapability } from '../types/capability'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  History,
  Info,
  PenLine,
  Route,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { pdfjs } from '../utils/pdfjs'
import { newId } from '../utils/newId'

import { createDocument, fetchDocumentsCached } from '../services/documentsApi'
import { previewMemo, previewToFile } from '../services/memoApi'
import { fetchDocumentWorkflow } from '../services/documentDetailApi'
import { fetchUsersByIds } from '../services/usersApi'
import { UploadCancelledError, type UploadProgress } from '../services/uploadClient'
import { useCurrentUser } from '../contexts/currentUser'
import { ROUTES } from '../types/routes'
import type { AssignableUser } from '../types/submitDocument'
import type { WorkflowTemplate } from '../types/workflowTemplate'
import {
  MAX_PDF_SIZE_BYTES,
  MAX_SUPPORTING_FILES,
  collectSubmitDocumentIssues,
  formatFileSize,
  getReadinessChecks,
  toApprovalChainPayload,
  validateSupportingFile,
  type ApprovalStepForm,
} from '../utils/submitDocument'
import {
  templateHasBranching,
  type CompiledTemplateStep,
} from '../utils/workflowTemplateCompile'
import { fetchActiveTemplate, fetchTemplateRoute } from '../services/workflowTemplateApi'
import { fetchStartingRoutes } from '../services/memoTypeRoutesApi'
import {
  firstIncompleteStep,
  moveItem,
  nextStep,
  previousStep,
  stepEyebrowFor,
  type AuthoringMode,
  type SubmitStepId,
} from '../utils/submitSteps'
import { memoBodyHasNoProse } from '../utils/memoDom'
import type { MemoSignatureSlot } from '../types/memo'
import { slotToPlacement } from '../utils/pdfCoordinates'
import { formatFullName } from '../utils/user'

import PreparerSignModal, {
  type PreparerSignaturePayload,
} from '../components/PreparerSignModal'
import Button from '../components/ui/Button'
import ConfirmDialog from '../components/ui/ConfirmDialog'
import { Card, CardHeader } from '../components/ui/Card'
import { Page, PageHeader } from '../components/ui/Page'
import { Skeleton, LoadingAnnouncer } from '../components/ui/Skeleton'

import DocumentInfoCard, {
  type DuplicateMatch,
} from '../components/submit/DocumentInfoCard'
import { PrimaryFileCard, SupportingFilesCard } from '../components/submit/FileCards'
import MemoComposeCard from '../components/submit/MemoComposeCard'
import ApprovalChainBuilder from '../components/submit/ApprovalChainBuilder'
import AddPersonDialog from '../components/submit/AddPersonDialog'
import TemplatePicker from '../components/submit/TemplatePicker'
import RoutingPreview, { type PreviewStep } from '../components/submit/RoutingPreview'
import { ReadinessPanel, SubmitActions } from '../components/submit/SubmitActions'
import SubmitStepper from '../components/submit/SubmitStepper'
import Eyebrow from '../components/ui/Eyebrow'

import { useSubmitDocumentForm } from '../hooks/useSubmitDocumentForm'
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard'
import { clearStoredDraft, useSubmitDraft } from '../hooks/useSubmitDraft'
import { useServerMemoDraft } from '../hooks/useServerMemoDraft'
import { memoDateInputValue } from '../utils/format'

function describeAge(iso: string): string {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days < 1) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return 'over a month ago'
}

/**
 * How long ago, in the words somebody would use.
 *
 * A date alone reads as a filing date; "11 minutes ago" is what tells
 * somebody this is the memo they were writing before lunch.
 */
function formatDraftAge(updatedAt: string): string {
  const minutes = Math.round((Date.now() - new Date(updatedAt).getTime()) / 60000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'moments ago'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export default function SubmitDocument() {
  const navigate = useNavigate()
  const { user: currentUser } = useCurrentUser()

  const { state, dispatch, dirty } = useSubmitDocumentForm()
  const guard = useUnsavedChangesGuard(dirty)
  const { draft, discard: discardDraft, dismiss: dismissDraft } = useSubmitDraft(
    state,
    dirty,
  )
  /*
   * And the same memo on the server, which is what survives a different
   * machine or a cleared browser. Only a typed memo is kept there: an
   * uploaded memo is its file, and a file cannot be put in a draft.
   */
  const serverDraft = useServerMemoDraft(state, dirty)

  const [fileError, setFileError] = useState<string | null>(null)
  const [supportingError, setSupportingError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [signModalOpen, setSignModalOpen] = useState(false)

  /*
   * The drawn memo the preparer signs on, and the line their signature
   * belongs on.
   *
   * A typed memo has no PDF until the server draws one, so there is nothing
   * to place a signature against until this has been fetched. Held here
   * rather than inside the dialog because the dialog is the same one the
   * upload path uses, and it should not have to know which it is showing.
   */
  const [preparedPdf, setPreparedPdf] = useState<File | null>(null)
  const [preparedSlot, setPreparedSlot] = useState<MemoSignatureSlot | null>(null)
  const [preparingPreview, setPreparingPreview] = useState(false)
  /*
   * Bumped whenever the memo is replaced from outside the editor. The editor
   * is uncontrolled and seeds itself once, so this is what puts a restored
   * draft on screen rather than only into state.
   */
  const [composerSeed, setComposerSeed] = useState(0)
  const [attempted, setAttempted] = useState(false)
  const [step, setStep] = useState<SubmitStepId>('details')

  const [template, setTemplate] = useState<WorkflowTemplate | null>(null)

  /*
   * The route each kind of memo starts from (fit-gap decision 7): an
   * administrator names a workflow per memo type, and per uploaded PDF, and
   * it is picked here first. Only first - a preparer who chooses another
   * route, or builds a chain by hand, is never overridden, and a draft that
   * already carries a template keeps it.
   */
  const [startingRoutes, setStartingRoutes] = useState<Record<string, string>>({})
  const routeChosenByHand = useRef(false)
  const autoPicked = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchStartingRoutes()
      .then(routes => {
        if (!cancelled) setStartingRoutes(routes)
      })
      .catch(() => {
        /* No starting route is the old behaviour: the preparer chooses. */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const routeKey = state.authoring === 'typed' ? state.memoType : 'UPLOADED'
  const startingTemplateId = routeKey ? startingRoutes[routeKey] : undefined

  useEffect(() => {
    if (!startingTemplateId || routeChosenByHand.current) return
    if (state.templateId === startingTemplateId) return
    // A template already chosen some other way - a resumed draft - stays.
    if (state.templateId && state.templateId !== autoPicked.current) return

    let cancelled = false
    fetchActiveTemplate(startingTemplateId)
      .then(full => {
        if (cancelled || routeChosenByHand.current) return
        autoPicked.current = full.id
        setTemplate(full)
        dispatch({ type: 'setRoutingMode', mode: 'template' })
        dispatch({ type: 'setTemplate', templateId: full.id })
      })
      .catch(() => {
        /* Archived since, or unreachable: the preparer chooses, as before. */
      })
    return () => {
      cancelled = true
    }
  }, [startingTemplateId, state.templateId, dispatch])
  /** The route the server gave the chosen template for this memo, and for which memo. */
  const [templateRoute, setTemplateRoute] = useState<{
    key: string
    steps: CompiledTemplateStep[] | null
    error: string | null
  } | null>(null)
  const [recent, setRecent] = useState<
    { title: string; status: string; id: string; createdAt: string }[]
  >([])

  /**
   * Users resolved by the approver combobox, kept so the chain rows and the
   * routing preview can name someone without another request. It grows as
   * searches return; it is a cache, not the source of truth.
   */
  const [userCache, setUserCache] = useState<Map<string, AssignableUser>>(new Map())
  const rememberUser = useCallback((user: AssignableUser) => {
    setUserCache(previous => {
      if (previous.get(user.id) === user) return previous
      const next = new Map(previous)
      next.set(user.id, user)
      return next
    })
  }, [])

  /**
   * The step that asked for a new person, and what was typed when it did.
   *
   * Null when the dialog is closed. Held here rather than in the chain builder
   * because creating somebody is an administrator's act against the directory,
   * not a property of one row of this form - and because the newly created
   * person has to land in the cache the preview reads from.
   */
  const [addingPersonFor, setAddingPersonFor] = useState<{
    stepId: string
    query: string
  } | null>(null)

  /*
   * Only an administrator may add somebody: `admin.routes.ts` is
   * `router.use(authenticate, requireAdmin)`. For everyone else the picker
   * says who to ask rather than offering a button that can only 403.
   */
  /*
   * Does uploading a document here mean signing it?
   *
   * The organisation's policy, which is the only answer available for an
   * uploaded file - it has no memo type to ask. A typed memo is told by the
   * server when its page is drawn, which is more precise: the memo type can
   * overrule the policy either way.
   *
   * Absent reads as true, so a client open across a deploy of the older
   * server keeps collecting the signature it always did.
   */
  const uploadedNeedsSignature =
    currentUser?.workflowPolicy.preparerSignsOnSubmit !== false

  /**
   * Whether this particular submission collects a signature.
   *
   * A typed memo is told by its memo type; an uploaded file by the policy.
   * The step's wording comes from here so it cannot offer to do something the
   * submission will not do - the server is still what decides, and refuses
   * either mismatch.
   */
  const submissionIsSigned =
    state.authoring === 'typed' ? state.memoTypeSigns : uploadedNeedsSignature

  const canAddPerson = holdsCapability(currentUser, 'users.manage')

  // The preparer signs before the chain starts and is barred from acting on
  // their own document, so a step assigned to them could never be completed.
  const excludedApproverIds = useMemo(
    () => new Set(currentUser ? [currentUser.id] : []),
    [currentUser],
  )

  const abortRef = useRef<AbortController | null>(null)

  // Recent submissions power both the duplicate warning and "reuse last chain".
  useEffect(() => {
    let cancelled = false

    fetchDocumentsCached()
      .then(response => {
        if (cancelled || !currentUser) return
        const mine = response.documents
          .filter(document => document.preparerId === currentUser.id)
          .slice(0, 20)
        setRecent(
          mine.map(document => ({
            id: document.id,
            title: document.title,
            status: document.status,
            createdAt: document.createdAt,
          })),
        )
      })
      .catch(() => {
        // A missing history only costs two conveniences; never block the form.
      })

    return () => {
      cancelled = true
    }
  }, [currentUser])

  // Page count for the file card, and an early warning when the PDF will not
  // open in the signature step.
  useEffect(() => {
    const file = state.file
    if (!file || file.type !== 'application/pdf') return

    let cancelled = false

    file
      .arrayBuffer()
      .then(buffer => pdfjs.getDocument({ data: buffer }).promise)
      .then(doc => {
        if (!cancelled) dispatch({ type: 'setPdfPages', pages: doc.numPages })
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: 'setPdfUnreadable' })
      })

    return () => {
      cancelled = true
    }
  }, [state.file, dispatch])

  // ── Derived ───────────────────────────────────────────────────────────────

  /*
   * Which memo the route is for: the template and the two fields its
   * decisions test. The route is asked of the server - the compiler submission
   * runs - a moment after these stop changing, and an answer is used only
   * while it still belongs to them, so a slow reply for the last title can
   * never be shown under this one.
   */
  const templateRouteKey =
    state.routingMode === 'template' && template
      ? JSON.stringify([template.id, state.title, state.description])
      : null

  useEffect(() => {
    if (!templateRouteKey) return
    const [id, title, description] = JSON.parse(templateRouteKey) as [string, string, string]
    let cancelled = false

    const timer = window.setTimeout(() => {
      fetchTemplateRoute(id, { title, description })
        .then(steps => {
          if (!cancelled) setTemplateRoute({ key: templateRouteKey, steps, error: null })
        })
        .catch((problem: unknown) => {
          if (cancelled) return
          setTemplateRoute({
            key: templateRouteKey,
            steps: null,
            error:
              problem instanceof Error
                ? problem.message
                : 'Could not work out where this template sends the memo.',
          })
        })
    }, 300)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [templateRouteKey])

  const currentRoute =
    templateRoute && templateRoute.key === templateRouteKey ? templateRoute : null
  const compiledTemplateSteps = currentRoute?.steps ?? null
  const templateRouteError = currentRoute?.error ?? null

  // A template names its approvers by id. Nothing has searched for them, so
  // resolve them once per selection or the routing preview reads
  // "Not assigned yet" for people the template has very much assigned.
  useEffect(() => {
    if (!compiledTemplateSteps) return

    const missing = [
      ...new Set(
        compiledTemplateSteps
          .map(step => step.assignedUserId)
          .filter(id => !userCache.has(id)),
      ),
    ]
    if (missing.length === 0) return

    let cancelled = false

    fetchUsersByIds(missing)
      .then(people => {
        if (cancelled) return
        for (const person of people) rememberUser(person)
      })
      .catch(() => {
        // The preview falls back to "Not assigned yet"; the submission is
        // unaffected, since the server routes by id.
      })

    return () => {
      cancelled = true
    }
  }, [compiledTemplateSteps, userCache, rememberUser])

  const validationInput = useMemo(
    () => ({
      title: state.title,
      file: state.file,
      authoring: state.authoring,
      memoType: state.memoType,
      memoTo: state.memoTo,
      memoFrom: state.memoFrom,
      memoDate: state.memoDate,
      body: state.body,
      steps: state.steps,
      routingMode: state.routingMode,
      templateId: state.templateId,
      templateSteps: compiledTemplateSteps,
      templateRouteError,
      // So the form can refuse a chain that routes this document back to the
      // person submitting it, which the server refuses after they have signed.
      preparerId: currentUser?.id ?? null,
    }),
    [state, compiledTemplateSteps, templateRouteError, currentUser?.id],
  )

  const issues = useMemo(
    () => collectSubmitDocumentIssues(validationInput),
    [validationInput],
  )
  const checks = useMemo(() => getReadinessChecks(validationInput), [validationInput])

  const readyCount = checks.filter(check => check.done).length
  const outstanding = checks.length - readyCount

  const previewSteps: PreviewStep[] = useMemo(() => {
    if (state.routingMode === 'template') {
      return (compiledTemplateSteps ?? []).map((step, index) => ({
        key: `${step.assignedUserId}-${index}`,
        approvalType: step.approvalType,
        user: userCache.get(step.assignedUserId) ?? null,
      }))
    }
    return state.steps.map(step => ({
      key: step.id,
      approvalType: step.approvalType,
      user: userCache.get(step.userId) ?? null,
    }))
  }, [state.routingMode, state.steps, compiledTemplateSteps, userCache])

  /**
   * The columns the foot of the page will carry, in signing order.
   *
   * Built from the same two things the server builds the strip from: whether
   * the preparer signs, and the chain. A column here that the filed page does
   * not print - or the other way round - would be this screen telling the
   * preparer their memo ends in a shape it does not.
   */
  const sheetSignatories = useMemo(() => {
    const columns = state.memoTypeSigns && currentUser
      ? [
          {
            key: currentUser.id,
            name: `${currentUser.firstName} ${currentUser.lastName}`.trim(),
          },
        ]
      : []

    for (const step of previewSteps) {
      // A step naming nobody yet is not a column. The strip grows as the
      // chain is built, which is what makes the shape of the page visible
      // while there is still time to change it.
      if (!step.user) continue
      columns.push({
        key: step.key,
        name: `${step.user.firstName} ${step.user.lastName}`.trim(),
      })
    }

    return columns
  }, [state.memoTypeSigns, currentUser, previewSteps])

  const duplicate: DuplicateMatch | null = useMemo(() => {
    const typed = state.title.trim().toLowerCase()
    if (typed.length < 4) return null
    const match = recent.find(
      document =>
        document.title.trim().toLowerCase() === typed && document.status !== 'DELETED',
    )
    return match
      ? {
          id: match.id,
          title: match.title,
          status: match.status,
          age: describeAge(match.createdAt),
        }
      : null
  }, [state.title, recent])

  const titleErrorShown = attempted ? issues.title : null
  const chainErrorShown = attempted ? issues.chain : null

  // ── Handlers ──────────────────────────────────────────────────────────────

  const applyFile = (next: File) => {
    if (next.type !== 'application/pdf') {
      setFileError('Only PDF files are allowed.')
      dispatch({ type: 'setFile', file: null })
      return
    }
    if (next.size > MAX_PDF_SIZE_BYTES) {
      setFileError(`File is ${formatFileSize(next.size)}. The limit is 20 MB.`)
      dispatch({ type: 'setFile', file: null })
      return
    }
    setFileError(null)
    dispatch({ type: 'setFile', file: next })
  }

  const addSupportingFiles = (list: FileList | null) => {
    if (!list?.length) return
    setSupportingError(null)

    const next = [...state.supportingFiles]
    for (const selected of Array.from(list)) {
      if (next.some(item => item.name === selected.name && item.size === selected.size)) {
        continue
      }
      if (next.length >= MAX_SUPPORTING_FILES) {
        setSupportingError(
          `You can attach up to ${MAX_SUPPORTING_FILES} supporting files.`,
        )
        break
      }
      const error = validateSupportingFile(selected)
      if (error) {
        setSupportingError(error)
        continue
      }
      next.push(selected)
    }

    dispatch({ type: 'setSupportingFiles', files: next })
  }

  const leave = (href: string) => {
    if (guard.requestNavigation(href)) navigate(href)
  }

  /**
   * Draw the memo, so there is a page to sign on.
   *
   * Asked for at the moment of signing rather than kept from an earlier look:
   * the signature strip sits under the text, so every edit moves the lines the
   * signatures go on. A cached preview would put the preparer's mark against
   * a layout that no longer exists.
   */
  /**
   * Draw the memo, and find out whether its author signs it.
   *
   * Both answers come from the one call on purpose. The strip is laid out by
   * the same request that reports this, so a page drawn with no column for
   * the preparer can never arrive alongside an instruction to sign one.
   *
   * Null means the memo could not be drawn at all.
   */
  const prepareTypedMemo = async (): Promise<{ preparerSigns: boolean } | null> => {
    setPreparingPreview(true)

    try {
      const preview = await previewMemo({
        title: state.title,
        memoTo: state.memoTo,
        memoFrom: state.memoFrom,
        // The drawing the preparer signs has to be dated as the filed copy
        // will be, or it is a different page with the ruled lines elsewhere.
        memoDate: state.memoDate,
        // Which decides whether the strip starts with the preparer's line.
        memoType: state.memoType ?? undefined,
        // Drawn on the page the preparer is about to sign, because the filed
        // copy will carry them and the two have to be the same drawing.
        notes: state.notes,
        body: state.body,
        chain: toApprovalChainPayload(state.steps.filter(step => step.userId)),
      })

      setPreparedPdf(previewToFile(preview.pdfBase64, state.title))
      setPreparedSlot(
        preview.slots.find(slot => slot.key === currentUser?.id) ?? null,
      )
      return { preparerSigns: preview.preparerSigns !== false }
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : 'The memo could not be prepared for signing. Try again.',
      )
      return null
    } finally {
      setPreparingPreview(false)
    }
  }

  const openSignStep = () => {
    setSubmitError(null)
    setAttempted(true)

    if (issues.firstMessage) {
      const firstBadStep = state.steps.find(entry => issues.steps[entry.id])
      const targetId = issues.title
        ? 'submit-doc-title'
        : issues.file
          ? 'submit-doc-file-drop'
          : state.routingMode === 'template'
            ? 'routing-mode-heading'
            : firstBadStep
              ? `step-${firstBadStep.id}-user`
              : 'approval-chain-heading'

      /* The offending control now lives on a step that may not be mounted,
         so move there FIRST. Focusing an unmounted id was the failure mode
         the moment this form stopped being one long page: validation would
         report a problem and then send focus nowhere. */
      const owning = issues.title ? 'details' : issues.file ? 'file' : 'routing'
      setStep(owning)

      requestAnimationFrame(() => {
        const target = document.getElementById(targetId)
        target?.focus()
        target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
      return
    }

    if (state.authoring === 'typed') {
      // Nothing opens until the memo has been drawn: the dialog's whole job
      // is placing a signature on a page, and there is no page yet.
      void prepareTypedMemo().then(prepared => {
        if (!prepared) return
        // A memo whose author does not sign it has no column for them on the
        // strip, so there is nothing for the dialog to do. It goes straight
        // to the first approver.
        if (!prepared.preparerSigns) {
          void handleSignedSubmit(undefined)
          return
        }
        setSignModalOpen(true)
      })
      return
    }

    if (!uploadedNeedsSignature) {
      void handleSignedSubmit(undefined)
      return
    }

    setSignModalOpen(true)
  }

  const handleSignedSubmit = async (
    signature: PreparerSignaturePayload | undefined,
  ) => {
    setSubmitting(true)
    setSubmitError(null)
    setProgress({ loaded: 0, total: 0, fraction: 0 })

    const controller = new AbortController()
    abortRef.current = controller

    try {
      await createDocument(
        {
          title: state.title,
          description: state.description,
          ...(state.authoring === 'typed'
            ? {
                body: state.body,
                notes: state.notes,
                memoType: state.memoType ?? undefined,
                memoTo: state.memoTo,
                memoFrom: state.memoFrom,
                memoDate: state.memoDate,
              }
            : { file: state.file! }),
          ...(state.routingMode === 'template'
            ? { templateId: state.templateId! }
            : { approvalChain: toApprovalChainPayload(state.steps) }),
          // Omitted entirely rather than sent empty: the server refuses a
          // signature on a document nobody signs at submission, which is what
          // stops a mark being put on a page that prints no line for it.
          ...(signature ? { signature } : {}),
          supportingFiles: state.supportingFiles,
          // Deleted server-side inside the same transaction that files the
          // memo, so an unfinished copy is never offered back afterwards.
          ...(serverDraft.draftId ? { draftId: serverDraft.draftId } : {}),
        },
        {
          signal: controller.signal,
          onProgress: setProgress,
        },
      )

      clearStoredDraft()
      // The server has already deleted its copy; this only stops a save that
      // was in flight from writing it back.
      serverDraft.submitted()
      setSignModalOpen(false)
      // The guard reads a ref, so clearing the form before navigating stops it
      // prompting on the way out of a submission that succeeded.
      dispatch({ type: 'reset' })
      navigate(ROUTES.dashboard)
    } catch (err) {
      const message =
        err instanceof UploadCancelledError
          ? 'Upload cancelled. Nothing was submitted.'
          : err instanceof Error
            ? err.message
            : 'Failed to submit document'
      setSubmitError(message)
      throw err
    } finally {
      abortRef.current = null
      setProgress(null)
      setSubmitting(false)
    }
  }

  /**
   * The chain from the preparer's most recent submission, offered as a
   * starting point. Most people route the same kind of document to the same
   * people repeatedly, and rebuilding it by hand every time is the bulk of the
   * work on this screen.
   */
  const [reusableChain, setReusableChain] = useState<{
    label: string
    steps: ApprovalStepForm[]
  } | null>(null)

  useEffect(() => {
    const previous = recent.find(document => document.status !== 'DELETED')
    if (!previous) return

    let cancelled = false

    fetchDocumentWorkflow(previous.id)
      .then(workflow => {
        if (cancelled) return
        const steps = workflow.workflow ?? []
        if (steps.length === 0) return

        for (const step of steps) {
          rememberUser({
            id: step.assignedUser.id,
            firstName: step.assignedUser.firstName,
            lastName: step.assignedUser.lastName,
            email: '',
            department: null,
          })
        }

        setReusableChain({
          label: steps
            .map(step =>
              formatFullName(step.assignedUser.firstName, step.assignedUser.lastName),
            )
            .join(' → '),
          steps: steps.map(step => ({
            id: newId(),
            approvalType: step.approvalType,
            userId: step.assignedUser.id,
          })),
        })
      })
      .catch(() => {
        // Only a convenience — a failure here should be invisible.
      })

    return () => {
      cancelled = true
    }
  }, [recent, rememberUser])

  // ── Render ────────────────────────────────────────────────────────────────

  if (!currentUser) {
    return (
      <Page>
        <div aria-hidden="true" className="mb-5 space-y-2">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-3 w-80" />
        </div>
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-5">
            <div aria-hidden="true" className="card space-y-4 p-5">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-24 w-full" />
            </div>
            <Skeleton className="h-48 w-full rounded-card" />
            <Skeleton className="h-40 w-full rounded-card" />
          </div>
          <Skeleton className="hidden h-72 w-full rounded-card xl:block" />
        </div>
        <LoadingAnnouncer loading label="Loading the submission form" />
      </Page>
    )
  }

  const back = previousStep(step)
  const forward = nextStep(step)

  return (
    <Page>
      <PageHeader
        eyebrow={stepEyebrowFor(step, state.authoring)}
        title="Submit a document"
        crumbs={[{ label: 'Documents', to: ROUTES.dashboard }, { label: 'Submit' }]}
      />

      <SubmitStepper
        current={step}
        checks={checks}
        attempted={attempted}
        authoring={state.authoring}
        onSelect={setStep}
      />

      {/*
        * A memo left unfinished in another session, on any machine.
        *
        * Offered above the local banner and instead of it: this one can put
        * the memo itself back, which the local draft can only do on the
        * device it was typed on. Both showing at once would be two banners
        * offering the same memo.
        */}
      {serverDraft.resumable && !draft && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-card border border-accent-line bg-accent-soft px-3.5 py-3">
          <div className="flex min-w-0 items-start gap-2">
            <History size={15} aria-hidden="true" className="mt-0.5 text-accent-ink" />
            <div className="min-w-0">
              <p className="text-ui font-medium text-content">
                You have a memo you have not finished writing
              </p>
              <p className="mt-0.5 text-meta leading-relaxed text-content-muted">
                {serverDraft.resumable.title
                  ? `“${serverDraft.resumable.title}”`
                  : 'Untitled'}
                {serverDraft.resumable.memoTypeLabel
                  ? ` · ${serverDraft.resumable.memoTypeLabel}`
                  : ''}{' '}
                — saved {formatDraftAge(serverDraft.resumable.updatedAt)}. It
                is kept on your account, so it opens on any machine.
              </p>
            </div>
          </div>
          <div className="flex flex-shrink-0 gap-2">
            <Button
              size="sm"
              onClick={() => {
                const resuming = serverDraft.resumable!
                dispatch({
                  type: 'restoreDraft',
                  draft: {
                    authoring: 'typed',
                    ...(resuming.title === null ? {} : { title: resuming.title }),
                    memoType: resuming.memoType,
                    ...(resuming.memoTo === null ? {} : { memoTo: resuming.memoTo }),
                    ...(resuming.memoFrom === null
                      ? {}
                      : { memoFrom: resuming.memoFrom }),
                    ...(resuming.memoDate
                      ? { memoDate: memoDateInputValue(resuming.memoDate) }
                      : {}),
                    ...(resuming.body ? { body: resuming.body } : {}),
                    ...(resuming.chain
                      ? {
                          routingMode: 'custom' as const,
                          steps: resuming.chain.map(step => ({
                            id: newId(),
                            userId: step.userId,
                            approvalType: step.approvalType,
                          })),
                        }
                      : {}),
                  },
                })
                // The editor seeds itself once, so the restored memo reaches
                // the screen through a remount and not otherwise.
                setComposerSeed(seed => seed + 1)
                serverDraft.adopt(resuming)
                setStep('file')
              }}
            >
              Resume
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void serverDraft.discard()}
              icon={<X size={13} aria-hidden="true" />}
            >
              Discard
            </Button>
          </div>
        </div>
      )}

      {draft && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-card border border-accent-line bg-accent-soft px-3.5 py-3">
          <div className="flex min-w-0 items-start gap-2">
            <History size={15} aria-hidden="true" className="mt-0.5 text-accent-ink" />
            <div className="min-w-0">
              <p className="text-ui font-medium text-content">
                You have an unfinished submission from {draft.savedAtLabel}
              </p>
              <p className="mt-0.5 text-meta leading-relaxed text-content-muted">
                {draft.title ? `“${draft.title}”` : 'Untitled'} — the text and
                approval chain can be restored.{' '}
                {draft.fileName
                  ? `You will need to re-attach ${draft.fileName}.`
                  : 'No file was attached.'}
              </p>
            </div>
          </div>
          <div className="flex flex-shrink-0 gap-2">
            <Button
              size="sm"
              onClick={() => {
                dispatch({
                  type: 'restoreDraft',
                  draft: {
                    title: draft.title,
                    description: draft.description,
                    routingMode: draft.routingMode,
                    templateId: draft.templateId,
                    steps: draft.steps,
                    /*
                     * And the memo itself. The draft has stored these since
                     * the form could write memos; restoring left them out,
                     * so somebody who typed a memo, closed the tab and
                     * pressed Restore got their title and chain back and
                     * their memo gone.
                     */
                    ...(draft.authoring ? { authoring: draft.authoring } : {}),
                    ...(draft.memoType === undefined
                      ? {}
                      : { memoType: draft.memoType }),
                    ...(draft.memoTo === undefined ? {} : { memoTo: draft.memoTo }),
                    ...(draft.memoFrom === undefined
                      ? {}
                      : { memoFrom: draft.memoFrom }),
                    ...(draft.memoDate === undefined
                      ? {}
                      : { memoDate: draft.memoDate }),
                    ...(draft.body ? { body: draft.body } : {}),
                  },
                })
                // The editor is uncontrolled, so a new body only reaches the
                // screen through a remount.
                if (draft.body) setComposerSeed(seed => seed + 1)
                dismissDraft()
              }}
            >
              Restore
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={discardDraft}
              icon={<X size={13} aria-hidden="true" />}
            >
              Discard
            </Button>
          </div>
        </div>
      )}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_21.25rem]">
        <div className="space-y-4">
          {step === 'details' && (
            <DocumentInfoCard
              title={state.title}
              description={state.description}
              titleError={titleErrorShown}
              duplicate={duplicate}
              onTitleChange={value => dispatch({ type: 'setTitle', value })}
              onDescriptionChange={value => dispatch({ type: 'setDescription', value })}
              onOpenDuplicate={id => leave(`/documents/${id}`)}
            />
          )}

          {step === 'file' && (
            <>
              <AuthoringPicker
                mode={state.authoring}
                onChange={mode => dispatch({ type: 'setAuthoring', mode })}
              />

              {state.authoring === 'typed' ? (
                <MemoComposeCard
                  memoType={state.memoType}
                  title={state.title}
                  memoTo={state.memoTo}
                  memoFrom={state.memoFrom}
                  memoDate={state.memoDate}
                  body={state.body}
                  seed={composerSeed}
                  error={attempted ? issues.file : null}
                  saveState={serverDraft.saveState}
                  onMemoTypeChange={(memoType, outline, preparerSigns) =>
                    dispatch({
                      type: 'setMemoType',
                      memoType,
                      body: outline,
                      preparerSigns,
                    })
                  }
                  onTitleChange={value => dispatch({ type: 'setTitle', value })}
                  onMemoToChange={value => dispatch({ type: 'setMemoTo', value })}
                  onMemoFromChange={value => dispatch({ type: 'setMemoFrom', value })}
                  onMemoDateChange={value => dispatch({ type: 'setMemoDate', value })}
                  onBodyChange={body => dispatch({ type: 'setBody', body })}
                  notes={state.notes}
                  onNotesChange={notes => dispatch({ type: 'setNotes', notes })}
                  signatories={sheetSignatories}
                />
              ) : (
              <PrimaryFileCard
                file={state.file}
                pdfPages={state.pdfPages}
                pdfUnreadable={state.pdfUnreadable}
                error={fileError ?? (attempted ? issues.file : null)}
                onSelect={applyFile}
                onClear={() => {
                  dispatch({ type: 'setFile', file: null })
                  setFileError(null)
                }}
              />
              )}

              <SupportingFilesCard
                files={state.supportingFiles}
                error={supportingError}
                onAdd={addSupportingFiles}
                onRemove={index =>
                  dispatch({
                    type: 'setSupportingFiles',
                    files: state.supportingFiles.filter((_, i) => i !== index),
                  })
                }
              />
            </>
          )}

          {step === 'routing' && (
            <Card>
              <CardHeader
                icon={Route}
                tone="warning"
                title="Approval routing"
                hint="Use a workflow from Workflow studio, or build the approval chain for this document by hand."
                meta={
                  state.routingMode === 'custom'
                    ? `${state.steps.length} step${state.steps.length === 1 ? '' : 's'}`
                    : undefined
                }
              />
              <div className="p-3.5 sm:p-4">
                <h3 id="routing-mode-heading" tabIndex={-1} className="sr-only">
                  Approval routing
                </h3>

                <div
                  role="tablist"
                  aria-label="Routing method"
                  className="mb-3.5 inline-flex rounded-control border border-line bg-canvas p-0.75"
                >
                  {(
                    [
                      ['template', 'Template'],
                      ['custom', 'Manual'],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      role="tab"
                      aria-selected={state.routingMode === mode}
                      onClick={() => {
                        routeChosenByHand.current = true
                        dispatch({ type: 'setRoutingMode', mode })
                      }}
                      className={`rounded-chip px-3 py-1 text-ui font-medium transition-colors ${
                        state.routingMode === mode
                          ? 'bg-surface text-content shadow-card'
                          : 'text-content-muted hover:text-content'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {state.routingMode === 'template' ? (
                  <TemplatePicker
                    selectedId={state.templateId}
                    problem={chainErrorShown}
                    onSelect={selected => {
                      routeChosenByHand.current = true
                      setTemplate(selected)
                      dispatch({ type: 'setTemplate', templateId: selected?.id ?? null })
                    }}
                  />
                ) : (
                  <>
                    <ApprovalChainBuilder
                      steps={state.steps}
                      usersById={userCache}
                      stepErrors={attempted ? issues.steps : {}}
                      excludeIds={excludedApproverIds}
                      reusable={reusableChain}
                      onAdd={() => dispatch({ type: 'addStep' })}
                      onRemove={id => dispatch({ type: 'removeStep', id })}
                      onMove={(index, direction) =>
                        dispatch({ type: 'moveStep', index, direction })
                      }
                      onReorder={(from, to) =>
                        dispatch({
                          type: 'replaceSteps',
                          steps: moveItem(state.steps, from, to),
                        })
                      }
                      onUpdate={(id, field, value) =>
                        dispatch({ type: 'updateStep', id, field, value })
                      }
                      onReuse={() => {
                        if (reusableChain) {
                          dispatch({ type: 'replaceSteps', steps: reusableChain.steps })
                        }
                      }}
                      onUserResolved={rememberUser}
                      canAddPerson={canAddPerson}
                      onAddPerson={(stepId, query) =>
                        setAddingPersonFor({ stepId, query })
                      }
                    />

                    {/*
                      * Rendered only while open, and keyed on the search that
                      * opened it, so each time it is a fresh mount holding a
                      * fresh prefill. The alternative - one long-lived dialog
                      * resetting its own fields in an effect - is the cascading
                      * render this codebase lints against.
                      */}
                    {addingPersonFor && (
                    <AddPersonDialog
                      key={`${addingPersonFor.stepId}:${addingPersonFor.query}`}
                      open
                      query={addingPersonFor.query}
                      onClose={() => setAddingPersonFor(null)}
                      onCreated={user => {
                        /*
                         * Straight into the step that asked. Remembering them
                         * first means the row and the routing preview can name
                         * them without waiting for another search - and without
                         * it the step would show "Assigned - loading their
                         * name…" for somebody who is already known.
                         */
                        rememberUser(user)
                        if (addingPersonFor) {
                          dispatch({
                            type: 'updateStep',
                            id: addingPersonFor.stepId,
                            field: 'userId',
                            value: user.id,
                          })
                        }
                        setAddingPersonFor(null)
                      }}
                    />
                    )}

                    {chainErrorShown && (
                      <p id="approval-chain-error" role="alert" className="field-error">
                        <AlertCircle
                          size={13}
                          aria-hidden="true"
                          className="flex-shrink-0"
                        />
                        {chainErrorShown}
                      </p>
                    )}
                  </>
                )}

                <p className="mt-3.5 flex items-start gap-2 rounded-control bg-info-soft px-3 py-2.5 text-meta leading-relaxed text-info-ink">
                  <Info size={13} aria-hidden="true" className="mt-px flex-shrink-0" />
                  Any step can approve, reject, or request a revision. A rejection ends
                  the approval chain; a revision request sends the document back to you for a
                  new version.
                </p>
              </div>
            </Card>
          )}

          {step === 'sign' && (
            <Card>
              <CardHeader
                icon={PenLine}
                title={submissionIsSigned ? 'Review and sign' : 'Review and submit'}
                hint={
                  submissionIsSigned
                    ? 'Check this is right, then place your signature on the PDF.'
                    : 'Check this is right. It goes to the first approver unsigned — you are not a signatory on this one.'
                }
                meta={`${readyCount}/${checks.length} ready`}
              />
              <div className="p-3.5 sm:p-4">
                <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                  <SummaryRow label="Title" value={state.title.trim() || null} step="details" onGo={setStep} />
                  <SummaryRow
                    label={state.authoring === 'typed' ? 'Memo' : 'PDF'}
                    value={
                      state.authoring === 'typed'
                        ? memoBodyHasNoProse(state.body)
                          ? null
                          : `Written here, to ${state.memoTo.trim() || 'nobody yet'}`
                        : state.file
                          ? `${state.file.name} · ${formatFileSize(state.file.size)}`
                          : null
                    }
                    step="file"
                    onGo={setStep}
                  />
                  <SummaryRow
                    label="Supporting files"
                    value={
                      state.supportingFiles.length
                        ? `${state.supportingFiles.length} attached`
                        : 'None'
                    }
                    step="file"
                    onGo={setStep}
                  />
                  <SummaryRow
                    label="Routing"
                    value={
                      state.routingMode === 'template'
                        ? template
                          ? `Template: ${template.name}`
                          : null
                        : previewSteps.length
                          ? `${previewSteps.length} step${previewSteps.length === 1 ? '' : 's'}, built by hand`
                          : null
                    }
                    step="routing"
                    onGo={setStep}
                  />
                </dl>

                <div className="mt-4 border-t border-line-soft pt-4">
                  <SubmitActions
                    submitError={submitError}
                    outstanding={outstanding}
                    attempted={attempted}
                    submitting={submitting || preparingPreview}
                    progress={progress}
                    onSubmit={openSignStep}
                    signs={submissionIsSigned}
                    onCancel={() => leave(ROUTES.dashboard)}
                    onCancelUpload={() => abortRef.current?.abort()}
                  />
                </div>
              </div>
            </Card>
          )}

          {/* Step navigation. The stepper above jumps anywhere; this is the
              one-handed path through the form in order. On a phone it stays
              at the foot of the screen, so Continue is never a scroll away. */}
          <div className="flex items-center justify-between gap-3 max-sm:sticky max-sm:bottom-0 max-sm:z-10 max-sm:-mx-4 max-sm:border-t max-sm:border-line max-sm:bg-surface max-sm:px-4 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))] max-sm:pt-3">
            {back ? (
              <Button
                variant="secondary"
                onClick={() => setStep(back)}
                icon={<ArrowLeft size={15} aria-hidden="true" />}
              >
                Back
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => leave(ROUTES.dashboard)}>
                Cancel
              </Button>
            )}

            {forward && (
              <Button onClick={() => setStep(forward)}>
                Continue
                <ArrowRight size={15} aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>

        <aside className="space-y-3 xl:sticky xl:top-4">
          {/*
            The design also puts a "Projected timeline" card here — a per-step
            ETA totalling "~4.2 days". It needs `slaDays` on each routing step,
            which the template node schema does not have, so there is nothing
            to project from and a duration invented on this screen would be
            read as a commitment to the approvers named beside it.
          */}
          <ReadinessPanel checks={checks} />

          <RoutingPreview
            preparer={currentUser}
            steps={previewSteps}
            branching={
              state.routingMode === 'template' &&
              Boolean(template) &&
              templateHasBranching(template!.graph)
            }
            emptyLabel={
              state.routingMode === 'template' ? 'No template chosen yet' : undefined
            }
          />

          {step !== 'sign' && outstanding === 0 && (
            <Button className="w-full" onClick={() => setStep('sign')}>
              Everything is ready — review and sign
            </Button>
          )}

          {step !== 'sign' && attempted && outstanding > 0 && (
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => setStep(firstIncompleteStep(checks))}
            >
              Go to what is missing
            </Button>
          )}
        </aside>
      </div>

      <PreparerSignModal
        open={signModalOpen}
        pdfFile={state.authoring === 'typed' ? preparedPdf : state.file}
        attachedPdf={state.authoring !== 'typed'}
        slot={
          state.authoring === 'typed' && preparedSlot
            ? slotToPlacement(preparedSlot)
            : null
        }
        documentTitle={state.title.trim() || 'Untitled document'}
        submitting={submitting}
        onClose={() => {
          if (!submitting) {
            setSignModalOpen(false)
            // The drawn memo goes with the dialog. Keeping it would mean the
            // next open could show a page drawn before the last few edits.
            setPreparedPdf(null)
            setPreparedSlot(null)
          }
        }}
        onConfirm={handleSignedSubmit}
      />

      <ConfirmDialog
        open={guard.pendingHref !== null}
        title="Leave without submitting?"
        confirmLabel="Discard and leave"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => {
          const href = guard.confirmNavigation()
          if (href) navigate(href)
        }}
        onCancel={guard.cancelNavigation}
      >
        This document has not been submitted. Your title, description and approval chain
        are saved as a draft on this device, but the files you attached are not.
      </ConfirmDialog>
    </Page>
  )
}

/** One line of the Sign step's summary, with a jump back to where it is set. */
function SummaryRow({
  label,
  value,
  step,
  onGo,
}: {
  label: string
  /** `null` means the field is still empty, and says so in the danger tone. */
  value: string | null
  step: SubmitStepId
  onGo: (step: SubmitStepId) => void
}) {
  return (
    <div className="min-w-0">
      <Eyebrow as="dt">{label}</Eyebrow>
      <dd className="mt-1 flex items-baseline gap-2">
        <span
          className={`min-w-0 flex-1 truncate text-ui ${
            value ? 'text-content' : 'text-danger-ink'
          }`}
          title={value ?? undefined}
        >
          {value ?? 'Not set'}
        </span>
        <button
          type="button"
          onClick={() => onGo(step)}
          className="flex-shrink-0 text-meta font-medium text-accent-ink transition-colors hover:text-accent-active"
        >
          Edit
        </button>
      </dd>
    </div>
  )
}

/**
 * Attach a PDF, or write the memo here.
 *
 * Presented as two equal choices rather than as a checkbox on the upload
 * card: they are different ways of producing the same document, and neither
 * is a modifier of the other. Uploading stays selected by default, because it
 * is what everybody here does today.
 */
function AuthoringPicker({
  mode,
  onChange,
}: {
  mode: AuthoringMode
  onChange: (mode: AuthoringMode) => void
}) {
  const options: { value: AuthoringMode; label: string; hint: string }[] = [
    {
      value: 'upload',
      label: 'Attach a PDF',
      hint: 'A memo written in Word and exported as a PDF.',
    },
    {
      value: 'typed',
      label: 'Write it here',
      hint: 'Typed in the portal and set on the standard letterhead.',
    },
  ]

  return (
    <fieldset className="card p-3.5 sm:p-4">
      <legend className="field-label">How is this memo being provided?</legend>

      <div className="grid gap-2 sm:grid-cols-2">
        {options.map(option => {
          const selected = option.value === mode
          return (
            <label
              key={option.value}
              className={`flex cursor-pointer gap-2.5 rounded-control border p-3 transition-colors ${
                selected
                  ? 'border-accent bg-accent-soft'
                  : 'border-line hover:border-content-subtle'
              }`}
            >
              <input
                type="radio"
                name="authoring-mode"
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
                className="mt-0.5 flex-shrink-0 accent-accent"
              />
              <span className="min-w-0">
                <span className="block text-ui font-medium text-content">
                  {option.label}
                </span>
                <span className="mt-0.5 block text-meta leading-relaxed text-content-muted">
                  {option.hint}
                </span>
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
