import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  downloadSupportingDocument,
  fetchSupportingDocumentFile,
} from '../../services/documentDetailApi'
import type { SupportingDocumentView } from '../../types/documentDetail'
import SupportingDocsTab from './SupportingDocsTab'

/**
 * The attachments a preparer sent along with the document being approved -
 * the quotes, the board minute, the spreadsheet the numbers came from. An
 * approver is about to sign the main document on the strength of these, so
 * the panel has to be honest about two things: which files are actually
 * attached, and which file the person is looking at or downloading. Handing
 * somebody the wrong attachment, or showing "no supporting documents" for a
 * fetch that failed, changes what they sign.
 *
 * The preview is a modal, so it owes the usual debts: a role, an accessible
 * name, Escape, and focus returned to the control that opened it.
 */

const captureViewerFile = vi.hoisted(() => vi.fn())

/* pdfjs-dist cannot start in jsdom - it wants a worker and a canvas - so the
   viewer is replaced by a spy that records the blob it was handed. Which blob
   reaches the viewer is the assertion that matters anyway: rendering the
   previous attachment's bytes under this attachment's name is the failure
   this panel could plausibly have. */
vi.mock('../PdfDocumentViewer', () => ({
  default: (props: { file: Blob | null }) => {
    captureViewerFile(props.file)
    return null
  },
}))

vi.mock('../../services/documentDetailApi', () => ({
  fetchSupportingDocumentFile: vi.fn(),
  downloadSupportingDocument: vi.fn(),
}))

const fetchFile = vi.mocked(fetchSupportingDocumentFile)
const download = vi.mocked(downloadSupportingDocument)

const DOC_ID = '3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c'

function attachment(
  overrides: Partial<SupportingDocumentView> = {},
): SupportingDocumentView {
  return {
    id: 'sup-1',
    fileName: 'lease-valuation.pdf',
    contentType: 'application/pdf',
    sizeLabel: '412 KB',
    uploadedAt: 'Sep 4, 2026',
    ...overrides,
  }
}

function renderTab(documents: SupportingDocumentView[] = [attachment()]) {
  return render(<SupportingDocsTab documentId={DOC_ID} documents={documents} />)
}

/** A promise the test resolves or rejects when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function blobOf(body: string, type: string) {
  const blob = new Blob([body], { type })
  return { blob, contentType: type }
}

beforeEach(() => {
  // `restoreMocks` restores spies, not a module mock's call log.
  fetchFile.mockReset()
  download.mockReset().mockResolvedValue(undefined)
  captureViewerFile.mockReset()

  // jsdom implements neither of these, and the preview path calls both on
  // every image, PDF and unsupported attachment. Without them the component
  // would fall into its error branch for reasons a browser never produces.
  window.URL.createObjectURL = vi.fn(() => 'blob:supporting-preview')
  window.URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  Reflect.deleteProperty(window.URL, 'createObjectURL')
  Reflect.deleteProperty(window.URL, 'revokeObjectURL')
})

describe('SupportingDocsTab', () => {
  it('says nothing was attached, rather than showing an empty card', () => {
    renderTab([])

    // An approver who sees a bare panel cannot tell "the preparer attached
    // nothing" from "the attachment list failed to load", and the second one
    // means they are about to sign without evidence they were meant to read.
    expect(
      screen.getByRole('heading', { name: 'No supporting documents' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('The preparer did not attach any supporting files to this submission.'),
    ).toBeInTheDocument()
    // And it is genuinely the empty card, not the notice printed above a list
    // that is still there: a leftover row with a Preview button on it would
    // send somebody after a file the panel has just said does not exist.
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('counts one file in the singular', () => {
    renderTab([attachment()])

    expect(screen.getByText(/^1 file attached by the preparer/)).toBeInTheDocument()
  })

  it('counts several files in the plural', () => {
    renderTab([
      attachment({ id: 'a', fileName: 'lease-valuation.pdf' }),
      attachment({ id: 'b', fileName: 'board-minute.docx' }),
      attachment({ id: 'c', fileName: 'quotes.csv' }),
    ])

    // "3 files" against a list of two is the sort of mismatch that makes
    // somebody go looking for an attachment that was never sent.
    expect(screen.getByText(/^3 files attached by the preparer/)).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('gives each file a name, a size and an upload date in one control', () => {
    renderTab([attachment({ fileName: 'lease-valuation.pdf', sizeLabel: '412 KB' })])

    // Size and date are how an approver spots the stale copy when a preparer
    // has attached two revisions of the same document.
    const file = screen.getByRole('button', { name: /^lease-valuation\.pdf/ })
    expect(file).toHaveTextContent('412 KB')
    expect(file).toHaveTextContent('Sep 4, 2026')
  })

  it('opens a preview dialog named after the file it is showing', async () => {
    const user = userEvent.setup({ delay: null })
    fetchFile.mockResolvedValue(blobOf('%PDF-1.4', 'application/pdf'))
    renderTab([attachment({ fileName: 'lease-valuation.pdf' })])

    await user.click(screen.getAllByRole('button', { name: /^Preview/ })[0])

    // The name is the whole point: a modal that says only "Preview" leaves a
    // screen reader user unable to confirm which attachment is on screen
    // before they act on it.
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAccessibleName('lease-valuation.pdf')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('fetches the attachment whose row was pressed, not the first in the list', async () => {
    const user = userEvent.setup({ delay: null })
    fetchFile.mockResolvedValue(blobOf('%PDF-1.4 minute', 'application/pdf'))
    renderTab([
      attachment({ id: 'sup-a', fileName: 'lease-valuation.pdf' }),
      attachment({ id: 'sup-b', fileName: 'board-minute.pdf' }),
    ])

    await user.click(screen.getAllByRole('button', { name: /^Preview/ })[1])

    // Every other preview test here has one attachment on screen, so a row
    // that always asks for `documents[0]` would satisfy all of them and still
    // put the wrong file in front of the approver. The id is the assertion.
    expect(fetchFile).toHaveBeenCalledWith(DOC_ID, 'sup-b')
    expect(fetchFile).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('dialog')).toHaveAccessibleName('board-minute.pdf')
  })

  it('opens the preview from the file name the panel invites you to click', async () => {
    const user = userEvent.setup({ delay: null })
    fetchFile.mockResolvedValue(blobOf('%PDF-1.4', 'application/pdf'))
    renderTab([attachment({ id: 'sup-a', fileName: 'lease-valuation.pdf' })])

    await user.click(screen.getByRole('button', { name: /^lease-valuation\.pdf/ }))

    // The panel's own subtitle says "click a file to preview". A name button
    // wired to nothing makes a liar of the instruction printed above it, and
    // it is the larger of the two targets on a phone.
    expect(fetchFile).toHaveBeenCalledWith(DOC_ID, 'sup-a')
    expect(await screen.findByRole('dialog')).toHaveAccessibleName(
      'lease-valuation.pdf',
    )
  })

  it('says it is loading while the attachment is being fetched', async () => {
    const user = userEvent.setup({ delay: null })
    const pending = deferred<{ blob: Blob; contentType: string }>()
    fetchFile.mockReturnValue(pending.promise)
    renderTab()

    await user.click(screen.getAllByRole('button', { name: /^Preview/ })[0])

    // A modal that opens empty for two seconds on a slow link reads as a
    // preview that is not available, and people close it before it arrives.
    expect(await screen.findByText('Loading preview...')).toBeInTheDocument()

    pending.resolve(blobOf('%PDF-1.4', 'application/pdf'))
    await waitFor(() =>
      expect(screen.queryByText('Loading preview...')).not.toBeInTheDocument(),
    )
  })

  it('hands the PDF viewer the bytes it just fetched', async () => {
    const user = userEvent.setup({ delay: null })
    fetchFile.mockResolvedValue(blobOf('%PDF-1.4 lease', 'application/pdf'))
    renderTab([attachment({ fileName: 'lease-valuation.pdf' })])

    await user.click(screen.getAllByRole('button', { name: /^Preview/ })[0])

    // Previewing attachment B while still holding attachment A's blob would
    // show one file's contents under another file's title - the single worst
    // thing this panel could do to somebody about to sign.
    await waitFor(() => expect(captureViewerFile).toHaveBeenCalled())
    const handed = captureViewerFile.mock.calls.at(-1)?.[0] as Blob
    expect(await handed.text()).toBe('%PDF-1.4 lease')
  })

  it('shows a text attachment inline instead of forcing a download', async () => {
    const user = userEvent.setup({ delay: null })
    fetchFile.mockResolvedValue(blobOf('supplier,quote\nAcme,120000', 'text/csv'))
    renderTab([attachment({ fileName: 'quotes.csv', contentType: 'text/csv' })])

    await user.click(screen.getAllByRole('button', { name: /^Preview/ })[0])

    expect(await screen.findByText(/Acme,120000/)).toBeInTheDocument()
  })

  it('trusts the content type on the response over the one recorded at upload', async () => {
    const user = userEvent.setup({ delay: null })
    // Uploaded as a generic octet-stream, served back as text.
    fetchFile.mockResolvedValue(blobOf('supplier,quote', 'text/csv'))
    renderTab([
      attachment({
        fileName: 'quotes-without-extension',
        contentType: 'application/octet-stream',
      }),
    ])

    await user.click(screen.getAllByRole('button', { name: /^Preview/ })[0])

    // Otherwise a perfectly previewable file is declared unpreviewable on the
    // strength of a content type the browser has already corrected.
    expect(await screen.findByText('supplier,quote')).toBeInTheDocument()
  })

  it('explains a file type it cannot render and offers the download instead', async () => {
    const user = userEvent.setup({ delay: null })
    fetchFile.mockResolvedValue(
      blobOf(
        'PK...',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    )
    renderTab([attachment({ id: 'sup-9', fileName: 'board-minute.docx' })])

    await user.click(screen.getAllByRole('button', { name: /^Preview/ })[0])

    // A dead-end modal would leave the only route to the evidence hidden
    // behind a close button and a second control on the row underneath.
    expect(
      await screen.findByText('Preview not available for this file type'),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Download file' }))
    expect(download).toHaveBeenCalledWith(DOC_ID, 'sup-9', 'board-minute.docx')
  })

  it('keeps the dialog open and explains a preview that would not load', async () => {
    const user = userEvent.setup({ delay: null })
    fetchFile.mockRejectedValue(new Error('Attachment is no longer stored'))
    renderTab()

    await user.click(screen.getAllByRole('button', { name: /^Preview/ })[0])

    // Closing on failure would look like a preview that simply did nothing,
    // and the reason - the file is gone from storage - is exactly what the
    // approver needs to tell the preparer.
    expect(await screen.findByText('Attachment is no longer stored')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('closes the preview on Escape and puts focus back on the control that opened it', async () => {
    const user = userEvent.setup({ delay: null })
    fetchFile.mockResolvedValue(blobOf('%PDF-1.4', 'application/pdf'))
    renderTab()

    const trigger = screen.getAllByRole('button', { name: /^Preview/ })[0]
    await user.click(trigger)
    await screen.findByRole('dialog')

    await user.keyboard('{Escape}')

    // Focus left on <body> drops a keyboard user back at the top of the page,
    // and they have to tab through the whole document header to get back to
    // the file list they were working down.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('closes the preview when the page behind it is clicked', async () => {
    const user = userEvent.setup({ delay: null })
    fetchFile.mockResolvedValue(blobOf('%PDF-1.4', 'application/pdf'))
    renderTab()

    await user.click(screen.getAllByRole('button', { name: /^Preview/ })[0])
    const dialog = await screen.findByRole('dialog')
    const scrim = dialog.parentElement!

    await user.click(scrim)

    // The dimmed page is the affordance everybody reaches for first, ahead of
    // Escape and ahead of the unnamed X in the corner.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('does not close the preview when the preview itself is clicked', async () => {
    const user = userEvent.setup({ delay: null })
    fetchFile.mockResolvedValue(blobOf('supplier,quote\nAcme,120000', 'text/csv'))
    renderTab([attachment({ fileName: 'quotes.csv', contentType: 'text/csv' })])

    await user.click(screen.getAllByRole('button', { name: /^Preview/ })[0])
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText(/Acme,120000/)

    await user.click(within(dialog).getByRole('heading', { name: 'quotes.csv' }))
    await user.click(within(dialog).getByText(/Acme,120000/))

    // The other half of the rule above, and the half that is easy to lose:
    // the close handler sits on the backdrop, so without `stopPropagation`
    // every click INSIDE the panel bubbles out to it and shuts the preview.
    // Selecting a figure out of a quote to paste into the approval note - the
    // one thing this dialog exists for - would dismiss it mid-drag.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(within(dialog).getByText(/Acme,120000/)).toBeInTheDocument()
  })

  it('releases the blob it was holding when the preview closes', async () => {
    const user = userEvent.setup({ delay: null })
    fetchFile.mockResolvedValue(blobOf('%PDF-1.4', 'application/pdf'))
    renderTab()

    await user.click(screen.getAllByRole('button', { name: /^Preview/ })[0])
    await screen.findByRole('dialog')
    expect(window.URL.createObjectURL).toHaveBeenCalled()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // An object URL survives its dialog: the browser holds the whole file in
    // memory until it is revoked or the tab is closed. An approver working
    // down a submission with a dozen attachments opens every one of them, and
    // nothing about the leak is visible until the tab is unusable.
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:supporting-preview')
  })

  it('moves focus into the dialog so the keyboard is not left behind it', async () => {
    const user = userEvent.setup({ delay: null })
    fetchFile.mockResolvedValue(blobOf('%PDF-1.4', 'application/pdf'))
    renderTab()

    await user.click(screen.getAllByRole('button', { name: /^Preview/ })[0])
    const dialog = await screen.findByRole('dialog')

    // If focus stayed outside, Tab would walk the page behind the scrim -
    // invisible, unscrollable, and still activatable.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  })

  it('repeats the file size in the dialog so the right file is confirmed before download', async () => {
    const user = userEvent.setup({ delay: null })
    fetchFile.mockResolvedValue(blobOf('%PDF-1.4', 'application/pdf'))
    renderTab([attachment({ fileName: 'lease-valuation.pdf', sizeLabel: '412 KB' })])

    await user.click(screen.getAllByRole('button', { name: /^Preview/ })[0])
    const dialog = await screen.findByRole('dialog')

    // The size is the only cheap way to tell two same-named revisions apart,
    // and the dialog is the last screen before the file leaves the system.
    expect(within(dialog).getByText(/412 KB/)).toBeInTheDocument()
  })

  it('downloads the file on screen from inside the preview, not the first on the list', async () => {
    const user = userEvent.setup({ delay: null })
    fetchFile.mockResolvedValue(blobOf('%PDF-1.4 minute', 'application/pdf'))
    renderTab([
      attachment({ id: 'sup-a', fileName: 'lease-valuation.pdf' }),
      attachment({ id: 'sup-b', fileName: 'board-minute.pdf' }),
    ])

    await user.click(screen.getAllByRole('button', { name: /^Preview/ })[1])
    const dialog = await screen.findByRole('dialog')

    await user.click(within(dialog).getByRole('button', { name: /^Download/ }))

    // The dialog's Download is a second, independent call site from the one
    // on the row, and it is the one people actually use - having looked at
    // the file, they save it from where they are looking. It reads its own
    // `previewDoc`, so it can be wired to the wrong attachment without any of
    // the row assertions noticing, and hands over the wrong evidence under a
    // title that says otherwise.
    expect(download).toHaveBeenCalledWith(DOC_ID, 'sup-b', 'board-minute.pdf')
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('downloads the file the button is sitting next to', async () => {
    const user = userEvent.setup({ delay: null })
    renderTab([
      attachment({ id: 'sup-a', fileName: 'lease-valuation.pdf' }),
      attachment({ id: 'sup-b', fileName: 'board-minute.docx' }),
    ])

    await user.click(screen.getAllByRole('button', { name: /^Download/ })[1])

    // Off-by-one here hands somebody the wrong evidence file under the right
    // name, and nothing on their machine would tell them.
    expect(download).toHaveBeenCalledWith(DOC_ID, 'sup-b', 'board-minute.docx')
  })

  it('says so when a download fails instead of failing silently', async () => {
    const user = userEvent.setup({ delay: null })
    download.mockRejectedValue(new Error('Attachment is no longer stored'))
    renderTab()

    await user.click(screen.getAllByRole('button', { name: /^Download/ })[0])

    // A click that produces no file and no message reads as a broken button,
    // and the person retries instead of reporting a missing attachment.
    expect(await screen.findByText('Attachment is no longer stored')).toBeInTheDocument()
  })

  it('lets the download be retried after it has failed', async () => {
    const user = userEvent.setup({ delay: null })
    download.mockRejectedValueOnce(new Error('Attachment is no longer stored'))
    renderTab()

    const button = screen.getAllByRole('button', { name: /^Download/ })[0]
    await user.click(button)
    await screen.findByText('Attachment is no longer stored')

    // The pending flag has to clear on the failure path too, or one bad
    // response disables the only route to the file until a full reload.
    expect(button).toBeEnabled()
    await user.click(button)
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('tells a screen reader which file each Download button belongs to', () => {
    renderTab([
      attachment({ id: 'sup-a', fileName: 'lease-valuation.pdf' }),
      attachment({ id: 'sup-b', fileName: 'board-minute.docx' }),
    ])

    // Every row renders "Preview" and "Download" with no per-file name, so a
    // screen reader user hearing "Preview, Download, Preview, Download" has
    // to count list items to work out which attachment they are about to
    // fetch. The file-name button beside them carries the name, which is
    // exactly why these two could too.
    expect(
      screen.getByRole('button', { name: /Download board-minute\.docx/ }),
    ).toBeInTheDocument()
  })

  it('names the control that closes the preview', async () => {
    const user = userEvent.setup({ delay: null })
    fetchFile.mockResolvedValue(blobOf('%PDF-1.4', 'application/pdf'))
    renderTab()

    await user.click(screen.getAllByRole('button', { name: /^Preview/ })[0])
    const dialog = await screen.findByRole('dialog')

    // The X in the dialog header is an icon-only <button> with no aria-label
    // and no text, so it announces as "button" and nothing else. Escape still
    // works, but a pointer-only screen reader user - or anyone on a switch -
    // has no named way out of a modal that covers the page.
    expect(within(dialog).getByRole('button', { name: /close/i })).toBeInTheDocument()
  })

  it('announces a download failure rather than only painting it red', async () => {
    const user = userEvent.setup({ delay: null })
    download.mockRejectedValue(new Error('Attachment is no longer stored'))
    renderTab()

    await user.click(screen.getAllByRole('button', { name: /^Download/ })[0])
    await screen.findByText('Attachment is no longer stored')

    // The banner is a plain <div> above the list with no live region, so the
    // failure never reaches anybody who is not looking at that strip of the
    // page when it appears.
    expect(screen.getByRole('alert')).toHaveTextContent('Attachment is no longer stored')
  })
})
