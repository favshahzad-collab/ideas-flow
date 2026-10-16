import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchDocumentFile } from '../../services/documentDetailApi'
import QueuePaper from './QueuePaper'

/**
 * The sheet of paper in the middle of My queue: the document itself, fetched
 * per selected row and handed to the lazily-loaded PDF viewer.
 *
 * Everything here is about not showing the wrong thing. A blank page where a
 * document failed to load reads as "this document is empty", which is a
 * different and much worse statement than "we could not fetch it". And the
 * cursor moves faster than the network does, so the paper on screen must
 * never be the previous row's document sitting under the new row's title.
 */

vi.mock('../../services/documentDetailApi', () => ({
  fetchDocumentFile: vi.fn(),
}))

// pdf.js cannot run in jsdom, and this component's job stops at handing the
// blob over. The stub prints what it was given so the test can tell which
// document's bytes arrived.
vi.mock('../PdfDocumentViewer', () => ({
  default: ({ file }: { file: Blob | null }) => (
    <p>Rendered document of {file?.size ?? 0} bytes</p>
  ),
}))

const fetchFile = vi.mocked(fetchDocumentFile)

// `restoreMocks` restores spies, not the mocks a module factory created, so
// this one keeps its call log across tests unless it is cleared by hand.
beforeEach(() => {
  fetchFile.mockReset()
})

function blobOf(size: number) {
  return new Blob(['x'.repeat(size)], { type: 'application/pdf' })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('while the file is still coming', () => {
  it('asks for the file, and claims neither a document nor a failure until it has one', () => {
    fetchFile.mockReturnValue(new Promise<Blob>(() => {}))
    render(<QueuePaper documentId="doc-1" />)

    // Absence on its own would also be true of a component that never asked
    // for anything, so the request is asserted alongside it. The placeholder
    // is page-shaped so nothing jumps when the real page lands; what matters
    // is that it is not an error and not a blank sheet passed off as the
    // document.
    expect(fetchFile).toHaveBeenCalledWith('doc-1', 'view')
    expect(fetchFile).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(/Rendered document/)).not.toBeInTheDocument()
  })

  it('tells a screen reader that the document is on its way', () => {
    // Marked as a known failure. The whole loading branch is aria-hidden, so
    // a reader is told nothing at all while a 400 KB viewer and a file are
    // fetched - silence, then a document appears. Every other async screen
    // in the app pairs its skeleton with a `LoadingAnnouncer` live region;
    // this one does not.
    fetchFile.mockReturnValue(new Promise<Blob>(() => {}))
    const { container } = render(<QueuePaper documentId="doc-1" />)

    expect(container.querySelector('[aria-live]')).not.toBeNull()
  })
})

describe('once the file arrives', () => {
  it('hands the document to the viewer', async () => {
    fetchFile.mockResolvedValue(blobOf(120))
    render(<QueuePaper documentId="doc-1" />)

    expect(await screen.findByText('Rendered document of 120 bytes')).toBeInTheDocument()
    expect(fetchFile).toHaveBeenCalledWith('doc-1', 'view')
  })

  it('does not fetch the document again just because the pane re-rendered', async () => {
    fetchFile.mockResolvedValue(blobOf(120))
    const { rerender } = render(<QueuePaper documentId="doc-1" />)
    await screen.findByText('Rendered document of 120 bytes')

    rerender(<QueuePaper documentId="doc-1" />)

    // The pane above this one re-renders on every keystroke the queue
    // answers. A fetch keyed on anything but the id would pull the file down
    // again on each one and drop the paper back to a skeleton while it did -
    // the page flickering under somebody who is trying to read it.
    expect(fetchFile).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Rendered document of 120 bytes')).toBeInTheDocument()
  })
})

describe('when the file cannot be fetched', () => {
  it('says so, in an alert, in the words the server used', async () => {
    fetchFile.mockRejectedValue(new Error('You do not have access to this document'))
    render(<QueuePaper documentId="doc-1" />)

    // An approver who cannot see the file must be told that, not left
    // looking at an empty page they might sign anyway.
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('You do not have access to this document')
    expect(screen.queryByText(/Rendered document/)).not.toBeInTheDocument()
  })

  it('falls back to a plain sentence when the failure carries no message', async () => {
    fetchFile.mockRejectedValue('boom')
    render(<QueuePaper documentId="doc-1" />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the document file',
    )
  })
})

describe('when the cursor moves before the network answers', () => {
  it('never shows one document under another document id', async () => {
    const second = deferred<Blob>()
    fetchFile.mockResolvedValueOnce(blobOf(120)).mockReturnValueOnce(second.promise)

    const { rerender } = render(<QueuePaper documentId="doc-1" />)
    await screen.findByText('Rendered document of 120 bytes')

    rerender(<QueuePaper documentId="doc-2" />)

    // J moves the cursor and the header retitles instantly. If the previous
    // document's page stayed put underneath it, the pane would be showing
    // one document and naming another - and the sign button acts on the
    // name, not on the paper.
    expect(screen.queryByText('Rendered document of 120 bytes')).not.toBeInTheDocument()

    second.resolve(blobOf(340))
    expect(await screen.findByText('Rendered document of 340 bytes')).toBeInTheDocument()
  })

  it('ignores an answer that arrives after the cursor has moved on', async () => {
    const first = deferred<Blob>()
    fetchFile.mockReturnValueOnce(first.promise).mockResolvedValueOnce(blobOf(340))

    const { rerender } = render(<QueuePaper documentId="doc-1" />)
    rerender(<QueuePaper documentId="doc-2" />)

    // The slow first request lands last. Without the cancelled guard it
    // would overwrite the document that is actually selected.
    first.resolve(blobOf(120))
    expect(await screen.findByText('Rendered document of 340 bytes')).toBeInTheDocument()
    await waitFor(() => expect(fetchFile).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Rendered document of 120 bytes')).not.toBeInTheDocument()
  })

  it('does not carry a failure over to the next document', async () => {
    const second = deferred<Blob>()
    fetchFile
      .mockRejectedValueOnce(new Error('You do not have access to this document'))
      .mockReturnValueOnce(second.promise)

    const { rerender } = render(<QueuePaper documentId="doc-1" />)
    await screen.findByRole('alert')

    rerender(<QueuePaper documentId="doc-2" />)

    // An error left on screen against the next row would tell an approver
    // they cannot open a document they can open perfectly well.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    second.resolve(blobOf(340))
    expect(await screen.findByText('Rendered document of 340 bytes')).toBeInTheDocument()
  })
})
