import { useMemo, useReducer } from 'react'
import type { ApiApprovalType } from '../types/document'
import type { MemoBody, MemoNote } from '../types/memo'
import { emptyMemoBody, memoBodyHasNoProse, memoBodyIsEmpty } from '../utils/memoDom'
import type { AuthoringMode } from '../utils/submitSteps'
import type { ApprovalStepForm } from '../utils/submitDocument'
import { todayAsDateInput } from '../utils/format'
import { newId } from '../utils/newId'

/**
 * Every field on the submission form in one reducer.
 *
 * The screen previously held fifteen independent `useState` calls, which was
 * workable while the form was one shape. It now has two routing modes, a draft
 * that has to be serialised and restored, and a dirty flag that has to know
 * whether *anything* has been touched — all of which need the fields as one
 * value rather than fifteen.
 */

export type RoutingMode = 'custom' | 'template'

export interface SubmitFormState {
  title: string
  description: string
  /**
   * Whether the memo is attached as a PDF or written here.
   *
   * The two are alternatives, never a mixture: the server refuses a
   * submission carrying both a file and a body, because it would have no
   * honest answer to which one the document is.
   */
  authoring: AuthoringMode
  /** Which kind of memo is being written. Only used when typing. */
  memoType: string | null
  /**
   * Whether writing this kind of memo means signing it.
   *
   * Resolved by the server and carried here so the sign step can say what it
   * will actually do. Starts true, which is how submission has always worked
   * and what an uploaded document falls back to until the policy says
   * otherwise.
   */
  memoTypeSigns: boolean
  /**
   * Notes placed on the page.
   *
   * Beside the body rather than inside it, exactly as the server keeps them:
   * the body is a flow that reflows, and a note is a box somebody put in a
   * particular place.
   */
  notes: MemoNote[]
  /** The header block's own fields, stored as columns rather than as prose. */
  memoTo: string
  memoFrom: string
  /**
   * The date the memo bears, as `2026-08-06`.
   *
   * Not the date it is submitted: a memo written on the 6th, agreed verbally
   * and put through the system on the 11th is dated the 6th, and the printed
   * header says so. Defaults to today, which is what it used to be fixed at.
   */
  memoDate: string
  body: MemoBody
  file: File | null
  supportingFiles: File[]
  routingMode: RoutingMode
  steps: ApprovalStepForm[]
  templateId: string | null
  /** Page count read from the PDF, once known. */
  pdfPages: number | null
  /** The PDF could not be opened for preview. */
  pdfUnreadable: boolean
}

function createEmptyStep(): ApprovalStepForm {
  return { id: newId(), approvalType: 'REVIEWER', userId: '' }
}

export function createInitialFormState(): SubmitFormState {
  return {
    title: '',
    description: '',
    // Uploading stays the default. It is what every preparer here does today,
    // and a form that changed what it was under them on the day this shipped
    // would be a worse introduction than a button saying there is another way.
    authoring: 'upload',
    memoType: null,
    memoTypeSigns: true,
    notes: [],
    memoTo: '',
    memoFrom: '',
    // Today, because that is what almost every memo is dated and what this
    // used to be fixed at. It stays editable.
    memoDate: todayAsDateInput(),
    body: emptyMemoBody(),
    file: null,
    supportingFiles: [],
    routingMode: 'custom',
    steps: [createEmptyStep()],
    templateId: null,
    pdfPages: null,
    pdfUnreadable: false,
  }
}

export type SubmitFormAction =
  | { type: 'setAuthoring'; mode: AuthoringMode }
  | {
      type: 'setMemoType'
      memoType: string | null
      body?: MemoBody
      preparerSigns?: boolean
    }
  | { type: 'setMemoTo'; value: string }
  | { type: 'setMemoFrom'; value: string }
  | { type: 'setMemoDate'; value: string }
  | { type: 'setBody'; body: MemoBody }
  | { type: 'setNotes'; notes: MemoNote[] }
  | { type: 'setTitle'; value: string }
  | { type: 'setDescription'; value: string }
  | { type: 'setFile'; file: File | null }
  | { type: 'setPdfPages'; pages: number }
  | { type: 'setPdfUnreadable' }
  | { type: 'setSupportingFiles'; files: File[] }
  | { type: 'setRoutingMode'; mode: RoutingMode }
  | { type: 'setTemplate'; templateId: string | null }
  | { type: 'addStep' }
  | { type: 'removeStep'; id: string }
  | { type: 'moveStep'; index: number; direction: -1 | 1 }
  | { type: 'updateStep'; id: string; field: 'userId' | 'approvalType'; value: string }
  | { type: 'replaceSteps'; steps: ApprovalStepForm[] }
  | { type: 'restoreDraft'; draft: Partial<SubmitFormState> }
  | { type: 'reset' }

export function submitFormReducer(
  state: SubmitFormState,
  action: SubmitFormAction,
): SubmitFormState {
  switch (action.type) {
    case 'setAuthoring':
      if (action.mode === state.authoring) return state
      /*
       * Nothing is thrown away by switching.
       *
       * Somebody who attached the wrong PDF, switched to writing, and then
       * realised they had the right one after all should find it still
       * attached. Only one of the two is ever sent, and which one is decided
       * by this flag - so keeping the other costs nothing and keeps a
       * mis-click from destroying work.
       */
      return { ...state, authoring: action.mode }

    case 'setMemoType':
      return {
        ...state,
        memoType: action.memoType,
        memoTypeSigns: action.preparerSigns ?? true,
        /*
         * The outline is a starting point, offered only for a body nobody has
         * written in - which means one holding no prose, not one holding no
         * characters. Judged by characters, changing your mind from one memo
         * type to another left the first type's headings in place, because
         * they were text.
         */
        ...(action.body && memoBodyHasNoProse(state.body) ? { body: action.body } : {}),
      }

    case 'setMemoTo':
      return { ...state, memoTo: action.value }

    case 'setMemoFrom':
      return { ...state, memoFrom: action.value }

    case 'setMemoDate':
      return { ...state, memoDate: action.value }

    case 'setBody':
      return { ...state, body: action.body }

    case 'setNotes':
      return { ...state, notes: action.notes }

    case 'setTitle':
      return { ...state, title: action.value }

    case 'setDescription':
      return { ...state, description: action.value }

    case 'setFile':
      // The page count and readability flag describe the file, so they are
      // cleared with it rather than in an effect that reacts to it.
      return { ...state, file: action.file, pdfPages: null, pdfUnreadable: false }

    case 'setPdfPages':
      return { ...state, pdfPages: action.pages }

    case 'setPdfUnreadable':
      return { ...state, pdfUnreadable: true }

    case 'setSupportingFiles':
      return { ...state, supportingFiles: action.files }

    case 'setRoutingMode':
      if (action.mode === state.routingMode) return state
      return {
        ...state,
        routingMode: action.mode,
        // Leaving template mode should not leave a template selected behind it.
        templateId: action.mode === 'template' ? state.templateId : null,
      }

    case 'setTemplate':
      return { ...state, templateId: action.templateId }

    case 'addStep':
      return { ...state, steps: [...state.steps, createEmptyStep()] }

    case 'removeStep':
      return { ...state, steps: state.steps.filter(step => step.id !== action.id) }

    case 'moveStep': {
      const target = action.index + action.direction
      if (target < 0 || target >= state.steps.length) return state
      const steps = [...state.steps]
      const [moved] = steps.splice(action.index, 1)
      steps.splice(target, 0, moved)
      return { ...state, steps }
    }

    case 'updateStep':
      return {
        ...state,
        steps: state.steps.map(step =>
          step.id === action.id
            ? {
                ...step,
                [action.field]:
                  action.field === 'approvalType'
                    ? (action.value as ApiApprovalType)
                    : action.value,
              }
            : step,
        ),
      }

    case 'replaceSteps':
      return { ...state, steps: action.steps }

    case 'restoreDraft':
      return { ...state, ...action.draft }

    case 'reset':
      return createInitialFormState()

    default:
      return state
  }
}

/** True once the preparer has entered anything worth warning them about losing. */
export function isFormDirty(state: SubmitFormState): boolean {
  if (state.title.trim()) return true
  if (state.description.trim()) return true
  if (state.file) return true
  if (state.memoTo.trim() || state.memoFrom.trim()) return true
  // A typed memo is the work. Losing it to a stray navigation, with no
  // warning, would be the most expensive thing this form could do.
  if (!memoBodyIsEmpty(state.body)) return true
  if (state.supportingFiles.length > 0) return true
  if (state.templateId) return true
  return state.steps.some(step => step.userId)
}

export function useSubmitDocumentForm(initial?: SubmitFormState) {
  const [state, dispatch] = useReducer(
    submitFormReducer,
    initial ?? null,
    (given: SubmitFormState | null) => given ?? createInitialFormState(),
  )

  const dirty = useMemo(() => isFormDirty(state), [state])

  return { state, dispatch, dirty }
}
