import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import DocumentInfoCard, { type DuplicateMatch } from './DocumentInfoCard'

/**
 * The title and description of the document being submitted.
 *
 * The title is not decoration: it is what every approver sees in their queue
 * and in every notification, and it is the only thing distinguishing this
 * submission from the near-identical one somebody sent last week. So the two
 * things that matter are that a refused title says why, on the field itself,
 * and that the duplicate warning is legible enough for a preparer to decide
 * whether they are about to send the same document round twice.
 */

function renderCard(
  overrides: {
    title?: string
    description?: string
    titleError?: string | null
    duplicate?: DuplicateMatch | null
  } = {},
) {
  const onTitleChange = vi.fn()
  const onDescriptionChange = vi.fn()
  const onOpenDuplicate = vi.fn()
  const view = render(
    <DocumentInfoCard
      title={overrides.title ?? ''}
      description={overrides.description ?? ''}
      titleError={overrides.titleError ?? null}
      duplicate={overrides.duplicate ?? null}
      onTitleChange={onTitleChange}
      onDescriptionChange={onDescriptionChange}
      onOpenDuplicate={onOpenDuplicate}
    />,
  )
  return { ...view, onTitleChange, onDescriptionChange, onOpenDuplicate }
}

const titleField = () => screen.getByRole('textbox', { name: 'Document Title' })
const descriptionField = () => screen.getByRole('textbox', { name: /Description/ })

describe('the title field', () => {
  it('is labelled, and the required asterisk is not read out as punctuation', () => {
    renderCard()

    // "Document Title star" is what an unhidden asterisk sounds like. The
    // requirement is carried by aria-required instead.
    expect(titleField()).toHaveAccessibleName('Document Title')
    expect(titleField()).toHaveAttribute('aria-required', 'true')
  })

  it('explains what the title is for while nothing is wrong with it', () => {
    renderCard()

    expect(
      screen.getByText(/Approvers see this title in their queue/),
    ).toBeInTheDocument()
  })

  it('reports a refused title on the field, not just somewhere on the page', async () => {
    // Marked invalid and described by the message, so tabbing back to the
    // field says what is wrong with it - a message that only appears at the
    // bottom of a four-step form is a message nobody finds.
    renderCard({ titleError: 'Document title is required.' })

    expect(titleField()).toHaveAttribute('aria-invalid', 'true')
    expect(titleField()).toHaveAccessibleDescription('Document title is required.')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Document title is required.',
    )
  })

  it('replaces the helper text rather than stacking two descriptions', () => {
    renderCard({ titleError: 'Document title is required.' })

    // Two descriptions on one field are read out back to back, and the
    // helpful one buries the urgent one.
    expect(
      screen.queryByText(/Approvers see this title in their queue/),
    ).not.toBeInTheDocument()
  })

  it('is clean of any invalid marking when the title is fine', () => {
    renderCard({ title: 'Warehouse lease extension' })

    expect(titleField()).not.toHaveAttribute('aria-invalid')
    expect(titleField()).toHaveValue('Warehouse lease extension')
    // No dangling aria-describedby either. A describedby pointing at an id
    // that is no longer rendered is read out as nothing at all, which is how
    // a field ends up silently un-described once the error clears.
    expect(titleField()).not.toHaveAttribute('aria-describedby')
    expect(titleField()).not.toHaveAccessibleDescription()
  })

  it('drops the error wiring once the title has been corrected', () => {
    // The half of the rule the error test cannot see: rendering with an
    // error and then without has to leave the field genuinely clean, not
    // invalid-forever with a message nobody can find.
    const { rerender } = renderCard({ titleError: 'Document title is required.' })
    expect(titleField()).toHaveAttribute('aria-invalid', 'true')

    rerender(
      <DocumentInfoCard
        title="Warehouse lease extension"
        description=""
        titleError={null}
        duplicate={null}
        onTitleChange={vi.fn()}
        onDescriptionChange={vi.fn()}
        onOpenDuplicate={vi.fn()}
      />,
    )

    expect(titleField()).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(
      screen.getByText(/Approvers see this title in their queue/),
    ).toBeInTheDocument()
  })

  it('hands every keystroke back to the form', async () => {
    const user = userEvent.setup({ delay: null })
    const { onTitleChange } = renderCard({ title: 'Warehouse lease' })

    await user.type(titleField(), ' extension')

    // Controlled input: the parent holds the value, so a dropped change is a
    // character the preparer typed and never sees. Ten characters typed, ten
    // changes reported - a debounce or a swallowed event would show up here
    // as a count, which asserting on the first call alone would not.
    expect(onTitleChange).toHaveBeenCalledTimes(' extension'.length)
    expect(onTitleChange).toHaveBeenNthCalledWith(1, 'Warehouse lease ')
    // The value never advances, because the parent in this test does not feed
    // it back - so each later keystroke is reported against the same prefix.
    expect(onTitleChange).toHaveBeenNthCalledWith(2, 'Warehouse leasee')
  })

  it('does not silently mangle what was typed on its way back to the form', () => {
    // Titles arrive with the counterparty's own punctuation in them. Trimming
    // or normalising here would make the field disagree with what is on
    // screen mid-word - typing a space after "lease" would delete it again.
    const { onTitleChange } = renderCard({ title: '' })
    const typed = '  Warehouse "lease" — extension (FY26) & renewal  '

    fireEvent.change(titleField(), { target: { value: typed } })

    expect(onTitleChange).toHaveBeenCalledWith(typed)
  })

  it('stops at the length the API accepts, instead of failing after the upload', async () => {
    const user = userEvent.setup({ delay: null })
    const { onTitleChange } = renderCard({ title: 'a'.repeat(500) })

    await user.type(titleField(), 'b')

    // 501 characters would come back as a 400 after the whole PDF had been
    // uploaded - the slowest possible way to learn about a typo.
    expect(onTitleChange).not.toHaveBeenCalled()
  })
})

describe('the duplicate warning', () => {
  const duplicate: DuplicateMatch = {
    id: 'doc-9',
    title: 'Warehouse lease extension',
    status: 'PENDING_REVIEW',
    age: '3 days ago',
  }

  it('names the document already in flight, and says how old it is', () => {
    renderCard({ duplicate })

    expect(screen.getByText(/You already submitted/)).toBeInTheDocument()
    expect(screen.getByText(/3 days ago/)).toBeInTheDocument()
  })

  it('says the status in words a person uses, not in the database spelling', () => {
    const { unmount } = renderCard({ duplicate })

    // "PENDING_REVIEW" is a value from the database. A preparer deciding
    // whether to send a second copy needs to read it, not decode it.
    expect(screen.getByText(/it is pending review/)).toBeInTheDocument()
    expect(screen.queryByText(/PENDING_REVIEW/)).not.toBeInTheDocument()
    unmount()

    // A second status, so the wording is proven to come from the match rather
    // than from one hard-coded phrase: "it is pending review" under a
    // document that was actually rejected is worse than saying nothing.
    renderCard({
      duplicate: { ...duplicate, status: 'PENDING_FINAL_APPROVAL' },
    })

    expect(screen.getByText(/it is pending final approval/)).toBeInTheDocument()
  })

  it('offers the earlier document to open rather than making them go looking', async () => {
    const user = userEvent.setup({ delay: null })
    const { onOpenDuplicate } = renderCard({ duplicate })

    await user.click(screen.getByRole('button', { name: /Warehouse lease extension/ }))

    expect(onOpenDuplicate).toHaveBeenCalledWith('doc-9')
  })

  it('warns without blocking, because a resubmission is sometimes right', () => {
    renderCard({ duplicate })

    // Nothing here disables anything. A hard block would strand somebody with
    // a genuinely separate document that happens to share a title.
    expect(titleField()).toBeEnabled()
    expect(screen.getByText(/Submit anyway if this is a separate document/)).toBeInTheDocument()
  })

  it('says nothing about duplicates when there is no match', () => {
    renderCard({ title: 'Warehouse lease extension' })

    expect(screen.queryByText(/You already submitted/)).not.toBeInTheDocument()
  })

  it('announces the warning that appears while the preparer is typing', () => {
    // The warning appears in response to typing rather than to a press, so
    // it has to announce itself: somebody who is not watching that corner of
    // the form - a screen-reader user, or anyone typing while reading their
    // notes - would otherwise never be told the document may already be in
    // the queue. A plain div here is silent, which is what this was.
    renderCard({ duplicate })

    expect(screen.getByRole('status')).toHaveTextContent(/You already submitted/)
  })
})

describe('the description', () => {
  it('is marked optional, so an empty one does not look like an omission', () => {
    renderCard()

    expect(descriptionField()).toHaveAccessibleName(/Optional/)
  })

  it('counts what has been typed against the limit', () => {
    renderCard({ description: 'Signed by the counterparty on 1 September.' })

    expect(screen.getByText('42 / 5000')).toBeInTheDocument()
  })

  it('reads as zero rather than blank before anything is typed', () => {
    renderCard({ description: '' })

    expect(screen.getByText('0 / 5000')).toBeInTheDocument()
  })

  it('says who will read it, since that is what decides what goes in it', () => {
    renderCard()

    expect(screen.getByText(/Shown to every approver on the document page/)).toBeInTheDocument()
  })

  it('hands changes back to the form', async () => {
    const user = userEvent.setup({ delay: null })
    const { onDescriptionChange } = renderCard({ description: 'Signed' })

    await user.type(descriptionField(), '!')

    expect(onDescriptionChange).toHaveBeenCalledWith('Signed!')
  })

  it('stops at the length the API accepts, as the title does', async () => {
    // The counter reading "5000 / 5000" has to mean something. Without the
    // cap the API refuses the whole submission after the PDF has uploaded,
    // and the only clue on screen was a number that kept counting.
    const user = userEvent.setup({ delay: null })
    const { onDescriptionChange } = renderCard({ description: 'a'.repeat(5000) })

    expect(screen.getByText('5000 / 5000')).toBeInTheDocument()
    await user.type(descriptionField(), 'b')

    expect(onDescriptionChange).not.toHaveBeenCalled()
  })
})
