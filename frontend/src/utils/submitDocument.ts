import type { ApiApprovalType } from '../types/document'
import type { MemoBody } from '../types/memo'
import { MEMO_BODY_LIMITS } from '../types/memo'
import { memoBodyHasNoProse, memoBodyLength } from './memoDom'
import type { ApprovalChainStepInput } from '../types/submitDocument'

export interface ApprovalStepForm {
  id: string
  approvalType: ApiApprovalType
  userId: string
}

/**
 * Descriptions mirror what the API actually does with each type, so the
 * form does not promise behaviour the workflow engine does not implement:
 * every step may approve, reject or request a revision — only the final
 * approver's approval closes the run, and only a reviewer is notified with
 * "review" wording instead of "approval".
 */
export const APPROVAL_TYPE_OPTIONS: {
  value: ApiApprovalType
  label: string
  description: string
}[] = [
  {
    value: 'REVIEWER',
    label: 'Reviewer',
    description:
      'Notified to review. Can approve, reject, or request a revision.',
  },
  {
    value: 'APPROVER',
    label: 'Approver',
    description:
      'Notified to approve. Can approve, reject, or request a revision.',
  },
  {
    value: 'FINAL_APPROVER',
    label: 'Final Approver',
    description:
      'Closes the workflow. Their approval marks the document Approved.',
  },
]

export const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024
export const MAX_SUPPORTING_FILES = 5

/** Mirrors the API's own limits so a long value fails here, not as a 400. */
export const MAX_TITLE_LENGTH = 500
export const MAX_DESCRIPTION_LENGTH = 5000

export const SUPPORTING_FILE_ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx,.txt,.csv,application/pdf,image/png,image/jpeg,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/csv'

const SUPPORTING_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
])

/**
 * `(bytes / 1024 / 1024).toFixed(1) MB` rendered every small attachment as
 * "0.0 MB". Scale the unit to the value instead.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const EXTENSION_LABELS: Record<string, string> = {
  pdf: 'PDF',
  png: 'PNG image',
  jpg: 'JPEG image',
  jpeg: 'JPEG image',
  doc: 'Word document',
  docx: 'Word document',
  xls: 'Excel workbook',
  xlsx: 'Excel workbook',
  txt: 'Text file',
  csv: 'CSV file',
}

export function describeFileType(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_LABELS[extension] ?? 'File'
}

export function validateSupportingFile(file: File): string | null {
  const extensionOk = /\.(pdf|png|jpe?g|docx?|xlsx?|txt|csv)$/i.test(file.name)
  if (!SUPPORTING_MIME_TYPES.has(file.type) && !extensionOk) {
    return `"${file.name}" is not an allowed supporting file type.`
  }
  if (file.size > MAX_PDF_SIZE_BYTES) {
    return `"${file.name}" exceeds the 20 MB limit.`
  }
  return null
}

export interface SubmitDocumentIssues {
  /** Message for the title field, if any. */
  title: string | null
  /**
   * Message for the PDF drop zone, if any - or, for a memo written here, for
   * the editor and the header fields it shares a step with.
   *
   * One field for both because they are the same step and the same question:
   * where is the document? Splitting them would put a second error channel
   * through every caller for a case that is never both at once.
   */
  file: string | null
  /** Message about the chain as a whole (ordering, duplicates, final approver). */
  chain: string | null
  /** Per-step messages, keyed by `ApprovalStepForm.id`. */
  steps: Record<string, string>
  /**
   * The first message in validation order. The single-string validator
   * returns this, so the two views of the form can never disagree.
   */
  firstMessage: string | null
}

/**
 * The same rules the API enforces, reported per field so the form can point
 * at the control that is wrong instead of showing one message at the bottom.
 * Rule order matches the API's, with the title-length limit added so an
 * over-long title is caught here rather than coming back as a 400.
 */
export interface SubmitDocumentInput {
  title: string
  file: File | null
  steps: ApprovalStepForm[]
  /** 'template' routes through a saved workflow instead of the step list. */
  routingMode?: 'custom' | 'template'
  templateId?: string | null
  /**
   * What the chosen template compiles to for *this* document. The server
   * recompiles and revalidates at submit time; this lets the form refuse a
   * template that cannot complete before the preparer signs it.
   */
  templateSteps?: { approvalType: ApiApprovalType; assignedUserId?: string }[] | null
  /** Why the server could not route this memo through the template, if it could not. */
  templateRouteError?: string | null
  /**
   * Whoever is submitting. Optional only because a caller may not have loaded
   * the profile yet; without it the rule below cannot be checked and the form
   * says nothing rather than guessing.
   *
   * The server refuses a chain that contains the preparer - they would be
   * approving their own memo - and the form had no equivalent rule, so the
   * checklist read 5 of 5 for a submission that could not be made. The
   * preparer found out after drawing their signature, with the routing two
   * steps behind them.
   */
  preparerId?: string | null
  /** 'typed' means the memo is written here and drawn by the server. */
  authoring?: 'upload' | 'typed'
  memoType?: string | null
  memoTo?: string
  memoFrom?: string
  /** The date the memo bears, as `2026-08-06`. */
  memoDate?: string
  body?: MemoBody | null
}

/**
 * What is missing from a memo written in the portal.
 *
 * Kept beside the upload rules rather than in a file of its own, because the
 * two are alternatives answering one question - is there a document to send? -
 * and a reader comparing them should not have to open two files.
 */
function typedMemoIssue(input: SubmitDocumentInput): string | null {
  if (!input.memoType) return 'Choose what kind of memo this is.'
  if (!input.memoTo?.trim()) return 'Say who the memo is addressed to.'
  if (!input.memoFrom?.trim()) return 'Say which department the memo is from.'

  /*
   * Only reachable by clearing the field - it is filled with today's date to
   * begin with. Caught here anyway, because the server refuses an empty one
   * and finding that out after the signing dialog has opened is too late.
   */
  if (!input.memoDate?.trim()) return 'Give the memo a date.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.memoDate)) {
    return 'Give the memo a date, as a day on the calendar.'
  }

  /*
   * Asked of the prose, not of every character.
   *
   * Choosing a memo type drops that type's outline into the editor, which is
   * text - so a plain length check said "written" the moment a type was
   * picked, and the checklist ticked for a memo holding nothing but the
   * headings this system put there itself.
   */
  if (!input.body || memoBodyHasNoProse(input.body)) {
    return 'Write the memo before submitting it.'
  }

  const length = memoBodyLength(input.body)

  if (length > MEMO_BODY_LIMITS.totalChars) {
    return `This memo is ${length.toLocaleString()} characters long; the limit is ${MEMO_BODY_LIMITS.totalChars.toLocaleString()}. Attach the detail as a supporting document instead.`
  }

  return null
}

/** Said the same way wherever it is said. */
const PREPARER_ON_CHAIN = 'You cannot approve your own document.'

export function collectSubmitDocumentIssues(
  input: SubmitDocumentInput,
): SubmitDocumentIssues {
  const issues: SubmitDocumentIssues = {
    title: null,
    file: null,
    chain: null,
    steps: {},
    firstMessage: null,
  }

  const ordered: string[] = []
  const record = (message: string) => {
    ordered.push(message)
    return message
  }

  if (!input.title.trim()) {
    issues.title = record('Document title is required.')
  } else if (input.title.trim().length > MAX_TITLE_LENGTH) {
    issues.title = record(
      `Document title cannot exceed ${MAX_TITLE_LENGTH} characters.`,
    )
  }

  if (input.authoring === 'typed') {
    // No file is expected, and none is sent. The server refuses a submission
    // carrying both, so asking for one here would make the form demand
    // something the API would then reject.
    const problem = typedMemoIssue(input)
    if (problem) issues.file = record(problem)
  } else if (!input.file) {
    issues.file = record('A PDF document is required.')
  } else if (input.file.type !== 'application/pdf') {
    issues.file = record('Only PDF files are allowed.')
  } else if (input.file.size > MAX_PDF_SIZE_BYTES) {
    issues.file = record('File size must not exceed 20 MB.')
  }

  if (input.routingMode === 'template') {
    // The chain comes from the template, so the step list is not validated —
    // but the template still has to be chosen, and still has to produce a
    // chain that can finish. The server enforces the same rules and will
    // refuse the submission; catching it here means the preparer finds out
    // before they sign rather than after.
    if (!input.templateId) {
      issues.chain = record('Choose a workflow template.')
    } else if (input.templateRouteError) {
      // The server's own words: it is the compiler submission will run.
      issues.chain = record(input.templateRouteError)
    } else if (input.templateSteps) {
      if (input.templateSteps.length === 0) {
        issues.chain = record(
          'This template produces no approval steps for this document.',
        )
      } else {
        const finals = input.templateSteps.filter(
          step => step.approvalType === 'FINAL_APPROVER',
        )
        const last = input.templateSteps[input.templateSteps.length - 1]
        if (finals.length !== 1 || last.approvalType !== 'FINAL_APPROVER') {
          issues.chain = record(
            'This template does not end in exactly one final approver for this document, so the workflow could never complete.',
          )
        } else if (
          input.preparerId &&
          input.templateSteps.some(step => step.assignedUserId === input.preparerId)
        ) {
          // A template is written once and used for years, by whoever it
          // suits - including the people named in it.
          issues.chain = record(
            'This template routes the document to you, and you cannot approve your own document. Choose another template, or route this one by hand.',
          )
        }
      }
    }

    issues.firstMessage = ordered[0] ?? null
    return issues
  }

  if (input.steps.length === 0) {
    issues.chain = record('At least one approval step is required.')
  } else {
    const unassigned = input.steps.filter(step => !step.userId)
    if (unassigned.length > 0) {
      record('Each approval step must have an assigned user.')
      for (const step of unassigned) {
        issues.steps[step.id] = 'Select the person who handles this step.'
      }
    }

    const seen = new Map<string, number>()
    for (const [index, step] of input.steps.entries()) {
      if (!step.userId) continue
      const firstIndex = seen.get(step.userId)
      if (firstIndex === undefined) {
        seen.set(step.userId, index)
      } else if (!issues.steps[step.id]) {
        issues.steps[step.id] = `Already assigned to step ${firstIndex + 1}.`
      }
    }

    if (seen.size !== input.steps.filter(step => step.userId).length) {
      issues.chain = record(
        'Duplicate users are not allowed in the approval chain.',
      )
    }

    /* Marked on the step, not only on the chain, because the chain message
       says what is wrong and the step says where. "Reuse that chain" is the
       likeliest way in: it replays a routing that may well name whoever is
       submitting this time. */
    const preparerSteps = input.preparerId
      ? input.steps.filter(step => step.userId === input.preparerId)
      : []
    if (preparerSteps.length > 0) {
      issues.chain = issues.chain ?? record(PREPARER_ON_CHAIN)
      for (const step of preparerSteps) {
        issues.steps[step.id] = issues.steps[step.id] ?? PREPARER_ON_CHAIN
      }
    }

    const finalApprovers = input.steps.filter(
      step => step.approvalType === 'FINAL_APPROVER',
    )

    if (finalApprovers.length !== 1) {
      issues.chain =
        issues.chain ?? record('Exactly one Final Approver is required.')
    } else {
      const lastStep = input.steps[input.steps.length - 1]
      if (lastStep.approvalType !== 'FINAL_APPROVER') {
        issues.chain =
          issues.chain ?? record('Final Approver must be the last step.')
      }
    }
  }

  issues.firstMessage = ordered[0] ?? null
  return issues
}

/** A rule the submitter can watch turn green as the form is filled in. */
export interface ReadinessCheck {
  id: string
  label: string
  done: boolean
}

export function getReadinessChecks(
  input: SubmitDocumentInput,
): ReadinessCheck[] {
  const titleAndFile: ReadinessCheck[] = [
    {
      id: 'title',
      label: 'Document title provided',
      done: Boolean(input.title.trim()),
    },
    input.authoring === 'typed'
      ? {
          id: 'file',
          label: 'Memo written, addressed and typed',
          done: typedMemoIssue(input) === null,
        }
      : {
          id: 'file',
          label: 'PDF attached (max 20 MB)',
          done:
            Boolean(input.file) &&
            input.file!.type === 'application/pdf' &&
            input.file!.size <= MAX_PDF_SIZE_BYTES,
        },
  ]

  if (input.routingMode === 'template') {
    const steps = input.templateSteps ?? []
    const finals = steps.filter(step => step.approvalType === 'FINAL_APPROVER')
    const last = steps[steps.length - 1]

    return [
      ...titleAndFile,
      {
        id: 'template',
        label: 'Workflow template chosen',
        done: Boolean(input.templateId),
      },
      {
        id: 'template-routes',
        label: 'Template routes this document to approvers',
        done: Boolean(input.templateId) && steps.length > 0,
      },
      {
        id: 'template-completes',
        label: 'Routing ends with a final approver',
        done:
          steps.length > 0 &&
          finals.length === 1 &&
          Boolean(last) &&
          last.approvalType === 'FINAL_APPROVER',
      },
      /* The same rule as on a hand-built chain, and just as invisible to the
         others: a template names people, and one of them can be whoever is
         using it today. Listed only when there is a profile to judge it
         against, for the same reason as below. */
      ...(input.preparerId
        ? [
            {
              id: 'not-preparer',
              label: 'You are not one of the approvers',
              done:
                steps.length > 0 &&
                !steps.some(step => step.assignedUserId === input.preparerId),
            },
          ]
        : []),
    ]
  }

  const assigned = input.steps.filter(step => step.userId)
  const userIds = assigned.map(step => step.userId)
  const finalApprovers = input.steps.filter(
    step => step.approvalType === 'FINAL_APPROVER',
  )
  const lastStep = input.steps[input.steps.length - 1]

  // "No person appears twice" and "exactly one final approver" are both
  // vacuously true of an empty chain, which showed an untouched form two
  // green ticks and a score of 2 of 5. A readiness indicator should not open
  // with credit the preparer has not earned, so both stay pending until there
  // is at least one assignee to judge.
  const hasAnyAssignee = assigned.length > 0

  return [
    ...titleAndFile,
    {
      id: 'steps',
      label: 'Every step has an assignee',
      done: input.steps.length > 0 && assigned.length === input.steps.length,
    },
    {
      id: 'unique',
      label: 'No person appears twice',
      done: hasAnyAssignee && new Set(userIds).size === userIds.length,
    },
    /* A separate line from "No person appears twice", because it is a
       separate rule: the preparer is not one of the steps, so nothing that
       compares the steps with each other can ever see them.
    
       Listed only when there is a profile to judge it against. A rule shown
       permanently unticked because nothing can evaluate it is worse than one
       that is not shown, and it would put the checklist out of step with what
       the form actually refuses. */
    ...(input.preparerId
      ? [
          {
            id: 'not-preparer',
            label: 'You are not one of the approvers',
            done: hasAnyAssignee && !userIds.includes(input.preparerId),
          },
        ]
      : []),
    {
      id: 'final',
      label: 'Exactly one final approver, placed last',
      done:
        hasAnyAssignee &&
        finalApprovers.length === 1 &&
        Boolean(lastStep) &&
        lastStep.approvalType === 'FINAL_APPROVER',
    },
  ]
}

export function toApprovalChainPayload(
  steps: ApprovalStepForm[],
): ApprovalChainStepInput[] {
  return steps.map(step => ({
    userId: step.userId,
    approvalType: step.approvalType,
  }))
}
