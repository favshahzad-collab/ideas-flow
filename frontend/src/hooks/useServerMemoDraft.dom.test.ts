import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createMemoDraft,
  deleteMemoDraft,
  listMemoDrafts,
  updateMemoDraft,
} from '../services/memoDraftsApi'
import type { ApprovalStepForm } from '../utils/submitDocument'
import type { SubmitFormState } from './useSubmitDocumentForm'
import { useServerMemoDraft } from './useServerMemoDraft'

/**
 * The memo kept on the server while it is being written.
 *
 * The local draft covers a closed tab on one machine. This covers the rest:
 * a different machine, a cleared browser, a laptop that died. For a memo
 * typed in the portal that is the whole of somebody's work - there is no Word
 * file on a desktop to go back to - so the failure that matters is silent
 * loss, and the second failure that matters is leaving a trail of duplicate
 * drafts behind while trying to prevent the first.
 */

vi.mock('../services/memoDraftsApi', () => ({
  listMemoDrafts: vi.fn(),
  createMemoDraft: vi.fn(),
  updateMemoDraft: vi.fn(),
  deleteMemoDraft: vi.fn(),
}))

const list = vi.mocked(listMemoDrafts)
const create = vi.mocked(createMemoDraft)
const update = vi.mocked(updateMemoDraft)
const remove = vi.mocked(deleteMemoDraft)

const SAVE_DEBOUNCE_MS = 2500

const step = (overrides: Partial<ApprovalStepForm> = {}): ApprovalStepForm => ({
  id: 'step-1',
  approvalType: 'REVIEWER',
  userId: 'user-1',
  ...overrides,
})

const written = (text: string) => ({
  type: 'doc' as const,
  content: [
    { type: 'paragraph' as const, content: [{ type: 'text' as const, text }] },
  ],
})

const formState = (overrides: Partial<SubmitFormState> = {}): SubmitFormState => ({
  title: 'Revision of Fuel Allowance',
  description: '',
  authoring: 'typed',
  memoType: 'APPROVAL_REQUEST',
  memoTypeSigns: true,
  notes: [],
  memoTo: 'Sir BMD',
  memoFrom: 'Human Resource Department',
  memoDate: '2026-08-06',
  body: written('Approval is solicited please.'),
  file: null,
  supportingFiles: [],
  routingMode: 'custom',
  steps: [step()],
  templateId: null,
  pdfPages: null,
  pdfUnreadable: false,
  ...overrides,
})

const savedDraft = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'draft-1',
    memoType: 'APPROVAL_REQUEST',
    memoTypeLabel: 'Approval Request',
    title: 'Revision of Fuel Allowance',
    memoTo: 'Sir BMD',
    memoFrom: 'Human Resource Department',
    body: written('Approval is solicited please.'),
    chain: [{ userId: 'user-1', approvalType: 'REVIEWER' }],
    templateId: null,
    createdAt: new Date(2026, 8, 23, 9).toISOString(),
    updatedAt: new Date(2026, 8, 23, 9, 30).toISOString(),
    ...overrides,
  }) as never

beforeEach(() => {
  vi.useFakeTimers()
  list.mockResolvedValue([])
  create.mockResolvedValue(savedDraft())
  update.mockResolvedValue(savedDraft())
  remove.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

/**
 * Let the pending promises resolve.
 *
 * Not `waitFor`, which polls on timers this file has faked - it never gets a
 * tick and times out after fifteen seconds having tested nothing. The list
 * lands on a microtask, so flushing one is both sufficient and exact.
 */
async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

/** Run the debounce out and let the save settle. */
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)
  })
}

describe('saving the memo as it is written', () => {
  it('creates a draft once the typing stops', async () => {
    renderHook(() => useServerMemoDraft(formState(), true))

    expect(create).not.toHaveBeenCalled()
    await settle()

    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![0]).toMatchObject({
      memoType: 'APPROVAL_REQUEST',
      title: 'Revision of Fuel Allowance',
      memoTo: 'Sir BMD',
    })
  })

  it('updates the same draft afterwards rather than making another', async () => {
    /*
     * The one that matters. Two saves can be in flight across a state
     * update, and reading the id out of render state rather than a ref lets
     * the second one create a second draft - so every ten seconds of typing
     * would leave another copy behind, and the resume banner would offer a
     * memo from four minutes ago while the real one was elsewhere.
     */
    const { rerender } = renderHook(
      ({ state }) => useServerMemoDraft(state, true),
      { initialProps: { state: formState() } },
    )

    await settle()
    rerender({ state: formState({ body: written('Now it says something else.') }) })
    await settle()
    rerender({ state: formState({ body: written('And again.') }) })
    await settle()

    expect(create).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls[0]![0]).toBe('draft-1')
  })

  it('says where the memo has got to', async () => {
    const { result } = renderHook(() => useServerMemoDraft(formState(), true))

    expect(result.current.saveState).toBe('idle')
    await settle()
    expect(result.current.saveState).toBe('saved')
    expect(result.current.draftId).toBe('draft-1')
  })

  it('says so when the save fails, rather than going quiet', async () => {
    create.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useServerMemoDraft(formState(), true))

    await settle()

    expect(result.current.saveState).toBe('error')
    expect(result.current.draftId).toBeNull()
  })

  it('leaves an uploaded memo alone', async () => {
    // A draft cannot hold a File, and an uploaded memo IS its file - so a
    // draft of one would promise a restore it could not perform.
    renderHook(() =>
      useServerMemoDraft(
        formState({ authoring: 'upload', file: new File(['%PDF'], 'memo.pdf') }),
        true,
      ),
    )

    await settle()

    expect(create).not.toHaveBeenCalled()
  })

  it('does not save an empty page', async () => {
    renderHook(() =>
      useServerMemoDraft(
        formState({
          title: '',
          memoTo: '',
          memoFrom: '',
          body: { type: 'doc', content: [{ type: 'paragraph' }] },
        }),
        true,
      ),
    )

    await settle()

    expect(create).not.toHaveBeenCalled()
  })

  it('saves a memo that has only a subject so far', async () => {
    renderHook(() =>
      useServerMemoDraft(
        formState({
          memoTo: '',
          memoFrom: '',
          body: { type: 'doc', content: [{ type: 'paragraph' }] },
        }),
        true,
      ),
    )

    await settle()

    expect(create).toHaveBeenCalledTimes(1)
  })

  it('waits until something has been typed', async () => {
    renderHook(() => useServerMemoDraft(formState(), false))

    await settle()

    expect(create).not.toHaveBeenCalled()
  })

  it('sends only the steps that name somebody', async () => {
    renderHook(() =>
      useServerMemoDraft(
        formState({ steps: [step(), step({ id: 'step-2', userId: '' })] }),
        true,
      ),
    )

    await settle()

    expect(create.mock.calls[0]![0].chain).toHaveLength(1)
  })
})

describe('after the memo is submitted', () => {
  it('stops saving, so nothing writes the draft back', async () => {
    const { result, rerender } = renderHook(
      ({ state }) => useServerMemoDraft(state, true),
      { initialProps: { state: formState() } },
    )

    await settle()
    act(() => result.current.submitted())

    rerender({ state: formState({ body: written('A later edit.') }) })
    await settle()

    // The server deleted the draft inside the submission's transaction. A
    // save that fired afterwards would put it straight back, and the preparer
    // would be offered the memo they had just filed.
    expect(update).not.toHaveBeenCalled()
    expect(result.current.draftId).toBeNull()
  })
})

describe('an unfinished memo from another session', () => {
  it('is offered back', async () => {
    list.mockResolvedValue([savedDraft()])
    const { result } = renderHook(() => useServerMemoDraft(formState(), false))

    await flush()
    expect(result.current.resumable).not.toBeNull()
    expect(result.current.resumable!.title).toBe('Revision of Fuel Allowance')
  })

  it('stops being offered once it is taken up, and is written into from then on', async () => {
    list.mockResolvedValue([savedDraft({ id: 'draft-9' })])
    const { result, rerender } = renderHook(
      ({ state, dirty }) => useServerMemoDraft(state, dirty),
      { initialProps: { state: formState(), dirty: false } },
    )

    await flush()
    expect(result.current.resumable).not.toBeNull()
    act(() => result.current.adopt(result.current.resumable!))

    expect(result.current.resumable).toBeNull()
    expect(result.current.draftId).toBe('draft-9')

    rerender({ state: formState({ body: written('Carried on.') }), dirty: true })
    await settle()

    // Resuming edits that row rather than starting a second copy of it.
    expect(create).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith('draft-9', expect.anything())
  })

  it('can be thrown away', async () => {
    list.mockResolvedValue([savedDraft({ id: 'draft-9' })])
    const { result } = renderHook(() => useServerMemoDraft(formState(), false))

    await flush()
    expect(result.current.resumable).not.toBeNull()
    await act(async () => {
      await result.current.discard()
    })

    expect(remove).toHaveBeenCalledWith('draft-9')
    expect(result.current.resumable).toBeNull()
  })

  it('does not claim it is gone when the delete failed', async () => {
    remove.mockRejectedValue(new Error('offline'))
    list.mockResolvedValue([savedDraft({ id: 'draft-9' })])
    const { result } = renderHook(() => useServerMemoDraft(formState(), false))

    await flush()
    expect(result.current.resumable).not.toBeNull()

    // The point is that it does not throw at the caller. It stays in the
    // list, which is a better answer than telling somebody their memo is gone.
    await act(async () => {
      await expect(result.current.discard()).resolves.toBeUndefined()
    })
  })

  it('lets somebody write a new memo when the list cannot be read', async () => {
    list.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useServerMemoDraft(formState(), true))

    await settle()

    expect(result.current.resumable).toBeNull()
    expect(create).toHaveBeenCalledTimes(1)
  })
})
