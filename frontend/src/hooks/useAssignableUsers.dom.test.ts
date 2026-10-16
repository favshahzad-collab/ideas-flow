import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAssignableUsers, type AssignableUsersPage } from '../services/usersApi'
import type { AssignableUser } from '../types/submitDocument'
import { formatUserOptionLabel, useAssignableUsers } from './useAssignableUsers'

/**
 * The list of people a workflow step can be assigned to.
 *
 * It fills the approver select in Workflow studio, which is where a
 * template decides who will be asked to approve every document routed through
 * it afterwards. An empty list here does not read as "something went wrong" -
 * it reads as "there is nobody to pick", and the way out of that is to save a
 * step with no approver on it, or to pick the wrong person because the right
 * one was not in the page that arrived.
 *
 * So the states have to be distinguishable: still loading, loaded and empty,
 * failed. And when it fails, it has to say so in words rather than in a raw
 * exception.
 */

vi.mock('../services/usersApi', () => ({
  fetchAssignableUsers: vi.fn(),
}))

const fetchUsers = vi.mocked(fetchAssignableUsers)

const user = (overrides: Partial<AssignableUser> = {}): AssignableUser => ({
  id: 'user-1',
  email: 'ayesha.khan@example.com',
  firstName: 'Ayesha',
  lastName: 'Khan',
  department: { name: 'Legal' },
  ...overrides,
})

const page = (users: AssignableUser[], total = users.length): AssignableUsersPage => ({
  users,
  total,
  returned: users.length,
})

/** A response the test decides the timing of. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/** Lets every queued promise callback run, inside act, with nothing left over. */
const settle = () => act(async () => void (await new Promise(done => setTimeout(done, 0))))

beforeEach(() => {
  // `restoreMocks` restores spies, not the call log of a module mock.
  fetchUsers.mockReset()
  fetchUsers.mockResolvedValue(page([user()]))
})

describe('the state it is in', () => {
  it('says it is still loading before the directory arrives', () => {
    // The list is empty at this moment too. A caller that cannot tell these
    // apart renders "no approvers available" over a request still in flight.
    const pending = deferred<AssignableUsersPage>()
    fetchUsers.mockReturnValue(pending.promise)

    const { result } = renderHook(() => useAssignableUsers())

    expect(result.current.loading).toBe(true)
    expect(result.current.users).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('hands over the people once they arrive', async () => {
    fetchUsers.mockResolvedValue(
      page([user({ id: 'u1' }), user({ id: 'u2', firstName: 'Bilal', lastName: 'Ahmed' })]),
    )

    const { result } = renderHook(() => useAssignableUsers())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.users.map(entry => entry.id)).toEqual(['u1', 'u2'])
    expect(result.current.error).toBeNull()
  })

  it('reports a genuinely empty directory without calling it an error', async () => {
    // A tenant with nobody assignable yet is a real state, and the caller has
    // to be able to say "nobody has been set up" rather than "loading failed".
    fetchUsers.mockResolvedValue(page([]))

    const { result } = renderHook(() => useAssignableUsers())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.users).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('stops loading when the request fails, instead of spinning forever', async () => {
    // A spinner that never resolves is the one state with no way out: no
    // list, no message, and no retry the person can reach.
    fetchUsers.mockRejectedValue(new Error('Network request failed'))

    const { result } = renderHook(() => useAssignableUsers())

    await waitFor(() => expect(result.current.loading).toBe(false))
  })
})

describe('what it says when it fails', () => {
  it('passes on the message the API gave', async () => {
    // The API's own wording is the only thing that distinguishes "your
    // session expired" - which the person can fix by signing in again - from
    // a server fault, which they cannot.
    fetchUsers.mockRejectedValue(new Error('Your session has expired.'))

    const { result } = renderHook(() => useAssignableUsers())

    await waitFor(() => expect(result.current.error).toBe('Your session has expired.'))
  })

  it('falls back to plain words when what was thrown is not an Error', async () => {
    // A rejected string or a thrown response object would otherwise reach the
    // screen as "undefined" or "[object Object]".
    fetchUsers.mockRejectedValue('kaboom')

    const { result } = renderHook(() => useAssignableUsers())

    await waitFor(() => expect(result.current.error).toBe('Failed to load users'))
    expect(result.current.users).toEqual([])
  })
})

describe('how much of the directory it takes', () => {
  it('asks for a capped page rather than the whole organisation', async () => {
    // This one is rendered as a flat select. Unbounded, a real directory
    // arrives as a several-megabyte response and a list nobody can scroll.
    renderHook(() => useAssignableUsers())

    await settle()
    expect(fetchUsers).toHaveBeenCalledWith({ limit: 100 })
  })

  it('reports how many people there really are, not how many it got', async () => {
    // The gap between the two is the only signal a caller has that the select
    // is hiding people - and an approver you cannot find is an approver the
    // step gets assigned to somebody else instead.
    fetchUsers.mockResolvedValue(page([user(), user({ id: 'u2' })], 312))

    const { result } = renderHook(() => useAssignableUsers())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.total).toBe(312)
    expect(result.current.users).toHaveLength(2)
  })
})

describe('trying again', () => {
  it('goes back to the server when asked, and shows what came back', async () => {
    // Counting the calls proves the request went out and nothing else. A
    // `refetch` that fires correctly and then discards the response - the
    // stale-closure version of this hook, or one that only writes state on the
    // mount path - passes a call-count assertion while the select carries on
    // showing the people who left the company. Somebody added since the panel
    // opened has to actually appear.
    fetchUsers.mockResolvedValue(page([user({ id: 'u1' })], 1))
    const { result } = renderHook(() => useAssignableUsers())
    await waitFor(() => expect(result.current.users.map(entry => entry.id)).toEqual(['u1']))

    fetchUsers.mockResolvedValue(page([user({ id: 'u1' }), user({ id: 'u2' })], 2))
    await act(async () => {
      await result.current.refetch()
    })

    expect(fetchUsers).toHaveBeenCalledTimes(2)
    expect(result.current.users.map(entry => entry.id)).toEqual(['u1', 'u2'])
    expect(result.current.total).toBe(2)
  })

  it('shows it is working again while the retry is in flight', async () => {
    // Without this the retry button looks dead on a slow connection and gets
    // pressed four more times.
    const { result } = renderHook(() => useAssignableUsers())
    await settle()
    expect(result.current.loading).toBe(false)

    const pending = deferred<AssignableUsersPage>()
    fetchUsers.mockReturnValue(pending.promise)
    act(() => void result.current.refetch())

    expect(result.current.loading).toBe(true)

    pending.resolve(page([user()]))
    await settle()
  })

  it('takes the error message down once the retry works', async () => {
    // An error banner still sitting above a list that has since loaded tells
    // the person the names below it cannot be trusted.
    fetchUsers.mockRejectedValueOnce(new Error('Network request failed'))
    const { result } = renderHook(() => useAssignableUsers())
    await waitFor(() => expect(result.current.error).toBe('Network request failed'))

    fetchUsers.mockResolvedValue(page([user({ id: 'u9' })]))
    await act(async () => {
      await result.current.refetch()
    })

    expect(result.current.error).toBeNull()
    expect(result.current.users.map(entry => entry.id)).toEqual(['u9'])
  })

  it('clears the list when a refresh fails rather than leaving a stale one', async () => {
    // The two honest options are "keep the old list" and "empty it"; what is
    // not allowed is a list shown next to an error, with nothing saying which
    // of the two the person is looking at. This hook empties it.
    fetchUsers.mockResolvedValue(page([user({ id: 'u1' })], 312))
    const { result } = renderHook(() => useAssignableUsers())
    await waitFor(() => expect(result.current.users).toHaveLength(1))

    fetchUsers.mockRejectedValue(new Error('Network request failed'))
    await act(async () => {
      await result.current.refetch()
    })

    expect(result.current.users).toEqual([])
    expect(result.current.error).toBe('Network request failed')
    // `total` is the exception, and it is pinned here because it is the only
    // way anyone finds out: the failure path empties `users` and leaves
    // `total` at whatever the last good response said. A caller wiring the two
    // together into "showing 25 of 312" renders "showing 0 of 312" next to the
    // error - a count of people it is not, and cannot currently, show.
    expect(result.current.total).toBe(312)
  })
})

describe('a response that lands late', () => {
  it('is harmless when the panel has already been closed', async () => {
    // Closing the designer while the directory is still loading. React drops
    // the write itself, so what is being pinned here is that nothing throws
    // on the way past and no "update was not wrapped in act" warning appears.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const late = deferred<AssignableUsersPage>()
    fetchUsers.mockReturnValue(late.promise)
    const { unmount } = renderHook(() => useAssignableUsers())

    unmount()
    late.resolve(page([user()]))
    await settle()

    expect(consoleError).not.toHaveBeenCalled()
  })
})

describe('the label each person is picked by', () => {
  it('names the person and the department they are in', () => {
    // Two Ayesha Khans in a directory is normal; two in one select with no
    // way to tell them apart is a step assigned to the wrong one.
    expect(formatUserOptionLabel(user({ department: { name: 'Legal' } }))).toBe(
      'Ayesha Khan — Legal',
    )
  })

  it('leaves the separator out when there is no department', () => {
    // "Ayesha Khan — " reads as a name that failed to load the rest of itself.
    expect(formatUserOptionLabel(user({ department: null }))).toBe('Ayesha Khan')
  })

  it('does not leave a hanging space when half the name is missing', () => {
    // Seeded and service accounts often carry only one name.
    expect(formatUserOptionLabel(user({ lastName: '', department: null }))).toBe('Ayesha')
  })
})
