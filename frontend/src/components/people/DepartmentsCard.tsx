import { useEffect, useState } from 'react'
import { Check, Pencil, Plus, Power, Trash2, X } from 'lucide-react'
import Button from '../ui/Button'
import ConfirmDialog from '../ui/ConfirmDialog'
import {
  createDepartment,
  deleteDepartment,
  fetchDepartments,
  updateDepartment,
  type Department,
} from '../../services/AdminApi'

/**
 * Departments, which until now could only be created with a database prompt.
 *
 * Reading the list was the entire department capability in this product. They
 * came from the seed script or from SQL and from nowhere else — and a person
 * cannot be created without one, so onboarding somebody into a new team was
 * blocked on an engineer with access to the server. That is the "manual
 * intervention outside the application" the requirement rules out, and it is
 * also why the add-a-person dialog on the submission screen gives up when
 * there are no departments: there was nothing it could tell an administrator
 * to do that did not involve leaving the building.
 *
 * Three actions, and the difference between the last two is the whole design:
 * renaming carries everybody with it, switching off keeps them and stops the
 * department being offered to anybody new, and deleting is only ever possible
 * while nobody is in it.
 */
export default function DepartmentsCard({
  onChanged,
}: {
  /** The user form's dropdown is built from the same list. */
  onChanged?: () => void
}) {
  const [departments, setDepartments] = useState<Department[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<Department | null>(null)

  const load = async () => {
    try {
      // Inactive ones included: a department nobody can see is a department
      // nobody can turn back on.
      setDepartments(await fetchDepartments({ includeInactive: true }))
      setLoadError(null)
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Could not load departments.',
      )
    }
  }

  useEffect(() => {
    let cancelled = false

    // Inactive ones included: a department nobody can see is a department
    // nobody can turn back on. Written as the promise rather than `void
    // load()` so every setState happens in a callback - resetting state
    // synchronously in an effect is the cascading render this codebase lints
    // against.
    fetchDepartments({ includeInactive: true })
      .then(list => {
        if (!cancelled) setDepartments(list)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadError(
          error instanceof Error ? error.message : 'Could not load departments.',
        )
      })

    return () => {
      cancelled = true
    }
  }, [])

  const after = async () => {
    await load()
    onChanged?.()
  }

  const run = async (id: string, work: () => Promise<unknown>) => {
    setBusyId(id)
    setActionError(null)
    try {
      await work()
      await after()
      return true
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'That did not work.',
      )
      return false
    } finally {
      setBusyId(null)
    }
  }

  const submitNew = async () => {
    const name = newName.trim()
    if (!name) return
    const ok = await run('new', () => createDepartment(name))
    if (ok) {
      setNewName('')
      setAdding(false)
    }
  }

  const submitRename = async (department: Department) => {
    const name = renameTo.trim()
    if (!name || name === department.name) {
      setRenamingId(null)
      return
    }
    const ok = await run(department.id, () =>
      updateDepartment(department.id, { name }),
    )
    if (ok) setRenamingId(null)
  }

  return (
    <aside className="card overflow-hidden" aria-label="Departments">
      <div className="flex items-center justify-between gap-2 border-b border-line-soft bg-canvas px-3.75 py-3.25">
        <div>
          <h2 className="text-ui font-semibold text-content">Departments</h2>
          <p className="mt-0.5 text-meta text-content-subtle">
            {departments
              ? `${departments.length} ${departments.length === 1 ? 'department' : 'departments'}`
              : 'Loading…'}
          </p>
        </div>
        {!adding && (
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus size={13} aria-hidden="true" />}
            onClick={() => {
              setAdding(true)
              setActionError(null)
            }}
          >
            Add
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-3 px-3.75 py-3.75">
        {loadError && (
          <p role="alert" className="field-error">
            {loadError}
          </p>
        )}

        {adding && (
          <form
            className="flex gap-2"
            onSubmit={event => {
              event.preventDefault()
              void submitNew()
            }}
          >
            <label htmlFor="new-department" className="sr-only">
              New department name
            </label>
            <input
              id="new-department"
              type="text"
              value={newName}
              autoFocus
              placeholder="e.g. Internal Audit"
              onChange={event => setNewName(event.target.value)}
              className="field h-8.5 flex-1"
            />
            <Button type="submit" size="sm" pending={busyId === 'new'} disabled={!newName.trim()}>
              Add
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setAdding(false)
                setNewName('')
                setActionError(null)
              }}
            >
              Cancel
            </Button>
          </form>
        )}

        {/* The server's own sentence: "Finance still has 12 people in it" is
            the difference between understanding the refusal and filing a bug. */}
        {actionError && (
          <p role="alert" className="field-error">
            {actionError}
          </p>
        )}

        {departments?.length === 0 && !adding && (
          <p className="text-meta leading-relaxed text-content-subtle">
            There are no departments yet. Nobody can be added to the directory
            until there is at least one, because every person belongs to one.
          </p>
        )}

        {departments && departments.length > 0 && (
          /*
           * Bounded, and scrolling inside itself.
           *
           * A real organisation has dozens of these - the seeded one has
           * thirty-eight - and an unbounded list turned this sidebar card into
           * the whole page, pushing the people table it sits beside off the
           * bottom of the screen. The height is generous enough to read
           * several at a glance and small enough that the card stays a card.
           */
          <ul className="flex max-h-96 flex-col divide-y divide-line-soft overflow-y-auto">
            {departments.map(department => (
              <li key={department.id} className="py-2 first:pt-0 last:pb-0">
                {renamingId === department.id ? (
                  <form
                    className="flex gap-2"
                    onSubmit={event => {
                      event.preventDefault()
                      void submitRename(department)
                    }}
                  >
                    {/* Not "Rename {name}" - that is the button's name, and
                        two controls answering to the same words in one row is
                        ambiguous to anybody driving this by voice or by a
                        screen reader's form list. */}
                    <label htmlFor={`rename-${department.id}`} className="sr-only">
                      New name for {department.name}
                    </label>
                    <input
                      id={`rename-${department.id}`}
                      type="text"
                      value={renameTo}
                      autoFocus
                      onChange={event => setRenameTo(event.target.value)}
                      className="field h-8.5 flex-1"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      pending={busyId === department.id}
                      icon={<Check size={13} aria-hidden="true" />}
                    >
                      Save
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      aria-label="Cancel rename"
                      onClick={() => setRenamingId(null)}
                    >
                      <X size={13} aria-hidden="true" />
                    </Button>
                  </form>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-ui text-content" title={department.name}>
                        {department.name}
                        {!department.isActive && (
                          /* In words as well as in colour: the row is dimmed,
                             and dimming is not something everybody can see. */
                          <span className="ml-2 text-meta text-content-subtle">
                            · Switched off
                          </span>
                        )}
                      </p>
                      <p className="text-meta text-content-subtle">
                        {department.userCount === 0
                          ? 'Nobody in it'
                          : `${department.userCount} ${department.userCount === 1 ? 'person' : 'people'}`}
                      </p>
                    </div>

                    <div className="flex flex-shrink-0 items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Rename ${department.name}`}
                        disabled={busyId === department.id}
                        onClick={() => {
                          setRenamingId(department.id)
                          setRenameTo(department.name)
                          setActionError(null)
                        }}
                        className="rounded-control p-1.5 text-content-subtle transition-colors hover:bg-sunken hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
                      >
                        <Pencil size={13} aria-hidden="true" />
                      </button>

                      <button
                        type="button"
                        aria-label={
                          department.isActive
                            ? `Switch off ${department.name}`
                            : `Switch on ${department.name}`
                        }
                        disabled={busyId === department.id}
                        onClick={() =>
                          void run(department.id, () =>
                            updateDepartment(department.id, {
                              isActive: !department.isActive,
                            }),
                          )
                        }
                        className="rounded-control p-1.5 text-content-subtle transition-colors hover:bg-sunken hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
                      >
                        <Power size={13} aria-hidden="true" />
                      </button>

                      {/*
                        * Only offered while nobody is in it.
                        *
                        * `departmentId` is required on a user, so deleting a
                        * department with people in it would mean orphaning or
                        * deleting them. The server refuses either way - this
                        * keeps the button from being there to press, because a
                        * control whose only outcome is a refusal reads as a
                        * permission somebody has.
                        */}
                      {department.userCount === 0 && (
                        <button
                          type="button"
                          aria-label={`Delete ${department.name}`}
                          disabled={busyId === department.id}
                          onClick={() => {
                            setConfirmDelete(department)
                            setActionError(null)
                          }}
                          className="rounded-control p-1.5 text-content-subtle transition-colors hover:bg-danger-soft hover:text-danger-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger disabled:opacity-50"
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.name ?? ''}?`}
        confirmLabel="Delete"
        destructive
        pending={busyId === confirmDelete?.id}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (!confirmDelete) return
          void run(confirmDelete.id, () => deleteDepartment(confirmDelete.id)).then(
            ok => {
              if (ok) setConfirmDelete(null)
            },
          )
        }}
      >
        Nobody is in this department, so removing it affects no accounts. If you
        may want the name back later, switch it off instead — that keeps it and
        stops it being offered to anybody new.
      </ConfirmDialog>
    </aside>
  )
}
