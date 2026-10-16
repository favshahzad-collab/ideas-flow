import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setUserActive } from '../../services/AdminApi'
import { fetchDelegations } from '../../services/delegationApi'
import { fetchMemosHeldBy } from '../../services/holdsApi'
import type { HeldMemo, MemosHeld } from '../../types/holds'
import type { User } from '../../types/admin'
import SwitchAccountDialog from './SwitchAccountDialog'

/**
 * Switching somebody's account off when they leave.
 *
 * The decision is irreversible in one direction that matters: the person
 * stops being able to sign in, every session they hold ends, and the memos
 * waiting on them stop where they are. That last part is the one an
 * administrator does not think of, so the dialog's job is to say it before
 * the button rather than leave it to be discovered on the Control room a
 * fortnight later.
 */

vi.mock('../../services/AdminApi', () => ({ setUserActive: vi.fn() }))
vi.mock('../../services/holdsApi', () => ({ fetchMemosHeldBy: vi.fn() }))
vi.mock('../../services/delegationApi', () => ({ fetchDelegations: vi.fn() }))
// The picker searches the directory; what matters here is what is chosen.
vi.mock('../submit/ApproverCombobox', () => ({
  default: ({
    id,
    selected,
    onChange,
  }: {
    id: string
    selected: { firstName: string } | null
    onChange: (user: unknown) => void
  }) => (
    <div>
      <input id={id} readOnly value={selected?.firstName ?? ''} />
      <button
        type="button"
        onClick={() =>
          onChange({
            id: 'u-nadia',
            email: 'nadia@example.com',
            firstName: 'Nadia',
            lastName: 'Butt',
            department: null,
          })
        }
      >
        Pick Nadia
      </button>
    </div>
  ),
}))

const save = vi.mocked(setUserActive)
const holds = vi.mocked(fetchMemosHeldBy)
const delegations = vi.mocked(fetchDelegations)

const PERSON: User = {
  id: 'u-kazim',
  email: 'kazim@example.com',
  firstName: 'Kazim',
  lastName: 'Zaidi',
  designation: null,
  loginRole: 'USER',
  department: { id: 'dep-1', name: 'Finance' },
  openApprovals: 0,
  deactivatedAt: null,
  coveredBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const memo = (overrides: Partial<HeldMemo> = {}): HeldMemo => ({
  documentId: 'doc-1',
  referenceNumber: 'MEMO-2026-0001',
  title: 'Warehouse lease extension',
  submittedAt: '2026-09-01T00:00:00.000Z',
  preparer: { id: 'u-sadia', firstName: 'Sadia', lastName: 'Rehman' },
  stepOrder: 1,
  approvalType: 'REVIEWER',
  totalSteps: 3,
  heldSince: '2026-09-01T00:00:00.000Z',
  dueAt: null,
  stepsAway: 0,
  ...overrides,
})

const nothing: MemosHeld = {
  person: {
    id: PERSON.id,
    firstName: 'Kazim',
    lastName: 'Zaidi',
    email: 'kazim@example.com',
    department: 'Finance',
  },
  holdingNow: [],
  ahead: [],
  returned: [],
  comingBack: [],
  total: 0,
}

const onClose = vi.fn()
const onDone = vi.fn()

const dialog = (active = false, person: User | null = PERSON) =>
  render(
    <SwitchAccountDialog
      person={person}
      active={active}
      onClose={onClose}
      onDone={onDone}
    />,
  )

beforeEach(() => {
  vi.clearAllMocks()
  holds.mockResolvedValue(nothing)
  delegations.mockResolvedValue({ given: [], held: [] })
  save.mockResolvedValue({
    id: PERSON.id,
    deactivatedAt: '2026-09-15T00:00:00.000Z',
    message: "Kazim's account is switched off and every session they held has ended.",
  })
})

describe('before anybody is picked', () => {
  it('draws nothing', () => {
    const { container } = dialog(false, null)

    expect(container).toBeEmptyDOMElement()
    expect(holds).not.toHaveBeenCalled()
  })
})

describe('what it says will happen', () => {
  it('names the two things that change: sign-in, and the open sessions', async () => {
    dialog()

    const body = await screen.findByRole('dialog')
    expect(body).toHaveTextContent('will not be able to sign in')
    expect(body).toHaveTextContent('every session they hold ends now')
  })

  it('says nothing they have already signed changes', async () => {
    // The fear this answers. An administrator who thinks switching an account
    // off might unpick approvals will not do it, and the leaver keeps a
    // working password instead.
    dialog()

    expect(
      await screen.findByText(/Nothing they have already signed changes/),
    ).toBeInTheDocument()
  })
})

describe('what stops because of it', () => {
  it('counts the memos waiting on them, and asks who takes them over', async () => {
    /*
     * Agreed after the fit-gap review: a leaver must not leave memos blocked.
     * Their steps go to a successor in the same act, so the dialog asks for
     * one and will not switch the account off without it.
     */
    holds.mockResolvedValue({
      ...nothing,
      holdingNow: [memo()],
      ahead: [memo({ documentId: 'doc-2', stepOrder: 3, stepsAway: 2 })],
      total: 2,
    })
    dialog()

    expect(await screen.findByText(/2 memos/)).toBeInTheDocument()
    expect(screen.getByLabelText('Who takes over their approvals')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Switch it off' })).toBeDisabled()
  })

  it('counts one memo in the singular', async () => {
    holds.mockResolvedValue({ ...nothing, holdingNow: [memo()], total: 1 })
    dialog()

    expect(await screen.findByText(/1 memo/)).toBeInTheDocument()
  })

  it('says plainly when nothing stops, rather than staying silent', async () => {
    // "Nothing is waiting on them" is the finding that makes this safe. A
    // dialog that showed the count only when it was bad would leave an
    // administrator guessing whether it had looked at all.
    dialog()

    expect(
      await screen.findByText(/Nothing is waiting on them/),
    ).toBeInTheDocument()
  })

  it('separates the memos sent back, which cannot be reassigned at all', async () => {
    holds.mockResolvedValue({
      ...nothing,
      returned: [memo({ stepOrder: null, totalSteps: null })],
      total: 1,
    })
    dialog()

    expect(
      await screen.findByText(/sent back to them for revision/),
    ).toBeInTheDocument()
    expect(screen.getByText(/cannot be reassigned at all/)).toBeInTheDocument()
  })

  it('names the memos out for correction that will come back to them', async () => {
    /*
     * The case that used to make this dialog say "Nothing is waiting on them"
     * and mean it. A memo sent back for revision is not in flight, so nobody's
     * step on it was counted - and a resubmission restarts the chain at step
     * one, past every approver named on it. So the account was switched off on
     * a clean bill of health, and the memo stopped dead the day it came back.
     *
     * Kept out of the headline number, which is about steps that can be moved
     * today: `reassignStep` refuses a memo that is not in flight.
     */
    holds.mockResolvedValue({
      ...nothing,
      comingBack: [memo({ stepOrder: 2, stepsAway: 1, heldSince: null })],
      total: 1,
    })
    dialog()

    expect(
      await screen.findByText(/1 memo is out\s+for correction/),
    ).toBeInTheDocument()
    // Their step on it moves too, so the next cycle goes to the successor.
    expect(screen.getByLabelText('Who takes over their approvals')).toBeInTheDocument()
    expect(screen.queryByText(/Nothing is waiting on them/)).not.toBeInTheDocument()
  })

  it('does not block the action when the count cannot be read', async () => {
    /*
     * A failed count is not a reason to leave a leaver's password working.
     * It says it could not check and still offers the button - the opposite
     * trade-off from the panel on the page behind it, where reading "nothing"
     * from a failure would be the dangerous answer.
     */
    holds.mockRejectedValue(new Error('Network is down'))
    dialog()

    expect(await screen.findByText(/Could not check what is waiting/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Switch it off' })).toBeEnabled()
  })

  it('asks nothing at all when the account is going back on', async () => {
    // Switching an account back on takes nothing away from anybody.
    dialog(true)

    await screen.findByText(/will be able to sign in again/)
    expect(holds).not.toHaveBeenCalled()
  })
})

describe('doing it', () => {
  it('sends the setting the button offered', async () => {
    const user = userEvent.setup()
    dialog()

    await user.click(await screen.findByRole('button', { name: 'Switch it off' }))

    await waitFor(() => expect(save).toHaveBeenCalledWith('u-kazim', false, undefined))
  })

  it('sends the other way round when switching back on', async () => {
    const user = userEvent.setup()
    dialog(true)

    await user.click(await screen.findByRole('button', { name: 'Switch it back on' }))

    await waitFor(() => expect(save).toHaveBeenCalledWith('u-kazim', true, undefined))
  })

  it('reports what happened, and reloads only once it has been read', async () => {
    /*
     * The same rule as every other confirmation here: the reload puts the
     * screen back into its loading state, which destroys the message. So the
     * dialog says what happened, and the page catches up when it is
     * dismissed.
     */
    const user = userEvent.setup()
    dialog()

    await user.click(await screen.findByRole('button', { name: 'Switch it off' }))

    expect(await screen.findByRole('status')).toHaveTextContent('switched off')
    expect(onDone).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('hands over the refusal the server wrote', async () => {
    // "Cannot switch off the last administrator" is the answer to the question
    // the person is about to ask. "Could not change the account" is a shrug.
    const user = userEvent.setup()
    save.mockRejectedValue(
      new Error('Cannot switch off the last administrator. Give somebody else the role first.'),
    )
    dialog()

    await user.click(await screen.findByRole('button', { name: 'Switch it off' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cannot switch off the last administrator',
    )
    expect(onDone).not.toHaveBeenCalled()
  })
})

describe('the successor', () => {
  const waitingOnThem: MemosHeld = { ...nothing, holdingNow: [memo()], total: 1 }

  it('sends the person chosen to take over', async () => {
    const user = userEvent.setup()
    holds.mockResolvedValue(waitingOnThem)
    dialog()

    await user.click(await screen.findByRole('button', { name: 'Pick Nadia' }))
    await user.click(screen.getByRole('button', { name: 'Switch it off' }))

    await waitFor(() => expect(save).toHaveBeenCalledWith('u-kazim', false, 'u-nadia'))
  })

  it('suggests whoever is covering for them now', async () => {
    const user = userEvent.setup()
    holds.mockResolvedValue(waitingOnThem)
    delegations.mockResolvedValue({
      given: [
        {
          id: 'del-1',
          delegatorId: 'u-kazim',
          delegateId: 'u-omar',
          startsAt: '2026-09-01T00:00:00.000Z',
          endsAt: null,
          reason: null,
          revokedAt: null,
          createdAt: '2026-09-01T00:00:00.000Z',
          delegator: { id: 'u-kazim', firstName: 'Kazim', lastName: 'Zaidi', designation: null, email: 'kazim@example.com' },
          delegate: { id: 'u-omar', firstName: 'Omar', lastName: 'Sheikh', designation: null, email: 'omar@example.com' },
          isActive: true,
        },
      ],
      held: [],
    } as never)
    dialog()

    expect(await screen.findByText(/Omar is covering for them now/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Switch it off' }))

    await waitFor(() => expect(save).toHaveBeenCalledWith('u-kazim', false, 'u-omar'))
  })

  it('is not asked for when nothing is waiting on them', async () => {
    dialog()

    await screen.findByText(/Nothing is waiting on them/)
    expect(screen.queryByLabelText('Who takes over their approvals')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Switch it off' })).toBeEnabled()
  })
})
