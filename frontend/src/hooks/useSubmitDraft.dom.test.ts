import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalStepForm } from '../utils/submitDocument'
import type { SubmitFormState } from './useSubmitDocumentForm'
import { clearStoredDraft, useSubmitDraft } from './useSubmitDraft'

/**
 * The local draft of a submission - the thing that decides whether a closed
 * tab costs a preparer ten minutes or an afternoon.
 *
 * Two ways to get it wrong and they are not symmetrical. Saving too little
 * loses work. Offering back the wrong thing is worse: a draft restored on top
 * of a form somebody is already filling in, or a week-old approval chain
 * restored into a document it was never meant for, is a document routed to
 * the wrong approvers by a screen that looked helpful.
 *
 * The one thing it deliberately cannot keep is the attached files - a `File`
 * handle does not survive a reload - so the names have to come back even
 * though the files do not, or the restored form looks complete and is not.
 */

const STORAGE_KEY = 'docflow_submit_draft'
const SAVE_DEBOUNCE_MS = 800
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const step = (overrides: Partial<ApprovalStepForm> = {}): ApprovalStepForm => ({
  id: 'step-1',
  approvalType: 'REVIEWER',
  userId: 'user-1',
  ...overrides,
})

const formState = (overrides: Partial<SubmitFormState> = {}): SubmitFormState => ({
  title: 'Warehouse lease extension',
  description: 'Five-year extension on the Sundar site.',
  authoring: 'upload',
  memoType: null,
  memoTypeSigns: true,
  notes: [],
  memoTo: '',
  memoFrom: '',
  memoDate: '2026-08-06',
  body: { type: 'doc', content: [{ type: 'paragraph' }] },
  file: null,
  supportingFiles: [],
  routingMode: 'custom',
  steps: [step()],
  templateId: null,
  pdfPages: null,
  pdfUnreadable: false,
  ...overrides,
})

/** Whatever is actually sitting in storage, as a plain object. */
const stored = (): Record<string, unknown> | null =>
  JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')

/** A draft left behind by an earlier visit. */
function seedDraft(overrides: Record<string, unknown> = {}) {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      savedAt: Date.now(),
      title: 'Warehouse lease extension',
      description: 'Five-year extension on the Sundar site.',
      routingMode: 'custom',
      templateId: null,
      steps: [step()],
      fileName: 'lease.pdf',
      supportingFileNames: ['annex-a.pdf'],
      ...overrides,
    }),
  )
}

const renderDraft = (state = formState(), dirty = false) =>
  renderHook(({ state: s, dirty: d }) => useSubmitDraft(s, d), {
    initialProps: { state, dirty },
  })

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

describe('what it offers back', () => {
  it('offers nothing on a first visit', () => {
    // The restore banner appearing on a machine that has never submitted
    // anything would be an offer to restore work that does not exist.
    const { result } = renderDraft()

    expect(result.current.draft).toBeNull()
  })

  it('offers the text and the approval chain from last time', () => {
    seedDraft()

    const { result } = renderDraft()

    expect(result.current.draft).toMatchObject({
      title: 'Warehouse lease extension',
      description: 'Five-year extension on the Sundar site.',
      steps: [step()],
    })
  })

  it('keeps the approval chain in the order it was built', () => {
    // The order is who sees the document first. Restoring a reversed chain
    // sends it to the approver before the reviewer and nobody would notice
    // until it had already been signed.
    seedDraft({
      steps: [
        step({ id: 'a', userId: 'reviewer-1', approvalType: 'REVIEWER' }),
        step({ id: 'b', userId: 'approver-1', approvalType: 'APPROVER' }),
      ],
    })

    const { result } = renderDraft()

    expect(result.current.draft?.steps.map(entry => entry.userId)).toEqual([
      'reviewer-1',
      'approver-1',
    ])
  })

  it('remembers that the routing came from a template', () => {
    // Restoring a template-routed draft as a custom chain would quietly swap
    // the approvers the template names for whatever the form defaults to.
    seedDraft({ routingMode: 'template', templateId: 'tpl-7', steps: [] })

    const { result } = renderDraft()

    expect(result.current.draft).toMatchObject({
      routingMode: 'template',
      templateId: 'tpl-7',
    })
  })

  it('names the files it cannot bring back', () => {
    // This is the whole reason the banner says what it says. A form restored
    // silently without its PDF looks finished and cannot be submitted.
    seedDraft({ fileName: 'lease.pdf', supportingFileNames: ['annex-a.pdf', 'map.pdf'] })

    const { result } = renderDraft()

    expect(result.current.draft?.fileName).toBe('lease.pdf')
    expect(result.current.draft?.supportingFileNames).toEqual(['annex-a.pdf', 'map.pdf'])
  })
})

describe('how it dates the draft', () => {
  const labelFor = (savedAt: number) => {
    seedDraft({ savedAt })
    return renderDraft().result.current.draft?.savedAtLabel
  }

  it('says "moments ago" for something just typed', () => {
    expect(labelFor(Date.now() - 20_000)).toBe('moments ago')
  })

  it.each([
    [1 * MINUTE, '1 minute ago'],
    [5 * MINUTE, '5 minutes ago'],
    [1 * HOUR, '1 hour ago'],
    [3 * HOUR, '3 hours ago'],
    [25 * HOUR, '1 day ago'],
    [3 * DAY, '3 days ago'],
  ] as const)('counts %i ms ago as "%s"', (age, expected) => {
    // Singular and plural both, because "1 minutes ago" in a banner is the
    // kind of thing that makes people distrust the rest of the screen.
    expect(labelFor(Date.now() - age)).toBe(expected)
  })
})

describe('drafts it refuses to offer', () => {
  it('lets go of one older than a week', () => {
    // A week-old approval chain restored into today's document is a routing
    // decision nobody made. Losing it is the safer failure.
    seedDraft({ savedAt: Date.now() - 8 * DAY })

    const { result } = renderDraft()

    expect(result.current.draft).toBeNull()
  })

  it('still offers one from a few days ago', () => {
    seedDraft({ savedAt: Date.now() - 6 * DAY })

    const { result } = renderDraft()

    expect(result.current.draft).not.toBeNull()
  })

  it('ignores a half-written entry rather than throwing on it', () => {
    // Storage can hold a truncated write from a tab that was killed mid-save.
    // A parse error here would white-screen the submission page.
    window.localStorage.setItem(STORAGE_KEY, '{"savedAt":')

    const { result } = renderDraft()

    expect(result.current.draft).toBeNull()
  })

  it('ignores an entry that is not a draft at all', () => {
    // The key is a plain string in a storage area shared with every other
    // script on the origin. Whatever ends up under it has to be treated as
    // hostile input: a bare JSON scalar parses without throwing, and reading
    // `.steps` off it yields undefined rather than an error, so the guard has
    // to be an explicit shape check and not a `try`.
    window.localStorage.setItem(STORAGE_KEY, '"docflow_submit_draft"')

    const { result } = renderDraft()

    expect(result.current.draft).toBeNull()
  })

  it('ignores an entry from an older build with no approval chain in it', () => {
    // `steps` is read straight into the form. A missing one would restore a
    // document with no approvers and no obvious sign that it is missing them.
    seedDraft({ steps: undefined })

    const { result } = renderDraft()

    expect(result.current.draft).toBeNull()
  })

  it('survives storage being blocked outright', () => {
    // Private mode and locked-down enterprise profiles both throw here.
    // Losing the draft is acceptable; failing to render the form is not.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('The operation is insecure.')
    })

    const { result } = renderDraft()

    expect(result.current.draft).toBeNull()
  })

  it('ignores an entry with no timestamp on it', () => {
    // Reported defect. `Date.now() - undefined` is NaN and every comparison
    // against NaN is false, so the age check waves the entry through and the
    // banner offers it as "an unfinished submission from NaN days ago".
    seedDraft({ savedAt: undefined })

    const { result } = renderDraft()

    expect(result.current.draft).toBeNull()
  })
})

describe('saving while the form is being filled in', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('writes nothing while the form is untouched', () => {
    // Otherwise arriving at the page and leaving again creates a draft of an
    // empty form, which is then offered back on every subsequent visit.
    renderDraft(formState(), false)

    act(() => vi.advanceTimersByTime(5 * SAVE_DEBOUNCE_MS))

    expect(stored()).toBeNull()
  })

  it('waits for a pause in the typing before it writes', () => {
    renderDraft(formState({ title: 'Warehouse lease' }), true)

    act(() => vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1))
    expect(stored()).toBeNull()

    act(() => vi.advanceTimersByTime(1))
    expect(stored()).toMatchObject({ title: 'Warehouse lease' })
  })

  it('restarts the clock on every keystroke and saves only the latest text', () => {
    // A write per character would be a JSON serialise of the whole form on
    // every keypress, and would leave a half-typed title in storage.
    const { rerender } = renderDraft(formState({ title: 'Ware' }), true)

    act(() => vi.advanceTimersByTime(500))
    rerender({ state: formState({ title: 'Warehouse' }), dirty: true })
    act(() => vi.advanceTimersByTime(500))
    expect(stored()).toBeNull()

    act(() => vi.advanceTimersByTime(SAVE_DEBOUNCE_MS))
    expect(stored()).toMatchObject({ title: 'Warehouse' })
  })

  it('records the file names and never the files themselves', () => {
    // A `File` cannot be serialised and would not be handed back by the
    // browser anyway. The names are what the restore banner needs so the
    // preparer knows what to re-attach.
    const main = new File(['pdf'], 'lease.pdf', { type: 'application/pdf' })
    const annex = new File(['pdf'], 'annex-a.pdf', { type: 'application/pdf' })
    renderDraft(formState({ file: main, supportingFiles: [annex] }), true)

    act(() => vi.advanceTimersByTime(SAVE_DEBOUNCE_MS))

    expect(stored()).toMatchObject({
      fileName: 'lease.pdf',
      supportingFileNames: ['annex-a.pdf'],
    })
    expect(stored()).not.toHaveProperty('file')
    expect(stored()).not.toHaveProperty('supportingFiles')
  })

  it('records no file name when nothing has been attached yet', () => {
    // Not the string "undefined", which the banner would then print.
    renderDraft(formState({ file: null }), true)

    act(() => vi.advanceTimersByTime(SAVE_DEBOUNCE_MS))

    expect(stored()?.fileName).toBeNull()
  })

  it('stamps the time so the next visit can say how old it is', () => {
    renderDraft(formState(), true)

    act(() => vi.advanceTimersByTime(SAVE_DEBOUNCE_MS))

    expect(stored()?.savedAt).toBe(Date.now())
  })

  it('does not write the draft back after the document has been submitted', () => {
    // The worst ordering in this hook. A submit succeeds, the success path
    // calls `clearStoredDraft` and the form stops being dirty - but a debounced
    // write from the last keystroke is still armed and is holding the whole
    // form in its closure. If it is allowed to fire, storage ends up holding a
    // draft of a document that has already been submitted, and the next visit
    // offers to restore it. Accepting that offer submits the same document a
    // second time.
    const { rerender } = renderDraft(formState({ title: 'Warehouse lease' }), true)

    act(() => vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 100))

    // The submit lands: storage is cleared and there is nothing unsaved left.
    clearStoredDraft()
    rerender({ state: formState({ title: 'Warehouse lease' }), dirty: false })

    act(() => vi.advanceTimersByTime(10 * SAVE_DEBOUNCE_MS))

    expect(stored()).toBeNull()
  })

  it('does not write once the form has gone from the screen', () => {
    // Navigating away mid-keystroke. The timer is on the window, not on the
    // component, so an uncancelled one fires against a form that no longer
    // exists - and would overwrite a draft the person had since discarded from
    // somewhere else in the app.
    const { unmount } = renderDraft(formState({ title: 'Warehouse lease' }), true)

    act(() => vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 100))
    unmount()
    act(() => vi.advanceTimersByTime(10 * SAVE_DEBOUNCE_MS))

    expect(stored()).toBeNull()
  })

  it('keeps the form usable when storage refuses the write', () => {
    // Quota exceeded, or private mode. A draft is a convenience; throwing out
    // of a timer would take the whole page down with it.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const { result } = renderDraft(formState(), true)

    expect(() => act(() => vi.advanceTimersByTime(SAVE_DEBOUNCE_MS))).not.toThrow()
    expect(result.current.draft).toBeNull()
  })
})

describe('putting the banner away', () => {
  it('discarding takes the draft out of storage for good', () => {
    // "Discard" has to mean discarded. Coming back tomorrow to be offered the
    // thing you deliberately threw away is how people stop trusting the
    // button - and the next person may accept it by reflex.
    seedDraft()
    const { result } = renderDraft()

    act(() => result.current.discard())

    expect(result.current.draft).toBeNull()
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('dismissing hides the banner but keeps the work', () => {
    // "Not now" is not "delete it". A reload has to be able to offer it again.
    seedDraft()
    const { result } = renderDraft()

    act(() => result.current.dismiss())

    expect(result.current.draft).toBeNull()
    expect(stored()).toMatchObject({ title: 'Warehouse lease extension' })
    expect(renderDraft().result.current.draft).not.toBeNull()
  })

  it('does not bring the banner back as the form is typed into', () => {
    // The banner sits above the form. Re-offering a restore over text somebody
    // is in the middle of writing is one accepted click from losing it.
    seedDraft()
    const { result, rerender } = renderDraft(formState({ title: '' }), false)
    act(() => result.current.dismiss())

    rerender({ state: formState({ title: 'A different document' }), dirty: true })

    expect(result.current.draft).toBeNull()
  })

  it('is not offered again after the document has actually been submitted', () => {
    // The submit path calls `clearStoredDraft` on success. Without it the same
    // draft is offered on the next visit and can be submitted a second time.
    seedDraft()

    clearStoredDraft()

    expect(renderDraft().result.current.draft).toBeNull()
  })
})
