import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAssignableUsers } from '../../services/usersApi'
import type { AssignableUser } from '../../types/submitDocument'
import type { ApprovalStepForm } from '../../utils/submitDocument'
import ApprovalChainBuilder from './ApprovalChainBuilder'

/**
 * Where a preparer builds the route their document will take. The order of
 * these rows is the order the document is handed round, so the two ways this
 * screen can hurt someone are both about agreement: the numbers on screen
 * disagreeing with the array that gets submitted, and a row appearing to
 * belong to somebody it does not.
 *
 * Reordering and removal are asked for here and performed by the parent, so
 * the tests below assert what the builder *asks for* (which row, by id, in
 * which direction) and then re-render with the answer, which is exactly how
 * the real screen behaves.
 *
 * The approver picker inside each row talks to the directory, so that service
 * is mocked - the duplicate and preparer rules are then exercised through the
 * real picker rather than through a stub that could agree with anything.
 */

vi.mock('../../services/usersApi', () => ({
  fetchAssignableUsers: vi.fn(),
}))

const search = vi.mocked(fetchAssignableUsers)

const person = (
  id: string,
  firstName: string,
  lastName: string,
  department: string | null,
): AssignableUser => ({
  id,
  email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
  firstName,
  lastName,
  department: department ? { name: department } : null,
})

const FATIMA = person('u-fatima', 'Fatima', 'Sheikh', 'Finance')
const BILAL = person('u-bilal', 'Bilal', 'Ahmed', 'Finance')
const CHANDNI = person('u-chandni', 'Chandni', 'Rao', null)

const DIRECTORY = new Map([FATIMA, BILAL, CHANDNI].map(user => [user.id, user]))

const step = (
  id: string,
  userId: string,
  approvalType: ApprovalStepForm['approvalType'] = 'REVIEWER',
): ApprovalStepForm => ({ id, userId, approvalType })

type Props = ComponentProps<typeof ApprovalChainBuilder>

/** A two-step chain that already validates, so a test overrides one thing. */
function renderBuilder(overrides: Partial<Props> = {}) {
  const handlers = {
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    onMove: vi.fn(),
    onReorder: vi.fn(),
    onUpdate: vi.fn(),
    onReuse: vi.fn(),
    onUserResolved: vi.fn(),
  }

  const props: Props = {
    steps: [step('s1', FATIMA.id), step('s2', BILAL.id, 'FINAL_APPROVER')],
    usersById: DIRECTORY,
    stepErrors: {},
    excludeIds: new Set<string>(),
    reusable: null,
    ...handlers,
    ...overrides,
  }

  const result = render(<ApprovalChainBuilder {...props} />)

  return {
    ...result,
    ...handlers,
    /** Re-render as the parent would after acting on one of the callbacks. */
    update: (next: Partial<Props>) =>
      result.rerender(<ApprovalChainBuilder {...props} {...next} />),
  }
}

const rows = () => screen.getAllByRole('listitem')
const approverFor = (index: number) =>
  screen.getByRole('button', { name: `Approver for step ${index}` })
const gripFor = (index: number) =>
  screen.getByRole('button', { name: new RegExp(`^Reorder step ${index}`) })

beforeEach(() => {
  search.mockResolvedValue({ users: [FATIMA, BILAL], total: 2, returned: 2 })
})

describe('ApprovalChainBuilder, what the chain says', () => {
  it('gives the chain a heading the form can send focus to', () => {
    // The heading is invisible, and existing is not what it is for: when a
    // step is wrong but no one row is to blame, `SubmitDocument.openSignStep`
    // looks up `approval-chain-heading` by id and focuses it. Both halves
    // have to hold - the id it looks up, and a tabindex that lets a heading
    // take focus at all - or validation reports a problem and sends the
    // preparer nowhere.
    renderBuilder()

    const heading = screen.getByRole('heading', { name: 'Approval steps' })
    expect(heading).toHaveAttribute('id', 'approval-chain-heading')

    heading.focus()
    expect(heading).toHaveFocus()
  })

  it('draws the chain as an ordered list, because the order is the meaning', () => {
    renderBuilder()

    // A bulleted list would say these people are a set. They are a sequence.
    expect(screen.getByRole('list').tagName).toBe('OL')
  })

  it('numbers each row and names the person that row routes to', () => {
    renderBuilder({
      steps: [
        step('s1', FATIMA.id),
        step('s2', CHANDNI.id, 'APPROVER'),
        step('s3', BILAL.id, 'FINAL_APPROVER'),
      ],
    })

    const [first, second, third] = rows()
    expect(within(first).getByRole('button', { name: 'Approver for step 1' })).toHaveTextContent(
      'Fatima Sheikh',
    )
    expect(within(second).getByRole('button', { name: 'Approver for step 2' })).toHaveTextContent(
      'Chandni Rao',
    )
    expect(within(third).getByRole('button', { name: 'Approver for step 3' })).toHaveTextContent(
      'Bilal Ahmed',
    )
  })

  it('shows the order it was handed, so the screen matches what would be submitted', () => {
    // The submitted payload is the array, in array order. If the rows were
    // sorted or grouped for display, the preparer would be signing off on a
    // route they never saw.
    const { update } = renderBuilder()

    expect(approverFor(1)).toHaveTextContent('Fatima Sheikh')

    update({ steps: [step('s2', BILAL.id, 'FINAL_APPROVER'), step('s1', FATIMA.id)] })

    expect(approverFor(1)).toHaveTextContent('Bilal Ahmed')
    expect(approverFor(2)).toHaveTextContent('Fatima Sheikh')
  })

  it('says what a role does while the step is still empty', () => {
    // "Final Approver" is a label; what it *does* - close the workflow - is
    // the thing a preparer has to know before they pick it.
    renderBuilder({ steps: [step('s1', '', 'FINAL_APPROVER')] })

    // The badge, not the <option> of the same name inside the type picker.
    expect(screen.getByText('Final Approver', { selector: 'span' })).toBeInTheDocument()
    expect(
      screen.getByText('Closes the workflow. Their approval marks the document Approved.'),
    ).toBeInTheDocument()
  })

  it('identifies the assignee by department and email, not by name alone', () => {
    // Two people with the same name is the ordinary case in a directory of
    // any size; the email is what settles which one is on the chain.
    renderBuilder({ steps: [step('s1', FATIMA.id)] })

    expect(screen.getByText('Finance · fatima.sheikh@example.com')).toBeInTheDocument()
    // And the generic blurb it replaces is gone. The line under a filled row
    // has one job - saying which Fatima Sheikh this is - and a row that
    // showed both would bury it under a definition of "Reviewer".
    expect(screen.queryByText(/Notified to review/)).not.toBeInTheDocument()
  })

  it('falls back to the email when the person has no department', () => {
    renderBuilder({ steps: [step('s1', CHANDNI.id)] })

    expect(screen.getByText('chandni.rao@example.com')).toBeInTheDocument()
  })
})

describe('ApprovalChainBuilder, reordering', () => {
  it('asks for a move down when the grip is given an arrow key, and shows the result', async () => {
    // Drag is unusable by keyboard, on a screen reader, and with a tremor.
    // The arrow keys on the handle are the whole of the alternative.
    const user = userEvent.setup({ delay: null })
    const { onMove, update } = renderBuilder()

    gripFor(1).focus()
    await user.keyboard('{ArrowDown}')

    expect(onMove).toHaveBeenCalledTimes(1)
    expect(onMove).toHaveBeenCalledWith(0, 1)

    // Asking is only half of it. When the parent hands the moved array back,
    // the rows have to renumber and the grips have to re-label, or the next
    // ArrowDown is aimed at a row that says 1 and moves the person now at 2.
    update({ steps: [step('s2', BILAL.id, 'FINAL_APPROVER'), step('s1', FATIMA.id)] })

    expect(approverFor(1)).toHaveTextContent('Bilal Ahmed')
    expect(gripFor(2)).toHaveAccessibleName(
      'Reorder step 2, Fatima Sheikh. Use the up and down arrow keys.',
    )
  })

  it('asks for a move up from the row below', async () => {
    const user = userEvent.setup({ delay: null })
    const { onMove } = renderBuilder()

    gripFor(2).focus()
    await user.keyboard('{ArrowUp}')

    expect(onMove).toHaveBeenCalledTimes(1)
    expect(onMove).toHaveBeenCalledWith(1, -1)
  })

  it('lands a dragged row on the gap it was dropped over', () => {
    // Drag is the way most people will actually reorder this, and it is the
    // only path that reports an arbitrary destination rather than one step.
    // Nothing else in this file exercises `onReorder` at all.
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: vi.fn(),
      getData: vi.fn(),
    }
    const { onReorder, onMove } = renderBuilder({
      steps: [
        step('s1', FATIMA.id),
        step('s2', CHANDNI.id, 'APPROVER'),
        step('s3', BILAL.id, 'FINAL_APPROVER'),
      ],
    })

    const [first, , third] = rows()
    fireEvent.dragStart(gripFor(1), { dataTransfer })
    fireEvent.dragOver(third, { dataTransfer })
    fireEvent.drop(third, { dataTransfer })

    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(onReorder).toHaveBeenCalledWith(0, 2)
    // A drop is a destination, not a nudge; reporting it as both would move
    // the row twice once the parent applied each.
    expect(onMove).not.toHaveBeenCalled()
    expect(first).toBeInTheDocument()
  })

  it('reorders nothing when a row is dropped back where it started', () => {
    // Picking a row up and changing your mind is the commonest drag there is.
    // Reporting it as a move would push a "you have unsaved changes" guard up
    // at somebody who changed nothing.
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: vi.fn(),
      getData: vi.fn(),
    }
    const { onReorder } = renderBuilder()

    const [first] = rows()
    fireEvent.dragStart(gripFor(1), { dataTransfer })
    fireEvent.dragOver(first, { dataTransfer })
    fireEvent.drop(first, { dataTransfer })

    expect(onReorder).not.toHaveBeenCalled()
  })

  it('will not walk the first step off the top or the last off the bottom', async () => {
    // An out-of-range move would either be dropped silently by the parent or
    // reorder the wrong pair. Either way the chain stops matching the screen.
    const user = userEvent.setup({ delay: null })
    const { onMove } = renderBuilder()

    gripFor(1).focus()
    await user.keyboard('{ArrowUp}')
    gripFor(2).focus()
    await user.keyboard('{ArrowDown}')

    expect(onMove).not.toHaveBeenCalled()
  })

  it('names the row each grip moves, and says which keys move it', () => {
    renderBuilder()

    // "Reorder" on its own, five times over, tells a screen-reader user
    // nothing about which row they are about to move.
    expect(gripFor(2)).toHaveAccessibleName(
      'Reorder step 2, Bilal Ahmed. Use the up and down arrow keys.',
    )
  })

  it('disables the grip when there is only one step to reorder', () => {
    // Genuinely disabled, not just faded: a grip that looked live and did
    // nothing would read as a broken control.
    renderBuilder({ steps: [step('s1', FATIMA.id, 'FINAL_APPROVER')] })

    expect(gripFor(1)).toBeDisabled()
  })
})

describe('ApprovalChainBuilder, adding and removing', () => {
  it('removes the row that was clicked, by identity rather than by position', async () => {
    // Passing an index here is how the wrong approver gets dropped from a
    // chain that was reordered a moment earlier.
    const user = userEvent.setup({ delay: null })
    const { onRemove } = renderBuilder({
      steps: [
        step('s1', FATIMA.id),
        step('s2', CHANDNI.id, 'APPROVER'),
        step('s3', BILAL.id, 'FINAL_APPROVER'),
      ],
    })

    await user.click(screen.getByRole('button', { name: 'Remove step 2' }))

    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledWith('s2')
  })

  it('renumbers the rows that are left after a removal', () => {
    const { update } = renderBuilder({
      steps: [
        step('s1', FATIMA.id),
        step('s2', CHANDNI.id, 'APPROVER'),
        step('s3', BILAL.id, 'FINAL_APPROVER'),
      ],
    })

    update({ steps: [step('s1', FATIMA.id), step('s3', BILAL.id, 'FINAL_APPROVER')] })

    // Bilal was step 3 and is now step 2. A stale number would have the
    // preparer read a three-step chain that no longer exists.
    expect(rows()).toHaveLength(2)
    expect(approverFor(2)).toHaveTextContent('Bilal Ahmed')
    expect(screen.queryByRole('button', { name: 'Remove step 3' })).not.toBeInTheDocument()
    expect(gripFor(2)).toHaveAccessibleName(
      'Reorder step 2, Bilal Ahmed. Use the up and down arrow keys.',
    )
  })

  it('offers no way to delete the only step, so the chain can never be emptied', () => {
    // A document with no approval chain cannot be submitted at all; removing
    // the last row would leave the form in a state it cannot leave.
    renderBuilder({ steps: [step('s1', FATIMA.id, 'FINAL_APPROVER')] })

    expect(screen.queryByRole('button', { name: /^Remove step/ })).not.toBeInTheDocument()
  })

  it('asks the parent for another step, and draws it as an empty row', async () => {
    const user = userEvent.setup({ delay: null })
    const { onAdd, onUpdate, update } = renderBuilder()

    await user.click(screen.getByRole('button', { name: 'Add step' }))

    expect(onAdd).toHaveBeenCalledTimes(1)
    // Asking is all it may do. A button that also wrote a userId would put
    // somebody on the chain the preparer never chose.
    expect(onUpdate).not.toHaveBeenCalled()

    update({
      steps: [
        step('s1', FATIMA.id),
        step('s2', BILAL.id, 'FINAL_APPROVER'),
        step('s3', ''),
      ],
    })

    // The new row has to read as empty and be labelled step 3, or it is
    // invisible to the keyboard and indistinguishable from a filled one.
    expect(rows()).toHaveLength(3)
    expect(approverFor(3)).toHaveTextContent('Search for a person')
    expect(screen.getByLabelText('Approval type for step 3')).toHaveValue('REVIEWER')
  })

  it('still offers a way forward when the chain is empty', () => {
    // An empty chain with no visible next move is a dead end.
    renderBuilder({ steps: [] })

    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Add step' })).toBeInTheDocument()
  })
})

describe('ApprovalChainBuilder, the rules it has to enforce', () => {
  it('reports a step problem as an alert and points the control at it', () => {
    // Colour on the border says nothing to a screen reader, and an error that
    // is not tied to the control leaves the preparer hunting for the row.
    renderBuilder({ stepErrors: { s2: 'Already assigned to step 1.' } })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Already assigned to step 1.')
    expect(approverFor(2)).toHaveAttribute('aria-invalid', 'true')
    expect(approverFor(2)).toHaveAttribute('aria-describedby', alert.id)
    // Only the offending row is flagged - one error must not paint the whole
    // chain red, or the preparer has three rows to check and no clue which.
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(approverFor(1)).not.toHaveAttribute('aria-invalid')
    expect(approverFor(1)).not.toHaveAttribute('aria-describedby')
  })

  it('will not let the same person be put on two steps, and says why', async () => {
    // The API refuses a duplicate chain outright, so the form has to refuse
    // it first - after the preparer has signed is far too late to find out.
    const user = userEvent.setup({ delay: null })
    const { onUpdate } = renderBuilder({
      steps: [step('s1', FATIMA.id), step('s2', '', 'FINAL_APPROVER')],
    })

    await user.click(approverFor(2))
    const alreadyUsed = await screen.findByRole('option', { name: /Fatima Sheikh/ })

    expect(alreadyUsed).toBeDisabled()
    expect(alreadyUsed).toHaveTextContent('Already in this approval chain')

    await user.click(alreadyUsed)
    expect(onUpdate).not.toHaveBeenCalled()

    // The person who is free is still selectable, so the row is not a dead end.
    await user.click(screen.getByRole('option', { name: /Bilal Ahmed/ }))
    expect(onUpdate).toHaveBeenCalledWith('s2', 'userId', BILAL.id)
  })

  it('never offers the preparer as an approver on their own document', async () => {
    // They sign before the chain starts and are barred from acting on it
    // afterwards, so a step assigned to them could never be completed.
    const user = userEvent.setup({ delay: null })
    renderBuilder({
      steps: [step('s1', '', 'FINAL_APPROVER')],
      excludeIds: new Set([FATIMA.id]),
    })

    await user.click(approverFor(1))

    expect(await screen.findByRole('option', { name: /Bilal Ahmed/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Fatima Sheikh/ })).not.toBeInTheDocument()
  })

  it('hands names back up as the directory returns them', async () => {
    // A row can only print "Finance · bilal.ahmed@example.com" for a person
    // the parent holds a user object for, and this is the only place those
    // objects come from. Without it the chain fills with ids and every row
    // reads as unassigned - which is exactly the defect below.
    const user = userEvent.setup({ delay: null })
    const { onUserResolved } = renderBuilder({ steps: [step('s1', '', 'FINAL_APPROVER')] })

    await user.click(approverFor(1))
    await screen.findByRole('option', { name: /Bilal Ahmed/ })

    expect(onUserResolved).toHaveBeenCalledWith(BILAL)
    expect(onUserResolved).toHaveBeenCalledWith(FATIMA)
  })

  it('offers every approval role and reports the change against the right step', async () => {
    const user = userEvent.setup({ delay: null })
    const { onUpdate } = renderBuilder()

    const type = screen.getByLabelText('Approval type for step 1')
    expect(within(type as HTMLSelectElement).getAllByRole('option').map(o => o.textContent)).toEqual(
      ['Reviewer', 'Approver', 'Final Approver'],
    )

    await user.selectOptions(type, 'FINAL_APPROVER')

    // By step id, not index: the row may have been dragged since it rendered.
    expect(onUpdate).toHaveBeenCalledWith('s1', 'approvalType', 'FINAL_APPROVER')
  })
})

describe('ApprovalChainBuilder, reusing a previous chain', () => {
  it('names the route it is offering before the preparer takes it', async () => {
    // "Reuse that chain" with no names attached asks somebody to accept a
    // route they cannot see.
    const user = userEvent.setup({ delay: null })
    const { onReuse, onUpdate } = renderBuilder({
      reusable: {
        label: 'Fatima Sheikh → Bilal Ahmed',
        steps: [step('r1', FATIMA.id), step('r2', BILAL.id, 'FINAL_APPROVER')],
      },
    })

    expect(screen.getByText('Fatima Sheikh → Bilal Ahmed')).toBeInTheDocument()
    // The offer is an offer. Drawing the old chain's rows alongside the
    // current one would double the chain on screen and leave the preparer
    // unsure which four rows are about to be submitted.
    expect(rows()).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: /Reuse that chain/ }))
    expect(onReuse).toHaveBeenCalledTimes(1)
    // Applying it is the parent's move: this must not edit the rows itself.
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('offers nothing to reuse when there is no previous chain', () => {
    renderBuilder()

    expect(screen.queryByRole('button', { name: /Reuse that chain/ })).not.toBeInTheDocument()
  })
})

describe('ApprovalChainBuilder, edges', () => {
  it('keeps a step readable while the directory is still catching up', () => {
    // A step whose person is not in the cache yet still has to number and
    // label itself, or the row disappears from the keyboard order entirely.
    // "It rendered" is not that: the labels are what carry the number, so
    // they are what gets asserted.
    renderBuilder({ steps: [step('s1', 'u-nobody-cached', 'FINAL_APPROVER')] })

    expect(gripFor(1)).toHaveAccessibleName('Reorder step 1. Use the up and down arrow keys.')
    expect(approverFor(1)).toHaveAccessibleName('Approver for step 1')
    expect(screen.getByLabelText('Approval type for step 1')).toHaveValue('FINAL_APPROVER')
  })

  it('survives a very long name without losing the controls beside it', () => {
    const long = person('u-long', 'Muhammad Abdul Rahman', 'Siddiqui Al-Hussaini', 'Procurement')
    renderBuilder({
      steps: [step('s1', long.id, 'FINAL_APPROVER')],
      usersById: new Map([[long.id, long]]),
    })

    // Whole, in the control and in the grip's label: a name clipped into the
    // DOM (rather than by CSS) would have the grip announce a different
    // person from the one it moves.
    expect(approverFor(1)).toHaveTextContent('Muhammad Abdul Rahman Siddiqui Al-Hussaini')
    expect(gripFor(1)).toHaveAccessibleName(
      'Reorder step 1, Muhammad Abdul Rahman Siddiqui Al-Hussaini. Use the up and down arrow keys.',
    )
    expect(screen.getByLabelText('Approval type for step 1')).toHaveValue('FINAL_APPROVER')
  })

  it('says a step is still unassigned rather than looking assigned', async () => {
    // A step can carry a userId the parent has not resolved a name for yet -
    // the "reuse that chain" path sets ids first. The control then falls back
    // to "Search for a person…", which is the same thing an empty step shows,
    // so a filled step reads as empty and gets reassigned.
    renderBuilder({ steps: [step('s1', 'u-nobody-cached', 'FINAL_APPROVER')] })

    expect(approverFor(1)).not.toHaveTextContent('Search for a person')
  })
})
