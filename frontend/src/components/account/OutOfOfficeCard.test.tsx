import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDelegation,
  fetchDelegations,
  revokeDelegation,
} from '../../services/delegationApi'
import { fetchAssignableUsers } from '../../services/usersApi'
import type { Delegation } from '../../types/delegation'
import { makeUser, renderWithProviders, TEST_USER_ID } from '../../test/render'
import OutOfOfficeCard from './OutOfOfficeCard'

/**
 * Arranging your own cover.
 *
 * The API has always allowed it - the delegator defaults to whoever is asking
 * - and until now the only screen that offered it was the administrators'
 * people table. So the tests that matter most here are the ones about WHOSE
 * approvals are being handed over: this card must ask for its own, never name
 * somebody else, and never offer to hand them to the person already holding
 * them or to you.
 */

vi.mock('../../services/delegationApi', () => ({
  fetchDelegations: vi.fn(),
  createDelegation: vi.fn(),
  revokeDelegation: vi.fn(),
}))

vi.mock('../../services/usersApi', () => ({
  fetchAssignableUsers: vi.fn(),
}))

vi.mock('../../hooks/usePendingApprovalCount', () => ({
  usePendingApprovalCount: () => ({ count: 3, reload: vi.fn() }),
}))

const read = vi.mocked(fetchDelegations)
const create = vi.mocked(createDelegation)
const revoke = vi.mocked(revokeDelegation)
const directory = vi.mocked(fetchAssignableUsers)

const person = (id: string, firstName: string, lastName: string) => ({
  id,
  firstName,
  lastName,
  designation: null,
  email: `${firstName.toLowerCase()}@example.com`,
})

const delegation = (overrides: Partial<Delegation> = {}): Delegation => ({
  id: 'del-1',
  delegatorId: TEST_USER_ID,
  delegateId: 'u-omar',
  startsAt: '2026-09-14T00:00:00.000Z',
  endsAt: '2026-09-20T23:59:59.000Z',
  reason: null,
  revokedAt: null,
  createdAt: '2026-09-14T00:00:00.000Z',
  delegator: person(TEST_USER_ID, 'Ayesha', 'Khan'),
  delegate: person('u-omar', 'Omar', 'Haddad'),
  isActive: true,
  ...overrides,
})

const card = () =>
  renderWithProviders(<OutOfOfficeCard />, {
    currentUser: { user: makeUser() },
  })

beforeEach(() => {
  vi.clearAllMocks()
  read.mockResolvedValue({ given: [], held: [] })
  directory.mockResolvedValue({
    users: [
      {
        id: 'u-omar',
        email: 'omar@example.com',
        firstName: 'Omar',
        lastName: 'Haddad',
        department: { name: 'Finance' },
      },
      {
        id: 'u-priya',
        email: 'priya@example.com',
        firstName: 'Priya',
        lastName: 'Nair',
        department: { name: 'Procurement' },
      },
    ],
    total: 2,
    returned: 2,
  })
})

/** Opens the delegate picker and chooses a name from it. */
async function choose(user: ReturnType<typeof userEvent.setup>, name: string) {
  /*
   * `findBy`, because the card is still reading the delegation list when this
   * is called and the picker is not on screen until that answer arrives.
   *
   * Named for its LABEL, not its contents: the trigger displays "Search for a
   * person..." as its value while nobody is chosen, and a `<label for>` on a
   * button wins the accessible name - which is the name somebody using a
   * screen reader hears, so it is the name to test by.
   */
  await user.click(await screen.findByRole('button', { name: 'Hand my approvals to' }))
  const list = await screen.findByRole('listbox', { name: 'People' })
  await user.click(await within(list).findByText(name))
}

describe('with nobody covering', () => {
  it('asks for a delegate and a date, and starts it for YOU', async () => {
    /*
     * `delegatorId` must not be sent. The server defaults it to whoever is
     * asking; naming somebody here would be this screen deciding whose
     * approvals move, which is the administrators' job and not this card's.
     */
    const user = userEvent.setup()
    create.mockResolvedValue(delegation({ endsAt: null }))
    card()

    await choose(user, 'Omar Haddad')
    await user.click(screen.getByRole('button', { name: 'Start delegation' }))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledWith({ delegateId: 'u-omar', endsAt: null })
    expect(create.mock.calls[0][0]).not.toHaveProperty('delegatorId')
  })

  it('sends the date when one is given', async () => {
    const user = userEvent.setup()
    create.mockResolvedValue(delegation())
    card()

    await choose(user, 'Omar Haddad')
    await user.type(await screen.findByLabelText('Until'), '2099-12-31')
    await user.click(screen.getByRole('button', { name: 'Start delegation' }))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledWith({
      delegateId: 'u-omar',
      endsAt: '2099-12-31',
    })
  })

  it('refuses a date in the past, and says why', async () => {
    // A delegation that ended before it began is not an error the server
    // needs to see, and "nothing happened" is not an answer.
    const user = userEvent.setup()
    card()

    await choose(user, 'Omar Haddad')
    await user.type(await screen.findByLabelText('Until'), '2020-01-01')

    expect(screen.getByText(/That date has already passed/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start delegation' })).toBeDisabled()
    expect(create).not.toHaveBeenCalled()
  })

  it('will not start one with nobody chosen', async () => {
    card()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start delegation' })).toBeDisabled()
    )
  })

  it('never offers you yourself', async () => {
    /*
     * The server refuses a delegation to yourself. A picker that offers the
     * option is a picker whose only outcome is an error message.
     */
    const user = userEvent.setup()
    directory.mockResolvedValue({
      users: [
        {
          id: TEST_USER_ID,
          email: 'ayesha.khan@example.com',
          firstName: 'Ayesha',
          lastName: 'Khan',
          department: null,
        },
        {
          id: 'u-omar',
          email: 'omar@example.com',
          firstName: 'Omar',
          lastName: 'Haddad',
          department: { name: 'Finance' },
        },
      ],
      total: 2,
      returned: 2,
    })
    card()

    await user.click(await screen.findByRole('button', { name: 'Hand my approvals to' }))
    const list = await screen.findByRole('listbox', { name: 'People' })

    expect(await within(list).findByText('Omar Haddad')).toBeInTheDocument()
    expect(within(list).queryByText('Ayesha Khan')).not.toBeInTheDocument()
  })
})

describe('with one in force', () => {
  it('says who is signing and until when', async () => {
    read.mockResolvedValue({ given: [delegation()], held: [] })
    card()

    expect(
      await screen.findByText(/Your approvals are going to Omar until/)
    ).toBeInTheDocument()
  })

  it('says it runs until you end it when no date was given', async () => {
    read.mockResolvedValue({ given: [delegation({ endsAt: null })], held: [] })
    card()

    expect(
      await screen.findByText('Your approvals are going to Omar until you end this.')
    ).toBeInTheDocument()
  })

  it('says what moves now, in the number of approvals on your desk', async () => {
    // The thing somebody leaving for the airport wants to know.
    read.mockResolvedValue({ given: [delegation()], held: [] })
    card()

    expect(
      await screen.findByText('3 approvals waiting on you can be signed by Omar.')
    ).toBeInTheDocument()
  })

  it('ends it, and offers the form again', async () => {
    const user = userEvent.setup()
    read.mockResolvedValue({ given: [delegation()], held: [] })
    revoke.mockResolvedValue(delegation({ isActive: false, revokedAt: '2026-09-15T00:00:00.000Z' }))
    card()

    await user.click(await screen.findByRole('button', { name: 'End delegation' }))

    await waitFor(() => expect(revoke).toHaveBeenCalledWith('del-1'))
    expect(
      await screen.findByRole('button', { name: 'Start delegation' })
    ).toBeInTheDocument()
  })

  it('does not offer the person already holding them', async () => {
    // Only reachable after ending one and starting another in the same visit,
    // but the rule is the same rule: the server refuses it, so do not offer it.
    const user = userEvent.setup()
    read.mockResolvedValue({ given: [], held: [] })
    card()

    await user.click(await screen.findByRole('button', { name: 'Hand my approvals to' }))
    const list = await screen.findByRole('listbox', { name: 'People' })

    expect(await within(list).findByText('Omar Haddad')).toBeInTheDocument()
  })
})

describe('what you are holding for other people', () => {
  it('says who you are covering for', async () => {
    /*
     * Free with the same request, and the one thing a delegate genuinely
     * needs: somebody else's approvals arriving in your queue with no
     * explanation is how a person decides the queue is broken.
     */
    read.mockResolvedValue({
      given: [],
      held: [
        delegation({
          id: 'del-2',
          delegatorId: 'u-priya',
          delegateId: TEST_USER_ID,
          delegator: person('u-priya', 'Priya', 'Nair'),
          delegate: person(TEST_USER_ID, 'Ayesha', 'Khan'),
        }),
      ],
    })
    card()

    expect(await screen.findByText(/Priya Nair, until/)).toBeInTheDocument()
  })

  /** Cover held for `who`, open-ended so no clock decides whether it counts. */
  const covering = (id: string, first: string, last: string) =>
    delegation({
      id: `del-${id}`,
      delegatorId: id,
      delegateId: TEST_USER_ID,
      endsAt: null,
      delegator: person(id, first, last),
      delegate: person(TEST_USER_ID, 'Ayesha', 'Khan'),
    })

  it('does not offer the form at all while you are covering for somebody', async () => {
    /*
     * The server refuses this: your colleague's steps stay addressed to you,
     * so handing your own approvals on would strand them. Offering the form
     * and failing on the button is asking somebody to fill in a rejection.
     */
    read.mockResolvedValue({ given: [], held: [covering('u-priya', 'Priya', 'Nair')] })
    card()

    expect(
      await screen.findByText(/cannot be handed on while you are covering/)
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start delegation' })).not.toBeInTheDocument()
  })

  it('states it once, with the dates, where the form would have been', async () => {
    // The card used to say it twice running: an explanation naming Priya,
    // directly above the standing "You are covering for" list naming Priya.
    read.mockResolvedValue({ given: [], held: [covering('u-priya', 'Priya', 'Nair')] })
    card()

    expect(
      await screen.findAllByText('Priya Nair, until they end it.')
    ).toHaveLength(1)
    expect(screen.getAllByText('You are covering for')).toHaveLength(1)
  })

  it('names who can end that cover, which is never you', async () => {
    // A delegation is ended by the person who gave it or by an administrator.
    // The one covering is neither, so "end it first" would be advice the
    // server refuses to take from the person reading it.
    read.mockResolvedValue({ given: [], held: [covering('u-priya', 'Priya', 'Nair')] })
    card()

    expect(await screen.findByText(/Priya can end that cover/)).toBeInTheDocument()
  })

  it('lists every one of them when you are covering for several people', async () => {
    read.mockResolvedValue({
      given: [],
      held: [
        covering('u-priya', 'Priya', 'Nair'),
        covering('u-bilal', 'Bilal', 'Ahmed'),
      ],
    })
    card()

    expect(await screen.findByText('Priya Nair, until they end it.')).toBeInTheDocument()
    expect(screen.getByText('Bilal Ahmed, until they end it.')).toBeInTheDocument()
    expect(screen.getByText(/Each of them can end their cover/)).toBeInTheDocument()
  })

  it('hides it for cover that has not started yet, which this form would still overlap', async () => {
    /*
     * The obvious reading of "am I covering" is the server's `isActive`, and
     * it is the wrong one here: this form hands over from now until you end
     * it, so cover beginning next Thursday shares days with it. Filtering on
     * `isActive` would offer the form today and let the server refuse it.
     */
    read.mockResolvedValue({
      given: [],
      held: [
        delegation({
          id: 'del-soon',
          delegatorId: 'u-priya',
          delegateId: TEST_USER_ID,
          startsAt: '2099-01-01T00:00:00.000Z',
          endsAt: null,
          delegator: person('u-priya', 'Priya', 'Nair'),
          delegate: person(TEST_USER_ID, 'Ayesha', 'Khan'),
          isActive: false,
        }),
      ],
    })
    card()

    expect(
      await screen.findByText(/cannot be handed on while you are covering/)
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start delegation' })).not.toBeInTheDocument()
  })

  it('offers the form again once the cover has finished', async () => {
    // The refusal is about days the two arrangements share. Cover that ended
    // last year shares none, and hiding the form for it would lock somebody
    // out of their own leave over an arrangement long finished.
    read.mockResolvedValue({
      given: [],
      held: [
        delegation({
          id: 'del-old',
          delegatorId: 'u-priya',
          delegateId: TEST_USER_ID,
          startsAt: '2020-01-01T00:00:00.000Z',
          endsAt: '2020-01-08T00:00:00.000Z',
          delegator: person('u-priya', 'Priya', 'Nair'),
          delegate: person(TEST_USER_ID, 'Ayesha', 'Khan'),
          isActive: false,
        }),
      ],
    })
    card()

    expect(
      await screen.findByRole('button', { name: 'Start delegation' })
    ).toBeInTheDocument()
  })
})

describe('when the list cannot be read', () => {
  it('says so and offers to try again, rather than showing an empty form', async () => {
    // An empty form here would read as "you have no delegation", which is a
    // different fact from "we could not find out".
    const user = userEvent.setup()
    read.mockRejectedValueOnce(new Error('Network is down'))
    card()

    expect(await screen.findByRole('alert')).toHaveTextContent('Network is down')

    read.mockResolvedValue({ given: [], held: [] })
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(
      await screen.findByRole('button', { name: 'Start delegation' })
    ).toBeInTheDocument()
  })
})
