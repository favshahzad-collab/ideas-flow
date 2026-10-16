import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, apiJson, jsonBody } from './apiClient'
import {
  clearTokens,
  onSessionExpired,
  setAuthToken,
  setRefreshToken,
} from './authTokens'
import { registerStepUpPrompt, rememberStepUp } from './stepUp'

/**
 * `authTokens` reads `localStorage`, which does not exist under the node test
 * environment — and its own try/catch would quietly turn every read into null,
 * so the refresh path would never even be reached.
 */
function installLocalStorage() {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  })
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  installLocalStorage()
  clearTokens()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('apiFetch', () => {
  it('attaches the bearer token', async () => {
    setAuthToken('access-1')
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }))

    await apiFetch('/api/documents')

    const [, init] = fetchMock.mock.calls[0]
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer access-1')
  })

  it('sends no Authorization header when there is no token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }))

    await apiFetch('/api/documents')

    const [, init] = fetchMock.mock.calls[0]
    expect(new Headers(init.headers).get('Authorization')).toBeNull()
  })

  it('leaves a FormData body without a Content-Type so the browser sets the boundary', async () => {
    setAuthToken('access-1')
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }))

    const body = new FormData()
    body.append('file', new Blob(['x']), 'x.pdf')
    await apiFetch('/api/documents', { method: 'POST', body })

    const [, init] = fetchMock.mock.calls[0]
    expect(new Headers(init.headers).get('Content-Type')).toBeNull()
  })

  it('passes a non-401 response straight back', async () => {
    setAuthToken('access-1')
    setRefreshToken('refresh-1')
    fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, 403))

    const res = await apiFetch('/api/documents')

    expect(res.status).toBe(403)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('apiFetch, expired access token', () => {
  it('refreshes once and replays the request with the new token', async () => {
    setAuthToken('stale')
    setRefreshToken('refresh-1')

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'expired' }, 401))
      .mockResolvedValueOnce(
        jsonResponse({ accessToken: 'access-2', refreshToken: 'refresh-2' }),
      )
      .mockResolvedValueOnce(jsonResponse({ documents: [] }))

    const res = await apiFetch('/api/documents')

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/refresh')

    // The replay must carry the token the refresh returned, not the stale one.
    const replay = new Headers(fetchMock.mock.calls[2][1].headers)
    expect(replay.get('Authorization')).toBe('Bearer access-2')
  })

  it('stores the rotated refresh token, so the 30-day window keeps sliding', async () => {
    setAuthToken('stale')
    setRefreshToken('refresh-1')

    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(
        jsonResponse({ accessToken: 'access-2', refreshToken: 'refresh-2' }),
      )
      .mockResolvedValueOnce(jsonResponse({}))

    await apiFetch('/api/documents')

    expect(localStorage.getItem('docflow_refresh_token')).toBe('refresh-2')
    expect(localStorage.getItem('docflow_auth_token')).toBe('access-2')
  })

  it('shares one refresh across a burst of concurrent 401s', async () => {
    setAuthToken('stale')
    setRefreshToken('refresh-1')

    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/auth/refresh') {
        return Promise.resolve(
          jsonResponse({ accessToken: 'access-2', refreshToken: 'refresh-2' }),
        )
      }
      const token = fetchMock.mock.calls.at(-1)?.[1]
      const auth = new Headers(token?.headers).get('Authorization')
      return Promise.resolve(
        auth === 'Bearer access-2' ? jsonResponse({}) : jsonResponse({}, 401),
      )
    })

    await Promise.all([
      apiFetch('/api/documents'),
      apiFetch('/api/notifications'),
      apiFetch('/api/audit/documents'),
      apiFetch('/api/users'),
    ])

    const refreshCalls = fetchMock.mock.calls.filter(c => c[0] === '/api/auth/refresh')
    expect(refreshCalls).toHaveLength(1)
  })

  it('does not try to refresh when there is no refresh token', async () => {
    setAuthToken('stale')
    fetchMock.mockResolvedValue(jsonResponse({}, 401))

    const res = await apiFetch('/api/documents')

    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never refreshes on the auth endpoints themselves', async () => {
    setAuthToken('stale')
    setRefreshToken('refresh-1')
    fetchMock.mockResolvedValue(jsonResponse({ error: 'bad password' }, 401))

    // A wrong password is a 401 that must not be mistaken for an expiry.
    await apiFetch('/api/auth/login', { method: 'POST', ...jsonBody({}) })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('apiFetch, unrecoverable 401', () => {
  it('clears tokens and announces the expiry when the refresh fails', async () => {
    setAuthToken('stale')
    setRefreshToken('dead')

    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid' }, 401))

    const expired = vi.fn()
    const unsubscribe = onSessionExpired(expired)

    const res = await apiFetch('/api/documents')

    expect(res.status).toBe(401)
    expect(expired).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('docflow_auth_token')).toBeNull()
    expect(localStorage.getItem('docflow_refresh_token')).toBeNull()

    unsubscribe()
  })

  it('announces the expiry when a freshly refreshed token is still rejected', async () => {
    setAuthToken('stale')
    setRefreshToken('refresh-1')

    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'access-2' }))
      .mockResolvedValueOnce(jsonResponse({}, 401))

    const expired = vi.fn()
    const unsubscribe = onSessionExpired(expired)

    await apiFetch('/api/documents')

    expect(expired).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('stops after one retry rather than looping', async () => {
    setAuthToken('stale')
    setRefreshToken('refresh-1')
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/api/auth/refresh'
          ? jsonResponse({ accessToken: 'access-2', refreshToken: 'refresh-2' })
          : jsonResponse({}, 401),
      ),
    )

    await apiFetch('/api/documents')

    // original + refresh + one replay
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('apiFetch, a change the server wants confirmed', () => {
  const refused = () =>
    jsonResponse({ error: { message: 'Confirm it is you.', code: 'STEP_UP_REQUIRED' } }, 403)

  afterEach(() => registerStepUpPrompt(null))

  it('asks the person once and resends the request with the confirmation', async () => {
    setAuthToken('access-1')
    fetchMock.mockResolvedValueOnce(refused()).mockResolvedValueOnce(jsonResponse({ ok: true }))
    const prompt = vi.fn(async () => {
      rememberStepUp('confirmation-1', new Date(Date.now() + 5 * 60_000).toISOString())
      return true
    })
    registerStepUpPrompt(prompt)

    const res = await apiFetch('/api/admin/users/u1/two-factor', { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init.headers).get('X-Step-Up'))).toEqual([
      null,
      'confirmation-1',
    ])
  })

  it('hands the refusal back unchanged when the person cancels', async () => {
    fetchMock.mockResolvedValueOnce(refused())
    registerStepUpPrompt(async () => false)

    const res = await apiFetch('/api/admin/sso/settings', { method: 'DELETE' })

    expect(res.status).toBe(403)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // And still readable by whoever shows the error.
    expect(await res.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } })
  })

  it('shares one prompt across requests refused at the same moment', async () => {
    fetchMock
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(refused())
      .mockResolvedValue(jsonResponse({ ok: true }))
    let release: (confirmed: boolean) => void = () => {}
    const prompt = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          release = confirmed => {
            rememberStepUp('confirmation-2', new Date(Date.now() + 5 * 60_000).toISOString())
            resolve(confirmed)
          }
        }),
    )
    registerStepUpPrompt(prompt)

    const both = Promise.all([
      apiFetch('/api/admin/mail/settings', { method: 'DELETE' }),
      apiFetch('/api/admin/sso/settings', { method: 'DELETE' }),
    ])
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1))
    release(true)

    expect((await both).map(res => res.status)).toEqual([200, 200])
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('leaves any other 403 alone', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'No.', code: 'FORBIDDEN' } }, 403))
    const prompt = vi.fn(async () => true)
    registerStepUpPrompt(prompt)

    const res = await apiFetch('/api/admin/users')

    expect(res.status).toBe(403)
    expect(prompt).not.toHaveBeenCalled()
  })

  it('forgets the confirmation when the session is cleared', async () => {
    rememberStepUp('confirmation-3', new Date(Date.now() + 5 * 60_000).toISOString())
    clearTokens()
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }))

    await apiFetch('/api/documents')

    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('X-Step-Up')).toBeNull()
  })
})

describe('apiJson', () => {
  it('throws the backend message', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: 'Document not found' } }, 404),
    )

    await expect(apiJson('/api/documents/x')).rejects.toThrow('Document not found')
  })

  it('falls back to a message for the status when the body carries none', async () => {
    fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 502 }))

    await expect(apiJson('/api/documents')).rejects.toThrow(/could not reach the server/i)
  })
})

describe('jsonBody', () => {
  it('sets the content type and serialises the payload', () => {
    const init = jsonBody({ a: 1 })

    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
    expect(init.body).toBe('{"a":1}')
  })
})

describe('apiFetch, a signature the server wants confirmed', () => {
  afterEach(() => registerStepUpPrompt(null))

  it('asks "to sign" and resends the approval with the confirmation', async () => {
    setAuthToken('access-1')
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'Confirm it is you to sign.', code: 'STEP_UP_REQUIRED_TO_SIGN' } }, 403),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    const prompt = vi.fn(async () => {
      rememberStepUp('confirmation-sign', new Date(Date.now() + 5 * 60_000).toISOString())
      return true
    })
    registerStepUpPrompt(prompt)

    const res = await apiFetch('/api/documents/d1/approve', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(prompt).toHaveBeenCalledWith('sign')
    expect(new Headers(fetchMock.mock.calls[1]![1].headers).get('X-Step-Up')).toBe('confirmation-sign')
  })
})
