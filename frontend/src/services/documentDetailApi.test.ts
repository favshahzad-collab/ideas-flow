import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiBlob, apiVoid } from './apiClient'
import { fetchDocumentFile, resubmitDocument } from './documentDetailApi'
import { confirmedToSign, SIGNING_NOT_CONFIRMED } from './stepUp'
import type { MemoBody } from '../types/memo'

// Signing asks "confirm it's you" first; these tests start confirmed.
vi.mock('./stepUp', async () => {
  const actual = await vi.importActual<typeof import('./stepUp')>('./stepUp')
  return { ...actual, confirmedToSign: vi.fn(async () => true) }
})
const confirmation = vi.mocked(confirmedToSign)

vi.mock('./apiClient', async () => {
  const actual = await vi.importActual<typeof import('./apiClient')>('./apiClient')
  return { ...actual, apiBlob: vi.fn(), apiVoid: vi.fn() }
})

const serve = vi.mocked(apiBlob)
const send = vi.mocked(apiVoid)

/**
 * One request when two parts of the same screen want the same file.
 *
 * Opening a memo mounts the preview and the page thumbnails together, and
 * both need the PDF. They each asked for it, so the server sent the same
 * bytes twice and wrote two audit rows for one person opening one memo once -
 * which is how a memo that has never left the browser came to show 28
 * downloads on its audit trail.
 *
 * Sharing applies to views alone. A download is an event the record has to
 * contain, so it never rides on somebody else's request.
 */

const deferred = () => {
  let resolve!: (blob: Blob) => void
  const promise = new Promise<Blob>(r => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  serve.mockReset()
})

describe('fetching a document file', () => {
  it('asks once when two callers want it at the same time', async () => {
    const pdf = new Blob(['%PDF'], { type: 'application/pdf' })
    const { promise, resolve } = deferred()
    serve.mockReturnValue(promise)

    const preview = fetchDocumentFile('doc-1', 'view')
    const thumbnails = fetchDocumentFile('doc-1', 'view')
    resolve(pdf)

    // Both get the bytes; only one request was made for them.
    await expect(preview).resolves.toBe(pdf)
    await expect(thumbnails).resolves.toBe(pdf)
    expect(serve).toHaveBeenCalledTimes(1)
  })

  it('asks again on the next visit, so a new version is never stale', async () => {
    /*
     * The sharing is of the in-flight promise only. A resolved blob is never
     * kept, because the file behind this url changes - a signature is added
     * at every approval step - and serving yesterday's copy from a cache is
     * the one bug a cache in front of a document must not have.
     */
    const first = new Blob(['%PDF v1'])
    const second = new Blob(['%PDF v2'])
    serve.mockResolvedValueOnce(first).mockResolvedValueOnce(second)

    await expect(fetchDocumentFile('doc-1', 'view')).resolves.toBe(first)
    await expect(fetchDocumentFile('doc-1', 'view')).resolves.toBe(second)
    expect(serve).toHaveBeenCalledTimes(2)
  })

  it('does not confuse two documents open at once', async () => {
    const one = new Blob(['one'])
    const two = new Blob(['two'])
    serve.mockResolvedValueOnce(one).mockResolvedValueOnce(two)

    const [a, b] = await Promise.all([
      fetchDocumentFile('doc-1', 'view'),
      fetchDocumentFile('doc-2', 'view'),
    ])

    expect(a).toBe(one)
    expect(b).toBe(two)
    expect(serve).toHaveBeenCalledTimes(2)
  })

  it('gives both callers the same failure, rather than one of them silence', async () => {
    const refusal = new Error('This file no longer matches the copy that was signed')
    serve.mockRejectedValue(refusal)

    const preview = fetchDocumentFile('doc-1', 'view')
    const thumbnails = fetchDocumentFile('doc-1', 'view')

    await expect(preview).rejects.toBe(refusal)
    await expect(thumbnails).rejects.toBe(refusal)
    expect(serve).toHaveBeenCalledTimes(1)
  })

  it('tells the server which of the two acts this is', async () => {
    serve.mockResolvedValue(new Blob(['%PDF']))

    await fetchDocumentFile('doc-1', 'view')
    await fetchDocumentFile('doc-1', 'download')

    expect(serve).toHaveBeenNthCalledWith(1, '/api/documents/doc-1/file?reason=view')
    expect(serve).toHaveBeenNthCalledWith(
      2,
      '/api/documents/doc-1/file?reason=download',
    )
  })

  it('never lets a download ride on a view already in flight', async () => {
    /*
     * The one case where sharing would destroy evidence. The preview is
     * already fetching when Download is pressed: handed the preview's
     * promise, the person gets their file and the trail never records that a
     * copy left the system. Both bytes are identical, so nothing on screen
     * would ever show it went wrong.
     */
    const pdf = new Blob(['%PDF'])
    const { promise, resolve } = deferred()
    serve.mockReturnValueOnce(promise).mockResolvedValueOnce(pdf)

    const preview = fetchDocumentFile('doc-1', 'view')
    const saved = fetchDocumentFile('doc-1', 'download')
    resolve(pdf)

    await expect(preview).resolves.toBe(pdf)
    await expect(saved).resolves.toBe(pdf)
    expect(serve).toHaveBeenCalledTimes(2)
  })

  it('does not share two downloads with each other either', async () => {
    // Pressing Download twice is two copies taken, and says so twice.
    serve.mockResolvedValue(new Blob(['%PDF']))

    await Promise.all([
      fetchDocumentFile('doc-1', 'download'),
      fetchDocumentFile('doc-1', 'download'),
    ])

    expect(serve).toHaveBeenCalledTimes(2)
  })

  it('lets the next caller retry after a failure', async () => {
    const pdf = new Blob(['%PDF'])
    serve
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(pdf)

    await expect(fetchDocumentFile('doc-1', 'view')).rejects.toThrow('network')
    // The failed entry must not be left behind, or the screen can never
    // recover without a reload.
    await expect(fetchDocumentFile('doc-1')).resolves.toBe(pdf)
  })
})

/**
 * What replaces the current version.
 *
 * A memo typed in the portal is revised by rewriting it, and the rewrite
 * travels as a multipart field holding JSON - the same way the approval chain
 * and the signature already travel, because the route parses those fields
 * back before validating them. Sent as anything else it reaches the schema as
 * a string and is refused with a message about types, which tells the
 * preparer nothing about their memo.
 */
describe('resubmitting', () => {
  const signature = {
    consent: true as const,
    useSavedSignature: true,
    signaturePage: 1,
    signatureX: 49,
    signatureY: 372,
    signatureWidth: 150,
    signatureHeight: 24,
  }

  const body: MemoBody = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Revised.' }] }],
  }

  const sent = () => send.mock.calls[0]![1]!.body as FormData

  beforeEach(() => {
    send.mockReset()
    send.mockResolvedValue(undefined)
  })

  it('asks the preparer to confirm it is them before sending a signed revision', async () => {
    confirmation.mockClear()
    const file = new File(['%PDF'], 'memo.pdf', { type: 'application/pdf' })
    await resubmitDocument('d1', file, signature)

    expect(confirmation).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('sends nothing at all when they cancel the confirmation', async () => {
    // Before the upload, not after a refusal: the PDF is never sent to be
    // turned away.
    confirmation.mockResolvedValueOnce(false)
    const file = new File(['%PDF'], 'memo.pdf', { type: 'application/pdf' })

    await expect(resubmitDocument('d1', file, signature)).rejects.toThrow(SIGNING_NOT_CONFIRMED)
    expect(send).not.toHaveBeenCalled()
  })

  it('sends an uploaded PDF as the file, as it always has', async () => {
    const file = new File(['%PDF'], 'memo.pdf', { type: 'application/pdf' })
    await resubmitDocument('d1', file, signature)

    expect(sent().get('file')).toBe(file)
    expect(sent().get('body')).toBeNull()
  })

  it('sends a rewritten memo as JSON, not as a file', async () => {
    await resubmitDocument('d1', { body, memoTo: 'Sir BMD' }, signature)

    expect(sent().get('file')).toBeNull()
    expect(JSON.parse(sent().get('body') as string).type).toBe('doc')
    expect(sent().get('memoTo')).toBe('Sir BMD')
  })

  it('leaves out a header line the revision did not touch', async () => {
    await resubmitDocument('d1', { body }, signature)

    // Absent, not empty: the server keeps what the memo already says, and an
    // empty string would blank the addressee off the page.
    expect(sent().get('memoTo')).toBeNull()
    expect(sent().get('memoFrom')).toBeNull()
  })

  it('sends the page notes back with a rewrite, so they are not read as removed', async () => {
    const notes = [{ page: 1, x: 400, y: 120, width: 140, height: 40, text: 'Budget attached' }]
    await resubmitDocument('d1', { body, notes }, signature)

    expect(JSON.parse(sent().get('notes') as string)).toEqual(notes)
  })

  it('patches the document', async () => {
    await resubmitDocument('d1', { body }, signature)

    expect(send.mock.calls[0]![0]).toBe('/api/documents/d1')
    expect(send.mock.calls[0]![1]!.method).toBe('PATCH')
  })
})
