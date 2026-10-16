import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '../../types/admin'
import type { Delegation } from '../../types/delegation'
import {
  createDelegation,
  fetchDelegations,
  revokeDelegation,
} from '../../services/delegationApi'
import DelegationPanel from './DelegationPanel'

/**
 * Handing one person's approvals to another while they are away.
 *
 * This panel authorises somebody to sign in another person's place, which
 * makes it the most consequential form on the administration screen: what it
 * collects decides who may approve a memo. So the rules it has to hold are
 * about who can be picked, when the arrangement applies, and never showing one
 * person's arrangement against another person's name.
 *
 * The API is mocked; `delegations.service.itest.ts` is where the rules behind
 * it are proven against a real database.
 */

vi.mock('../../services/delegationApi', () => ({
  fetchDelegations: vi.fn(),
  createDelegation: vi.fn(),
  revokeDelegation: vi.fn(),
}))

const mockedFetch = vi.mocked(fetchDelegations)
const mockedCreate = vi.mocked(createDelegation)
const mockedRevoke = vi.mocked(revokeDelegation)

function person(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    email: 'priya.nair@example.com',
    firstName: 'Priya',
    lastName: 'Nair',
    designation: null,
    loginRole: 'USER',
    department: { id: 'dep-1', name: 'Procurement' },
    openApprovals: 0,
    deactivatedAt: null,
    coveredBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const TOM = person({
  id: 'u2',
  firstName: 'Tom',
  lastName: 'Becker',
  email: 'tom.becker@example.com',
  department: { id: 'dep-2', name: 'Legal' },
})

const SANA = person({
  id: 'u3',
  firstName: 'Sana',
  lastName: 'Iqbal',
  email: 'sana.iqbal@example.com',
})

const asDelegationPerson = (user: User) => ({
  id: user.id,
  firstName: user.firstName,
  lastName: user.lastName,
  designation: user.designation,
  email: user.email,
})

function delegation(overrides: Partial<Delegation> = {}): Delegation {
  return {
    id: 'd1',
    delegatorId: 'u1',
    delegateId: TOM.id,
    startsAt: '2026-09-01T00:00:00.000Z',
    endsAt: '2026-09-30T23:59:59.999Z',
    reason: null,
    revokedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    delegator: asDelegationPerson(person()),
    delegate: asDelegationPerson(TOM),
    isActive: true,
    ...overrides,
  }
}

beforeEach(() => {
  mockedFetch.mockReset()
  mockedCreate.mockReset()
  mockedRevoke.mockReset()
  mockedFetch.mockResolvedValue({ given: [], held: [] })
})

function renderPanel({
  selected = person(),
  colleagues = [TOM, SANA],
  onChange,
}: {
  selected?: User | null
  colleagues?: User[]
  onChange?: () => void
} = {}) {
  return render(
    <DelegationPanel person={selected} colleagues={colleagues} onChange={onChange} />,
  )
}

/** The form, once the panel has finished asking the API about this person. */
const form = () => screen.findByRole('switch', { name: 'Out of office' })

/** Turns out-of-office on, which is what unlocks the rest of the form. */
async function markAway(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await form())
}

describe('before anybody is picked', () => {
  it('explains what the panel is for instead of showing an idle form', () => {
    renderPanel({ selected: null })

    // An empty card with three greyed-out controls looks broken. Saying "pick
    // a person" names the missing step, which is the only thing wrong.
    expect(screen.getByText('Pick a person')).toBeInTheDocument()
    expect(
      screen.getByText(/Choose a name in the table to set their out-of-office/),
    ).toBeInTheDocument()
    // The landmark keeps its name in the empty state too - it is the same
    // region either way, and a panel that only becomes findable once
    // something is selected cannot be navigated to in order to select.
    expect(screen.getByRole('complementary', { name: 'Delegation' })).toBeInTheDocument()
  })

  it('offers no controls at all, so nothing can be set against nobody', () => {
    renderPanel({ selected: null })

    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Save delegation' }),
    ).not.toBeInTheDocument()
  })

  it('asks the API about nobody', () => {
    renderPanel({ selected: null })

    expect(mockedFetch).not.toHaveBeenCalled()
  })
})

describe('once a person is selected', () => {
  it('names whose approvals are about to be handed over', () => {
    renderPanel()

    // The table can be scrolled away from under this panel. If the header did
    // not name the person, a delegation could be set against whoever happened
    // to be selected three clicks ago.
    expect(screen.getByText(/Priya Nair/)).toHaveTextContent('Procurement')
  })

  it('shows an em dash for a person with no department rather than a blank line', () => {
    renderPanel({
      selected: person({ department: undefined as unknown as User['department'] }),
    })

    expect(screen.getByText(/Priya Nair/)).toHaveTextContent('—')
  })

  it('asks the API what is already in force for them', async () => {
    renderPanel()

    await form()
    expect(mockedFetch).toHaveBeenCalledWith('u1')
  })

  it('keeps the away date and the delegate locked until somebody is marked away', async () => {
    renderPanel()

    // Disabled in fact, not merely styled grey: a delegate set on somebody
    // who is at their desk would silently re-route approvals they are
    // sitting there waiting to make.
    expect(await form()).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByLabelText('Away until')).toBeDisabled()
    expect(screen.getByLabelText('Delegate approvals to')).toBeDisabled()
  })

  it('unlocks them when out of office is switched on', async () => {
    const user = userEvent.setup({ delay: null })
    renderPanel()

    await markAway(user)

    expect(await form()).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('Away until')).toBeEnabled()
    expect(screen.getByLabelText('Delegate approvals to')).toBeEnabled()
  })

  it('lists the colleagues it was handed, behind a placeholder', async () => {
    const user = userEvent.setup({ delay: null })
    renderPanel()
    await markAway(user)

    expect(screen.getByRole('option', { name: 'Select a person' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Tom Becker' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Sana Iqbal' })).toBeInTheDocument()
  })

  it('keeps a person out of their own delegate list', async () => {
    const user = userEvent.setup({ delay: null })
    // The API refuses a self-delegation, and the option is never offered
    // either - whatever list this component is handed.
    renderPanel({ selected: person(), colleagues: [person(), TOM] })
    await markAway(user)

    expect(screen.queryByRole('option', { name: 'Priya Nair' })).not.toBeInTheDocument()
  })

  it('keeps the administrator using the panel out of the list for somebody else', async () => {
    const user = userEvent.setup({ delay: null })
    // Arranging Priya's cover and naming yourself as it would let one person
    // decide both that she is away and who signs instead. The API refuses it,
    // and the option is never offered.
    render(
      <DelegationPanel person={person()} colleagues={[TOM, SANA]} actingUserId={SANA.id} />,
    )
    await markAway(user)

    expect(
      screen.getAllByRole('option').map(option => option.textContent),
    ).toEqual(['Select a person', 'Tom Becker'])
  })

  it('confirms who was picked, with the department that tells two Toms apart', async () => {
    const user = userEvent.setup({ delay: null })
    renderPanel()
    await markAway(user)

    await user.selectOptions(screen.getByLabelText('Delegate approvals to'), TOM.id)

    expect(screen.getByText(/Tom Becker · Legal/)).toBeInTheDocument()
  })

  it('says nobody is available rather than offering an empty list', async () => {
    const user = userEvent.setup({ delay: null })
    renderPanel({ colleagues: [] })
    await markAway(user)

    expect(screen.getByLabelText('Delegate approvals to')).toBeDisabled()
    expect(
      screen.getByText('There is nobody else to hand these approvals to.'),
    ).toBeInTheDocument()
  })
})

describe('the guards on the form', () => {
  it('drops the delegate when the person is marked back at their desk', async () => {
    const user = userEvent.setup({ delay: null })
    renderPanel()

    await markAway(user)
    await user.selectOptions(screen.getByLabelText('Delegate approvals to'), TOM.id)
    await markAway(user)

    // Otherwise the panel goes on showing "Tom Becker · Legal" under a switch
    // that says the person is in, and Save would send it.
    expect(screen.queryByText(/Tom Becker · Legal/)).not.toBeInTheDocument()
  })

  it('refuses an away date that has already passed, and says why', async () => {
    const user = userEvent.setup({ delay: null })
    renderPanel()
    await markAway(user)

    await user.type(screen.getByLabelText('Away until'), '2020-01-01')

    // "Away until" is the end of an absence that starts now, so a date in the
    // past is an absence that ended before it began.
    expect(screen.getByText(/already passed/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Away until')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: 'Save delegation' })).toBeDisabled()
  })

  it('will not offer a past date in the picker either', async () => {
    renderPanel()
    await form()

    expect(screen.getByLabelText('Away until')).toHaveAttribute('min')
  })

  it('clears the form when a different person is selected', async () => {
    const user = userEvent.setup({ delay: null })
    const { rerender } = renderPanel({ selected: person(), colleagues: [TOM, SANA] })

    await markAway(user)
    await user.selectOptions(screen.getByLabelText('Delegate approvals to'), TOM.id)

    // Otherwise the panel reads as though the new person is already marked
    // away with a delegate assigned - the most misleading state on the screen.
    rerender(
      <DelegationPanel person={SANA} colleagues={[person(), TOM]} />,
    )

    expect(await form()).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByText(/Tom Becker · Legal/)).not.toBeInTheDocument()
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith(SANA.id))
  })

  it('keeps Save disabled until there is somebody to hand them to', async () => {
    const user = userEvent.setup({ delay: null })
    renderPanel()

    // Awaited: the form only exists once the panel has finished asking the
    // API whether this person already has somebody covering for them.
    await form()
    expect(screen.getByRole('button', { name: 'Save delegation' })).toBeDisabled()

    await markAway(user)
    expect(screen.getByRole('button', { name: 'Save delegation' })).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('Delegate approvals to'), TOM.id)
    expect(screen.getByRole('button', { name: 'Save delegation' })).toBeEnabled()
  })
})

describe('saving one', () => {
  it('sends the person, the delegate and the end date', async () => {
    const user = userEvent.setup({ delay: null })
    mockedCreate.mockResolvedValue(delegation())
    renderPanel()

    await markAway(user)
    await user.type(screen.getByLabelText('Away until'), '2099-09-30')
    await user.selectOptions(screen.getByLabelText('Delegate approvals to'), TOM.id)
    await user.click(screen.getByRole('button', { name: 'Save delegation' }))

    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith({
        delegatorId: 'u1',
        delegateId: TOM.id,
        endsAt: '2099-09-30',
      }),
    )
  })

  it('hands over open-endedly when no date is given', async () => {
    const user = userEvent.setup({ delay: null })
    mockedCreate.mockResolvedValue(delegation({ endsAt: null }))
    renderPanel()

    await markAway(user)
    await user.selectOptions(screen.getByLabelText('Delegate approvals to'), TOM.id)
    await user.click(screen.getByRole('button', { name: 'Save delegation' }))

    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith(
        expect.objectContaining({ endsAt: null }),
      ),
    )
  })

  it('shows the arrangement it just made, rather than the form again', async () => {
    const user = userEvent.setup({ delay: null })
    mockedCreate.mockResolvedValue(delegation())
    renderPanel()

    await markAway(user)
    await user.selectOptions(screen.getByLabelText('Delegate approvals to'), TOM.id)
    await user.click(screen.getByRole('button', { name: 'Save delegation' }))

    expect(await screen.findByText('In force')).toBeInTheDocument()
    expect(screen.getByText('Tom Becker')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Save delegation' }),
    ).not.toBeInTheDocument()
  })

  it('tells the screen around it, so the queue column catches up', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn()
    mockedCreate.mockResolvedValue(delegation())
    renderPanel({ onChange })

    await markAway(user)
    await user.selectOptions(screen.getByLabelText('Delegate approvals to'), TOM.id)
    await user.click(screen.getByRole('button', { name: 'Save delegation' }))

    await waitFor(() => expect(onChange).toHaveBeenCalled())
  })

  it('says what the API refused, and keeps the form', async () => {
    const user = userEvent.setup({ delay: null })
    mockedCreate.mockRejectedValue(
      new Error('Tom has handed their own approvals to somebody else.'),
    )
    renderPanel()

    await markAway(user)
    await user.selectOptions(screen.getByLabelText('Delegate approvals to'), TOM.id)
    await user.click(screen.getByRole('button', { name: 'Save delegation' }))

    // The refusal is the useful part: it names the reason the administrator
    // has to act on. Swallowing it would leave them clicking Save again.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Tom has handed their own approvals to somebody else.',
    )
    expect(screen.getByRole('button', { name: 'Save delegation' })).toBeInTheDocument()
  })
})

describe('one already in force', () => {
  beforeEach(() => {
    mockedFetch.mockResolvedValue({ given: [delegation()], held: [] })
  })

  it('shows who is covering, and until when', async () => {
    renderPanel()

    expect(await screen.findByText('In force')).toBeInTheDocument()
    expect(screen.getByText('Tom Becker')).toBeInTheDocument()
    expect(screen.getByText(/Approving for Priya until/)).toBeInTheDocument()
  })

  it('offers to end it instead of stacking a second one on top', async () => {
    renderPanel()

    expect(await screen.findByRole('button', { name: 'End delegation' })).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Save delegation' }),
    ).not.toBeInTheDocument()
  })

  it('says what happens to approvals already given under it', async () => {
    renderPanel()

    await screen.findByText('In force')
    expect(
      screen.getByText(/Approvals already given under it stand/),
    ).toBeInTheDocument()
  })

  it('ends it, and comes back to the form', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn()
    mockedRevoke.mockResolvedValue(delegation({ isActive: false }))
    renderPanel({ onChange })

    await user.click(await screen.findByRole('button', { name: 'End delegation' }))

    await waitFor(() => expect(mockedRevoke).toHaveBeenCalledWith('d1'))
    expect(await form()).toBeInTheDocument()
    expect(onChange).toHaveBeenCalled()
  })

  it('says what the API refused rather than pretending it ended', async () => {
    const user = userEvent.setup({ delay: null })
    mockedRevoke.mockRejectedValue(new Error('That delegation has already been ended.'))
    renderPanel()

    await user.click(await screen.findByRole('button', { name: 'End delegation' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That delegation has already been ended.',
    )
  })
})

describe('when they are covering for somebody else', () => {
  /*
   * `POST /api/delegations` refuses onward delegation in both directions, and
   * this is the half that strands a memo: the colleague's steps stay addressed
   * to the person covering, so whoever took their approvals could neither sign
   * those steps nor know they were waiting.
   *
   * An administrator is the person who can undo it, which is why the panel
   * names whose cover it is rather than only refusing.
   */
  const covering = (overrides: Partial<Delegation> = {}) =>
    delegation({
      id: 'd-cover',
      delegatorId: SANA.id,
      delegateId: 'u1',
      endsAt: null,
      delegator: asDelegationPerson(SANA),
      delegate: asDelegationPerson(person()),
      ...overrides,
    })

  it('does not offer a form whose only outcome is a refusal', async () => {
    mockedFetch.mockResolvedValue({ given: [], held: [covering()] })
    renderPanel()

    expect(await screen.findByText('Covering for')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Out of office' })).not.toBeInTheDocument()
  })

  it('names whose cover it is, and where to end it', async () => {
    // Without the name an administrator has to open every row in the table to
    // find the arrangement the refusal is about.
    mockedFetch.mockResolvedValue({ given: [], held: [covering()] })
    renderPanel()

    expect(await screen.findByText('Sana Iqbal')).toBeInTheDocument()
    expect(
      screen.getByText(/End that cover from Sana’s own row first/)
    ).toBeInTheDocument()
  })

  it('counts cover that has not started yet, which a handover would still overlap', async () => {
    // A handover made here runs from now until somebody ends it, so it shares
    // days with cover beginning next year. Reading the server's `isActive`
    // would offer the form today and let the server refuse it.
    mockedFetch.mockResolvedValue({
      given: [],
      held: [covering({ startsAt: '2099-01-01T00:00:00.000Z', isActive: false })],
    })
    renderPanel()

    expect(await screen.findByText('Covering for')).toBeInTheDocument()
  })

  it('offers the form again once that cover has finished', async () => {
    mockedFetch.mockResolvedValue({
      given: [],
      held: [
        covering({
          startsAt: '2020-01-01T00:00:00.000Z',
          endsAt: '2020-01-08T00:00:00.000Z',
          isActive: false,
        }),
      ],
    })
    renderPanel()

    expect(await form()).toBeInTheDocument()
  })

  it('never leaves it on screen under the next person selected', async () => {
    /*
     * The panel is one person at a time, and the answer for Priya must not
     * still be on screen under Tom. A reply that arrives clears it by itself;
     * a reply that FAILS does not, and that is the frame this holds - the
     * panel would name Sana as somebody Tom is covering for, beside an error
     * saying it could not find out.
     */
    mockedFetch.mockResolvedValue({ given: [], held: [covering()] })
    const { rerender } = renderPanel()

    expect(await screen.findByText('Covering for')).toBeInTheDocument()

    mockedFetch.mockRejectedValue(new Error('Network is down'))
    rerender(<DelegationPanel person={TOM} colleagues={[person(), SANA]} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Network is down')
    expect(screen.queryByText('Covering for')).not.toBeInTheDocument()
  })
})

describe('what is waiting on them', () => {
  it('says how many approvals would move', async () => {
    const user = userEvent.setup({ delay: null })
    renderPanel({ selected: person({ openApprovals: 3 }) })
    await markAway(user)

    await user.selectOptions(screen.getByLabelText('Delegate approvals to'), TOM.id)

    expect(screen.getByText(/3 approvals on Priya's desk would move to Tom/)).toBeInTheDocument()
  })

  it('counts one approval in the singular', async () => {
    renderPanel({ selected: person({ openApprovals: 1 }) })
    await form()

    expect(screen.getByText(/1 approval on Priya's desk/)).toBeInTheDocument()
  })

  it('says nothing is waiting rather than showing a zero', async () => {
    renderPanel()
    await form()

    expect(
      screen.getByText('Nothing is waiting on Priya right now.'),
    ).toBeInTheDocument()
  })

  it('reports what the delegate can sign once it is in force', async () => {
    mockedFetch.mockResolvedValue({ given: [delegation()], held: [] })
    renderPanel({ selected: person({ openApprovals: 2 }) })

    expect(
      await screen.findByText(/2 approvals on Priya's desk can be signed by Tom/),
    ).toBeInTheDocument()
  })
})

describe('when the API cannot be reached', () => {
  it('says so instead of showing an empty form', async () => {
    mockedFetch.mockRejectedValue(new Error('Network request failed'))
    renderPanel()

    expect(await screen.findByRole('alert')).toHaveTextContent('Network request failed')
  })
})
