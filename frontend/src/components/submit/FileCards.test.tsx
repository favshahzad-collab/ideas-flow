import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PrimaryFileCard, SupportingFilesCard } from './FileCards'

/**
 * The two attachment cards on the submit form.
 *
 * The primary card holds the one file everybody in the chain will sign; the
 * supporting card holds the reference material they read alongside it. Both
 * are places where a person confirms "yes, that is the right file" by reading
 * a name, a type and a size - so a size that rounds to "0 KB", a type that is
 * missing, or a file that was refused but still looks attached would each
 * send the wrong document round for signature.
 *
 * `formatFileSize` and `describeFileType` are tested in submitDocument.test.ts.
 * What is tested here is what the cards state, and what they let a person do.
 */

const MODIFIED = new Date('2026-09-01T10:00:00.000Z').getTime()

/**
 * jsdom derives `size` from the parts, so a 20 MB fixture would mean a 20 MB
 * string in a unit test. The size is stated directly instead.
 */
function makeFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type, lastModified: MODIFIED })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

const PDF = makeFile('warehouse-lease-extension.pdf', 'application/pdf', 482_000)

function renderPrimary(
  overrides: {
    file?: File | null
    pdfPages?: number | null
    pdfUnreadable?: boolean
    error?: string | null
  } = {},
) {
  const onSelect = vi.fn()
  const onClear = vi.fn()
  const view = render(
    <PrimaryFileCard
      file={overrides.file === undefined ? PDF : overrides.file}
      pdfPages={overrides.pdfPages ?? null}
      pdfUnreadable={overrides.pdfUnreadable ?? false}
      error={overrides.error ?? null}
      onSelect={onSelect}
      onClear={onClear}
    />,
  )
  return { ...view, onSelect, onClear }
}

function renderSupporting(
  overrides: { files?: File[]; error?: string | null } = {},
) {
  const onAdd = vi.fn()
  const onRemove = vi.fn()
  const view = render(
    <SupportingFilesCard
      files={overrides.files ?? []}
      error={overrides.error ?? null}
      onAdd={onAdd}
      onRemove={onRemove}
    />,
  )
  return { ...view, onAdd, onRemove }
}

/**
 * The real file input, which is `class="hidden"` and driven by the visible
 * button beside it. A browser file dialog cannot be opened from a test, so
 * the input is addressed directly - it is the element the dialog would hand
 * the file to.
 */
const fileInput = (container: HTMLElement) =>
  container.querySelector('input[type="file"]') as HTMLInputElement

describe('the PDF that will be signed', () => {
  it('names the attached file, in full, however long the name is', () => {
    const long = makeFile(
      'FY2026 warehouse lease extension - counterparty countersigned - final v7.pdf',
      'application/pdf',
      1_048_576,
    )
    renderPrimary({ file: long })

    // The name is the only way to tell this apart from the four other drafts
    // in the same folder, so it is never abbreviated in the markup.
    expect(
      screen.getByText(
        'FY2026 warehouse lease extension - counterparty countersigned - final v7.pdf',
      ),
    ).toBeInTheDocument()
  })

  it('states the type as well as the name', () => {
    renderPrimary()

    expect(screen.getByText(/PDF document/)).toBeInTheDocument()
  })

  it('measures a small attachment in bytes rather than rounding it away', () => {
    // A 900-byte signature page shown as "0 KB" - or, as it once was, "0.0
    // MB" - reads as an upload that silently failed, and the preparer
    // re-attaches a file that was already there.
    renderPrimary({ file: makeFile('addendum.pdf', 'application/pdf', 900) })

    expect(screen.getByText('900 B')).toBeInTheDocument()
    expect(screen.queryByText(/0 KB|0\.0 MB/)).not.toBeInTheDocument()
  })

  it('measures a kilobyte-scale attachment in KB', () => {
    renderPrimary({ file: makeFile('addendum.pdf', 'application/pdf', 1_536) })

    expect(screen.getByText('2 KB')).toBeInTheDocument()
  })

  it('measures a megabyte-scale attachment in MB', () => {
    renderPrimary({ file: makeFile('scan.pdf', 'application/pdf', 4_404_019) })

    expect(screen.getByText('4.2 MB')).toBeInTheDocument()
  })

  it('survives a genuinely empty file instead of showing nothing', () => {
    renderPrimary({ file: makeFile('empty.pdf', 'application/pdf', 0) })

    // "0 B" is the truth and is worth saying out loud - a blank space where
    // the size goes looks like a rendering fault rather than a bad file.
    expect(screen.getByText('0 B')).toBeInTheDocument()
  })

  it('says when it was last modified, to tell two versions apart', () => {
    renderPrimary()

    expect(
      screen.getByText(new RegExp(`Modified ${new Date(MODIFIED).toLocaleDateString()}`)),
    ).toBeInTheDocument()
  })

  it('claims no page count when the PDF has not been read', () => {
    renderPrimary({ pdfPages: null })

    // Showing "0 pages" for a PDF still being parsed would look like a
    // corrupt file.
    expect(screen.queryByText(/pages?$/)).not.toBeInTheDocument()
  })

  it('counts pages in singular and plural', () => {
    const { unmount } = render(
      <PrimaryFileCard
        file={PDF}
        pdfPages={1}
        pdfUnreadable={false}
        error={null}
        onSelect={vi.fn()}
        onClear={vi.fn()}
      />,
    )
    expect(screen.getByText('1 page')).toBeInTheDocument()
    unmount()

    renderPrimary({ pdfPages: 12 })
    expect(screen.getByText('12 pages')).toBeInTheDocument()
  })

  it('warns, before signing, that this PDF cannot be opened for preview', () => {
    // Discovering the file will not take a signature at the signing step -
    // after the chain has been built - is the expensive version of this.
    renderPrimary({ pdfUnreadable: true })

    expect(screen.getByRole('alert')).toHaveTextContent(/could not be opened for preview/i)
  })

  it('keeps quiet about readability when the PDF opened fine', () => {
    renderPrimary({ pdfUnreadable: false })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('attaching and replacing the PDF', () => {
  it('invites a file and states the limits before one is chosen', () => {
    renderPrimary({ file: null })

    const dropZone = screen.getByRole('button', { name: /Drag and drop your PDF here/ })
    expect(dropZone).toBeInTheDocument()
    expect(dropZone).toHaveTextContent('PDF only · up to 20 MB · this is the file everyone signs')
  })

  it('accepts a file dropped onto the zone, which is what it advertises', () => {
    const { onSelect } = renderPrimary({ file: null })
    const dropped = makeFile('dropped.pdf', 'application/pdf', 2_048)

    fireEvent.drop(screen.getByRole('button', { name: /Drag and drop your PDF here/ }), {
      dataTransfer: { files: [dropped] },
    })

    expect(onSelect).toHaveBeenCalledWith(dropped)
  })

  it('takes the first of several dropped files, since only one is signed', () => {
    // Dropping a folder or a multi-selection is easy to do by accident. One
    // PDF goes round for signature, so the card commits to one - silently
    // taking the last, or handing the parent an array it does not expect,
    // are both ways to sign the wrong document.
    const { onSelect } = renderPrimary({ file: null })
    const first = makeFile('lease.pdf', 'application/pdf', 2_048)
    const second = makeFile('appendix.pdf', 'application/pdf', 4_096)

    fireEvent.drop(screen.getByRole('button', { name: /Drag and drop your PDF here/ }), {
      dataTransfer: { files: [first, second] },
    })

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(first)
  })

  it('ignores a drop that carries no file at all', () => {
    // Dragging selected text or a link onto the zone fires the same event
    // with an empty file list. Passing that on as a selection would clear the
    // attached PDF, or crash on a File the parent never got.
    const { onSelect } = renderPrimary({ file: null })

    fireEvent.drop(screen.getByRole('button', { name: /Drag and drop your PDF here/ }), {
      dataTransfer: { files: [] },
    })

    expect(onSelect).not.toHaveBeenCalled()
    // And the zone is still the resting invitation, not stuck mid-drag.
    expect(screen.getByText('Drag and drop your PDF here')).toBeInTheDocument()
  })

  it('says the drop is live while a file is held over it', () => {
    renderPrimary({ file: null })
    const dropZone = screen.getByRole('button', { name: /Drag and drop your PDF here/ })

    fireEvent.dragOver(dropZone)

    // Without the wording change, the only feedback that the zone will accept
    // the file is a border colour.
    expect(screen.getByText('Drop the PDF to attach it')).toBeInTheDocument()
  })

  it('stops saying so the moment the file is dragged back off it', () => {
    // A zone left saying "Drop the PDF to attach it" after the pointer has
    // gone is telling the preparer to release over a target that is no longer
    // armed, and the file lands in the browser's own PDF viewer instead.
    renderPrimary({ file: null })
    const dropZone = screen.getByRole('button', { name: /Drag and drop your PDF here/ })

    fireEvent.dragOver(dropZone)
    fireEvent.dragLeave(dropZone)

    expect(screen.queryByText('Drop the PDF to attach it')).not.toBeInTheDocument()
    expect(screen.getByText('Drag and drop your PDF here')).toBeInTheDocument()
  })

  it('takes the file the browser file dialog hands back', () => {
    const { container, onSelect } = renderPrimary({ file: null })
    const chosen = makeFile('browsed.pdf', 'application/pdf', 6_000)

    fireEvent.change(fileInput(container), { target: { files: [chosen] } })

    expect(onSelect).toHaveBeenCalledWith(chosen)
  })

  it('treats a cancelled file dialog as no change, not as a cleared file', () => {
    // Closing the dialog without choosing fires `change` with an empty list.
    // Forwarding that would detach the PDF the preparer already had - the one
    // destructive outcome of a gesture that means "never mind".
    const { container, onSelect } = renderPrimary({ file: null })

    fireEvent.change(fileInput(container), { target: { files: [] } })

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('forgets the last choice, so re-picking the same file is still a change', () => {
    // A file input holds the path it was given, and choosing the identical
    // path a second time fires no second `change` event. Somebody who
    // re-exports a corrected PDF over the old one and re-attaches it would
    // submit the stale file believing they had replaced it, so the input is
    // cleared after every selection.
    // jsdom refuses a non-empty value on a file input, so the write itself is
    // what is observed - reading `.value` back would be '' either way and
    // would pass against a card that never cleared it.
    const { container, onSelect } = renderPrimary({ file: null })
    const input = fileInput(container)
    const cleared: string[] = []
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => '',
      set: (written: string) => void cleared.push(written),
    })
    const chosen = makeFile('browsed.pdf', 'application/pdf', 6_000)

    fireEvent.change(input, { target: { files: [chosen] } })

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(cleared).toEqual([''])
  })

  it('accepts only PDFs at the dialog, rather than refusing them afterwards', () => {
    // The card promises "PDF only". Letting the dialog offer every file on
    // the machine and rejecting the choice afterwards is a slower, ruder way
    // to say the same thing.
    const { container } = renderPrimary({ file: null })

    expect(fileInput(container)).toHaveAttribute('accept', '.pdf,application/pdf')
    expect(fileInput(container)).not.toHaveAttribute('multiple')
  })

  it('offers a way to swap the wrong file out, and to remove it entirely', async () => {
    const user = userEvent.setup({ delay: null })
    const { onClear } = renderPrimary()

    expect(screen.getByRole('button', { name: /Replace/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Remove/ }))

    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('shows the attached file or the invitation, never both at once', () => {
    // Two states on screen together - a named file above a "drag your PDF
    // here" zone - leaves a preparer unable to say whether anything is
    // actually attached, on the one card where that is the whole question.
    const withFile = renderPrimary()
    expect(screen.getByText('warehouse-lease-extension.pdf')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Drag and drop your PDF here/ }),
    ).not.toBeInTheDocument()
    withFile.unmount()

    renderPrimary({ file: null })
    expect(
      screen.getByRole('button', { name: /Drag and drop your PDF here/ }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Replace/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument()
  })

  it('reports a refused file next to the zone that refused it', () => {
    renderPrimary({ file: null, error: 'Only PDF files are allowed.' })

    expect(screen.getByRole('alert')).toHaveTextContent('Only PDF files are allowed.')
    expect(
      screen.getByRole('button', { name: /Drag and drop your PDF here/ }),
    ).toHaveAttribute('aria-invalid', 'true')
  })

  it('ties that refusal to the drop zone, so it is read again on focus', () => {
    // `role="alert"` announces the refusal once and then it is gone. If
    // `aria-describedby` still pointed only at the static hint, tabbing back
    // to the control would say "PDF only, up to 20 MB" as if nothing were
    // wrong - the one moment the person is asking what went wrong is the one
    // moment the control would not tell them. The title field in
    // DocumentInfoCard wires its error up the same way.
    renderPrimary({ file: null, error: 'Only PDF files are allowed.' })

    expect(
      screen.getByRole('button', { name: /Drag and drop your PDF here/ }),
    ).toHaveAccessibleDescription(/Only PDF files are allowed/)
  })
})

describe('the supporting files', () => {
  const NOTES = makeFile('board-notes.docx', '', 12_288)
  const SHEET = makeFile('costings.xlsx', '', 44_100)

  it('says what kind of file each attachment is, not only its name', () => {
    // "board-notes.docx · 12 KB" tells an approver whether they can open it
    // on the device they are approving from.
    renderSupporting({ files: [NOTES] })

    const row = within(screen.getByRole('listitem'))
    expect(row.getByText('board-notes.docx')).toBeInTheDocument()
    expect(row.getByText(/Word document/)).toBeInTheDocument()
    expect(row.getByText('12 KB')).toBeInTheDocument()
  })

  it('calls an unrecognised extension a file rather than guessing at it', () => {
    renderSupporting({ files: [makeFile('archive.zip', '', 2_048)] })

    const row = within(screen.getByRole('listitem'))
    expect(row.getByText(/^File/)).toBeInTheDocument()
    expect(row.getByText('2 KB')).toBeInTheDocument()
  })

  it('never renders a real attachment as nothing at all', () => {
    renderSupporting({ files: [makeFile('receipt.png', 'image/png', 400)] })

    const row = within(screen.getByRole('listitem'))
    expect(row.getByText('400 B')).toBeInTheDocument()
    expect(screen.queryByText(/^0 KB$|^0\.0 MB$/)).not.toBeInTheDocument()
  })

  it('names each remove button after the file it removes', async () => {
    // Three buttons all called "Remove" leave a screen-reader user counting
    // rows to work out which one drops the costings.
    const user = userEvent.setup({ delay: null })
    const { onRemove } = renderSupporting({ files: [NOTES, SHEET] })

    await user.click(screen.getByRole('button', { name: 'Remove supporting file costings.xlsx' }))

    expect(onRemove).toHaveBeenCalledWith(1)
  })

  it('keeps each row self-contained, so the size belongs to the right file', () => {
    renderSupporting({ files: [NOTES, SHEET] })

    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]).getByText('12 KB')).toBeInTheDocument()
    expect(within(rows[1]).getByText('43 KB')).toBeInTheDocument()
  })

  it('counts what is attached against the limit', () => {
    renderSupporting({ files: [NOTES, SHEET] })

    expect(screen.getByText('2/5')).toBeInTheDocument()
    expect(screen.getByText(/2 files attached/)).toBeInTheDocument()
  })

  it('says "1 file attached", not "1 files attached"', () => {
    renderSupporting({ files: [NOTES] })

    expect(screen.getByText(/1 file attached/)).toBeInTheDocument()
  })

  it('totals the attachments, since the whole submission travels together', () => {
    renderSupporting({ files: [NOTES, SHEET] })

    expect(screen.getByText('55 KB')).toBeInTheDocument()
  })

  it('counts the remaining slots in singular and plural', () => {
    const { unmount } = render(
      <SupportingFilesCard files={[NOTES]} error={null} onAdd={vi.fn()} onRemove={vi.fn()} />,
    )
    expect(screen.getByText('4 slots left · 20 MB each')).toBeInTheDocument()
    unmount()

    renderSupporting({ files: [NOTES, SHEET, NOTES, SHEET] })
    expect(screen.getByText('1 slot left · 20 MB each')).toBeInTheDocument()
  })

  it('stops offering more once the five slots are used', () => {
    // The count is the only remaining explanation, so it has to be visible
    // and honest: the invitation disappearing on its own reads as a fault.
    renderSupporting({ files: [NOTES, SHEET, NOTES, SHEET, NOTES] })

    expect(screen.queryByRole('button', { name: /Add supporting files/ })).not.toBeInTheDocument()
    expect(screen.getByText('5/5')).toBeInTheDocument()
  })

  it('shows an empty card as empty, with the invitation and no phantom totals', () => {
    renderSupporting({ files: [] })

    expect(screen.getByRole('button', { name: /Add supporting files/ })).toBeInTheDocument()
    expect(screen.getByText('0/5')).toBeInTheDocument()
    // "0 files attached · 0 B total" under an empty card is noise that reads
    // like a failed upload.
    expect(screen.queryByText(/files attached/)).not.toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('tells a refused file apart from the ones that were accepted', () => {
    // The refused file never joins the list, and the message names it. Both
    // halves matter: a bare "that file was not allowed" beside five rows
    // leaves the preparer unable to tell which of them is missing.
    renderSupporting({
      files: [NOTES],
      error: '"payroll.exe" is not an allowed supporting file type.',
    })

    expect(screen.getByRole('alert')).toHaveTextContent(
      '"payroll.exe" is not an allowed supporting file type.',
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('board-notes.docx')).toBeInTheDocument()
    expect(screen.queryByText('payroll.exe')).not.toBeInTheDocument()
  })

  it('keeps the add control usable after a refusal, with the slot not spent', () => {
    renderSupporting({
      files: [NOTES],
      error: '"payroll.exe" exceeds the 20 MB limit.',
    })

    // A refusal that also removed the way to try again would be a dead end.
    expect(screen.getByRole('button', { name: /Add supporting files/ })).toBeInTheDocument()
    // And the refused file must not have cost a slot on its way out: "3 slots
    // left" beside one attached file is the count quietly disagreeing with
    // the list, and the preparer stops believing either.
    expect(screen.getByText('1/5')).toBeInTheDocument()
    expect(screen.getByText('4 slots left · 20 MB each')).toBeInTheDocument()
  })

  it('hands the whole selection over at once, not one file at a time', () => {
    // The dialog is `multiple`, and the parent is what enforces the five-file
    // cap - it needs the full list to say "that is three too many" rather
    // than accepting files until it runs out of room.
    const { container, onAdd } = renderSupporting({ files: [] })
    const input = container.querySelector('input[type="file"]') as HTMLInputElement

    expect(input).toHaveAttribute('multiple')
    fireEvent.change(input, { target: { files: [NOTES, SHEET] } })

    expect(onAdd).toHaveBeenCalledTimes(1)
    const [handed] = onAdd.mock.calls[0] as [FileList]
    expect(Array.from(handed)).toEqual([NOTES, SHEET])
  })
})
