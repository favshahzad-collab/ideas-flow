import { describe, expect, it } from 'vitest'
import { parseApiError } from './apiError'

/**
 * Every failed request in the app ends up here, and whatever this returns is
 * what the user reads. Two things it must never do: show `[object Object]`,
 * and show nothing useful because the response was an HTML error page from
 * something in front of the API.
 */

const respond = (status: number, body?: unknown, asText?: string) =>
  new Response(asText ?? (body === undefined ? '' : JSON.stringify(body)), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('when the API said what went wrong', () => {
  it('uses the backend error shape', async () => {
    const message = await parseApiError(
      respond(400, { error: { message: 'Title is required', code: 'VALIDATION_ERROR' } }),
    )

    expect(message).toBe('Title is required')
  })

  it('accepts a bare message field', async () => {
    expect(await parseApiError(respond(400, { message: 'Nope' }))).toBe('Nope')
  })

  it('accepts a plain string error', async () => {
    expect(await parseApiError(respond(404, { error: 'Route not found' }))).toBe(
      'Route not found',
    )
  })

  it('prefers the structured message over the loose ones', async () => {
    const message = await parseApiError(
      respond(400, { error: { message: 'structured' }, message: 'loose' }),
    )

    expect(message).toBe('structured')
  })
})

describe('when it did not', () => {
  it('turns a network failure, which has no status at all, into advice', async () => {
    // A fetch that never reached the server surfaces as status 0, which the
    // Response constructor will not build - so this is the shape the browser
    // actually hands over.
    const networkFailure = {
      status: 0,
      json: () => Promise.reject(new Error('no body')),
    } as unknown as Response

    expect(await parseApiError(networkFailure)).toBe(
      'We could not reach the server. Check your connection and try again.',
    )
  })

  it.each([
    [502, 'We could not reach the server. Check your connection and try again.'],
    [503, 'We could not reach the server. Check your connection and try again.'],
    [504, 'We could not reach the server. Check your connection and try again.'],
    [401, 'Your session has expired. Please sign in again.'],
    [403, 'You do not have permission to do that.'],
    [404, 'We could not find what you were looking for.'],
    [408, 'The server took too long to respond. Please try again.'],
    [413, 'That file is too large to upload.'],
    [429, 'Too many requests. Wait a moment and try again.'],
    [500, 'Something went wrong on our end. Please try again.'],
    [418, 'That request could not be completed. Please check your details and try again.'],
  ])('turns a bare %i into something a person can act on', async (status, expected) => {
    // A gateway timeout arrives as an HTML page with no JSON in it at all;
    // "Request failed (504)" tells the user nothing they can do next.
    expect(await parseApiError(respond(status, undefined, ''))).toBe(expected)
  })

  it('survives an HTML error page', async () => {
    const html = new Response('<html><body>502 Bad Gateway</body></html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    })

    expect(await parseApiError(html)).toContain('could not reach the server')
  })

  it('never returns the string [object Object]', async () => {
    // The bug this file exists to prevent: an `error` that is an object with
    // no `message`, interpolated straight into a template.
    for (const body of [
      { error: { code: 'NO_MESSAGE_HERE' } },
      { error: {} },
      { error: [1, 2, 3] },
      { error: null },
      {},
    ]) {
      const message = await parseApiError(respond(400, body))
      expect(message).not.toContain('[object Object]')
      expect(message.length).toBeGreaterThan(0)
    }
  })
})
