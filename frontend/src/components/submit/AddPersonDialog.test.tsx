import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createUser, fetchDepartments } from '../../services/AdminApi'
import type { User } from '../../types/admin'
import { splitTypedName } from '../../utils/user'
import AddPersonDialog from './AddPersonDialog'

/**
 * Adding an approver without leaving the submission.
 *
 * This dialog exists because the picker used to end at "Nobody matches X."
 * and the only way past was the People screen — which costs the attached PDF,
 * since the submit draft keeps the typed fields and not the file. So the
 * questions here are: does it create the right person, does it refuse to
 * create a half-formed one, and does it tell the truth about what creating an
 * account does and does not do.
 *
 * The API module is mocked rather than `fetch`: this component's contract is
 * "ask AdminApi to create a user", and stubbing the network would also be
 * asserting on the URL builder, which is not this component's job.
 */

vi.mock('../../services/AdminApi', () => ({
  createUser: vi.fn(),
  fetchDepartments: vi.fn(),
}))

const create = vi.mocked(createUser)
const departments = vi.mocked(fetchDepartments)

const FINANCE = { id: 'd-finance', name: 'Finance', isActive: true, userCount: 4 }
const LEGAL = { id: 'd-legal', name: 'Legal', isActive: true, userCount: 2 }

const created = (overrides: Partial<User> = {}): User => ({
  id: 'u-new',
  email: 'zaraq.mahmood@example.com',
  firstName: 'Zaraq',
  lastName: 'Mahmood',
  loginRole: 'USER',
  designation: null,
  department: FINANCE,
  openApprovals: 0,
  deactivatedAt: null,
  coveredBy: null,
  createdAt: '2026-09-09T00:00:00.000Z',
  updatedAt: '2026-09-09T00:00:00.000Z',
  ...overrides,
})

beforeEach(() => {
  create.mockReset()
  departments.mockReset()
  departments.mockResolvedValue([FINANCE, LEGAL])
})

function renderDialog(query = 'Zaraq Mahmood') {
  const onClose = vi.fn()
  const onCreated = vi.fn()
  const view = render(
    <AddPersonDialog open query={query} onClose={onClose} onCreated={onCreated} />,
  )
  return { ...view, onClose, onCreated, user: userEvent.setup({ delay: null }) }
}

const field = (name: RegExp | string) => screen.getByLabelText(name)

describe('splitTypedName', () => {
  it('splits a typed name so nobody retypes what they just typed', () => {
    expect(splitTypedName('Zaraq Mahmood')).toEqual({
      firstName: 'Zaraq',
      lastName: 'Mahmood',
      email: '',
    })
  })

  it('keeps a surname whole when there is a middle name', () => {
    // "Muhammad Zaraq Mahmood" losing "Mahmood" would put the wrong name under
    // a signature on an approved memo.
    expect(splitTypedName('Muhammad Zaraq Mahmood')).toEqual({
      firstName: 'Muhammad',
      lastName: 'Zaraq Mahmood',
      email: '',
    })
  })

  it('treats an address as an address, not a first name', () => {
    expect(splitTypedName('zaraq@example.com')).toEqual({
      firstName: '',
      lastName: '',
      email: 'zaraq@example.com',
    })
  })

  it('copes with one word, and with nothing at all', () => {
    expect(splitTypedName('Zaraq')).toEqual({ firstName: 'Zaraq', lastName: '', email: '' })
    expect(splitTypedName('   ')).toEqual({ firstName: '', lastName: '', email: '' })
  })
})

describe('what it arrives holding', () => {
  it('carries the search across so the name is already there', async () => {
    renderDialog('Zaraq Mahmood')

    expect(await screen.findByDisplayValue('Zaraq')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Mahmood')).toBeInTheDocument()
  })

  it('offers the departments the organisation actually has', async () => {
    renderDialog()

    await waitFor(() => expect(departments).toHaveBeenCalled())
    expect(await screen.findByRole('option', { name: 'Finance' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Legal' })).toBeInTheDocument()
  })

  it('chooses for them when there is only one department', async () => {
    // One option is not a choice; making them open a select to pick the only
    // possible answer is friction with no decision in it.
    departments.mockResolvedValue([FINANCE])
    renderDialog()

    await waitFor(() =>
      expect(field(/Department/)).toHaveValue(FINANCE.id),
    )
  })

  it('says plainly that creating an account sends nothing', async () => {
    /*
     * The assumption worth breaking. There is no invitation email in this
     * product, so an administrator who does not pass the password on has made
     * an approver who cannot sign in — and the memo then waits on somebody who
     * does not know it exists and could not open it if they did.
     */
    renderDialog()

    expect(
      await screen.findByText(/No invitation email is sent/i),
    ).toBeInTheDocument()
  })
})

describe('what it refuses to create', () => {
  it('will not make a person with no email', async () => {
    const { user, onCreated } = renderDialog()
    await screen.findByRole('option', { name: 'Finance' })

    await user.selectOptions(field(/Department/), FINANCE.id)
    await user.type(field(/Temporary password/), 'temporary-pass-9')
    await user.click(screen.getByRole('button', { name: 'Add and assign' }))

    expect(await screen.findByText('Email is required')).toBeInTheDocument()
    expect(create).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('will not accept something that is not an address', async () => {
    // The address is where every approval notice for this person goes. A typo
    // here is a memo that waits on somebody who is never told.
    const { user } = renderDialog()
    await screen.findByRole('option', { name: 'Finance' })

    await user.type(field(/Work email/), 'zaraq.at.example.com')
    await user.selectOptions(field(/Department/), FINANCE.id)
    await user.type(field(/Temporary password/), 'temporary-pass-9')
    await user.click(screen.getByRole('button', { name: 'Add and assign' }))

    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument()
    expect(create).not.toHaveBeenCalled()
  })

  it('holds the same password floor the API does', async () => {
    // Six characters, matching admin.schema.ts. A form that accepts less just
    // moves the refusal to the server after everything is typed.
    const { user } = renderDialog()
    await screen.findByRole('option', { name: 'Finance' })

    await user.type(field(/Work email/), 'zaraq@example.com')
    await user.selectOptions(field(/Department/), FINANCE.id)
    await user.type(field(/Temporary password/), 'abc')
    await user.click(screen.getByRole('button', { name: 'Add and assign' }))

    expect(
      await screen.findByText('Password must be at least 12 characters'),
    ).toBeInTheDocument()
    expect(create).not.toHaveBeenCalled()
  })

  it('will not make a person with no name', async () => {
    const { user } = renderDialog('')
    await screen.findByRole('option', { name: 'Finance' })

    await user.type(field(/Work email/), 'zaraq@example.com')
    await user.selectOptions(field(/Department/), FINANCE.id)
    await user.type(field(/Temporary password/), 'temporary-pass-9')
    await user.click(screen.getByRole('button', { name: 'Add and assign' }))

    expect(await screen.findByText('First name is required')).toBeInTheDocument()
    expect(create).not.toHaveBeenCalled()
  })

  it('says so when there is no department to put anybody in', async () => {
    /*
     * A person must belong to a department and the API refuses without one, so
     * on an organisation with none this dialog cannot succeed. Saying that up
     * front — and naming the screen that fixes it — beats a 400 after
     * everything has been typed.
     */
    departments.mockResolvedValue([])
    const { user } = renderDialog()

    expect(
      await screen.findByText(/no departments to put them in/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add and assign' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Add and assign' }))
    expect(create).not.toHaveBeenCalled()
  })
})

describe('creating them', () => {
  const fillValid = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByRole('option', { name: 'Finance' })
    await user.type(field(/Work email/), 'zaraq.mahmood@example.com')
    await user.selectOptions(field(/Department/), FINANCE.id)
    await user.type(field(/Designation/), 'Manager, Finance')
    await user.type(field(/Temporary password/), 'temporary-pass-9')
  }

  it('sends exactly what was filled in', async () => {
    create.mockResolvedValue(created())
    const { user } = renderDialog()

    await fillValid(user)
    await user.click(screen.getByRole('button', { name: 'Add and assign' }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        firstName: 'Zaraq',
        lastName: 'Mahmood',
        email: 'zaraq.mahmood@example.com',
        password: 'temporary-pass-9',
        departmentId: FINANCE.id,
        designation: 'Manager, Finance',
        loginRole: 'USER',
      }),
    )
  })

  it('never makes an administrator', async () => {
    /*
     * Deliberately not offered. Granting administrator is a privilege
     * decision - it hands somebody every document in the organisation and the
     * People screen with it - and a submission wizard is the wrong place to
     * take it silently. The People screen exists for that and shows what the
     * role means.
     */
    create.mockResolvedValue(created())
    const { user } = renderDialog()

    await fillValid(user)
    expect(screen.queryByLabelText(/role/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add and assign' }))

    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0][0].loginRole).toBe('USER')
  })

  it('hands the new person back ready to drop into the step', async () => {
    create.mockResolvedValue(created())
    const { user, onCreated } = renderDialog()

    await fillValid(user)
    await user.click(screen.getByRole('button', { name: 'Add and assign' }))

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({
        id: 'u-new',
        email: 'zaraq.mahmood@example.com',
        firstName: 'Zaraq',
        lastName: 'Mahmood',
        loginRole: 'USER',
        department: { name: 'Finance' },
      }),
    )
  })

  it('says what went wrong instead of closing on a failure', async () => {
    // Closing here would look like success and leave the step empty, which is
    // discovered at the sign step or not at all.
    create.mockRejectedValue(new Error('A user with this email already exists'))
    const { user, onCreated, onClose } = renderDialog()

    await fillValid(user)
    await user.click(screen.getByRole('button', { name: 'Add and assign' }))

    expect(
      await screen.findByText('A user with this email already exists'),
    ).toBeInTheDocument()
    expect(onCreated).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('lets them try again after a refusal', async () => {
    create.mockRejectedValueOnce(new Error('A user with this email already exists'))
    const { user } = renderDialog()

    await fillValid(user)
    await user.click(screen.getByRole('button', { name: 'Add and assign' }))
    await screen.findByText('A user with this email already exists')

    // The button must come back, or the only way out is to close and lose the
    // typing.
    expect(screen.getByRole('button', { name: 'Add and assign' })).toBeEnabled()
  })
})
