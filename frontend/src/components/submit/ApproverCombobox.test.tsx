import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAssignableUsers } from '../../services/usersApi'
import type { AssignableUser } from '../../types/submitDocument'
import ApproverCombobox from './ApproverCombobox'

/**
 * The control that decides who a document is routed to. Everything downstream
 * of it - who is notified, who can sign, how long the document sits - follows
 * from the person picked here, and a mis-pick is discovered days later when
 * nothing has moved.
 *
 * So the questions worth asking are: does it show the people the directory
 * actually returned, does it refuse the two people it must refuse (someone
 * already on the chain, and the preparer themselves), and can somebody who
 * never touches a mouse drive it - open it, move the highlight, choose, and
 * get out again without choosing.
 *
 * The directory lives behind a service module, so that module is mocked here
 * rather than `fetch`: the component's contract is "ask `fetchAssignableUsers`
 * for a page", and a test that stubbed the network would also be asserting on
 * the URL builder, which is not this component's job.
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
  extra: Partial<AssignableUser> = {},
): AssignableUser => ({
  id,
  email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
  firstName,
  lastName,
  department: department ? { name: department } : null,
  ...extra,
})

const FATIMA = person('u-fatima', 'Fatima', 'Sheikh', 'Finance')
const BILAL = person('u-bilal', 'Bilal', 'Ahmed', 'Finance')
const CHANDNI = person('u-chandni', 'Chandni', 'Rao', 'Legal')

const page = (users: AssignableUser[], total = users.length) => ({
  users,
  total,
  returned: users.length,
})

type Props = ComponentProps<typeof ApproverCombobox>

/**
 * The combobox as the builder actually mounts it: labelled from outside by
 * the step it belongs to, with an unrelated control on the page so that an
 * "outside click" has somewhere real to land.
 */
function renderCombobox(overrides: Partial<Props> = {}) {
  const onChange = vi.fn()
  const onResolved = vi.fn()

  const result = render(
    <>
      <label htmlFor="approver">Approver for step 2</label>
      <ApproverCombobox
        id="approver"
        value=""
        selected={null}
        takenIds={new Set()}
        onChange={onChange}
        onResolved={onResolved}
        {...overrides}
      />
      <button type="button">Somewhere else</button>
    </>,
  )

  return { ...result, onChange, onResolved }
}

const trigger = () => screen.getByRole('button', { name: /Approver for step 2/i })
const searchField = () => screen.getByRole('textbox', { name: 'Search for a person' })

/** Open the panel and wait for the first page of people to land. */
async function openWithResults(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger())
  await screen.findByRole('option', { name: /Fatima Sheikh/ })
}

beforeEach(() => {
  // `restoreMocks` clears the implementation between tests, so every test
  // starts from the same unremarkable directory unless it says otherwise.
  search.mockResolvedValue(page([FATIMA, BILAL, CHANDNI]))
})

describe('ApproverCombobox, closed', () => {
  it('is announced as a collapsed listbox that the step label names', () => {
    renderCombobox()

    const control = trigger()
    // Without haspopup + expanded a screen-reader user is told this is an
    // ordinary button and has no reason to expect a list to appear.
    expect(control).toHaveAttribute('aria-haspopup', 'listbox')
    expect(control).toHaveAttribute('aria-expanded', 'false')
    expect(control).toHaveAttribute('aria-required', 'true')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    // And it must not point at a list that is not there: a dangling
    // aria-controls sends a screen reader to an id with nothing behind it.
    expect(control).not.toHaveAttribute('aria-controls')
  })

  it('asks for a person when the step is empty', () => {
    renderCombobox()

    expect(trigger()).toHaveTextContent('Search for a person')
  })

  it('names the person the step is routed to, so a filled chain reads back', () => {
    // The closed control is the only place the chain says who step 2 goes to.
    // Showing the placeholder over a real assignment would have the preparer
    // believe the step is empty and reassign it.
    renderCombobox({ value: BILAL.id, selected: BILAL })

    expect(trigger()).toHaveTextContent('Bilal Ahmed')
    expect(trigger()).not.toHaveTextContent('Search for a person')
  })

  it('flags an invalid step to assistive technology, not only with a red border', () => {
    renderCombobox({ invalid: true, describedBy: 'step-error' })

    expect(trigger()).toHaveAttribute('aria-invalid', 'true')
    expect(trigger()).toHaveAttribute('aria-describedby', 'step-error')
  })

  it('leaves a step that is fine unflagged', () => {
    // The other half of the same contract, and the one that actually costs
    // something when it breaks: a control permanently marked invalid is
    // announced as an error on a form nobody has touched yet, and the real
    // error, when it comes, is indistinguishable from the noise.
    renderCombobox({ value: BILAL.id, selected: BILAL })

    expect(trigger()).not.toHaveAttribute('aria-invalid', 'true')
    expect(trigger()).not.toHaveAttribute('aria-describedby')
  })
})

describe('ApproverCombobox, opening', () => {
  it('opens on click and points at the list it opened', async () => {
    const user = userEvent.setup({ delay: null })
    renderCombobox()

    await user.click(trigger())

    const list = screen.getByRole('listbox', { name: 'People' })
    expect(trigger()).toHaveAttribute('aria-expanded', 'true')
    // aria-controls is what lets a screen reader move into the list it was
    // just told appeared.
    expect(trigger()).toHaveAttribute('aria-controls', list.id)
  })

  it.each(['{ArrowDown}', '{Enter}', '[Space]'])(
    'opens with %s and puts the caret straight in the search field',
    async key => {
      const user = userEvent.setup({ delay: null })
      renderCombobox()

      trigger().focus()
      await user.keyboard(key)

      // Opening without moving focus leaves a keyboard user pressing keys at
      // a button while the list they asked for sits there ignoring them.
      await waitFor(() => expect(searchField()).toHaveFocus())
    },
  )

  it('lists the people the directory returned, gathered under their departments', async () => {
    const user = userEvent.setup({ delay: null })
    // Deliberately not in department order. Two headings and a flat list of
    // whatever the server sent would satisfy "Finance is on screen"; only the
    // drawn order shows the rows were actually gathered under them.
    search.mockResolvedValue(page([FATIMA, CHANDNI, BILAL]))
    renderCombobox()
    await openWithResults(user)

    expect(screen.getByText('Finance')).toBeInTheDocument()
    expect(screen.getByText('Legal')).toBeInTheDocument()
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      expect.stringContaining('Fatima Sheikh'),
      expect.stringContaining('Bilal Ahmed'),
      expect.stringContaining('Chandni Rao'),
    ])
  })

  it('shows how much of the directory it is showing when there is more', async () => {
    // Nine people match and three are on screen. Without this line the
    // preparer reads three names as "these are the only people there are".
    const user = userEvent.setup({ delay: null })
    search.mockResolvedValue(page([FATIMA, BILAL, CHANDNI], 9))
    renderCombobox()
    await openWithResults(user)

    expect(screen.getByText(/Showing 3 of 9 people/)).toBeInTheDocument()
  })

  it('stays quiet about counts when it is showing everybody', async () => {
    const user = userEvent.setup({ delay: null })
    renderCombobox()
    await openWithResults(user)

    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument()
  })
})

describe('ApproverCombobox, searching', () => {
  it('sends the term to the server once the typing settles, not once per key', async () => {
    // A real directory is far too big to filter in the browser, so the search
    // has to be the server's - but three keystrokes must not become three
    // requests either, or the panel flickers through three different answers.
    const user = userEvent.setup({ delay: null })
    renderCombobox()
    await openWithResults(user)

    await user.type(searchField(), 'rao')

    await waitFor(() => expect(search).toHaveBeenLastCalledWith({ q: 'rao', limit: 25 }))
    expect(search).not.toHaveBeenCalledWith({ q: 'r', limit: 25 })
    expect(search).not.toHaveBeenCalledWith({ q: 'ra', limit: 25 })
  })

  it('says who was searched for when nobody matches', async () => {
    const user = userEvent.setup({ delay: null })
    renderCombobox()
    await user.click(trigger())
    await screen.findByRole('option', { name: /Fatima Sheikh/ })

    search.mockResolvedValue(page([]))
    await user.type(searchField(), 'zzz')

    // Echoing the term is what tells someone they mistyped a name rather than
    // that the person has no account.
    expect(await screen.findByText(/Nobody matches/)).toHaveTextContent('zzz')
  })

  it('distinguishes an empty directory from a search that found nothing', async () => {
    const user = userEvent.setup({ delay: null })
    search.mockResolvedValue(page([]))
    renderCombobox()
    await user.click(trigger())

    // Wait for the answer to actually come back first. This panel prints
    // those same words before it has asked anybody (see the failing test
    // below), so without this the assertion would be satisfied by a
    // component that never searched at all.
    await waitFor(() => expect(search).toHaveBeenCalledWith({ q: '', limit: 25 }))

    expect(screen.getByText('No people are available to assign.')).toBeInTheDocument()
    // The distinction the test name claims: nobody was searched for, so the
    // "nobody matches X" wording would be a lie about what was asked.
    expect(screen.queryByText(/Nobody matches/)).not.toBeInTheDocument()
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
  })

  it('reports a failed lookup instead of pretending the directory is empty', async () => {
    // "No people are available to assign" after a 500 is a lie that sends the
    // preparer to raise a ticket about missing accounts.
    const user = userEvent.setup({ delay: null })
    search.mockRejectedValue(new Error('Directory is unavailable'))
    renderCombobox()
    await user.click(trigger())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Directory is unavailable')
    expect(screen.queryByText('No people are available to assign.')).not.toBeInTheDocument()
  })

  it('stops claiming the directory is empty once the request is in flight', async () => {
    const user = userEvent.setup({ delay: null })
    search.mockReturnValue(new Promise(() => {}))
    renderCombobox()
    await user.click(trigger())

    // A hung request must read as "still looking", never as an answer.
    await waitFor(() =>
      expect(screen.queryByText('No people are available to assign.')).not.toBeInTheDocument(),
    )
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
  })

  it('does not answer "nobody is available" before it has asked anybody', async () => {
    // The empty state is drawn whenever there are no results and no request in
    // flight - which includes the whole 220ms debounce window after opening.
    // Every open therefore begins with a fifth of a second of "No people are
    // available to assign." before the first request is even sent.
    const user = userEvent.setup({ delay: null })
    renderCombobox()

    await user.click(trigger())

    expect(screen.queryByText('No people are available to assign.')).not.toBeInTheDocument()
  })

  it('offers a way to undo the search without deleting it character by character', async () => {
    const user = userEvent.setup({ delay: null })
    renderCombobox()
    await openWithResults(user)

    // Nothing to clear until something has been typed, or the row carries a
    // control that does nothing.
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument()

    await user.type(searchField(), 'rao')

    // An icon-only button with no name is unreachable by voice control and
    // announced as "button" by a screen reader.
    const clear = await screen.findByRole('button', { name: 'Clear search' })
    await user.click(clear)

    expect(searchField()).toHaveValue('')
    // Emptying the box has to put the directory back. Leaving the last
    // search's results under an empty field reads as "these are everybody".
    await waitFor(() => expect(search).toHaveBeenLastCalledWith({ q: '', limit: 25 }))
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument()
  })

  it('forgets the search once somebody has been chosen', async () => {
    // Reopening onto a stale term shows a filtered list that looks exactly
    // like the whole directory, and the next step gets picked from three
    // names out of nine hundred.
    const user = userEvent.setup({ delay: null })
    renderCombobox()
    await openWithResults(user)

    await user.type(searchField(), 'rao')
    await user.click(await screen.findByRole('option', { name: /Chandni Rao/ }))
    await user.click(trigger())

    expect(await screen.findByRole('textbox', { name: 'Search for a person' })).toHaveValue('')
  })
})

describe('ApproverCombobox, choosing somebody', () => {
  it('hands the parent the whole person, not just an id, and closes', async () => {
    // The chain has to name the person straight away; if only the id came
    // back the row would read as empty until a lookup returned.
    const user = userEvent.setup({ delay: null })
    const { onChange } = renderCombobox()
    await openWithResults(user)

    await user.click(screen.getByRole('option', { name: /Bilal Ahmed/ }))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(BILAL)
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('marks the person already on this step as the selected option', async () => {
    const user = userEvent.setup({ delay: null })
    renderCombobox({ value: BILAL.id, selected: BILAL })
    await openWithResults(user)

    // Reopening the list must show what is currently set, or the preparer
    // cannot tell a chain they have filled in from one they have not.
    expect(screen.getByRole('option', { name: /Bilal Ahmed/, selected: true })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Fatima Sheikh/, selected: false })).toBeInTheDocument()
  })

  it('moves the highlight with the arrow keys and commits it with Enter', async () => {
    const user = userEvent.setup({ delay: null })
    search.mockResolvedValue(page([FATIMA, BILAL]))
    const { onChange } = renderCombobox()
    await openWithResults(user)

    await user.keyboard('{ArrowDown}{Enter}')

    expect(onChange).toHaveBeenCalledWith(BILAL)
  })

  it('stops at the top of the list rather than wrapping round to the bottom', async () => {
    // Wrapping silently moves the selection to the far end of the list, which
    // is how somebody ends up routing a document to the last person they saw.
    const user = userEvent.setup({ delay: null })
    search.mockResolvedValue(page([FATIMA, BILAL]))
    const { onChange } = renderCombobox()
    await openWithResults(user)

    await user.keyboard('{ArrowUp}{ArrowUp}{Enter}')

    expect(onChange).toHaveBeenCalledWith(FATIMA)
  })

  it('moves the highlight down the list as it is drawn, not as the server sent it', async () => {
    // The list is drawn grouped by department, but the highlight walks the
    // server's own order. Press ArrowDown once against a page that came back
    // Finance/Legal/Finance and the second row on screen is not the row Enter
    // will take. This test is written to the right answer, and fails. See
    // defects.
    const user = userEvent.setup({ delay: null })
    search.mockResolvedValue(page([FATIMA, CHANDNI, BILAL]))
    const { onChange } = renderCombobox()
    await openWithResults(user)

    // Drawn as Finance (Fatima, Bilal) then Legal (Chandni).
    const drawn = screen.getAllByRole('option').map(option => option.textContent)
    expect(drawn[1]).toContain('Bilal Ahmed')

    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenCalledWith(BILAL)
  })

  it('tells a screen reader which person is highlighted', async () => {
    // The highlight is a background tint and nothing else: no
    // aria-activedescendant, no focus on the option, no aria-selected change.
    // A screen-reader user pressing ArrowDown hears silence and then commits
    // somebody they were never told about.
    const user = userEvent.setup({ delay: null })
    renderCombobox()
    await openWithResults(user)

    await user.keyboard('{ArrowDown}')
    expect(searchField()).toHaveAttribute('aria-activedescendant')
  })

  it('announces how many people the search found', async () => {
    // Results arrive silently: the spinner is aria-hidden and the list has no
    // live region, so a screen-reader user has no signal that the panel
    // changed under them.
    const user = userEvent.setup({ delay: null })
    renderCombobox()
    await openWithResults(user)

    expect(screen.getByRole('status')).toHaveTextContent(/3/)
  })
})

describe('ApproverCombobox, the people it must refuse', () => {
  it('shows a person already on another step but will not let them be picked twice', async () => {
    // Hiding them would read as "that person has no account". Showing them
    // greyed out with a reason is what stops the preparer hunting for a name
    // that is right there.
    const user = userEvent.setup({ delay: null })
    const { onChange } = renderCombobox({ takenIds: new Set([BILAL.id]) })
    await openWithResults(user)

    const taken = screen.getByRole('option', { name: /Bilal Ahmed/ })
    expect(taken).toBeDisabled()
    expect(taken).toHaveTextContent('Already in this approval chain')

    await user.click(taken)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('never lets Enter land on somebody already on another step', async () => {
    // The highlight starts on the first selectable row, not the first row.
    // Starting it on a disabled row would make Enter appear to do nothing.
    const user = userEvent.setup({ delay: null })
    const { onChange } = renderCombobox({ takenIds: new Set([FATIMA.id]) })
    await openWithResults(user)

    await user.keyboard('{Enter}')

    expect(onChange).toHaveBeenCalledWith(BILAL)
  })

  it('never offers the preparer as an approver on their own document', async () => {
    // The server refuses such a chain outright, so offering the name would
    // only produce a submission that fails after the document is signed.
    const user = userEvent.setup({ delay: null })
    const { onResolved } = renderCombobox({ excludeIds: new Set([FATIMA.id]) })
    await screen.findByRole('button', { name: /Approver for step 2/i })
    await user.click(trigger())
    await screen.findByRole('option', { name: /Bilal Ahmed/ })

    expect(screen.queryByRole('option', { name: /Fatima Sheikh/ })).not.toBeInTheDocument()
    // Nor may they leak into the parent's cache of resolved people, which is
    // what the routing preview names steps from. That negative is only worth
    // anything next to the positive: a component that resolved nobody at all
    // would satisfy it, and would leave every step on the chain nameless.
    expect(onResolved).toHaveBeenCalledWith(BILAL)
    expect(onResolved).toHaveBeenCalledWith(CHANDNI)
    expect(onResolved).not.toHaveBeenCalledWith(FATIMA)
  })

  it('counts the hidden preparer out of the "showing x of y" total', async () => {
    // Otherwise the panel promises a person it will never show, and the
    // preparer keeps typing looking for them.
    const user = userEvent.setup({ delay: null })
    search.mockResolvedValue(page([FATIMA, BILAL, CHANDNI], 9))
    renderCombobox({ excludeIds: new Set([FATIMA.id]) })
    await user.click(trigger())
    await screen.findByRole('option', { name: /Bilal Ahmed/ })

    expect(screen.getByText(/Showing 2 of 8 people/)).toBeInTheDocument()
  })
})

describe('ApproverCombobox, getting out again', () => {
  it('closes on Escape without choosing anybody', async () => {
    const user = userEvent.setup({ delay: null })
    const { onChange } = renderCombobox()
    await openWithResults(user)

    await user.keyboard('{Escape}')

    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    // Escape must dismiss, never commit whatever happened to be highlighted.
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps that Escape to itself, so the form behind it does not close too', async () => {
    // This control is opened inside a long form and, on the detail screen,
    // inside a dialog. One Escape closing both would throw away everything
    // typed above it.
    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    try {
      const user = userEvent.setup({ delay: null })
      renderCombobox()
      await openWithResults(user)

      await user.keyboard('{Escape}')
      expect(outer).not.toHaveBeenCalled()

      // Once it is closed the key belongs to the form again.
      await user.keyboard('{Escape}')
      expect(outer).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', outer)
    }
  })

  it('closes when the pointer goes somewhere else on the page', async () => {
    const user = userEvent.setup({ delay: null })
    const { onChange } = renderCombobox()
    await openWithResults(user)

    await user.click(screen.getByRole('button', { name: 'Somewhere else' }))

    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('closes again when the control it was opened from is clicked a second time', async () => {
    // The panel covers the rest of the row. A trigger that only ever opens
    // leaves the one obvious way of dismissing it - click the thing you
    // clicked - doing nothing at all.
    const user = userEvent.setup({ delay: null })
    const { onChange } = renderCombobox()
    await openWithResults(user)

    await user.click(trigger())

    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('gives focus back to the control it opened from', async () => {
    // Closing drops the search field out of the DOM and focus lands on
    // `body`. A keyboard user is returned to the top of the document and has
    // to tab back through the whole form to reach step 3.
    const user = userEvent.setup({ delay: null })
    renderCombobox()
    await openWithResults(user)

    await user.keyboard('{Escape}')
    expect(trigger()).toHaveFocus()
  })
})

describe('ApproverCombobox, the option rows themselves', () => {
  it('draws every icon as decoration so no row is announced as a bare graphic', async () => {
    const user = userEvent.setup({ delay: null })
    renderCombobox({ value: BILAL.id, selected: BILAL })
    await openWithResults(user)

    const row = screen.getByRole('option', { name: /Bilal Ahmed/ })

    // A bare `<svg>` has no `img` role, so querying for one returned an empty
    // list and the loop over it asserted nothing whatever. Ask the DOM for the
    // icons instead, and prove there is one to check before checking it.
    const icons = [...row.querySelectorAll('svg')]
    expect(icons.length).toBeGreaterThan(0)
    for (const icon of icons) expect(icon).toHaveAttribute('aria-hidden', 'true')

    // The tick on the chosen row is decoration; `aria-selected` is what
    // actually carries "this is the one".
    expect(row).toHaveAttribute('aria-selected', 'true')
    // And the avatar disc is initials, which must not end up spoken as part
    // of the row. Anchored, so a leaked "BA" fails: what the option is called
    // is the name and the email and nothing else. (Loose about the space
    // between them - the DOM runs adjacent elements together, and how a
    // screen reader pauses is not this component's promise.)
    expect(row).toHaveAccessibleName(/^Bilal Ahmed\s*bilal\.ahmed@example\.com$/)
  })

  it('reads out the email as well as the name, so two Bilals can be told apart', async () => {
    const user = userEvent.setup({ delay: null })
    renderCombobox()
    await openWithResults(user)

    expect(screen.getByRole('option', { name: /Bilal Ahmed/ })).toHaveTextContent(
      'bilal.ahmed@example.com',
    )
  })

  it('marks an administrator account, which is rarely the right approver', async () => {
    const user = userEvent.setup({ delay: null })
    search.mockResolvedValue(
      page([person('u-root', 'Service', 'Account', null, { loginRole: 'ADMINISTRATOR' }), BILAL]),
    )
    renderCombobox()
    await user.click(trigger())

    const row = await screen.findByRole('option', { name: /Service Account/ })
    expect(row).toHaveTextContent('Admin')
    // And an ordinary account is not tagged. A marker on every row marks
    // nothing, and this one is the only warning before a document is routed
    // to a mailbox nobody reads.
    expect(screen.getByRole('option', { name: /Bilal Ahmed/ })).not.toHaveTextContent('Admin')
    // Somebody with no department still has to be filed somewhere the eye
    // can find them, rather than silently dropped from the grouped list.
    expect(screen.getByText('No department')).toBeInTheDocument()
  })
})

describe('when nobody matches', () => {
  /**
   * The one case this control could not help with.
   *
   * An approver who is not in the directory ended the search at "Nobody
   * matches X." and left. Getting past it meant abandoning the wizard for the
   * People screen, and the submit draft keeps the typed title but NOT the
   * attached PDF - so one missing person cost the whole upload. That is the
   * "separate tab" the feedback describes.
   */
  it('offers to add them, carrying across what was typed', async () => {
    const user = userEvent.setup({ delay: null })
    const onAddPerson = vi.fn()
    search.mockResolvedValue(page([]))
    renderCombobox({ canAddPerson: true, onAddPerson })

    await user.click(trigger())
    await user.type(searchField(), 'Zaraq Mahmood')

    const add = await screen.findByRole('button', {
      name: /Add “Zaraq Mahmood” as a new person/,
    })
    await user.click(add)

    // The query goes with it, so the dialog can prefill rather than making
    // somebody type the name they have already typed.
    expect(onAddPerson).toHaveBeenCalledWith('Zaraq Mahmood')
  })

  it('still says nobody matched, so the offer is not mistaken for a result', async () => {
    const user = userEvent.setup({ delay: null })
    search.mockResolvedValue(page([]))
    renderCombobox({ canAddPerson: true, onAddPerson: vi.fn() })

    await user.click(trigger())
    await user.type(searchField(), 'Zaraq')

    expect(await screen.findByText('Nobody matches “Zaraq”.')).toBeInTheDocument()
  })

  it('offers nothing to somebody who could not do it anyway', async () => {
    /*
     * Only an administrator may create a user - admin.routes.ts is
     * `router.use(authenticate, requireAdmin)` - so for a preparer this button
     * could only ever produce a 403. A control whose single outcome is a
     * refusal is worse than no control: it reads as a permission they have.
     */
    const user = userEvent.setup({ delay: null })
    search.mockResolvedValue(page([]))
    renderCombobox({ canAddPerson: false, onAddPerson: vi.fn() })

    await user.click(trigger())
    await user.type(searchField(), 'Zaraq')

    await screen.findByText('Nobody matches “Zaraq”.')
    expect(
      screen.queryByRole('button', { name: /as a new person/ }),
    ).not.toBeInTheDocument()
    // And it says who can, rather than leaving them at a dead end.
    expect(
      screen.getByText('Only an administrator can add someone new.'),
    ).toBeInTheDocument()
  })

  it('says nothing about adding anyone when the directory is simply empty', async () => {
    // No query means no name to add. "Add “” as a new person" is nonsense, and
    // the empty-directory case is a different problem from a failed search.
    const user = userEvent.setup({ delay: null })
    search.mockResolvedValue(page([]))
    renderCombobox({ canAddPerson: false, onAddPerson: vi.fn() })

    await user.click(trigger())

    expect(
      await screen.findByText('No people are available to assign.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Only an administrator can add someone new.'),
    ).not.toBeInTheDocument()
  })

  it('leaves the picker alone when no handler was given', async () => {
    // `canAddPerson` without a handler must not render a button that does
    // nothing when pressed.
    const user = userEvent.setup({ delay: null })
    search.mockResolvedValue(page([]))
    renderCombobox({ canAddPerson: true })

    await user.click(trigger())
    await user.type(searchField(), 'Zaraq')

    await screen.findByText('Nobody matches “Zaraq”.')
    expect(
      screen.queryByRole('button', { name: /as a new person/ }),
    ).not.toBeInTheDocument()
  })
})
