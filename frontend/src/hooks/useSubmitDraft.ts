import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoBody } from '../types/memo'
import type { AuthoringMode } from '../utils/submitSteps'
import type { ApprovalStepForm } from '../utils/submitDocument'
import type { RoutingMode, SubmitFormState } from './useSubmitDocumentForm'

/**
 * A local draft of the submission form.
 *
 * The schema reserves a DRAFT document status that nothing writes, and a
 * server-side draft is a feature in its own right — it needs a lifecycle, a
 * list view and a way to resume from another machine. This is the smaller
 * half of the problem: keeping a mis-click, a reload or a closed tab from
 * costing the preparer everything they typed.
 *
 * What it cannot hold is the files. A `File` handle is not serialisable and
 * the browser will not hand it back on the next visit, so the restore banner
 * says so explicitly rather than quietly restoring a form that looks complete
 * and is not.
 */

const STORAGE_KEY = 'docflow_submit_draft'
const SAVE_DEBOUNCE_MS = 800
/** Older than this and it is more likely to confuse than to help. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface StoredDraft {
  savedAt: number
  title: string
  description: string
  /*
   * The memo itself, for a memo written here.
   *
   * The file cannot be stored - a `File` handle is not serialisable and the
   * browser will not hand it back - which is why the banner tells people to
   * re-attach it. A typed memo has no such excuse: it is plain data, it is
   * the whole of the preparer's work, and losing an hour of writing to a
   * closed tab would be the most expensive thing this form could do.
   */
  authoring?: AuthoringMode
  memoType?: string | null
  memoTo?: string
  memoFrom?: string
  memoDate?: string
  body?: MemoBody
  routingMode: RoutingMode
  templateId: string | null
  steps: ApprovalStepForm[]
  /** Names only — enough to tell the preparer what they need to re-attach. */
  fileName: string | null
  supportingFileNames: string[]
}

export interface RestorableDraft extends StoredDraft {
  savedAtLabel: string
}

function read(): StoredDraft | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredDraft
    if (!parsed || typeof parsed !== 'object') return null
    /*
     * A stored entry with no timestamp is not a fresh one.
     *
     * `Date.now() - undefined` is NaN and every comparison against NaN is
     * false, so the age check below waved it straight through and the banner
     * offered "an unfinished submission from NaN days ago".
     */
    if (typeof parsed.savedAt !== 'number' || !Number.isFinite(parsed.savedAt)) {
      return null
    }

    if (Date.now() - parsed.savedAt > MAX_AGE_MS) return null
    if (!Array.isArray(parsed.steps)) return null

    /*
     * An entry written before this form could write memos has no `authoring`,
     * and restoring it as `undefined` would leave the form in neither mode.
     * Everything stored then was an upload, so that is what it was.
     */
    return { ...parsed, authoring: parsed.authoring ?? 'upload' }
  } catch {
    // Private mode, disabled storage, or a shape from an older build.
    return null
  }
}

function write(draft: StoredDraft): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft))
  } catch {
    // Storage full or unavailable. A draft is a convenience, never a promise.
  }
}

export function clearStoredDraft(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to do.
  }
}

function describeAge(savedAt: number): string {
  const minutes = Math.round((Date.now() - savedAt) / 60000)
  if (minutes < 1) return 'moments ago'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export function useSubmitDraft(state: SubmitFormState, dirty: boolean) {
  // Read once, before anything is typed, so a fresh visit can offer to restore.
  const [available, setAvailable] = useState<RestorableDraft | null>(() => {
    const stored = read()
    return stored ? { ...stored, savedAtLabel: describeAge(stored.savedAt) } : null
  })
  const [dismissed, setDismissed] = useState(false)

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!dirty) return

    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      write({
        savedAt: Date.now(),
        title: state.title,
        description: state.description,
        authoring: state.authoring,
        memoType: state.memoType,
        memoTo: state.memoTo,
        memoFrom: state.memoFrom,
        memoDate: state.memoDate,
        body: state.body,
        routingMode: state.routingMode,
        templateId: state.templateId,
        steps: state.steps,
        fileName: state.file?.name ?? null,
        supportingFileNames: state.supportingFiles.map(file => file.name),
      })
    }, SAVE_DEBOUNCE_MS)

    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [dirty, state])

  const discard = useCallback(() => {
    clearStoredDraft()
    setAvailable(null)
    setDismissed(true)
  }, [])

  const dismiss = useCallback(() => setDismissed(true), [])

  return {
    /** A restorable draft, or null when there is nothing to offer. */
    draft: dismissed ? null : available,
    discard,
    dismiss,
  }
}
