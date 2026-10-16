import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps, FormEvent } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadDocumentFile } from '../utils/downloadDocument'
import DownloadDocumentButton from './DownloadDocumentButton'

/**
 * The Download control that appears on document rows, version lists and the
 * detail header. It is the only way to get the actual file, so the things
 * that matter are: it fetches the version it is sitting next to, it cannot be
 * fired twice, it says so when it fails, and clicking it does not also
 * activate the row it lives inside.
 */

vi.mock('../utils/downloadDocument', () => ({
  downloadDocumentFile: vi.fn(),
}))

const download = vi.mocked(downloadDocumentFile)

const DOC_ID = '3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c'

type Props = ComponentProps<typeof DownloadDocumentButton>

function renderButton(overrides: Partial<Props> = {}) {
  return render(
    <DownloadDocumentButton documentId={DOC_ID} versionNumber={3} {...overrides} />,
  )
}

/** A promise the test resolves when it wants the download to finish. */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  // `restoreMocks` restores spies, not the call log of a module mock.
  download.mockReset()
  download.mockResolvedValue(undefined)
})

describe('DownloadDocumentButton', () => {
  it('is reachable by name, with the icon left out of the name', async () => {
    renderButton()

    // "Download Download" would be the name if the lucide icon were exposed;
    // an icon that repeats the label is noise in a screen reader.
    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument()
  })

  it('takes the wording the surrounding screen needs', () => {
    renderButton({ label: 'Download v3' })

    expect(screen.getByRole('button', { name: 'Download v3' })).toBeInTheDocument()
  })

  it('takes the placement class the surrounding layout gives it', () => {
    const { container } = renderButton({ className: 'ml-auto' })

    // Not a styling assertion about how the button looks - it is the one
    // prop the three screens this control appears on use to place it. Drop
    // the passthrough and the button jumps position in a table cell, a
    // version list and the detail header at once, with nothing failing.
    const placed = container.querySelector('.ml-auto')
    expect(placed).not.toBeNull()
    expect(placed).toContainElement(screen.getByRole('button', { name: 'Download' }))
  })

  it('downloads the version it is sitting next to', async () => {
    const user = userEvent.setup({ delay: null })
    // Deliberately not the default the helper renders: a hardcoded or stale
    // version number would still match if this asked for the default.
    renderButton({ versionNumber: 7 })

    await user.click(screen.getByRole('button', { name: 'Download' }))

    // The version goes in the filename, so downloading v7 and then v1 leaves
    // two distinct files rather than one silently overwriting the other.
    expect(download).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledWith(DOC_ID, 'document-3f2a9b1c-v7.pdf')
  })

  it('does not submit the form it is rendered inside', async () => {
    const user = userEvent.setup({ delay: null })
    const submit = vi.fn((event: FormEvent) => event.preventDefault())
    render(
      <form onSubmit={submit}>
        <DownloadDocumentButton documentId={DOC_ID} versionNumber={1} />
      </form>,
    )

    await user.click(screen.getByRole('button', { name: 'Download' }))

    // A button with no explicit type submits. On the upload and review forms
    // this control sits in, that would post a half-filled form and navigate
    // away while the file was still being fetched.
    expect(submit).not.toHaveBeenCalled()
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('is genuinely disabled, not just greyed, when there is no file', async () => {
    const user = userEvent.setup({ delay: null })
    renderButton({ disabled: true })

    const button = screen.getByRole('button', { name: 'Download' })

    // A styled-grey-but-clickable button would fire a request for a file that
    // does not exist and show the person a raw 404.
    expect(button).toBeDisabled()
    await user.click(button)
    expect(download).not.toHaveBeenCalled()
  })

  it('says why it is unavailable rather than leaving the person guessing', () => {
    renderButton({ disabled: true })

    expect(screen.getByRole('button', { name: 'Download' })).toHaveAttribute(
      'title',
      'File not available',
    )
  })

  it('does not claim the file is missing when it is there', () => {
    renderButton()

    // The other half of the contract: a tooltip permanently reading "File not
    // available" on a working button is worse than none, because people stop
    // pressing a control they are told is dead.
    expect(screen.getByRole('button', { name: 'Download' })).toHaveAttribute(
      'title',
      'Download document',
    )
  })

  it('marks itself busy and refuses a second click while the file is still coming', async () => {
    const user = userEvent.setup({ delay: null })
    const pending = deferred()
    download.mockReturnValue(pending.promise)
    const { container } = renderButton()

    const button = screen.getByRole('button', { name: 'Download' })
    expect(button).not.toHaveAttribute('aria-busy')

    await user.click(button)

    // An impatient double-click on a slow connection must not produce two
    // copies of the same PDF in the downloads folder.
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    // The download icon is swapped for a spinner while this runs. The name
    // has to survive that swap - a control that renames itself mid-request
    // is a control a screen reader user has just lost track of.
    expect(screen.getByRole('button', { name: 'Download' })).toBe(button)
    await user.click(button)
    expect(download).toHaveBeenCalledTimes(1)

    pending.resolve()
    await waitFor(() => expect(button).not.toBeDisabled())
    // Coming back is the other half: still busy after the file has arrived
    // and assistive tech goes on describing a finished download as running.
    expect(button).not.toHaveAttribute('aria-busy')
    // ...and a download that worked says nothing. An error line left over
    // from a previous attempt under a button that just succeeded is worse
    // than no message at all.
    expect(container.querySelector('[aria-live]')).toBeEmptyDOMElement()
  })

  it('shows why the download failed, where a screen reader will hear it', async () => {
    const user = userEvent.setup({ delay: null })
    download.mockRejectedValue(new Error('Network unreachable'))
    const { container } = renderButton()

    // The region has to already be in the page before the failure arrives.
    // A live region inserted at the same moment as its first message is not
    // announced by NVDA or VoiceOver - the change has to happen inside a
    // region the screen reader was already watching.
    const region = container.querySelector('[aria-live]')
    expect(region).not.toBeNull()
    expect(region).toBeEmptyDOMElement()

    await user.click(screen.getByRole('button', { name: 'Download' }))

    const message = await screen.findByText('Network unreachable')
    // The failure arrives long after the click, so it has to be announced;
    // a silent red line means a blind user believes the file downloaded.
    expect(message.closest('[aria-live]')).toBe(region)
    // `assertive` would interrupt whatever is being read; `off` is silence.
    expect(region).toHaveAttribute('aria-live', 'polite')
    // Without aria-atomic a message that replaces an earlier one is announced
    // as only the words that changed, which for two similar network errors is
    // a fragment of a sentence.
    expect(region).toHaveAttribute('aria-atomic', 'true')
  })

  it('falls back to plain words when the failure is not an Error', async () => {
    const user = userEvent.setup({ delay: null })
    download.mockRejectedValue('kaboom')
    renderButton()

    await user.click(screen.getByRole('button', { name: 'Download' }))

    // Otherwise the person would read "undefined" or nothing at all.
    expect(await screen.findByText('Download failed')).toBeInTheDocument()
  })

  it('keeps the whole message available when it is too long to fit', async () => {
    const user = userEvent.setup({ delay: null })
    const long =
      'The document file could not be retrieved because the storage service did not respond in time'
    download.mockRejectedValue(new Error(long))
    renderButton()

    await user.click(screen.getByRole('button', { name: 'Download' }))

    // The line is truncated to fit a table cell; if the full text were not
    // kept the person would only ever see "The document file could not be...".
    expect(await screen.findByText(long)).toHaveAttribute('title', long)
  })

  it('lets the person try again after a failure', async () => {
    const user = userEvent.setup({ delay: null })
    download.mockRejectedValueOnce(new Error('Network unreachable'))
    renderButton()

    const button = screen.getByRole('button', { name: 'Download' })
    await user.click(button)
    await screen.findByText('Network unreachable')

    // A button that stayed disabled after a transient failure would strand
    // the person on a document they cannot get out of the system.
    expect(button).not.toBeDisabled()
    // ...and it must stop reporting itself as busy, or assistive tech goes on
    // describing a finished download as still in progress.
    expect(button).not.toHaveAttribute('aria-busy')

    await user.click(button)

    // The stale error must clear the moment the retry starts, or a successful
    // download still looks like it failed.
    expect(screen.queryByText('Network unreachable')).not.toBeInTheDocument()
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('does not open the document row it sits inside', async () => {
    const user = userEvent.setup({ delay: null })
    const openRow = vi.fn()
    render(
      <div onClick={openRow}>
        <DownloadDocumentButton documentId={DOC_ID} versionNumber={1} />
      </div>,
    )

    await user.click(screen.getByRole('button', { name: 'Download' }))

    // These buttons live on clickable rows. Without stopPropagation, asking
    // for the file would also navigate away from the list mid-download.
    expect(openRow).not.toHaveBeenCalled()
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('is operable from the keyboard alone', async () => {
    const user = userEvent.setup({ delay: null })
    renderButton()

    await user.tab()

    expect(screen.getByRole('button', { name: 'Download' })).toHaveFocus()
    await user.keyboard('{Enter}')

    // Downloading is the whole point of the control; a mouse-only path would
    // put the file out of reach for anyone using a keyboard or a switch.
    expect(download).toHaveBeenCalledTimes(1)
  })
})
