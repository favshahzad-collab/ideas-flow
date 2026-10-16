import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { UploadProgress } from '../../services/uploadClient'
import type { ReadinessCheck } from '../../utils/submitDocument'
import { ReadinessPanel, SubmitActions, UploadProgressBar } from './SubmitActions'

/**
 * The bottom of the submit form: the checklist that says whether the document
 * is ready, the progress of the upload, and the button that signs it away.
 *
 * Submitting is the irreversible act on this screen - it puts the document in
 * somebody else's queue - so the failure that matters most is a person
 * pressing the button and being told nothing: no reason for a refusal, no
 * sign that the upload is running, or a second press that submits twice.
 */

type CheckId = 'title' | 'file' | 'steps' | 'unique' | 'final'

function checks(overrides: Partial<Record<CheckId, boolean>> = {}): ReadinessCheck[] {
  const done = {
    title: true,
    file: true,
    steps: true,
    unique: true,
    final: true,
    ...overrides,
  }
  return [
    { id: 'title', label: 'Document title provided', done: done.title },
    { id: 'file', label: 'PDF attached (max 20 MB)', done: done.file },
    { id: 'steps', label: 'Every step has an assignee', done: done.steps },
    { id: 'unique', label: 'No person appears twice', done: done.unique },
    {
      id: 'final',
      label: 'Exactly one final approver, placed last',
      done: done.final,
    },
  ]
}

function progress(overrides: Partial<UploadProgress> = {}): UploadProgress {
  return { loaded: 2_048, total: 5_120, fraction: 0.4, ...overrides }
}

function renderActions(
  overrides: {
    submitError?: string | null
    outstanding?: number
    attempted?: boolean
    submitting?: boolean
    progress?: UploadProgress | null
  } = {},
) {
  const onSubmit = vi.fn()
  const onCancel = vi.fn()
  const onCancelUpload = vi.fn()
  const view = render(
    <SubmitActions
      submitError={overrides.submitError ?? null}
      outstanding={overrides.outstanding ?? 0}
      attempted={overrides.attempted ?? false}
      submitting={overrides.submitting ?? false}
      progress={overrides.progress ?? null}
      onSubmit={onSubmit}
      onCancel={onCancel}
      onCancelUpload={onCancelUpload}
    />,
  )
  return { ...view, onSubmit, onCancel, onCancelUpload }
}

const submitButton = () => screen.getByRole('button', { name: /Sign & submit/ })

describe('the submit button', () => {
  it('stays pressable while requirements are outstanding, so pressing it explains why', async () => {
    // Deliberately not disabled on an incomplete form. A grey button with no
    // explanation is the worst answer to "why can I not submit?" - here the
    // press is what surfaces the field errors and the count below.
    const user = userEvent.setup({ delay: null })
    const { onSubmit } = renderActions({ outstanding: 3 })

    expect(submitButton()).toBeEnabled()
    await user.click(submitButton())

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('refuses a second press while the first submission is in flight', async () => {
    // Two presses would upload the PDF twice and put two documents in the
    // approver's queue, which somebody then has to work out how to withdraw.
    const user = userEvent.setup({ delay: null })
    const { onSubmit } = renderActions({ submitting: true })

    expect(submitButton()).toBeDisabled()
    await user.click(submitButton())

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('says the work is happening rather than only looking greyed out', () => {
    const { unmount } = renderActions({ submitting: true })

    // aria-busy is what tells a screen-reader user that the disabled button
    // is mid-request rather than permanently unavailable.
    expect(submitButton()).toHaveAttribute('aria-busy', 'true')
    unmount()

    // And it has to come off again. A button left permanently busy is a
    // button a screen reader keeps describing as mid-request, so nothing ever
    // says the submission finished.
    renderActions({ submitting: false })
    expect(submitButton()).not.toHaveAttribute('aria-busy')
    expect(submitButton()).toBeEnabled()
  })

  it('stays pressable after the server has refused once, so it can be retried', async () => {
    // A network drop mid-upload is the ordinary case here. Disabling the
    // button on an error would strand a filled-in four-step form with no way
    // to send it, and the only way out would be to start again.
    const user = userEvent.setup({ delay: null })
    const { onSubmit } = renderActions({
      submitError: 'The connection dropped before the upload finished.',
      attempted: true,
    })

    expect(submitButton()).toBeEnabled()
    await user.click(submitButton())

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('holds the cancel button too, so leaving cannot race the upload', () => {
    renderActions({ submitting: true })

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('lets a preparer walk away from a submission they have not sent', async () => {
    const user = userEvent.setup({ delay: null })
    const { onCancel } = renderActions()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('warns that signing is still to come, so the button is not a surprise', () => {
    // The button says "Sign & submit" but opens the signing step. Without
    // this line a preparer can believe they have already signed.
    renderActions()

    expect(
      screen.getByText('You place your signature on the PDF in the next step.'),
    ).toBeInTheDocument()
  })
})

describe('why a submission was refused', () => {
  it('counts what is still outstanding once a submit has been attempted', () => {
    renderActions({ attempted: true, outstanding: 3 })

    expect(screen.getByRole('alert')).toHaveTextContent(
      '3 requirements above still need attention.',
    )
  })

  it('says "1 requirement ... needs attention", not "1 requirements"', () => {
    renderActions({ attempted: true, outstanding: 1 })

    expect(screen.getByRole('alert')).toHaveTextContent(
      '1 requirement above still needs attention.',
    )
  })

  it('stays quiet about outstanding work before the first attempt', () => {
    // Scolding somebody for an unfinished form they have just opened reads as
    // a broken screen rather than as guidance.
    renderActions({ attempted: false, outstanding: 3 })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says nothing once the attempt has nothing left outstanding', () => {
    renderActions({ attempted: true, outstanding: 0 })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reports the server’s own refusal, not a generic failure', () => {
    // "The approval chain contains a deactivated user" is actionable;
    // "Something went wrong" sends the preparer to the help desk.
    renderActions({
      submitError: 'The approval chain contains a deactivated user.',
    })

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The approval chain contains a deactivated user.',
    )
  })

  it('shows a server refusal and an outstanding count as two separate messages', () => {
    renderActions({
      submitError: 'The connection dropped before the upload finished.',
      attempted: true,
      outstanding: 2,
    })

    // They have different causes and different fixes; merging them into one
    // banner would leave the preparer fixing the wrong thing.
    expect(screen.getAllByRole('alert')).toHaveLength(2)
  })
})

describe('the upload in flight', () => {
  it('says how far along a measurable upload is', () => {
    renderActions({ submitting: true, progress: progress() })

    const bar = screen.getByRole('progressbar', { name: 'Upload progress' })
    expect(bar).toHaveAttribute('aria-valuenow', '40')
    expect(screen.getByText('Uploading 40%')).toBeInTheDocument()
    expect(screen.getByText('2 KB of 5 KB')).toBeInTheDocument()
  })

  it('does not invent a percentage the browser has not reported', () => {
    // An unmeasurable upload showing "0%" for two minutes reads as a stall.
    // No aria-valuenow is how a progress bar says "indeterminate".
    renderActions({
      submitting: true,
      progress: progress({ fraction: null, total: 0, loaded: 0 }),
    })

    const bar = screen.getByRole('progressbar', { name: 'Upload progress' })
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(screen.getByText('Uploading…')).toBeInTheDocument()
  })

  it('leaves out the byte line when the total is unknown', () => {
    renderActions({
      submitting: true,
      progress: progress({ fraction: null, total: 0, loaded: 900 }),
    })

    // Not "900 B of 0 B", which reads as an upload sending data to nowhere.
    expect(screen.queryByText(/\d+(\.\d+)? (B|KB|MB) of /)).not.toBeInTheDocument()
    expect(screen.queryByText(/0 B/)).not.toBeInTheDocument()
  })

  it('lets a 20 MB upload be abandoned without abandoning the form', async () => {
    const user = userEvent.setup({ delay: null })
    const { onCancel, onCancelUpload } = renderActions({
      submitting: true,
      progress: progress(),
    })

    // By name, not by position. Relying on DOM order to tell the two apart
    // was the defect: a screen reader hears the name and nothing else.
    await user.click(screen.getByRole('button', { name: 'Cancel upload' }))

    expect(onCancelUpload).toHaveBeenCalledTimes(1)
    // Aborting a slow upload must not also throw away everything typed.
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('names the upload’s cancel button for what it actually cancels', () => {
    // While an upload runs there are two buttons on screen that both cancel
    // something - one aborts the upload, one abandons the whole submission.
    // If both were named just "Cancel", nothing but DOM order would tell them
    // apart, and a screen-reader user picking one would have no way to know
    // whether they had thrown away a transfer or the entire form.
    renderActions({ submitting: true, progress: progress() })

    expect(screen.getByRole('button', { name: /cancel upload/i })).toBeInTheDocument()
  })

  it('shows no progress bar before the upload starts', () => {
    renderActions({ progress: null })

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('states a percentage on its own for a bar that has just started', () => {
    renderActions({ submitting: true, progress: progress({ loaded: 0, fraction: 0 }) })

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
    expect(screen.getByText('Uploading 0%')).toBeInTheDocument()
  })
})

describe('the readiness checklist', () => {
  it('lists every requirement in the preparer’s own words', () => {
    render(<ReadinessPanel checks={checks()} />)

    expect(screen.getByRole('heading', { name: 'Ready to submit' })).toBeInTheDocument()
    expect(screen.getByText('Exactly one final approver, placed last')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
  })

  it('scores what is done out of what is needed', () => {
    render(<ReadinessPanel checks={checks({ steps: false, unique: false, final: false })} />)

    expect(screen.getByText('2/5')).toBeInTheDocument()
  })

  it('announces the score as it changes, since it is the progress signal', () => {
    // The number moves as the form is filled in. Without a live region it
    // moves silently, and the panel is useless to anyone not watching it.
    const { rerender } = render(<ReadinessPanel checks={checks({ final: false })} />)

    const score = screen.getByText('4/5')
    expect(score).toHaveAttribute('aria-live', 'polite')
    // Atomic, so the whole "5 of 5" is spoken. Without it a change from 4/5
    // to 5/5 is announced as the single character that differs - "5" - which
    // says nothing at all.
    expect(score).toHaveAttribute('aria-atomic', 'true')

    // The region has to be the same node across the update. Re-keying or
    // re-mounting it is the classic way a live region goes quiet: the browser
    // announces changes within a region, not the arrival of a new one.
    rerender(<ReadinessPanel checks={checks()} />)
    expect(screen.getByText('5/5')).toBe(score)
  })

  it('says done or not done in words, not with a tick and a tint', () => {
    // The only visual difference between a met requirement and an unmet one
    // is a tick versus a dot, both drawn in aria-hidden spans.
    render(<ReadinessPanel checks={checks({ unique: false, final: false })} />)

    expect(screen.getAllByText('— done')).toHaveLength(3)
    expect(screen.getAllByText('— not yet done')).toHaveLength(2)
  })

  it('opens an untouched form with nothing marked done', () => {
    render(
      <ReadinessPanel
        checks={checks({
          title: false,
          file: false,
          steps: false,
          unique: false,
          final: false,
        })}
      />,
    )

    // Credit the preparer has not earned makes the whole panel unreliable.
    expect(screen.getByText('0/5')).toBeInTheDocument()
    expect(screen.queryByText('— done')).not.toBeInTheDocument()
  })
})

describe('the progress bar on its own', () => {
  it('reports the bounds a screen reader needs to say "40 percent"', () => {
    render(<UploadProgressBar progress={progress()} onCancel={vi.fn()} />)

    const bar = screen.getByRole('progressbar', { name: 'Upload progress' })
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
  })

  it('rounds to a whole percent rather than showing a fraction', () => {
    render(
      <UploadProgressBar
        progress={{ loaded: 3_333, total: 10_000, fraction: 0.3333 }}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByText('Uploading 33%')).toBeInTheDocument()
  })

  it('cancels the upload when asked', async () => {
    const user = userEvent.setup({ delay: null })
    const onCancel = vi.fn()
    render(<UploadProgressBar progress={progress()} onCancel={onCancel} />)

    await user.click(screen.getByRole('button', { name: 'Cancel upload' }))

    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
