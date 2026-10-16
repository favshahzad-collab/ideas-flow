import { useCallback, useEffect, useRef, useState } from 'react'

import {
  createMemoDraft,
  deleteMemoDraft,
  listMemoDrafts,
  updateMemoDraft,
  type MemoDraft,
  type MemoDraftInput,
} from '../services/memoDraftsApi'
import { memoBodyHasNoProse } from '../utils/memoDom'
import type { SubmitFormState } from './useSubmitDocumentForm'
import { toApprovalChainPayload } from '../utils/submitDocument'

/**
 * The memo being written, kept on the server as well as in this browser.
 *
 * `useSubmitDraft` stops a closed tab costing somebody their afternoon on the
 * machine they closed it on. This stops a different machine, a cleared
 * browser or a reinstalled laptop costing them the same thing — which for a
 * memo typed here is the whole of their work, since there is no Word file on
 * a desktop to fall back to.
 *
 * Only a typed memo is saved. An uploaded memo IS its file, a `File` cannot
 * be sent to a draft and would not come back, and a server draft holding only
 * its title would promise a restore it could not perform.
 *
 * Nothing here is an artefact: a draft has no reference number, no digest and
 * no audit row, and the submission deletes it in the same transaction that
 * creates the document.
 */

/**
 * Longer than the local save. Every tick is a network write, and the local
 * draft is already holding the last 800ms of typing.
 */
const SAVE_DEBOUNCE_MS = 2500

export type DraftSaveState = 'idle' | 'saving' | 'saved' | 'error'

/** What is worth sending. An empty page is not a draft of anything. */
function worthSaving(state: SubmitFormState): boolean {
  if (state.authoring !== 'typed') return false
  return (
    !memoBodyHasNoProse(state.body) ||
    state.title.trim().length > 0 ||
    state.memoTo.trim().length > 0 ||
    state.memoFrom.trim().length > 0
  )
}

function toInput(state: SubmitFormState): MemoDraftInput {
  return {
    ...(state.memoType ? { memoType: state.memoType } : {}),
    ...(state.title.trim() ? { title: state.title.trim() } : {}),
    ...(state.memoTo.trim() ? { memoTo: state.memoTo.trim() } : {}),
    ...(state.memoFrom.trim() ? { memoFrom: state.memoFrom.trim() } : {}),
    ...(state.memoDate ? { memoDate: state.memoDate } : {}),
    body: state.body,
    // Only the steps that name somebody. A half-picked chain is normal while
    // it is being picked, and the server has no completeness rules for a
    // draft — but an entry with no user is not a choice anyone made.
    chain: toApprovalChainPayload(state.steps.filter(step => step.userId)),
    templateId: state.templateId,
  }
}

export function useServerMemoDraft(state: SubmitFormState, dirty: boolean) {
  const [draftId, setDraftId] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<DraftSaveState>('idle')
  const [resumable, setResumable] = useState<MemoDraft | null>(null)
  const [dismissed, setDismissed] = useState(false)

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /*
   * The id as the save loop sees it, not as React renders it.
   *
   * Two saves can be in flight across a state update, and reading `draftId`
   * from the closure would let the second one POST a second draft because the
   * first one's id had not landed in state yet. Every ten seconds of typing
   * would have left another copy behind.
   */
  const idRef = useRef<string | null>(null)
  /** Saving is skipped once the memo has been submitted or abandoned. */
  const stopped = useRef(false)

  useEffect(() => {
    let cancelled = false

    listMemoDrafts()
      .then(drafts => {
        // Newest first, and only ones with something in them. The server
        // orders by `updatedAt`, so the first row is the one to offer.
        if (!cancelled) setResumable(drafts[0] ?? null)
      })
      .catch(() => {
        // A draft is a convenience. Failing to list them must not stop
        // somebody writing a new memo.
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (stopped.current) return
    if (!dirty || !worthSaving(state)) return

    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const input = toInput(state)
      setSaveState('saving')

      const save = idRef.current
        ? updateMemoDraft(idRef.current, input)
        : createMemoDraft(input)

      void save
        .then(draft => {
          if (stopped.current) return
          idRef.current = draft.id
          setDraftId(draft.id)
          setSaveState('saved')
        })
        .catch(() => {
          if (!stopped.current) setSaveState('error')
        })
    }, SAVE_DEBOUNCE_MS)

    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [dirty, state])

  /**
   * The memo has been submitted. The server deletes the draft in the same
   * transaction, so there is nothing to delete here — only a save already on
   * its way to stop, before it recreates what was just removed.
   */
  const submitted = useCallback(() => {
    stopped.current = true
    if (timer.current) clearTimeout(timer.current)
    idRef.current = null
    setDraftId(null)
    setSaveState('idle')
  }, [])

  /** Throw the unfinished memo away, on the server as well as here. */
  const discard = useCallback(async () => {
    const id = resumable?.id ?? idRef.current
    setResumable(null)
    setDismissed(true)
    if (!id) return
    try {
      await deleteMemoDraft(id)
    } catch {
      // It stays in the list, which is better than telling somebody their
      // memo is gone when it is not.
    }
    if (idRef.current === id) {
      idRef.current = null
      setDraftId(null)
    }
  }, [resumable])

  /** Take up the offered draft: this form now edits that row. */
  const adopt = useCallback((draft: MemoDraft) => {
    idRef.current = draft.id
    setDraftId(draft.id)
    setResumable(null)
    setDismissed(true)
    setSaveState('saved')
  }, [])

  const dismiss = useCallback(() => setDismissed(true), [])

  return {
    /** The draft this form is writing into, to send with the submission. */
    draftId,
    saveState,
    /** An unfinished memo from another session, or null. */
    resumable: dismissed ? null : resumable,
    adopt,
    discard,
    dismiss,
    submitted,
  }
}
