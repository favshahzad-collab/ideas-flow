import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDepartment,
  deleteDepartment,
  fetchDepartments,
  updateDepartment,
  type Department,
} from '../../services/AdminApi'
import DepartmentsCard from './DepartmentsCard'

/**
 * The screen that stopped departments being a database job.
 *
 * Reading the list was the entire department capability in this product: they
 * came from the seed script or from SQL, and a person cannot be created
 * without one, so onboarding somebody into a new team was blocked on an
 * engineer with server access.
 *
 * What the tests are really about is the difference between the three actions.
 * Renaming carries everybody with it. Switching off keeps the people and stops
 * the department being offered to anybody new. Deleting is only ever possible
 * while nobody is in it — and the screen must not offer it otherwise, because
 * the server will refuse and a button whose only outcome is a refusal reads as
 * a permission somebody has.
 */

vi.mock('../../services/AdminApi', () => ({
  fetchDepartments: vi.fn(),
  createDepartment: vi.fn(),
  updateDepartment: vi.fn(),
  deleteDepartment: vi.fn(),
}))

const list = vi.mocked(fetchDepartments)
const create = vi.mocked(createDepartment)
const update = vi.mocked(updateDepartment)
const remove = vi.mocked(deleteDepartment)

const department = (overrides: Partial<Department> = {}): Department => ({
  id: 'd-finance',
  name: 'Finance',
  isActive: true,
  userCount: 3,
  ...overrides,
})

const EMPTY = department({ id: 'd-new', name: 'Internal Audit', userCount: 0 })
const OFF = department({ id: 'd-off', name: 'Dissolved Unit', userCount: 0, isActive: false })

beforeEach(() => {
  list.mockReset()
  create.mockReset()
  update.mockReset()
  remove.mockReset()
  list.mockResolvedValue([department()])
})

describe('what it shows', () => {
  it('lists each department with how many people are in it', async () => {
    list.mockResolvedValue([department(), EMPTY])
    render(<DepartmentsCard />)

    expect(await screen.findByText('Finance')).toBeInTheDocument()
    expect(screen.getByText('3 people')).toBeInTheDocument()
    expect(screen.getByText('Nobody in it')).toBeInTheDocument()
  })

  it('counts one person as a person', async () => {
    list.mockResolvedValue([department({ userCount: 1 })])
    render(<DepartmentsCard />)

    expect(await screen.findByText('1 person')).toBeInTheDocument()
  })

  it('asks for the switched-off ones too', async () => {
    // A department nobody can see is a department nobody can turn back on.
    render(<DepartmentsCard />)

    await waitFor(() =>
      expect(list).toHaveBeenCalledWith({ includeInactive: true }),
    )
  })

  it('says a department is switched off in words, not only by dimming it', async () => {
    // Colour alone is not a state anybody can rely on reading.
    list.mockResolvedValue([OFF])
    render(<DepartmentsCard />)

    expect(await screen.findByText(/Switched off/)).toBeInTheDocument()
  })

  it('explains the empty case rather than showing a blank panel', async () => {
    /*
     * The state that blocks everything else on the screen: no department means
     * no people, because every person belongs to one. Saying so beats an empty
     * box that looks like a loading failure.
     */
    list.mockResolvedValue([])
    render(<DepartmentsCard />)

    expect(
      await screen.findByText(/Nobody can be added to the directory/),
    ).toBeInTheDocument()
  })

  it('says so when the list will not load', async () => {
    list.mockRejectedValue(new Error('Network request failed'))
    render(<DepartmentsCard />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Network request failed')
  })
})

describe('adding one', () => {
  it('creates it and re-reads the list', async () => {
    const user = userEvent.setup({ delay: null })
    create.mockResolvedValue(EMPTY)
    render(<DepartmentsCard />)

    await user.click(await screen.findByRole('button', { name: 'Add' }))
    await user.type(screen.getByLabelText('New department name'), 'Internal Audit')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(create).toHaveBeenCalledWith('Internal Audit'))
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('tells the rest of the screen, so the user form offers it immediately', async () => {
    /*
     * The user form's dropdown is built from the same list. Without this the
     * department somebody just added is missing from the form until the page
     * is reloaded - and the person who added it is, by definition, about to
     * use it.
     */
    const user = userEvent.setup({ delay: null })
    const onChanged = vi.fn()
    create.mockResolvedValue(EMPTY)
    render(<DepartmentsCard onChanged={onChanged} />)

    await user.click(await screen.findByRole('button', { name: 'Add' }))
    await user.type(screen.getByLabelText('New department name'), 'Internal Audit')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('hands over the server\'s refusal for a name already taken', async () => {
    // "A department called Finance already exists" is actionable. "Request
    // failed" is not.
    const user = userEvent.setup({ delay: null })
    create.mockRejectedValue(
      new Error('A department called "Finance" already exists.'),
    )
    render(<DepartmentsCard />)

    await user.click(await screen.findByRole('button', { name: 'Add' }))
    await user.type(screen.getByLabelText('New department name'), 'finance')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(
      await screen.findByText(/A department called "Finance" already exists/),
    ).toBeInTheDocument()
  })

  it('will not submit an empty name', async () => {
    const user = userEvent.setup({ delay: null })
    render(<DepartmentsCard />)

    await user.click(await screen.findByRole('button', { name: 'Add' }))

    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
    expect(create).not.toHaveBeenCalled()
  })
})

describe('renaming one', () => {
  it('renames it', async () => {
    const user = userEvent.setup({ delay: null })
    update.mockResolvedValue(department({ name: 'Group Finance' }))
    render(<DepartmentsCard />)

    await user.click(await screen.findByRole('button', { name: 'Rename Finance' }))
    const field = screen.getByLabelText('New name for Finance')
    await user.clear(field)
    await user.type(field, 'Group Finance')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('d-finance', { name: 'Group Finance' }),
    )
  })

  it('arrives holding the current name, so a small correction is small', async () => {
    const user = userEvent.setup({ delay: null })
    render(<DepartmentsCard />)

    await user.click(await screen.findByRole('button', { name: 'Rename Finance' }))

    expect(screen.getByLabelText('New name for Finance')).toHaveValue('Finance')
  })

  it('does nothing when the name has not changed', async () => {
    // Renaming Finance to Finance is not a request to do anything, and sending
    // it would spend an audit row saying nothing happened.
    const user = userEvent.setup({ delay: null })
    render(<DepartmentsCard />)

    await user.click(await screen.findByRole('button', { name: 'Rename Finance' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(update).not.toHaveBeenCalled()
  })

  it('can be abandoned', async () => {
    const user = userEvent.setup({ delay: null })
    render(<DepartmentsCard />)

    await user.click(await screen.findByRole('button', { name: 'Rename Finance' }))
    await user.click(screen.getByRole('button', { name: 'Cancel rename' }))

    expect(screen.queryByLabelText('New name for Finance')).not.toBeInTheDocument()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('switching one off', () => {
  it('switches it off without touching the people in it', async () => {
    /*
     * This is what "delete" means for a department with people in it. Their
     * accounts keep pointing at it and every memo they approved still names
     * it; it simply stops being offered for anything new.
     */
    const user = userEvent.setup({ delay: null })
    update.mockResolvedValue(department({ isActive: false }))
    render(<DepartmentsCard />)

    await user.click(await screen.findByRole('button', { name: 'Switch off Finance' }))

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('d-finance', { isActive: false }),
    )
  })

  it('offers to switch a dormant one back on', async () => {
    const user = userEvent.setup({ delay: null })
    list.mockResolvedValue([OFF])
    update.mockResolvedValue(department({ ...OFF, isActive: true }))
    render(<DepartmentsCard />)

    await user.click(
      await screen.findByRole('button', { name: 'Switch on Dissolved Unit' }),
    )

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('d-off', { isActive: true }),
    )
  })
})

describe('deleting one', () => {
  it('is not offered while anybody is in it', async () => {
    /*
     * `departmentId` is required on a user, so the server refuses this and
     * always will. Rendering the button anyway would read as a permission
     * somebody has, and spend a click to find out they do not.
     */
    list.mockResolvedValue([department({ userCount: 3 })])
    render(<DepartmentsCard />)

    await screen.findByText('Finance')
    expect(
      screen.queryByRole('button', { name: 'Delete Finance' }),
    ).not.toBeInTheDocument()
  })

  it('is offered once it is empty', async () => {
    list.mockResolvedValue([EMPTY])
    render(<DepartmentsCard />)

    expect(
      await screen.findByRole('button', { name: 'Delete Internal Audit' }),
    ).toBeInTheDocument()
  })

  it('asks before removing it, and names the alternative', async () => {
    const user = userEvent.setup({ delay: null })
    list.mockResolvedValue([EMPTY])
    render(<DepartmentsCard />)

    await user.click(
      await screen.findByRole('button', { name: 'Delete Internal Audit' }),
    )

    expect(screen.getByRole('dialog')).toHaveTextContent(/switch it off instead/i)
    expect(remove).not.toHaveBeenCalled()
  })

  it('removes it once confirmed', async () => {
    const user = userEvent.setup({ delay: null })
    list.mockResolvedValue([EMPTY])
    remove.mockResolvedValue({ id: EMPTY.id, name: EMPTY.name })
    render(<DepartmentsCard />)

    await user.click(
      await screen.findByRole('button', { name: 'Delete Internal Audit' }),
    )
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(remove).toHaveBeenCalledWith('d-new'))
  })

  it('shows the server\'s refusal if it turns out not to be empty after all', async () => {
    /*
     * The count on screen can be a moment out of date - somebody else may have
     * moved a person into it since this list was read. The server is the one
     * that knows, and its sentence carries the number.
     */
    const user = userEvent.setup({ delay: null })
    list.mockResolvedValue([EMPTY])
    remove.mockRejectedValue(
      new Error('Internal Audit still has 2 people in it. Move them first...'),
    )
    render(<DepartmentsCard />)

    await user.click(
      await screen.findByRole('button', { name: 'Delete Internal Audit' }),
    )
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText(/still has 2 people in it/)).toBeInTheDocument()
  })
})
