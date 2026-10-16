import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Node } from '@xyflow/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAssignableUsers } from '../../services/usersApi'
import type { AssignableUser } from '../../types/submitDocument'
import NodeConfigPanel from './NodeConfigPanel'

/**
 * The inspector is where an administrator decides what a workflow template
 * actually does: who each step is routed to, which role they hold, and what a
 * decision branches on. A template is not a document - it is the rule every
 * document routed through it obeys afterwards - so a mis-set node is not one
 * mistake, it is every approval made under it.
 *
 * The expensive failure is quiet. An approval node with no `approverId`
 * compiles to nothing: the step vanishes from the chain and the document skips
 * a signature nobody notices is missing. The designer refuses to save such a
 * graph; this panel is the half of that mitigation an administrator can see,
 * so what it says about a step with no assignee - in words, and to a screen
 * reader, not only as a red border - is the behaviour under test here.
 *
 * The directory lives behind a service module, so that module is mocked rather
 * than `fetch`: the panel's contract is "ask `fetchAssignableUsers` for the
 * assignable people", not the shape of a URL.
 */

vi.mock('../../services/usersApi', () => ({
  fetchAssignableUsers: vi.fn(),
}))

const directory = vi.mocked(fetchAssignableUsers)

const person = (
  id: string,
  firstName: string,
  lastName: string,
  department: string | null
): AssignableUser => ({
  id,
  email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
  firstName,
  lastName,
  department: department ? { name: department } : null,
})

const AYESHA = person('u-ayesha', 'Ayesha', 'Khan', 'Legal')
const BILAL = person('u-bilal', 'Bilal', 'Ahmed', 'Finance')
const CHANDNI = person('u-chandni', 'Chandni', 'Rao', null)

const AYESHA_LABEL = 'Ayesha Khan — Legal'
const BILAL_LABEL = 'Bilal Ahmed — Finance'
const CHANDNI_LABEL = 'Chandni Rao'

const page = (users: AssignableUser[], total = users.length) => ({
  users,
  total,
  returned: users.length,
})

function node(overrides: Partial<Node> = {}): Node {
  return {
    id: 'node-1',
    type: 'approval',
    position: { x: 0, y: 0 },
    data: {},
    ...overrides,
  }
}

/** A fully configured approval step; each test removes only what it is about. */
function approvalNode(data: Record<string, unknown> = {}): Node {
  return node({
    id: 'approval-1712000000000',
    type: 'approval',
    data: {
      label: 'Finance review',
      approvalType: 'REVIEWER',
      approverId: BILAL.id,
      approverName: BILAL_LABEL,
      ...data,
    },
  })
}

function decisionNode(data: Record<string, unknown> = {}): Node {
  return node({
    id: 'decision-1712000000000',
    type: 'decision',
    data: {
      label: 'Confidential?',
      conditionField: 'title',
      conditionOperator: 'contains',
      conditionValue: 'Confidential',
      ...data,
    },
  })
}

async function renderPanel(selected: Node | null) {
  const onUpdate = vi.fn()
  const onDelete = vi.fn()
  const onClose = vi.fn()

  const view = render(
    <NodeConfigPanel
      node={selected}
      onUpdate={onUpdate}
      onDelete={onDelete}
      onClose={onClose}
    />
  )

  // The directory resolves on the next microtask. Flushing it here means every
  // test starts from the loaded panel instead of racing the fetch.
  await act(async () => {})

  return { ...view, onUpdate, onDelete, onClose }
}

const assigneeSelect = () => screen.getByRole('combobox', { name: /^Assignee/ })

beforeEach(() => {
  // `restoreMocks` clears the implementation between tests, so every test
  // starts from the same unremarkable directory unless it says otherwise.
  // Returned out of order on purpose: the panel is expected to sort.
  directory.mockResolvedValue(page([CHANDNI, BILAL, AYESHA]))
})

describe('NodeConfigPanel with nothing selected', () => {
  it('says what to do rather than showing an empty pane', async () => {
    await renderPanel(null)

    // A blank column beside the canvas reads as a broken panel; the sentence
    // is the difference between "nothing here" and "nothing selected yet".
    expect(
      screen.getByText('Select a node on the canvas to configure it here.')
    ).toBeInTheDocument()
  })

  it('offers no delete while nothing is selected', async () => {
    await renderPanel(null)

    // A delete button with no node behind it could only act on a stale
    // selection, which is the one deletion nobody could predict.
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()

    // The fields go with it, for the same reason and one step earlier: a Label
    // box or an Assignee select left standing over a cleared selection sends
    // its edit to whichever node happened to be open last. Absence of a delete
    // button alone would also be satisfied by a panel that had simply stopped
    // rendering, so this is what says the empty state is the empty state.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})

describe('NodeConfigPanel, naming the step being edited', () => {
  it('names the step rather than showing its id', async () => {
    await renderPanel(approvalNode())

    // The id is `approval-${Date.now()}`. An administrator with four approval
    // steps on the canvas cannot tell from that which one is open.
    expect(screen.getByText('Finance review')).toBeInTheDocument()
    expect(screen.queryByText(/approval-1712000000000/)).not.toBeInTheDocument()
  })

  it('falls back to the person holding the step when it has no label', async () => {
    // An approver outside the loaded page, so the only place this name can be
    // coming from is the node's own stored `approverName`.
    await renderPanel(
      approvalNode({
        label: undefined,
        approverId: 'u-outside-the-page',
        approverName: 'Fatima Sheikh — Operations',
      })
    )

    // The panel title, specifically. The Assignee select now names this
    // person too - that is the fix for a step assigned outside the loaded
    // page, which is exactly what this fixture is - so an unscoped query
    // finds two and the <option> is not the one this test is about.
    const titles = screen
      .getAllByText('Fatima Sheikh — Operations')
      .filter(element => element.tagName !== 'OPTION')

    expect(titles).toHaveLength(1)
  })

  it('falls back to the kind of node when it has neither', async () => {
    await renderPanel(decisionNode({ label: undefined }))

    // "Node" for every step would make the header useless; the type is the
    // last thing that still distinguishes one from another.
    expect(screen.getByText('Decision')).toBeInTheDocument()
    expect(screen.queryByText(/decision-1712000000000/)).not.toBeInTheDocument()
  })

  it('gives the icon-only close control a name, and closes on it', async () => {
    const user = userEvent.setup({ delay: null })
    const { onClose } = await renderPanel(approvalNode())

    await user.click(screen.getByRole('button', { name: 'Close the inspector' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('NodeConfigPanel, editing a node', () => {
  it('patches nothing merely for being opened on a node', async () => {
    const { onUpdate, onDelete } = await renderPanel(
      approvalNode({ approvalType: undefined, label: undefined })
    )

    // Three of the selects here fall back to a value for display - REVIEWER,
    // `title`, `contains` - while the node stores nothing. Normalising those
    // defaults back through `onUpdate` on mount is the tempting fix and the
    // wrong one: the designer marks the template dirty on every patch, so a
    // template would come up unsaved for having been looked at, and the
    // unsaved-changes prompt would fire on the way out of a read-only visit.
    expect(onUpdate).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('sends every edit to the id of the node that is selected', async () => {
    const user = userEvent.setup({ delay: null })
    const { onUpdate } = await renderPanel(approvalNode())

    await user.type(screen.getByRole('textbox', { name: 'Label' }), 'X')

    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0][0]).toBe('approval-1712000000000')
  })

  it('sends only the field that changed, never a copy of the whole node', async () => {
    const user = userEvent.setup({ delay: null })
    const { onUpdate } = await renderPanel(approvalNode())

    await user.type(screen.getByRole('textbox', { name: 'Label' }), 'X')

    // The designer merges the patch into the node it holds. A panel that sent
    // its whole `data` back would write the values it was rendered with - so
    // an edit made after the canvas moved on would quietly restore the old
    // approver along with the new label.
    expect(onUpdate.mock.calls[0][1]).toStrictEqual({ label: 'Finance reviewX' })
  })

  it('records the chosen approver by name as well as by id', async () => {
    const user = userEvent.setup({ delay: null })
    const { onUpdate } = await renderPanel(
      approvalNode({ approverId: undefined, approverName: undefined })
    )

    await user.selectOptions(assigneeSelect(), AYESHA.id)

    // Only the id is saved to the API; the name is what the canvas node and
    // the validation messages call this step. Without it the graph shows a
    // step assigned to nobody visible.
    expect(onUpdate.mock.calls[0][1]).toStrictEqual({
      approverId: AYESHA.id,
      approverName: AYESHA_LABEL,
    })
  })

  it('shows the person the step is already routed to', async () => {
    await renderPanel(approvalNode())

    // The panel is controlled, so the select has to read back out of the node
    // rather than out of its own memory of what was last picked. An empty
    // select over a stored `approverId` reads as an unassigned step: the next
    // administrator to open it picks somebody, and a step that already had a
    // holder is reassigned by an edit nobody meant to make.
    expect(assigneeSelect()).toHaveValue(BILAL.id)
  })

  it('clears the stored name when the assignee is cleared', async () => {
    const user = userEvent.setup({ delay: null })
    const { onUpdate } = await renderPanel(approvalNode())

    await user.selectOptions(assigneeSelect(), '')

    // Keeping the name behind an emptied id is the worst of both: the canvas
    // still reads "Bilal Ahmed", the compiler routes to nobody, and the step
    // disappears from the chain.
    expect(onUpdate.mock.calls[0][1]).toStrictEqual({
      approverId: undefined,
      approverName: undefined,
    })
  })

  it('lists people by the name shown, not in the order the directory returned', async () => {
    await renderPanel(approvalNode({ approverId: undefined, approverName: undefined }))

    const options = within(assigneeSelect())
      .getAllByRole('option')
      .map(option => option.textContent)

    // The list is a flat select of up to a hundred people. Unsorted, finding a
    // name in it is a linear read of every entry.
    expect(options).toEqual([
      'Select a person…',
      AYESHA_LABEL,
      BILAL_LABEL,
      CHANDNI_LABEL,
    ])
  })

  it('names the assignee outside the select, without spelling the initials out', async () => {
    await renderPanel(approvalNode())

    // A closed select is not re-read by every screen reader after a change,
    // and on a narrow panel the chosen option is the first thing to truncate.
    // One of these two mentions is the option inside the select; the other is
    // the confirmation line, which is the one an administrator can actually
    // read back without opening the list again.
    const mentions = screen.getAllByText(BILAL_LABEL)
    expect(mentions.filter(el => el.tagName !== 'OPTION')).toHaveLength(1)

    // The chip beside it is two letters of decoration. Announced, the step
    // reads as "B A, Bilal Ahmed — Finance".
    expect(screen.getByText('BA')).toHaveAttribute('aria-hidden', 'true')
  })

  it('sends the approval type on its own when the type is changed', async () => {
    const user = userEvent.setup({ delay: null })
    const { onUpdate } = await renderPanel(approvalNode())

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Approval type' }),
      'FINAL_APPROVER'
    )

    // A patch that carried `approverId` along with it would re-assert the
    // approver the panel was rendered with, which is how a reassignment made
    // on the canvas gets quietly undone by an unrelated edit here.
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0][0]).toBe('approval-1712000000000')
    expect(onUpdate.mock.calls[0][1]).toStrictEqual({ approvalType: 'FINAL_APPROVER' })
  })

  it('asks the directory once for the panel, not once per selection', async () => {
    const { rerender, onUpdate, onDelete, onClose } = await renderPanel(approvalNode())

    rerender(
      <NodeConfigPanel
        node={decisionNode()}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onClose={onClose}
      />
    )
    await act(async () => {})

    // First: the panel is now showing the node it was handed, not the one it
    // was mounted on. Without this the fetch count below would be satisfied by
    // a panel that had latched onto its first node and ignored every selection
    // after it - which is the same single request, and a broken inspector.
    expect(screen.getByRole('combobox', { name: 'If field' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /^Assignee/ })).not.toBeInTheDocument()
    expect(screen.getByText('Confidential?')).toBeInTheDocument()

    // Clicking down a ten-step template is one selection after another. If the
    // directory were fetched per selection that is ten requests for the same
    // hundred people, on the screen where somebody clicks the most.
    expect(directory).toHaveBeenCalledTimes(1)
  })

  it('does not offer SLA or escalation fields the template API would strip', async () => {
    await renderPanel(approvalNode())

    // Pinned against the controls that ARE an approval step: two absences on
    // their own are also what a panel that had stopped rendering its fields
    // altogether would show, so on its own this test would go on passing
    // through the one regression it would most matter to catch.
    expect(screen.getByRole('combobox', { name: 'Approval type' })).toBeInTheDocument()
    expect(assigneeSelect()).toBeInTheDocument()

    // There is no `slaDays` or `onBreach` on the node schema and zod strips
    // unknown keys rather than rejecting them, so a control here would take a
    // deadline, report success and lose it. Off is the honest state.
    expect(screen.queryByRole('combobox', { name: 'SLA' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'On breach' })).not.toBeInTheDocument()
  })
})

describe('NodeConfigPanel, an approval step with no assignee', () => {
  const unassigned = () => approvalNode({ approverId: undefined, approverName: undefined })

  it('says in words that the step cannot be saved without one', async () => {
    await renderPanel(unassigned())

    // The red border alone is invisible to anyone who cannot see it and
    // meaningless to anyone who can but does not know the rule. This sentence
    // is the visible half of the compiler's silent-drop mitigation.
    expect(
      screen.getByText('This step needs an assignee before the workflow can be saved.')
    ).toBeInTheDocument()
  })

  it('ties that message to the select a screen reader is sitting on', async () => {
    await renderPanel(unassigned())

    const select = assigneeSelect()
    expect(select).toHaveAttribute('aria-invalid', 'true')

    // `aria-invalid` on its own announces "invalid entry" and stops there.
    // The description is what says which entry and what to do about it.
    const describedBy = select.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy as string)).toHaveTextContent(
      /needs an assignee/
    )
  })

  it('drops the warning once somebody is chosen', async () => {
    const user = userEvent.setup({ delay: null })
    const { rerender, onUpdate, onDelete, onClose } = await renderPanel(unassigned())

    expect(screen.getByText(/needs an assignee/)).toBeInTheDocument()

    await user.selectOptions(assigneeSelect(), AYESHA.id)

    // The panel does not clear its own warning: it is controlled, so the
    // designer merges the patch and hands the node back. Replaying that round
    // trip is what proves the message is derived from the node rather than
    // latched on the first render - a static render of an assigned node would
    // pass even if the warning could never clear.
    rerender(
      <NodeConfigPanel
        node={approvalNode({ approverId: AYESHA.id, approverName: AYESHA_LABEL })}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onClose={onClose}
      />
    )

    // A warning that never clears teaches people to ignore it, and the next
    // one - the real one - goes unread with it.
    expect(screen.queryByText(/needs an assignee/)).not.toBeInTheDocument()
    expect(assigneeSelect()).not.toHaveAttribute('aria-invalid')
    // Left behind, `aria-describedby` points at an id that is no longer in the
    // document: the select then announces with a description nobody can hear.
    expect(assigneeSelect()).not.toHaveAttribute('aria-describedby')
  })

  it('does not read the required marker out as part of the field name', async () => {
    await renderPanel(unassigned())

    // The asterisk is aria-hidden, so the field is announced "Assignee" and
    // not "Assignee star" - the requirement is carried by the message above.
    expect(assigneeSelect()).toHaveAccessibleName('Assignee')
  })

  it(
    'shows who a step is routed to when that person is outside the loaded page',
    async () => {
      // DEFECT: the panel loads a flat page of a hundred people and matches the
      // stored `approverId` against it. A template assigned to anybody outside
      // that page renders an EMPTY Assignee select on a step that is in fact
      // assigned - and with `approverId` set, no "needs an assignee" warning
      // appears either. The step reads as unassigned and re-picking silently
      // reassigns it to somebody else.
      await renderPanel(approvalNode({ approverId: 'u-outside-the-page' }))

      expect(assigneeSelect()).toHaveValue('u-outside-the-page')
    }
  )

  it('says when the list of people is only part of the directory', async () => {
    // DEFECT: `useAssignableUsers` returns `total` precisely so a caller can
    // say "showing 3 of 312", and the panel ignores it. An administrator who
    // cannot find a colleague in the select has no way to tell a person
    // without an account from a person past the hundredth row.
    directory.mockResolvedValue(page([AYESHA, BILAL, CHANDNI], 312))
    await renderPanel(approvalNode({ approverId: undefined, approverName: undefined }))

    expect(screen.getByText(/312/)).toBeInTheDocument()
  })

  it('leaves nobody selectable when the directory request fails', async () => {
    directory.mockRejectedValue(new Error('Network error'))
    await renderPanel(unassigned())

    // Pinned so the expected failure below cannot be satisfied by the panel
    // throwing on a rejected request instead of by the missing explanation:
    // `it.fails` accepts any error, including one from a crash.
    expect(
      within(assigneeSelect())
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['Select a person…'])
    expect(screen.getByText(/needs an assignee/)).toBeInTheDocument()
  })

  it('explains when the directory could not be loaded at all', async () => {
    // DEFECT: the hook exposes `error`, the panel drops it. A failed request
    // leaves a select holding nothing but "Select a person…", which reads as
    // "this organisation has no assignable people" rather than "ask again".
    directory.mockRejectedValue(new Error('Network error'))
    await renderPanel(approvalNode({ approverId: undefined, approverName: undefined }))

    expect(screen.getByText(/could not|failed|try again/i)).toBeInTheDocument()
  })
})

describe('NodeConfigPanel, the approval type', () => {
  it('warns that a Final Approver must be the only one and the last one', async () => {
    await renderPanel(approvalNode({ approvalType: 'FINAL_APPROVER' }))

    // Two final approvers, or one in the middle, fails at save. Saying so at
    // the moment the type is set costs one sentence; discovering it at save
    // costs a walk back through every step.
    expect(screen.getByText(/exactly one Final Approver/)).toBeInTheDocument()
  })

  it('does not show that warning on an ordinary reviewer step', async () => {
    await renderPanel(approvalNode({ approvalType: 'REVIEWER' }))

    expect(screen.queryByText(/exactly one Final Approver/)).not.toBeInTheDocument()
  })

  it('shows Reviewer for a node that carries no type of its own', async () => {
    await renderPanel(approvalNode({ approvalType: undefined }))

    // Documented, not endorsed: the select falls back to REVIEWER for display
    // while the node still stores nothing, so the panel reads "Reviewer" on a
    // step the designer will refuse to save for having no approval type.
    expect(screen.getByRole('combobox', { name: 'Approval type' })).toHaveValue('REVIEWER')
  })
})

describe('NodeConfigPanel, a decision step', () => {
  it('flags a branch with nothing to compare against', async () => {
    await renderPanel(decisionNode({ conditionValue: '' }))

    expect(
      screen.getByText('Enter the value this branch compares against.')
    ).toBeInTheDocument()
    const value = screen.getByRole('textbox', { name: /^Value/ })
    expect(value).toHaveAttribute('aria-invalid', 'true')

    // Same reason as the assignee: "invalid entry" on its own does not say
    // which entry or what would fix it, and the red border says neither.
    const describedBy = value.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy as string)).toHaveTextContent(
      /Enter the value this branch compares against/
    )
  })

  it('treats a value of nothing but spaces as missing', async () => {
    await renderPanel(decisionNode({ conditionValue: '   ' }))

    // A branch comparing against "   " is not a branch: it matches no title
    // anybody types, so every document takes the No path and the Yes path
    // silently never runs.
    expect(
      screen.getByText('Enter the value this branch compares against.')
    ).toBeInTheDocument()
  })

  it('accepts a filled-in condition without complaint', async () => {
    await renderPanel(decisionNode())

    const value = screen.getByRole('textbox', { name: /^Value/ })
    expect(value).toHaveValue('Confidential')
    expect(screen.queryByText(/Enter the value/)).not.toBeInTheDocument()
    expect(value).not.toHaveAttribute('aria-invalid')
    expect(value).not.toHaveAttribute('aria-describedby')
  })

  it('shows the condition the node actually stores, not the first option', async () => {
    await renderPanel(
      decisionNode({ conditionField: 'description', conditionOperator: 'equals' })
    )

    // Both selects fall back to `title`/`contains` for display when the node
    // carries nothing. Rendering that fallback over a stored value would show
    // a branch on the title while the saved template branches on the
    // description - the panel and the compiler disagreeing in silence.
    expect(screen.getByRole('combobox', { name: 'If field' })).toHaveValue('description')
    expect(screen.getByRole('combobox', { name: 'Operator' })).toHaveValue('equals')
  })

  it('sends the operator on its own, leaving the field and the value alone', async () => {
    const user = userEvent.setup({ delay: null })
    const { onUpdate } = await renderPanel(decisionNode())

    await user.selectOptions(screen.getByRole('combobox', { name: 'Operator' }), 'startsWith')

    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0][0]).toBe('decision-1712000000000')
    expect(onUpdate.mock.calls[0][1]).toStrictEqual({ conditionOperator: 'startsWith' })
  })

  it('sends the compared field on its own when the field is changed', async () => {
    const user = userEvent.setup({ delay: null })
    const { onUpdate } = await renderPanel(decisionNode())

    await user.selectOptions(screen.getByRole('combobox', { name: 'If field' }), 'description')

    expect(onUpdate.mock.calls[0][1]).toStrictEqual({ conditionField: 'description' })
  })

  it('sends the compared value on its own as it is typed', async () => {
    const user = userEvent.setup({ delay: null })
    const { onUpdate } = await renderPanel(decisionNode({ conditionValue: '' }))

    await user.type(screen.getByRole('textbox', { name: /^Value/ }), 'S')

    // The value is the only part of a branch somebody types rather than picks,
    // and it is the string the compiler actually compares against. A patch
    // that carried the field and the operator along with it would re-assert
    // the pair the panel was rendered with on every keystroke - so correcting
    // a typo in the value would quietly undo a change of operator made on the
    // canvas a moment earlier.
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0][0]).toBe('decision-1712000000000')
    expect(onUpdate.mock.calls[0][1]).toStrictEqual({ conditionValue: 'S' })
  })

  it('does not read the required marker out as part of the Value field name', async () => {
    await renderPanel(decisionNode({ conditionValue: '' }))

    // The same asterisk as the Assignee field, and the same rule: it is
    // aria-hidden, so the field announces as "Value" and not "Value star".
    // The other decision tests match it by prefix, which would keep passing
    // with the marker read out loud.
    expect(screen.getByRole('textbox', { name: /^Value/ })).toHaveAccessibleName('Value')
  })

  it('says in words which handle is Yes and which is No', async () => {
    await renderPanel(decisionNode())

    // The two handles are a green dot and a red dot on the canvas. Wiring the
    // branches the wrong way round routes every matching document down the
    // path meant for the ones that do not match, so the dots cannot be the
    // only thing that says which is which.
    expect(screen.getByText(/Upper handle/)).toHaveTextContent(/Yes/)
    expect(screen.getByText(/Lower handle/)).toHaveTextContent(/No/)
  })

  it('does not ask a decision node for an assignee', async () => {
    await renderPanel(decisionNode())

    // A decision is not a step somebody holds; offering an assignee here would
    // invite a value the compiler has nowhere to put.
    expect(screen.queryByRole('combobox', { name: /^Assignee/ })).not.toBeInTheDocument()
  })
})

describe('NodeConfigPanel, the Start and End nodes', () => {
  const startNode = () => node({ id: 'start-1', type: 'start', data: { label: 'Start' } })

  it('refuses to rename the Start node, disabled rather than merely styled grey', async () => {
    const user = userEvent.setup({ delay: null })
    const { onUpdate } = await renderPanel(startNode())

    const label = screen.getByRole('textbox', { name: 'Label' })
    expect(label).toBeDisabled()

    await user.type(label, 'X')
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('asks the Start node for nothing it could ever hold', async () => {
    await renderPanel(startNode())

    // Start has no assignee and no condition. Offering either would put a
    // required field on the one node that is complete the moment it exists -
    // and with the Assignee select comes "this step needs an assignee", a
    // blocking message about a rule that does not apply, on a node nobody can
    // fix. The designer saves such a graph happily; the panel would be the
    // only thing claiming otherwise.
    expect(screen.queryByRole('combobox', { name: /^Assignee/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /^Value/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/needs an assignee/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Enter the value/)).not.toBeInTheDocument()
  })

  it('offers no way to delete the Start node', async () => {
    await renderPanel(startNode())

    // A graph with no Start compiles to an empty chain: the template would
    // save, be picked on the submit screen, and route to nobody.
    expect(screen.queryByRole('button', { name: /Delete node/ })).not.toBeInTheDocument()
  })

  it('explains the one-Start rule where the rule is enforced', async () => {
    await renderPanel(startNode())

    expect(screen.getByText(/only be one Start node/)).toBeInTheDocument()
  })

  it('does let an End node be deleted', async () => {
    await renderPanel(node({ id: 'end-1', type: 'end', data: { label: 'End' } }))

    expect(screen.getByRole('button', { name: /Delete node/ })).toBeInTheDocument()
    expect(screen.getByText(/marks the workflow complete/i)).toBeInTheDocument()
  })
})

describe('NodeConfigPanel, deleting a node', () => {
  const openDelete = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: /Delete node/ }))
    return screen.getByRole('dialog')
  }

  it('opens no confirmation merely for selecting a node', async () => {
    await renderPanel(approvalNode())

    // `confirmDelete` starting true - or a ConfirmDialog that rendered
    // regardless of `open` - would put a modal with a focus trap over the
    // canvas the moment anybody clicked a step.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Delete node/ })).toBeInTheDocument()
  })

  it('asks first, in a dialog that names the kind of step going', async () => {
    const user = userEvent.setup({ delay: null })
    await renderPanel(decisionNode())

    const dialog = await openDelete(user)

    expect(dialog).toHaveAttribute('aria-modal', 'true')
    // "Delete node?" would be true of all four kinds. The type is what tells
    // somebody mid-click that they are about to remove a branch.
    expect(dialog).toHaveAccessibleName('Delete Decision step?')
  })

  it('names the step itself in the confirmation, and warns the edges go with it', async () => {
    const user = userEvent.setup({ delay: null })
    await renderPanel(approvalNode())

    const dialog = await openDelete(user)

    expect(within(dialog).getByText('Finance review')).toBeInTheDocument()
    // Deleting a node in the middle of a chain silently breaks the path
    // through it. Saying so is the difference between one undo and a template
    // that saves with a dead end.
    expect(dialog).toHaveTextContent(/every\s+connection into or out of it/i)
  })

  it('deletes nothing while the dialog is only open', async () => {
    const user = userEvent.setup({ delay: null })
    const { onDelete } = await renderPanel(approvalNode())

    await openDelete(user)

    expect(onDelete).not.toHaveBeenCalled()
  })

  it('deletes nothing when the confirmation is cancelled', async () => {
    const user = userEvent.setup({ delay: null })
    const { onDelete } = await renderPanel(approvalNode())

    const dialog = await openDelete(user)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('removes exactly the selected node once, when confirmed', async () => {
    const user = userEvent.setup({ delay: null })
    const { onDelete } = await renderPanel(approvalNode())

    const dialog = await openDelete(user)
    await user.click(within(dialog).getByRole('button', { name: 'Delete step' }))

    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith('approval-1712000000000')
  })

  it('takes Escape as a cancel and hands focus back to the button that opened it', async () => {
    const user = userEvent.setup({ delay: null })
    const { onDelete } = await renderPanel(approvalNode())

    await openDelete(user)
    await user.keyboard('{Escape}')

    expect(onDelete).not.toHaveBeenCalled()
    // Focus dumped on the body after a dismissed dialog leaves a keyboard user
    // tabbing from the top of the page back to where they already were.
    expect(screen.getByRole('button', { name: /Delete node/ })).toHaveFocus()
  })

  it('closes the confirmation after deleting, so the next selection starts clean', async () => {
    const user = userEvent.setup({ delay: null })
    await renderPanel(approvalNode())

    const dialog = await openDelete(user)
    await user.click(within(dialog).getByRole('button', { name: 'Delete step' }))

    // The panel keeps its own `confirmDelete` state across a change of node. A
    // dialog left standing would be pointing at a node that no longer exists.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
