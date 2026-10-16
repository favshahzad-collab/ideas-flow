import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchMemosHeldBy } from '../../services/holdsApi'
import type { HeldMemo, MemosHeld } from '../../types/holds'
import type { User } from '../../types/admin'
import HoldsPanel from './HoldsPanel'

/**
 * What stops if this person does.
 *
 * The answer is only useful if the four groups stay apart. "With them now" is
 * already stopped; "coming to them" is the warning that makes asking in
 * advance worth anything; "sent back to them" cannot be cured by moving an
 * approver at all, because only a preparer may correct a memo; "coming back to
 * them" cannot be moved yet either, because the server refuses to reassign a
 * step on a memo that is not in flight. A panel that merged them into one
 * count would be telling an administrator to do the same thing about four
 * different problems.
 */

vi.mock('../../services/holdsApi', () => ({
  fetchMemosHeldBy: vi.fn(),
}))

const read = vi.mocked(fetchMemosHeldBy)

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

const answer = (overrides: Partial<MemosHeld> = {}): MemosHeld => ({
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
  ...overrides,
})

const panel = (person: User | null = PERSON) => render(<HoldsPanel person={person} />)

beforeEach(() => {
  vi.clearAllMocks()
  read.mockResolvedValue(answer())
})

describe('before anybody is picked', () => {
  it('draws nothing, rather than an empty card about nobody', () => {
    const { container } = panel(null)

    expect(container).toBeEmptyDOMElement()
    expect(read).not.toHaveBeenCalled()
  })
})

describe('the four ways a memo stops', () => {
  it('separates the one that has stopped from the one that will', async () => {
    /*
     * The distinction the whole feature rests on. Merged into one list, the
     * memo three steps away reads as a fire to put out today, and the one
     * that is genuinely stopped gets no more urgency than it.
     */
    read.mockResolvedValue(
      answer({
        holdingNow: [memo({ title: 'Stopped today' })],
        ahead: [
          memo({
            documentId: 'doc-2',
            title: 'Coming on Thursday',
            stepOrder: 3,
            stepsAway: 2,
            heldSince: null,
          }),
        ],
        total: 2,
      }),
    )
    panel()

    expect(await screen.findByText(/With them now \(1\)/)).toBeInTheDocument()
    expect(screen.getByText(/Coming to them \(1\)/)).toBeInTheDocument()
    expect(screen.getByText('Stopped today')).toBeInTheDocument()
    expect(screen.getByText('Coming on Thursday')).toBeInTheDocument()
  })

  it('says how far off the one that has not arrived is', async () => {
    // "Look at this today" and "before month end" are different instructions.
    read.mockResolvedValue(
      answer({
        ahead: [memo({ stepOrder: 3, stepsAway: 2, heldSince: null })],
        total: 1,
      }),
    )
    panel()

    expect(await screen.findByText(/2 approvals away/)).toBeInTheDocument()
  })

  it('counts one approval away in the singular', async () => {
    read.mockResolvedValue(
      answer({
        ahead: [memo({ stepOrder: 2, stepsAway: 1, heldSince: null })],
        total: 1,
      }),
    )
    panel()

    expect(await screen.findByText(/1 approval away/)).toBeInTheDocument()
  })

  it('does not read somebody their own name as the person waiting', async () => {
    // Every memo sent back waits on its own preparer, so the panel would end
    // each of those lines with the name at the top of the card.
    read.mockResolvedValue(
      answer({
        returned: [
          memo({
            stepOrder: null,
            totalSteps: null,
            preparer: { id: 'u-kazim', firstName: 'Kazim', lastName: 'Zaidi' },
          }),
        ],
        total: 1,
      }),
    )
    panel()

    await screen.findByText(/Sent back to them/)
    expect(screen.queryByText(/· Kazim Zaidi/)).not.toBeInTheDocument()
  })

  it('names who is waiting when it is somebody else', async () => {
    read.mockResolvedValue(answer({ holdingNow: [memo()], total: 1 }))
    panel()

    expect(await screen.findByText(/Sadia Rehman/)).toBeInTheDocument()
  })

  it('says a memo sent back cannot be fixed by moving an approver', async () => {
    /*
     * Only the preparer may correct a memo - `updateDocument` refuses anybody
     * else in so many words - so reassignment does nothing for this group. A
     * panel that did not say so would have an administrator reassigning
     * approvers on a memo that is not waiting on any of them.
     */
    read.mockResolvedValue(
      answer({
        returned: [memo({ stepOrder: null, totalSteps: null, stepsAway: 0 })],
        total: 1,
      }),
    )
    panel()

    expect(await screen.findByText(/Sent back to them \(1\)/)).toBeInTheDocument()
    expect(
      screen.getByText(/reassigning an approver does not help here/),
    ).toBeInTheDocument()
  })

  it('lists the memo out for correction that will come back past their step', async () => {
    /*
     * The fourth way, and the one that was missing entirely. A memo sent back
     * for revision is not in flight, so nobody's step on it counted - and a
     * resubmission starts the chain again at step one, so it reaches every
     * approver named on it a second time, including whoever sent it back.
     *
     * It says when rather than how far, because neither of the other two
     * numbers is true of it: nothing is counting down against the step, and
     * nobody is waiting on this person for it yet.
     */
    read.mockResolvedValue(
      answer({
        comingBack: [
          memo({ title: 'Out for correction', stepOrder: 2, stepsAway: 1, heldSince: null }),
        ],
        total: 1,
      }),
    )
    panel()

    expect(await screen.findByText(/Coming back to them \(1\)/)).toBeInTheDocument()
    expect(screen.getByText('Out for correction')).toBeInTheDocument()
    expect(screen.getByText(/Step 2 of 3 · when it is resubmitted/)).toBeInTheDocument()
  })

  it('says this group cannot be moved yet, because the server refuses it', async () => {
    // `reassignStep` refuses a memo that is not PENDING_REVIEW. A hint that
    // read "move these before the memo arrives", as the group above it does,
    // would send an administrator at a button that answers with a refusal.
    read.mockResolvedValue(answer({ comingBack: [memo({ stepOrder: 2 })], total: 1 }))
    panel()

    expect(
      await screen.findByText(/cannot be moved until the preparer sends it back in/),
    ).toBeInTheDocument()
  })

  it('leaves out a group with nothing in it, rather than showing a zero', async () => {
    read.mockResolvedValue(answer({ holdingNow: [memo()], total: 1 }))
    panel()

    expect(await screen.findByText(/With them now/)).toBeInTheDocument()
    expect(screen.queryByText(/Coming to them/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Sent back to them/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Coming back to them/)).not.toBeInTheDocument()
  })
})

describe('when nothing waits on them', () => {
  it('says so in words, which is the answer somebody came for', async () => {
    // An empty card would read as "did not load". This is a finding, and the
    // finding is what makes it safe to switch the account off.
    panel()

    expect(
      await screen.findByText(/Nothing is waiting on Kazim/),
    ).toBeInTheDocument()
  })
})

describe('one person at a time', () => {
  it('never shows one person answer under the next person name', async () => {
    /*
     * The most misleading state this panel can be in, and it lives in the
     * frame BETWEEN the name changing and the new answer arriving. A reply
     * that lands overwrites the old answer by itself, so a test that waits
     * for one proves nothing: the window to catch is while the next request
     * is still in the air, which is exactly the window a person sees.
     */
    read.mockResolvedValue(answer({ holdingNow: [memo()], total: 1 }))
    const { rerender } = panel()

    expect(await screen.findByText(/With them now/)).toBeInTheDocument()

    read.mockReturnValue(new Promise(() => {}))
    rerender(<HoldsPanel person={{ ...PERSON, id: 'u-other', firstName: 'Dania' }} />)

    expect(await screen.findByText(/Reading what is waiting on Dania/)).toBeInTheDocument()
    expect(screen.queryByText(/With them now/)).not.toBeInTheDocument()
  })

  it('and not once the next answer has failed either', async () => {
    read.mockResolvedValue(answer({ holdingNow: [memo()], total: 1 }))
    const { rerender } = panel()

    expect(await screen.findByText(/With them now/)).toBeInTheDocument()

    read.mockRejectedValue(new Error('Network is down'))
    rerender(<HoldsPanel person={{ ...PERSON, id: 'u-other', firstName: 'Dania' }} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Network is down')
    expect(screen.queryByText(/With them now/)).not.toBeInTheDocument()
  })

  it('asks again about the person now selected', async () => {
    panel()
    await waitFor(() => expect(read).toHaveBeenCalledWith('u-kazim'))
  })
})

describe('when the answer cannot be read', () => {
  it('says so and offers to try again, rather than reading as "nothing"', async () => {
    /*
     * The dangerous wrong answer. "Nothing is waiting on them" is what an
     * administrator acts on when switching an account off; a failed request
     * that rendered as an empty panel would say exactly that, wrongly.
     */
    const user = userEvent.setup()
    read.mockRejectedValueOnce(new Error('Network is down'))
    panel()

    expect(await screen.findByRole('alert')).toHaveTextContent('Network is down')
    expect(screen.queryByText(/Nothing is waiting/)).not.toBeInTheDocument()

    read.mockResolvedValue(answer())
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText(/Nothing is waiting on Kazim/)).toBeInTheDocument()
  })
})
