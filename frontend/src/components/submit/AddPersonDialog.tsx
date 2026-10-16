import { useEffect, useId, useMemo, useState } from 'react'
import Modal from '../Modal'
import Button from '../ui/Button'
import { createUser, fetchDepartments, type Department } from '../../services/AdminApi'
import type { AssignableUser } from '../../types/submitDocument'
import { splitTypedName } from '../../utils/user'
import { PASSWORD_MIN_LENGTH } from '../../utils/passwordRule'

/**
 * Add somebody to the directory without leaving the submission.
 *
 * The picker used to end at "Nobody matches “Zaraq Mahmood”." and stop there.
 * Getting past it meant abandoning the wizard for the People screen — and the
 * draft keeps the title and the description but NOT the PDF, so the price of
 * one missing approver was re-attaching the document and finding your place
 * again. That is the "separate tab" the feedback describes.
 *
 * Only an administrator can reach this: `admin.routes.ts` is
 * `router.use(authenticate, requireAdmin)`, so for anyone else the button is
 * not rendered at all rather than rendered and refused.
 */

const MIN_PASSWORD = PASSWORD_MIN_LENGTH

type Form = {
  firstName: string
  lastName: string
  email: string
  designation: string
  departmentId: string
  password: string
}

type Errors = Partial<Record<keyof Form, string>>

function validate(form: Form): Errors {
  const errors: Errors = {}
  if (!form.firstName.trim()) errors.firstName = 'First name is required'
  if (!form.lastName.trim()) errors.lastName = 'Last name is required'
  if (!form.email.trim()) errors.email = 'Email is required'
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
    errors.email = 'Enter a valid email address'
  }
  if (!form.departmentId) errors.departmentId = 'Department is required'
  if (form.password.length < MIN_PASSWORD) {
    errors.password = `Password must be at least ${MIN_PASSWORD} characters`
  }
  return errors
}

export default function AddPersonDialog({
  open,
  query,
  onClose,
  onCreated,
}: {
  open: boolean
  /** What was typed into the picker, used to prefill the name or the email. */
  query: string
  onClose: () => void
  /** The new person, ready to drop straight into the step that asked for them. */
  onCreated: (user: AssignableUser) => void
}) {
  const ids = useId()
  const field = (name: string) => `${ids}-${name}`

  const [departments, setDepartments] = useState<Department[]>([])
  const [loadingDepartments, setLoadingDepartments] = useState(true)
  const [departmentsError, setDepartmentsError] = useState<string | null>(null)
  const [form, setForm] = useState<Form>(() => ({
    ...splitTypedName(query),
    designation: '',
    departmentId: '',
    password: '',
  }))
  const [errors, setErrors] = useState<Errors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  /*
   * Loaded once, on mount.
   *
   * There is no "reopen" to handle: the parent renders this only while it is
   * open and keys it on the step that asked, so every open is a new mount with
   * `useState` doing the prefilling. That is also what keeps this effect free
   * of synchronous setState - resetting form state in an effect is the
   * cascading-render shape `react-hooks/set-state-in-effect` exists to catch,
   * and remounting is the answer to it rather than a suppression.
   */
  useEffect(() => {
    let cancelled = false

    fetchDepartments()
      .then(list => {
        if (cancelled) return
        setDepartments(list)
        // One department is not a choice, so make it for them.
        if (list.length === 1) {
          setForm(current => ({ ...current, departmentId: list[0]?.id ?? '' }))
        }
      })
      .catch(error => {
        if (cancelled) return
        setDepartmentsError(
          error instanceof Error ? error.message : 'Could not load departments'
        )
      })
      .finally(() => {
        if (!cancelled) setLoadingDepartments(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const set = (name: keyof Form) => (value: string) => {
    setForm(current => ({ ...current, [name]: value }))
    // Clear the error for the field being corrected, not every field: an error
    // that vanishes from a control the person has not touched reads as fixed.
    setErrors(current => (current[name] ? { ...current, [name]: undefined } : current))
  }

  /*
   * No department, no person. Creating a user requires one and the API refuses
   * without it, so saying so here beats a 400 after everything is typed - and
   * naming the screen that fixes it beats "Department is required".
   */
  const blocked = !loadingDepartments && !departmentsError && departments.length === 0

  const busy = saving || loadingDepartments

  const submit = async () => {
    const found = validate(form)
    setErrors(found)
    if (Object.keys(found).some(key => found[key as keyof Form])) return

    setSaving(true)
    setSubmitError(null)
    try {
      const created = await createUser({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        password: form.password,
        departmentId: form.departmentId,
        designation: form.designation.trim(),
        /*
         * Always a plain user. Making somebody an administrator is a privilege
         * decision, and a submission wizard is the wrong place to take it -
         * the People screen exists for that and shows what the role means.
         */
        loginRole: 'USER',
      })

      onCreated({
        id: created.id,
        email: created.email,
        firstName: created.firstName,
        lastName: created.lastName,
        loginRole: 'USER',
        department: { name: created.department.name },
      })
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : 'Could not add this person'
      )
    } finally {
      setSaving(false)
    }
  }

  const departmentOptions = useMemo(
    () => departments.map(d => ({ id: d.id, name: d.name })),
    [departments]
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a person"
      description="They are added to the directory and assigned to this step. Nothing is submitted yet."
      size="md"
    >
      <div className="space-y-4">
        {blocked && (
          <p role="alert" className="field-error">
            There are no departments to put them in, and a person must belong to
            one. Add a department on the People &amp; delegation screen first.
          </p>
        )}

        {departmentsError && (
          <p role="alert" className="field-error">
            {departmentsError}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={field('first')} className="field-label">
              First name
              <span className="ml-1 text-danger-ink" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id={field('first')}
              type="text"
              value={form.firstName}
              onChange={event => set('firstName')(event.target.value)}
              aria-required="true"
              aria-invalid={errors.firstName ? true : undefined}
              aria-describedby={errors.firstName ? field('first-error') : undefined}
              className="field h-10"
            />
            {errors.firstName && (
              <p id={field('first-error')} className="field-error">
                {errors.firstName}
              </p>
            )}
          </div>

          <div>
            <label htmlFor={field('last')} className="field-label">
              Last name
              <span className="ml-1 text-danger-ink" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id={field('last')}
              type="text"
              value={form.lastName}
              onChange={event => set('lastName')(event.target.value)}
              aria-required="true"
              aria-invalid={errors.lastName ? true : undefined}
              aria-describedby={errors.lastName ? field('last-error') : undefined}
              className="field h-10"
            />
            {errors.lastName && (
              <p id={field('last-error')} className="field-error">
                {errors.lastName}
              </p>
            )}
          </div>
        </div>

        <div>
          <label htmlFor={field('email')} className="field-label">
            Work email
            <span className="ml-1 text-danger-ink" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id={field('email')}
            type="email"
            value={form.email}
            onChange={event => set('email')(event.target.value)}
            aria-required="true"
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={`${field('email-hint')}${errors.email ? ` ${field('email-error')}` : ''}`}
            className="field h-10"
          />
          <p id={field('email-hint')} className="mt-1 text-meta text-content-subtle">
            Where every approval notice for them will be sent.
          </p>
          {errors.email && (
            <p id={field('email-error')} className="field-error">
              {errors.email}
            </p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={field('department')} className="field-label">
              Department
              <span className="ml-1 text-danger-ink" aria-hidden="true">
                *
              </span>
            </label>
            <select
              id={field('department')}
              value={form.departmentId}
              onChange={event => set('departmentId')(event.target.value)}
              disabled={loadingDepartments || blocked}
              aria-required="true"
              aria-invalid={errors.departmentId ? true : undefined}
              aria-describedby={
                errors.departmentId ? field('department-error') : undefined
              }
              className="field h-10"
            >
              <option value="">
                {loadingDepartments ? 'Loading departments…' : 'Select a department'}
              </option>
              {departmentOptions.map(option => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
            {errors.departmentId && (
              <p id={field('department-error')} className="field-error">
                {errors.departmentId}
              </p>
            )}
          </div>

          <div>
            <label htmlFor={field('designation')} className="field-label">
              Designation <span className="text-content-subtle">(Optional)</span>
            </label>
            <input
              id={field('designation')}
              type="text"
              value={form.designation}
              onChange={event => set('designation')(event.target.value)}
              placeholder="e.g. Manager, Finance"
              aria-describedby={field('designation-hint')}
              className="field h-10"
            />
            <p
              id={field('designation-hint')}
              className="mt-1 text-meta text-content-subtle"
            >
              Printed under their signature on approved memos.
            </p>
          </div>
        </div>

        <div>
          <label htmlFor={field('password')} className="field-label">
            Temporary password
            <span className="ml-1 text-danger-ink" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id={field('password')}
            type="password"
            value={form.password}
            onChange={event => set('password')(event.target.value)}
            autoComplete="new-password"
            aria-required="true"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={`${field('password-hint')}${errors.password ? ` ${field('password-error')}` : ''}`}
            className="field h-10"
          />
          {/*
            Said plainly because it is not what people assume. Creating an
            account sends nothing - there is no invitation email in this
            product - so an administrator who does not pass this on has made
            an approver who cannot sign in, and the memo waits on them.
          */}
          <p id={field('password-hint')} className="mt-1 text-meta text-content-subtle">
            No invitation email is sent. Give this to them yourself so they can
            sign in and act on the memo.
          </p>
          {errors.password && (
            <p id={field('password-error')} className="field-error">
              {errors.password}
            </p>
          )}
        </div>

        {submitError && (
          <p role="alert" className="field-error">
            {submitError}
          </p>
        )}

        <div className="flex justify-end gap-2 border-t border-line-soft pt-4">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} pending={saving} disabled={busy || blocked}>
            Add and assign
          </Button>
        </div>
      </div>
    </Modal>
  )
}
