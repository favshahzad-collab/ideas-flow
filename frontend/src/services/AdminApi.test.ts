import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchUsers } from './AdminApi'
import { apiJson } from './apiClient'

/**
 * The contract between the People screen and the admin API.
 *
 * This exists because the contract broke silently. The backend moved the user
 * list onto the page envelope every list endpoint uses, the service kept
 * saying "array", and the screen handed an object to `setUsers` and died on
 * `.filter` - with every unit test green, because none of them crossed this
 * boundary. A shape change on the other side of the wire has to fail here.
 */

vi.mock('./apiClient', () => ({
  apiJson: vi.fn(),
  apiVoid: vi.fn(),
  apiBlob: vi.fn(),
  jsonBody: (body: unknown) => ({ body: JSON.stringify(body) }),
}))

const mockedApiJson = vi.mocked(apiJson)

const person = (id: string) => ({
  id,
  email: `${id}@example.com`,
  firstName: 'Ayesha',
  lastName: 'Khan',
  loginRole: 'USER' as const,
  department: { id: 'd1', name: 'Human Resources' },
  designation: 'Assistant Manager, HR',
})

beforeEach(() => {
  mockedApiJson.mockReset()
})

describe('fetchUsers', () => {
  it('returns the rows out of the page envelope', async () => {
    mockedApiJson.mockResolvedValueOnce({
      users: [person('u1'), person('u2')],
      total: 2,
      returned: 2,
    })

    const users = await fetchUsers()

    // Callers `.filter`, `.map` and `.find` on this. An envelope where an
    // array is expected is not a type error at runtime - it is a blank screen.
    expect(Array.isArray(users)).toBe(true)
    expect(users.map(user => user.id)).toEqual(['u1', 'u2'])
  })

  it('asks the admin list endpoint and nothing else', async () => {
    mockedApiJson.mockResolvedValueOnce({ users: [], total: 0, returned: 0 })

    await fetchUsers()

    expect(mockedApiJson).toHaveBeenCalledTimes(1)
    expect(mockedApiJson.mock.calls[0][0]).toBe('/api/admin/users?limit=200&offset=0')
  })

  it('reads every page, so nobody past the first page goes missing', async () => {
    // The server pages the list. Reading only the first page left everybody
    // added earliest off People, Access control and the transfer list.
    const many = Array.from({ length: 200 }, (_, i) => person(`u${i}`))
    mockedApiJson
      .mockResolvedValueOnce({ users: many, total: 203, returned: 200 })
      .mockResolvedValueOnce({ users: [person('a'), person('b'), person('c')], total: 203, returned: 3 })

    const users = await fetchUsers()

    expect(users).toHaveLength(203)
    expect(mockedApiJson.mock.calls.map(call => call[0])).toEqual([
      '/api/admin/users?limit=200&offset=0',
      '/api/admin/users?limit=200&offset=200',
    ])
  })

  it('stops on an empty page even if the total says there are more', async () => {
    // Somebody switched off between two pages shrinks the list under it; an
    // empty page must end the loop rather than ask for ever.
    mockedApiJson
      .mockResolvedValueOnce({ users: [person('u1')], total: 5, returned: 1 })
      .mockResolvedValueOnce({ users: [], total: 5, returned: 0 })

    expect(await fetchUsers()).toHaveLength(1)
    expect(mockedApiJson).toHaveBeenCalledTimes(2)
  })

  it('returns an empty list, not undefined, for an empty organisation', async () => {
    mockedApiJson.mockResolvedValueOnce({ users: [], total: 0, returned: 0 })

    expect(await fetchUsers()).toEqual([])
  })

  it('carries the designation through, since the memo prints it', async () => {
    mockedApiJson.mockResolvedValueOnce({
      users: [person('u1')],
      total: 1,
      returned: 1,
    })

    const [user] = await fetchUsers()

    expect(user.designation).toBe('Assistant Manager, HR')
  })
})
