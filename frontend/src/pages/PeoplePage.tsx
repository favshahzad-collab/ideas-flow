import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Download, Eye, EyeOff, Plus, Search, Upload } from 'lucide-react'
import { Page, PageHeader } from '../components/ui/Page'
import { LoadingAnnouncer } from '../components/ui/Skeleton'
import Button from '../components/ui/Button'
import Modal from '../components/Modal.tsx'
import PeopleTable from '../components/people/PeopleTable'
import DelegationPanel from '../components/people/DelegationPanel'
import HoldsPanel from '../components/people/HoldsPanel'
import SwitchAccountDialog from '../components/people/SwitchAccountDialog'
import AdminPowersDialog from '../components/people/AdminPowersDialog'
import DepartmentsCard from '../components/people/DepartmentsCard'
import PeopleTabs from '../components/people/PeopleTabs'
import { FEATURES } from '../config/features'
import {
  bulkCreateUsers,
  createUser,
  downloadUserImportTemplate,
  fetchDepartments,
  fetchUsers,
  resetUserTwoFactor,
  updateUser,
} from '../services/AdminApi.ts'
import { fetchSsoAvailable } from '../services/authApi'
import { useCurrentUser } from '../contexts/currentUser'
import { peopleEyebrow } from '../utils/people'
import type { BulkUserImportResult, User } from '../types/admin.ts'
import { ROUTES } from '../types/routes'
import { PASSWORD_MIN_LENGTH } from '../utils/passwordRule'
import type { Department } from '../services/AdminApi.ts'

type UserForm = {
  firstName: string
  lastName: string
  /** Optional: a person whose title is not yet recorded is not an error. */
  designation: string
  email: string
  password: string
  departmentId: string
  /** Empty for nobody recorded. */
  lineManagerId: string
  role: string
}

type UserFormErrors = Partial<Record<keyof UserForm, string>>

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validateUserForm(form: UserForm, isEdit: boolean): UserFormErrors {
  const errors: UserFormErrors = {}

  if (!form.firstName.trim()) {
    errors.firstName = 'First name is required'
  }
  if (!form.lastName.trim()) {
    errors.lastName = 'Last name is required'
  }
  if (!form.email.trim()) {
    errors.email = 'Email is required'
  } else if (!EMAIL_PATTERN.test(form.email.trim())) {
    errors.email = 'Enter a valid email address'
  }
  if (!isEdit && !form.password) {
    errors.password = 'Password is required'
  } else if (form.password && form.password.length < PASSWORD_MIN_LENGTH) {
    errors.password = `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
  }
  if (!form.departmentId) {
    errors.departmentId = 'Department is required'
  }

  return errors
}

function fieldFromApiMessage(message: string): keyof UserForm | null {
  const lower = message.toLowerCase()
  if (lower.includes('first name')) return 'firstName'
  if (lower.includes('last name')) return 'lastName'
  if (lower.includes('designation')) return 'designation'
  if (lower.includes('email')) return 'email'
  if (lower.includes('password')) return 'password'
  if (lower.includes('line manager')) return 'lineManagerId'
  if (lower.includes('department')) return 'departmentId'
  if (lower.includes('role')) return 'role'
  return null
}

function inputClass(hasError: boolean) {
  return `field h-9 ${hasError ? 'border-danger bg-danger-soft/40 hover:border-danger' : ''}`
}

export default function PeoplePage() {
  /* Only to find your own row in the table, which is the one row whose
     two-step sign-in you can do anything about. */
  const { user: signedInUser } = useCurrentUser()
  const [search, setSearch] = useState('')
  const [users, setUsers] = useState<User[]>([])
  const [departments, setDepartments] = useState<Department[]>([])

  const [addUserModal, setAddUserModal] = useState(false)
  const [editingUser, setEditingUser] = useState<User | null>(null)
  const [resettingTwoFactor, setResettingTwoFactor] = useState<User | null>(null)
  /* Who is being switched off or back on, and which way round. Held together
     because the dialog is one dialog: the question it asks differs, but the
     decision and the button are the same shape either way. */
  /** The administrator whose powers are being set, by a Super Administrator. */
  const [settingPowers, setSettingPowers] = useState<User | null>(null)
  const [switching, setSwitching] = useState<{ user: User; active: boolean } | null>(
    null,
  )
  const [resetLoading, setResetLoading] = useState(false)
  const [resetError, setResetError] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  /*
   * Whether this deployment offers Microsoft sign-in, which decides whether a
   * row in the import may leave its password blank. Asked of the server
   * rather than assumed: the answer lives in a database row an administrator
   * can change on the Single sign-on screen, so a build-time guess would go
   * stale the moment they did.
   *
   * Defaults to false, which is the safe way round - the copy then asks for a
   * password, and a password always works.
   */
  const [microsoftSignIn, setMicrosoftSignIn] = useState(false)

  useEffect(() => {
    let cancelled = false

    fetchSsoAvailable()
      .then(available => {
        if (!cancelled) setMicrosoftSignIn(available)
      })
      .catch(() => {
        /* `fetchSsoAvailable` answers false rather than throwing. */
      })

    return () => {
      cancelled = true
    }
  }, [])

  const [importModal, setImportModal] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importLoading, setImportLoading] = useState(false)
  const [importError, setImportError] = useState('')
  const [importResult, setImportResult] = useState<BulkUserImportResult | null>(null)
  const [formErrors, setFormErrors] = useState<UserFormErrors>({})
  const [saveError, setSaveError] = useState('')
  const [saveLoading, setSaveLoading] = useState(false)
  const [usersLoading, setUsersLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  /*
   * Re-read after the departments card changes anything.
   *
   * The user form's dropdown is built from this list, so without a refresh a
   * department added on the left is missing from the form on the right until
   * the page is reloaded - and the person who just added it is, by definition,
   * about to use it.
   */
  const loadDepartments = useCallback(async () => {
    try {
      setDepartments(await fetchDepartments())
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Failed to load departments',
      )
    }
  }, [])
  /* Stored as an id, not the object: an edit or an import replaces every row
     in `users`, and a held object would go on describing the old one. */
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    // Both failures used to go to `console.error` alone, so a failed load
    // left an empty table that was indistinguishable from an organisation
    // with no users in it.
    fetchUsers()
      .then(setUsers)
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'Failed to load users')
      })
      .finally(() => setUsersLoading(false))

    fetchDepartments()
      .then(setDepartments)
      .catch((error: unknown) => {
        setLoadError(
          error instanceof Error ? error.message : 'Failed to load departments',
        )
      })
  }, [])

  const [form, setForm] = useState<UserForm>({
    firstName: '',
    lastName: '',
    designation: '',
    email: '',
    password: '',
    departmentId: '',
    lineManagerId: '',
    role: 'USER',
  })

  const query = search.trim().toLowerCase()
  const filteredUsers = query
    ? users.filter(
        user =>
          `${user.firstName} ${user.lastName}`.toLowerCase().includes(query) ||
          user.email.toLowerCase().includes(query) ||
          (user.department?.name ?? '').toLowerCase().includes(query),
      )
    : users

  const selectedPerson = users.find(user => user.id === selectedId) ?? null

  const handleAddUser = () => {
    setEditingUser(null)
    setShowPassword(false)
    setFormErrors({})
    setSaveError('')
    setForm({
      firstName: '',
      lastName: '',
      designation: '',
      email: '',
      password: '',
      departmentId: departments[0]?.id ?? '',
      lineManagerId: '',
      role: 'USER',
    })
    setAddUserModal(true)
  }

  const handleEditUser = (user: User) => {
    setEditingUser(user)
    setShowPassword(false)
    setFormErrors({})
    setSaveError('')
    setForm({
      firstName: user.firstName,
      lastName: user.lastName,
      designation: user.designation ?? '',
      email: user.email,
      password: '',
      departmentId: user.department.id,
      lineManagerId: user.lineManagerId ?? '',
      role: user.loginRole,
    })
    setAddUserModal(true)
  }

  /**
   * The departments this form may offer, plus the one the person is already in.
   *
   * The list is active-only, correctly - a department that has been switched
   * off must not be offered for a new assignment. But somebody who was already
   * in it when it was switched off still is, and without their department in
   * the options the select renders with nothing chosen: it reads as "Select a
   * department" for a person who plainly has one, and the moment anybody
   * touches the dropdown their real department is gone.
   *
   * So it is added back, once, labelled for what it is.
   */
  const departmentOptions = useMemo(() => {
    const current = editingUser?.department
    if (!current || departments.some(department => department.id === current.id)) {
      return departments.map(department => ({ ...department, retired: false }))
    }

    return [
      ...departments.map(department => ({ ...department, retired: false })),
      { id: current.id, name: current.name, isActive: false, userCount: 0, retired: true },
    ]
  }, [departments, editingUser])

  const updateFormField = <K extends keyof UserForm>(field: K, value: UserForm[K]) => {
    setForm(prev => ({ ...prev, [field]: value }))
    setFormErrors(prev => ({ ...prev, [field]: undefined }))
    setSaveError('')
  }

  const handleSaveUser = async () => {
    const errors = validateUserForm(form, Boolean(editingUser))
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors)
      setSaveError('Please fix the highlighted fields and try again.')
      return
    }

    setSaveLoading(true)
    setSaveError('')
    setFormErrors({})

    try {
      if (editingUser) {
        await updateUser(editingUser.id, {
          email: form.email.trim(),
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          designation: form.designation.trim(),
          departmentId: form.departmentId,
          lineManagerId: form.lineManagerId || null,
          loginRole: form.role,
          ...(form.password ? { password: form.password } : {}),
        })
      } else {
        await createUser({
          email: form.email.trim(),
          password: form.password,
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          designation: form.designation.trim(),
          departmentId: form.departmentId,
          ...(form.lineManagerId ? { lineManagerId: form.lineManagerId } : {}),
          loginRole: form.role,
        })
      }

      try {
        const updatedUsers = await fetchUsers()
        setUsers(updatedUsers)
      } catch {
        // User was saved; list refresh can fail independently.
      }

      setAddUserModal(false)
      setEditingUser(null)
      setShowPassword(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save user'
      const field = fieldFromApiMessage(message)
      if (field) {
        setFormErrors({ [field]: message })
      }
      setSaveError(message)
    } finally {
      setSaveLoading(false)
    }
  }

  const handleOpenImport = () => {
    setImportFile(null)
    setImportError('')
    setImportResult(null)
    setImportModal(true)
  }

  const handleImportUsers = async () => {
    if (!importFile) {
      setImportError('Please choose a .csv or .xlsx file to import.')
      return
    }

    setImportLoading(true)
    setImportError('')
    setImportResult(null)

    try {
      const result = await bulkCreateUsers(importFile)
      setImportResult(result)

      if (result.created > 0) {
        const updatedUsers = await fetchUsers()
        setUsers(updatedUsers)
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to import users')
    } finally {
      setImportLoading(false)
    }
  }

  /**
   * Lift somebody's second factor.
   *
   * Asked for by name rather than done from the menu, because it is also
   * exactly what somebody with a stolen administrator session would reach
   * for - and because the person on the other end stops being protected by
   * it the moment this returns. The audit trail records it either way.
   */
  const confirmResetTwoFactor = async () => {
    if (!resettingTwoFactor) return

    setResetLoading(true)
    setResetError('')

    try {
      await resetUserTwoFactor(resettingTwoFactor.id)
      setUsers(await fetchUsers())
      setResettingTwoFactor(null)
    } catch (err) {
      setResetError(
        err instanceof Error
          ? err.message
          : 'Could not turn off two-step sign-in.'
      )
    } finally {
      setResetLoading(false)
    }
  }

  /*
   * People only. This used to also print a department count taken from the
   * DEPARTMENTS THE LISTED PEOPLE ARE IN, which is not what the word means
   * beside it: on a fresh install it read "1 person · 1 department" while the
   * Departments card in the same sidebar said 37, and the obvious reading of
   * that is that the department list failed to load. One number, one owner -
   * the card owns departments.
   */
  /* `peopleEyebrow` owns the wording and the rule about when the two-step
     figure appears; it is the only security number this application prints,
     so it is tested on its own rather than inside a page mount. */
  const eyebrow = peopleEyebrow(users, usersLoading)

  return (
    <Page>
      <PageHeader
        title="People & delegation"
        eyebrow={eyebrow}
        actions={
          <>
            <Button variant="secondary" icon={<Upload size={15} />} onClick={handleOpenImport}>
              Import
            </Button>
            <Button icon={<Plus size={15} />} onClick={handleAddUser}>
              Add person
            </Button>
          </>
        }
      />

      <PeopleTabs />

      {/* Two columns: the people, and the things that are true about them
          collectively - who is covering for whom, and whether the notices
          this system sends are arriving. */}
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="card overflow-hidden">
          <div className="flex flex-col gap-2.5 border-b border-line-soft px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:w-64">
              <label htmlFor="admin-user-search" className="sr-only">
                Search people
              </label>
              <Search
                size={14}
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-subtle"
              />
              <input
                id="admin-user-search"
                type="search"
                autoComplete="off"
                name="user-search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search people…"
                className="field h-8.5 bg-sunken pl-8.5"
              />
            </div>

            <p className="font-mono text-data uppercase tracking-eyebrow text-content-subtle">
              {filteredUsers.length} shown
            </p>
          </div>

          <PeopleTable
            users={filteredUsers}
            loading={usersLoading}
            loadError={loadError}
            search={search}
            selectedId={selectedId}
            onSelect={user => setSelectedId(user.id)}
            onEdit={handleEditUser}
            currentUserId={signedInUser?.id ?? null}
            onResetTwoFactor={user => {
              setResetError('')
              setResettingTwoFactor(user)
            }}
            onSetActive={(user, active) => setSwitching({ user, active })}
            // Super Administrators only: nobody else may change what an
            // administrator can do.
            onSetPowers={signedInUser?.isSuperAdmin ? setSettingPowers : undefined}
          />
        </div>

        <div className="flex flex-col gap-4">
          {FEATURES.delegation && (
            <DelegationPanel
              person={selectedPerson}
              colleagues={users.filter(user => user.id !== selectedId)}
              actingUserId={signedInUser?.id}
              // Saving or ending a delegation changes whose desk the waiting
              // approvals are on, which is a column in the table beside it.
              onChange={() => {
                void fetchUsers()
                  .then(setUsers)
                  .catch(() => {
                    // The panel has already reported anything that failed; a
                    // stale queue count is not worth a second error banner.
                  })
              }}
            />
          )}

          {/* Directly under the delegation panel, because the two answer one
              question between them: what is waiting on this person, and who
              else could take it. */}
          <HoldsPanel person={selectedPerson} />

          {/* Above the mail card because it is the one somebody needs
              first: no department means no people, and no people means
              nothing else on this screen does anything. */}
          <DepartmentsCard onChanged={() => void loadDepartments()} />
        </div>
      </div>

      <LoadingAnnouncer
        loading={usersLoading}
        label="Loading people"
        doneLabel={loadError ? loadError : `${filteredUsers.length} people loaded`}
      />

      <Modal
        open={addUserModal}
        onClose={() => {
          if (saveLoading) return
          setAddUserModal(false)
          setShowPassword(false)
          setFormErrors({})
          setSaveError('')
        }}
        title={editingUser ? 'Edit person' : 'Add person'}
        size="md"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="admin-first-name" className="field-label">
                First name
              </label>
              <input
                type="text"
                id="admin-first-name"
                value={form.firstName}
                onChange={e => updateFormField('firstName', e.target.value)}
                placeholder="First name"
                className={inputClass(Boolean(formErrors.firstName))}
              />
              {formErrors.firstName && (
                <p className="field-error">{formErrors.firstName}</p>
              )}
            </div>
            <div>
              <label htmlFor="admin-last-name" className="field-label">
                Last name
              </label>
              <input
                type="text"
                id="admin-last-name"
                value={form.lastName}
                onChange={e => updateFormField('lastName', e.target.value)}
                placeholder="Last name"
                className={inputClass(Boolean(formErrors.lastName))}
              />
              {formErrors.lastName && (
                <p className="field-error">{formErrors.lastName}</p>
              )}
            </div>
          </div>

          <div>
            <label htmlFor="admin-designation" className="field-label">
              Designation
            </label>
            {/* Printed under this person's signature on every memo they sign.
                Optional: a title not yet recorded is a gap in the record, not
                a reason to refuse the account. */}
            <input
              type="text"
              id="admin-designation"
              value={form.designation}
              onChange={e => updateFormField('designation', e.target.value)}
              placeholder="e.g. Manager, Finance"
              maxLength={120}
              className={inputClass(Boolean(formErrors.designation))}
            />
            {formErrors.designation && (
              <p className="field-error">{formErrors.designation}</p>
            )}
          </div>

          <div>
            <label htmlFor="admin-email" className="field-label">
              Email address
            </label>
            <input
              type="email"
              id="admin-email"
              value={form.email}
              onChange={e => updateFormField('email', e.target.value)}
              placeholder="user@company.com"
              className={inputClass(Boolean(formErrors.email))}
            />
            {formErrors.email && <p className="field-error">{formErrors.email}</p>}
          </div>

          <div>
            <label htmlFor="admin-password" className="field-label">
              Password
              {editingUser && (
                <span className="font-normal text-content-subtle"> (optional)</span>
              )}
            </label>
            <div className="relative">
              <input
                id="admin-password"
                type={showPassword ? 'text' : 'password'}
                value={form.password}
                onChange={e => updateFormField('password', e.target.value)}
                autoComplete="new-password"
                placeholder={
                  editingUser
                    ? 'Leave blank to keep current password'
                    : `Enter password (min. ${PASSWORD_MIN_LENGTH} characters)`
                }
                className={`${inputClass(Boolean(formErrors.password))} pr-10`}
              />
              <button
                type="button"
                onClick={() => setShowPassword(prev => !prev)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-content-subtle hover:text-content-muted"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {formErrors.password && <p className="field-error">{formErrors.password}</p>}
          </div>

          <div>
            <label htmlFor="admin-department" className="field-label">
              Department
            </label>
            <select
              id="admin-department"
              value={form.departmentId}
              onChange={e => updateFormField('departmentId', e.target.value)}
              className={inputClass(Boolean(formErrors.departmentId))}
            >
              <option value="">Select a department</option>
              {departmentOptions.map(dept => (
                <option key={dept.id} value={dept.id}>
                  {dept.name}
                  {dept.retired ? ' (switched off)' : ''}
                </option>
              ))}
            </select>
            {formErrors.departmentId && (
              <p className="field-error">{formErrors.departmentId}</p>
            )}
          </div>

          <div>
            <label htmlFor="admin-line-manager" className="field-label">
              Line manager
            </label>
            <select
              id="admin-line-manager"
              value={form.lineManagerId}
              onChange={e => updateFormField('lineManagerId', e.target.value)}
              aria-describedby="admin-line-manager-hint"
              className={inputClass(Boolean(formErrors.lineManagerId))}
            >
              <option value="">Nobody recorded</option>
              {users
                .filter(
                  candidate =>
                    candidate.id !== editingUser?.id &&
                    (!candidate.deactivatedAt || candidate.id === form.lineManagerId),
                )
                .map(candidate => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.firstName} {candidate.lastName}
                    {candidate.designation ? ` - ${candidate.designation}` : ''}
                  </option>
                ))}
            </select>
            <p id="admin-line-manager-hint" className="mt-1 text-meta text-content-muted">
              Told when a memo has waited on this person two working days past its deadline.
            </p>
            {formErrors.lineManagerId && (
              <p className="field-error">{formErrors.lineManagerId}</p>
            )}
          </div>

          <div>
            <label htmlFor="admin-role" className="field-label">
              System role
            </label>
            <select
              id="admin-role"
              value={form.role}
              onChange={e => updateFormField('role', e.target.value)}
              className={inputClass(Boolean(formErrors.role))}
            >
              <option value="USER">User</option>
              <option value="ADMINISTRATOR">Administrator</option>
            </select>
            {/* The choice was two words with nothing to say what either bought.
                The screen that answers it is one link away rather than
                summarised here, so there is one description of the rules. */}
            <p className="mt-1 text-meta text-content-subtle">
              <Link
                to={ROUTES.accessControl}
                className="text-accent-ink underline underline-offset-2 hover:text-accent"
              >
                What each role can do
              </Link>
            </p>
            {formErrors.role && <p className="field-error">{formErrors.role}</p>}
          </div>

          {saveError && (
            <p
              role="alert"
              className="rounded-control border border-danger-line bg-danger-soft px-3 py-2 text-ui text-danger-ink"
            >
              {saveError}
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:gap-3">
            <Button
              size="lg"
              className="flex-1"
              onClick={handleSaveUser}
              pending={saveLoading}
            >
              {editingUser ? 'Update person' : 'Create person'}
            </Button>
            <Button
              size="lg"
              variant="secondary"
              className="flex-1"
              onClick={() => !saveLoading && setAddUserModal(false)}
              disabled={saveLoading}
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={importModal}
        onClose={() => !importLoading && setImportModal(false)}
        title="Import people"
        size="md"
      >
        <div className="space-y-4">
          <p className="text-ui leading-relaxed text-content-muted">
            Upload a .csv or .xlsx file with one person per row. Required columns:
            <span className="font-medium text-content">
              {' '}
              firstName, lastName, email, department, role
              {microsoftSignIn ? '' : ', password'}
            </span>
            . Department names must match existing departments exactly.
          </p>

          {/*
            Said here rather than left to the template, because the template is
            a file somebody opens in Excel and the consequence of guessing
            wrong is a spreadsheet of real passwords.
          */}
          {microsoftSignIn && (
            <p className="text-ui leading-relaxed text-content-muted">
              Leave <span className="font-medium text-content">password</span>{' '}
              blank for anybody who signs in with their Microsoft work account,
              which is most people. Give a password only to someone who has no
              Microsoft account here.
            </p>
          )}

          <Button
            variant="ghost"
            size="sm"
            icon={<Download size={15} />}
            onClick={() => downloadUserImportTemplate(microsoftSignIn)}
          >
            Download template (.csv)
          </Button>

          <div>
            {/* This was the one label on the page with no `htmlFor`, so the
                file input was the only field a screen reader announced
                unlabelled. */}
            <label htmlFor="admin-import-file" className="field-label">
              Spreadsheet file
            </label>
            <input
              id="admin-import-file"
              type="file"
              accept=".csv,.xlsx"
              onChange={e => {
                setImportFile(e.target.files?.[0] ?? null)
                setImportError('')
                setImportResult(null)
              }}
              className="block w-full text-ui text-content-muted file:mr-3 file:rounded-control file:border-0 file:bg-accent-soft file:px-3 file:py-2 file:text-ui file:font-medium file:text-accent-ink hover:file:bg-accent-line"
            />
            {importFile && (
              <p className="mt-1.5 text-meta text-content-muted">{importFile.name}</p>
            )}
          </div>

          {importError && (
            <p
              role="alert"
              className="rounded-control border border-danger-line bg-danger-soft px-3 py-2 text-ui text-danger-ink"
            >
              {importError}
            </p>
          )}

          {importResult && (
            <div className="space-y-3">
              <p className="rounded-control border border-accent-line bg-accent-soft px-3 py-2 text-ui text-accent-ink">
                Created {importResult.created} person
                {importResult.created === 1 ? '' : 's'}.
              </p>

              {importResult.failed.length > 0 && (
                <div className="overflow-hidden rounded-control border border-warning-line">
                  <p className="bg-warning-soft px-3 py-2 text-ui font-medium text-warning-ink">
                    {importResult.failed.length} row
                    {importResult.failed.length === 1 ? '' : 's'} failed
                  </p>
                  <div className="max-h-40 divide-y divide-warning-line overflow-y-auto">
                    {importResult.failed.map(failure => (
                      <p
                        key={`${failure.row}-${failure.email ?? 'unknown'}`}
                        className="px-3 py-2 text-meta text-content-muted"
                      >
                        <span className="font-medium">Row {failure.row}</span>
                        {failure.email ? ` (${failure.email})` : ''}: {failure.error}
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:gap-3">
            <Button
              size="lg"
              className="flex-1"
              onClick={handleImportUsers}
              pending={importLoading}
              disabled={!importFile}
            >
              Import people
            </Button>
            <Button
              size="lg"
              variant="secondary"
              className="flex-1"
              onClick={() => setImportModal(false)}
              disabled={importLoading}
            >
              {importResult ? 'Close' : 'Cancel'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!resettingTwoFactor}
        onClose={() => !resetLoading && setResettingTwoFactor(null)}
        title="Turn off two-step sign-in"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-ui leading-relaxed text-content-muted">
            <span className="font-semibold text-content">
              {resettingTwoFactor?.firstName} {resettingTwoFactor?.lastName}
            </span>{' '}
            will sign in with their password alone again, and their recovery
            codes stop working. Do this when they have lost the phone and the
            codes — they can set it up again from their account page.
          </p>

          {resetError && (
            <p
              role="alert"
              className="rounded-control border border-danger-line bg-danger-soft px-3 py-2 text-ui text-danger-ink"
            >
              {resetError}
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:gap-3">
            <Button
              size="lg"
              variant="dangerSolid"
              className="flex-1"
              onClick={confirmResetTwoFactor}
              pending={resetLoading}
            >
              Turn it off
            </Button>
            <Button
              size="lg"
              variant="secondary"
              className="flex-1"
              onClick={() => setResettingTwoFactor(null)}
              disabled={resetLoading}
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <AdminPowersDialog
        person={settingPowers}
        onClose={() => setSettingPowers(null)}
        onDone={() => {
          void fetchUsers()
            .then(setUsers)
            .catch(() => {
              // The powers were saved; the list refreshing is a nicety.
            })
        }}
      />

      <SwitchAccountDialog
        person={switching?.user ?? null}
        active={switching?.active ?? false}
        onClose={() => setSwitching(null)}
        // Whether somebody can sign in is a column in the table beside it,
        // and switching an account off takes them out of every picker.
        onDone={() => {
          void fetchUsers()
            .then(setUsers)
            .catch(() => {
              // The dialog has already reported anything that failed.
            })
        }}
      />
    </Page>
  )
}
