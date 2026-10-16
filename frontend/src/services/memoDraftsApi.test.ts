import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createMemoDraft,
  deleteMemoDraft,
  listMemoDrafts,
  updateMemoDraft,
} from './memoDraftsApi'
import type { MemoBody } from '../types/memo'

/**
 * The calls behind a memo that is still being written.
 *
 * The method assertions are not pedantry: `jsonBody` sets the header and the
 * body and nothing else, and leaving the method off sends a GET carrying a
 * body, which fetch refuses outright with an error about GET requests rather
 * than anything to do with memos. That exact mistake shipped once already, in
 * the preview call.
 */

const body: MemoBody = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Drafting.' }] }],
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => ({ drafts: [], id: 'draft-1' }),
    text: async () => '{}',
  })
})

const call = () => fetchMock.mock.calls[0]!

describe('listing what is unfinished', () => {
  it('unwraps the envelope the API answers with', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({ drafts: [{ id: 'draft-1' }] }),
      text: async () => '{}',
    })

    expect(await listMemoDrafts()).toEqual([{ id: 'draft-1' }])
  })
})

describe('saving one', () => {
  it('creates with a POST', async () => {
    await createMemoDraft({ body, title: 'Fuel allowance' })

    expect(String(call()[0])).toContain('/api/memo-drafts')
    expect(call()[1].method).toBe('POST')
    expect(JSON.parse(call()[1].body).body.type).toBe('doc')
  })

  it('updates with a PATCH, not a PUT', async () => {
    /*
     * PATCH is load-bearing: the client sends what changed, and a request
     * that leaves the chain out must not be read as "the preparer cleared
     * it" halfway through picking approvers.
     */
    await updateMemoDraft('draft-1', { title: 'Renamed' })

    expect(String(call()[0])).toContain('/api/memo-drafts/draft-1')
    expect(call()[1].method).toBe('PATCH')
  })

  it('deletes with a DELETE', async () => {
    await deleteMemoDraft('draft-1')

    expect(String(call()[0])).toContain('/api/memo-drafts/draft-1')
    expect(call()[1].method).toBe('DELETE')
  })
})
