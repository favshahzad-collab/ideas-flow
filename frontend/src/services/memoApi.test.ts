import { beforeEach, describe, expect, it, vi } from 'vitest'

import { previewMemo, previewToFile, fetchMemoTypes } from './memoApi'
import type { MemoBody } from '../types/memo'

/**
 * The calls behind the memo authoring screen.
 *
 * The method assertion below is not pedantry. `jsonBody` sets the header and
 * the body and nothing else, so leaving the method off sent the preview as a
 * GET carrying a body - which fetch refuses outright, with an error about
 * GET/HEAD requests rather than about anything to do with memos. The preview
 * never fired and the signing dialog it feeds never opened, and no test with
 * a mocked service could have seen it.
 */

const body: MemoBody = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'It is submitted.' }] }],
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => ({ pdfBase64: '', slots: [], pageCount: 1 }),
    text: async () => '{}',
  })
})

describe('asking the server to draw the memo', () => {
  it('sends it as a POST', async () => {
    await previewMemo({ body })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('/api/memo-drafts/preview')
    expect(init.method).toBe('POST')
  })

  it('carries the header fields and the chain', async () => {
    await previewMemo({
      title: 'Fuel allowance',
      memoTo: 'Sir BMD',
      memoFrom: 'HR',
      body,
      chain: [{ userId: 'u1', approvalType: 'FINAL_APPROVER' }],
    })

    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(sent.memoTo).toBe('Sir BMD')
    expect(sent.chain).toHaveLength(1)
    // The body goes as a value, not as a string inside a string.
    expect(sent.body.type).toBe('doc')
  })

  it('passes an abort signal through, so a slow draw can be cancelled', async () => {
    const controller = new AbortController()
    await previewMemo({ body }, { signal: controller.signal })

    expect(fetchMock.mock.calls[0]![1].signal).toBe(controller.signal)
  })
})

describe('the list of memo types', () => {
  /*
   * The call answers with the page as well as the types.
   *
   * The composer needs both to draw the compose step - the types to choose
   * from, and the page to size the column they type into - and they arrive
   * together because a second request for five numbers would be a second way
   * for the screen to be half-loaded.
   */
  const PAGE = {
    paper: 'A4',
    marginLeft: 43.2,
    marginRight: 43.2,
    marginTop: 57.6,
    marginBottom: 57.6,
    width: 595.28,
    height: 841.89,
    textWidth: 508.88,
    textHeight: 726.69,
  }

  it('hands back the types and the page together', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({ memoTypes: [{ key: 'APPROVAL_REQUEST' }], page: PAGE }),
      text: async () => '{}',
    })

    expect(await fetchMemoTypes()).toEqual({
      memoTypes: [{ key: 'APPROVAL_REQUEST' }],
      page: PAGE,
    })
  })
})

describe('turning the drawn memo into a file the viewer can open', () => {
  const pdf = 'JVBERi0xLjcK' // "%PDF-1.7\n"

  it('decodes the bytes', async () => {
    const file = previewToFile(pdf, 'Fuel allowance')
    const text = await file.text()

    expect(text.startsWith('%PDF-')).toBe(true)
    expect(file.type).toBe('application/pdf')
  })

  it('names it after the memo, so a saved copy is recognisable', () => {
    expect(previewToFile(pdf, 'Fuel allowance').name).toBe('Fuel allowance.pdf')
  })

  it('drops characters a filename cannot carry', () => {
    expect(previewToFile(pdf, 'Fuel: 50L / month?').name).toBe('Fuel 50L  month.pdf')
  })

  it('falls back to a name when the title is empty', () => {
    expect(previewToFile(pdf, '   ').name).toBe('memo.pdf')
  })
})
