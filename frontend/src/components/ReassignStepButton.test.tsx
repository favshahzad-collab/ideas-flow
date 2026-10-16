import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reassignStep } from '../services/approvalApi'
import { fetchAssignableUsers } from '../services/usersApi'
import { renderWithProviders } from '../test/render'
import type { WorkflowStepView, WorkflowStepStatus } from '../types/documentDetail'
import ReassignStepButton from './ReassignStepButton'

/**
 * Moving a step to a different approver.
 *
 * Who may do it, onto whom, and who is told are all the server's, and are
 * held shut by the integration suite. What these hold is the part a person
 * touches: that the dialog cannot send an unexplained reassignment, that a
 * refusal arrives in the words the server chose, and that a name already on
 * the memo is visible-but-unavailable rather than quietly missing - somebody
 * who cannot find a colleague in the list assumes the search is broken.
 */

vi.mock('../services/approvalApi', () => ({
  reassignStep: vi.fn(),
}))

vi.mock('../services/usersApi', () => ({
  fetchAssignableUsers: vi.fn(),
}))

const move = vi.mocked(reassignStep)
const people = vi.mocked(fetchAssignableUsers)

const person = (id: string, firstName: string, lastName: string, department: string) => ({
  id,
  firstName,
  lastName,
  email: `${firstName.toLowerCase()}@example.com`,
  department: { name: department },
})

const PEOPLE = [
  person('u-omar', 'Omar', 'Haddad', 'Finance'),
  person('u-dania', 'Dania', 'Sheikh', 'Legal'),
]

const page = (users: typeof PEOPLE) => ({
  users,
  total: users.length,
  returned: users.length,
})

const onDone = vi.fn()

const step = (
  order: number,
  name: string,
  userId: string,
  status: WorkflowStepStatus,
): WorkflowStepView => ({
  id: `doc-1-step-${order}`,
  step: order,
  type: 'Reviewer',
  user: name,
  userId,
  initials: name.slice(0, 2).toUpperCase(),
  status,
})

/* The preparer's row, which the chain draws because a chain starting at step
   1 hides who sent the memo - and which has nothing on it to hand to anybody. */
const PREPARER_ROW: WorkflowStepView = {
  id: 'doc-1-preparer',
  step: 0,
  type: 'Preparer',
  user: 'Bilal Ahmed',
  userId: 'u-preparer',
  initials: 'BA',
  status: 'completed',
}

/** Three approvers, the memo sitting on the first. */
const CHAIN: WorkflowStepView[] = [
  PREPARER_ROW,
  step(1, 'Ayesha Khan', 'u-ayesha', 'current'),
  step(2, 'Dania Sheikh', 'u-dania', 'pending'),
  step(3, 'Kazim Zaidi', 'u-kazim', 'pending'),
]

/** The memo on its last step, so there is nothing ahead of it to choose. */
const LAST_STEP: WorkflowStepView[] = [
  PREPARER_ROW,
  step(1, 'Dania Sheikh', 'u-dania', 'completed'),
  step(2, 'Ayesha Khan', 'u-ayesha', 'current'),
]

const render = (steps: WorkflowStepView[] = CHAIN) =>
  renderWithProviders(
    <ReassignStepButton
      documentId="doc-1"
      preparerId="u-preparer"
      steps={steps}
      onDone={onDone}
    />,
  )

/**
 * The list of people, which is not the only listbox in this dialog: the step
 * picker's options carry role "option" too, and a name like /Dania Sheikh/
 * matches an approver on the chain as readily as a candidate to replace one.
 */
const candidates = () => screen.findByRole('listbox', { name: 'People' })

/** Open the dialog and pick somebody out of the list. */
const choose = async (user: ReturnType<typeof userEvent.setup>, name: RegExp) => {
  await user.click(screen.getByRole('button', { name: 'Reassign' }))
  await user.click(await screen.findByRole('button', { name: 'Hand this step to' }))
  await user.click(await within(await candidates()).findByRole('option', { name }))
}

/** The whole gesture: open, pick Omar, give a reason, send it. */
const moveTo = async (user: ReturnType<typeof userEvent.setup>, reason: string) => {
  await choose(user, /Omar Haddad/)
  await user.type(screen.getByLabelText('Why it is moving'), reason)
  await user.click(screen.getByRole('button', { name: 'Move the step' }))
}

const RESULT = {
  message: 'Step 1 moved to Omar Haddad, who has been asked to approve it.',
  currentStepOrder: 1,
  stepOrder: 1,
  movedFrom: { id: 'u-ayesha', firstName: 'Ayesha', lastName: 'Khan' },
  movedTo: { id: 'u-omar', firstName: 'Omar', lastName: 'Haddad' },
}

beforeEach(() => {
  vi.clearAllMocks()
  people.mockResolvedValue(page(PEOPLE))
})

describe('the dialog', () => {
  it('names who is holding it, when that is the only step it could move', async () => {
    const user = userEvent.setup()
    render(LAST_STEP)

    await user.click(screen.getByRole('button', { name: 'Reassign' }))

    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'It is with Ayesha Khan',
    )
  })

  it('asks which step when there are others still ahead of the memo', async () => {
    /*
     * A memo stops just as completely at an approver who has left and is
     * third in the chain. The difference is that this one can be seen
     * coming - and seeing it coming is worth nothing if the only cure is to
     * wait for the memo to arrive and get stuck.
     */
    const user = userEvent.setup()
    render()

    await user.click(screen.getByRole('button', { name: 'Reassign' }))

    const which = await screen.findByLabelText('Which step')
    expect(which).toHaveValue('1')
    expect(
      [...screen.getByLabelText('Which step').querySelectorAll('option')].map(
        option => option.textContent,
      ),
    ).toEqual([
      'Step 1 — Ayesha Khan (with them now)',
      'Step 2 — Dania Sheikh',
      'Step 3 — Kazim Zaidi',
    ])
  })

  it('offers every step of a memo back with its preparer, since the next cycle starts at step 1', async () => {
    // Sent back or rejected: steps that were decided last cycle are all ahead
    // of the next one, and one held by somebody who left must be movable.
    const user = userEvent.setup()
    renderWithProviders(
      <ReassignStepButton
        documentId="doc-1"
        preparerId="u-preparer"
        steps={[
          PREPARER_ROW,
          step(1, 'Ayesha Khan', 'u-ayesha', 'completed'),
          step(2, 'Dania Sheikh', 'u-dania', 'completed'),
        ]}
        onDone={onDone}
        betweenCycles
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Reassign' }))

    expect(
      [...(await screen.findByLabelText('Which step')).querySelectorAll('option')].map(
        option => option.textContent,
      ),
    ).toEqual(['Step 1 — Ayesha Khan', 'Step 2 — Dania Sheikh'])
    expect(screen.getByText(/will be asked when it is resubmitted/)).toBeInTheDocument()
  })

  it('never offers a step already decided, which carries a signature', async () => {
    // Rewriting whose name stands against a signed step would make the chain
    // disagree with the actions recorded on it. The server refuses it too.
    const user = userEvent.setup()
    render(LAST_STEP)

    await user.click(screen.getByRole('button', { name: 'Reassign' }))
    await screen.findByRole('dialog')

    expect(screen.queryByLabelText('Which step')).not.toBeInTheDocument()
  })

  it('says whether the memo has reached the step that is chosen', async () => {
    const user = userEvent.setup()
    render()

    await user.click(screen.getByRole('button', { name: 'Reassign' }))
    expect(
      await screen.findByText('The memo is waiting on this step now.'),
    ).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Which step'), '3')

    expect(
      screen.getByText('The memo has not reached this step yet.'),
    ).toBeInTheDocument()
  })

  it('says the approval is still required, so it is not mistaken for a skip', async () => {
    // The two controls sit next to each other in the header and do opposite
    // things: one asks somebody else for the signature, one does without it.
    const user = userEvent.setup()
    render()

    await user.click(screen.getByRole('button', { name: 'Reassign' }))

    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'The approval is still required',
    )
  })
})

describe('before it will send', () => {
  it('needs both a person and a reason', async () => {
    const user = userEvent.setup()
    render()
    await user.click(screen.getByRole('button', { name: 'Reassign' }))

    expect(await screen.findByRole('button', { name: 'Move the step' })).toBeDisabled()
  })

  it('still refuses on a person alone, because the reason is the record', async () => {
    const user = userEvent.setup()
    render()

    await choose(user, /Omar Haddad/)

    expect(screen.getByRole('button', { name: 'Move the step' })).toBeDisabled()
    expect(move).not.toHaveBeenCalled()
  })

  it('refuses a reason that is only spaces', async () => {
    const user = userEvent.setup()
    render()
    await choose(user, /Omar Haddad/)

    await user.type(screen.getByLabelText('Why it is moving'), '   ')

    expect(screen.getByRole('button', { name: 'Move the step' })).toBeDisabled()
  })
})

describe('when it goes', () => {
  it('sends the person picked and the reason given', async () => {
    const user = userEvent.setup()
    move.mockResolvedValue(RESULT)
    render()

    await moveTo(user, 'Ayesha has left.')

    await waitFor(() =>
      expect(move).toHaveBeenCalledWith('doc-1', 'u-omar', 'Ayesha has left.', 1),
    )
  })

  it('names the step even when it is the one the memo is sitting on', async () => {
    /*
     * Between this screen loading and the button being pressed an approver
     * may have signed, and the step that was current then is decided now.
     * Naming it has the server refuse - which is the right answer - instead
     * of moving whichever step happens to be current when the request lands.
     */
    const user = userEvent.setup()
    move.mockResolvedValue(RESULT)
    render()

    await user.click(screen.getByRole('button', { name: 'Reassign' }))
    await user.selectOptions(await screen.findByLabelText('Which step'), '3')
    await user.click(screen.getByRole('button', { name: 'Hand this step to' }))
    await user.click(await within(await candidates()).findByRole('option', { name: /Omar Haddad/ }))
    await user.type(screen.getByLabelText('Why it is moving'), 'Kazim retires.')
    await user.click(screen.getByRole('button', { name: 'Move the step' }))

    await waitFor(() =>
      expect(move).toHaveBeenCalledWith('doc-1', 'u-omar', 'Kazim retires.', 3),
    )
  })

  it('does not tell somebody a memo left them when it was never with them', async () => {
    const user = userEvent.setup()
    move.mockResolvedValue({
      ...RESULT,
      stepOrder: 3,
      message: 'Step 3 moved to Omar Haddad, who will be asked when the memo reaches them.',
    })
    render()

    await user.click(screen.getByRole('button', { name: 'Reassign' }))
    await user.selectOptions(await screen.findByLabelText('Which step'), '3')
    await user.click(screen.getByRole('button', { name: 'Hand this step to' }))
    await user.click(await within(await candidates()).findByRole('option', { name: /Omar Haddad/ }))
    await user.type(screen.getByLabelText('Why it is moving'), 'Kazim retires.')
    await user.click(screen.getByRole('button', { name: 'Move the step' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Kazim Zaidi has been told they are off this memo')
    expect(dialog).not.toHaveTextContent('no longer with them')
  })

  it('reports what happened in the dialog, and waits to be dismissed', async () => {
    /*
     * The reason the confirmation lives here rather than beside the button:
     * `onDone` puts the whole screen back into its loading state, which
     * unmounts this control and everything it was saying. A message shown
     * outside the dialog and reloaded a moment later is a message nobody can
     * read - which is exactly what the first version of this did on the real
     * page while passing a test that never reloaded anything.
     */
    const user = userEvent.setup()
    move.mockResolvedValue(RESULT)
    render()
    await moveTo(user, 'Ayesha has left.')

    expect(await screen.findByRole('status')).toHaveTextContent('moved to Omar Haddad')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('reloads the page only once the person has read it', async () => {
    const user = userEvent.setup()
    move.mockResolvedValue(RESULT)
    render()
    await moveTo(user, 'Ayesha has left.')
    await screen.findByRole('status')

    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(onDone).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('reloads it just the same when the dialog is dismissed another way', async () => {
    // Escape and the backdrop close it too, and the memo on screen is stale
    // either way. Leaving the reload on one button would have left the page
    // naming the old approver until something else happened to refresh it.
    const user = userEvent.setup()
    move.mockResolvedValue(RESULT)
    render()
    await moveTo(user, 'Ayesha has left.')
    await screen.findByRole('status')

    await user.keyboard('{Escape}')

    expect(onDone).toHaveBeenCalledOnce()
  })
})

describe('when it does not', () => {
  it('hands over the refusal the server wrote, which is the useful half', async () => {
    /*
     * "Dania already has a step on this memo. One person cannot hold two" is
     * the answer to the question the administrator is about to ask. A generic
     * "could not reassign" would replace an answer with a shrug.
     */
    const user = userEvent.setup()
    move.mockRejectedValue(
      new Error('Dania already has a step on this memo. One person cannot hold two.'),
    )
    render()

    await moveTo(user, 'Wrong person.')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'One person cannot hold two',
    )
  })

  it('keeps the dialog open with the reason still typed in it', async () => {
    // Closing it would throw away what they wrote in answer to a problem they
    // can fix by changing one field.
    const user = userEvent.setup()
    move.mockRejectedValue(new Error('Network is down'))
    render()

    await moveTo(user, 'Ayesha has left.')

    await screen.findByRole('alert')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('Why it is moving')).toHaveValue('Ayesha has left.')
    expect(onDone).not.toHaveBeenCalled()
  })
})

describe('who the picker offers', () => {
  it('shows somebody already on the memo, and will not let them be chosen twice', async () => {
    const user = userEvent.setup()
    render()

    await user.click(screen.getByRole('button', { name: 'Reassign' }))
    await user.click(await screen.findByRole('button', { name: 'Hand this step to' }))

    const dania = await within(await candidates()).findByRole('option', {
      name: /Dania Sheikh/,
    })
    expect(dania).toBeDisabled()
    expect(dania).toHaveTextContent('Already in this approval chain')
  })

  it('does not offer the preparer at all, who could never approve it', async () => {
    const user = userEvent.setup()
    people.mockResolvedValue(
      page([...PEOPLE, person('u-preparer', 'Bilal', 'Ahmed', 'HR')]),
    )
    render()

    await user.click(screen.getByRole('button', { name: 'Reassign' }))
    await user.click(await screen.findByRole('button', { name: 'Hand this step to' }))

    const peopleList = within(await candidates())
    await peopleList.findByRole('option', { name: /Omar Haddad/ })
    expect(peopleList.queryByRole('option', { name: /Bilal Ahmed/ })).not.toBeInTheDocument()
  })

  it('does not offer the administrator doing the moving, who could then sign it', async () => {
    const user = userEvent.setup()
    people.mockResolvedValue(
      page([...PEOPLE, person('u-admin', 'Sana', 'Malik', 'IT')]),
    )
    renderWithProviders(
      <ReassignStepButton
        documentId="doc-1"
        preparerId="u-preparer"
        steps={CHAIN}
        actingUserId="u-admin"
        onDone={onDone}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Reassign' }))
    await user.click(await screen.findByRole('button', { name: 'Hand this step to' }))

    const peopleList = within(await candidates())
    await peopleList.findByRole('option', { name: /Omar Haddad/ })
    // Everybody the list was handed, less the one person moving the step.
    expect(peopleList.getAllByRole('option')).toHaveLength(PEOPLE.length)
    expect(peopleList.queryByRole('option', { name: /Sana Malik/ })).not.toBeInTheDocument()
  })
})
