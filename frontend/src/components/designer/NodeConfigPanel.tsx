import { useId, useMemo, useState } from 'react'
import { AlertCircle, SlidersHorizontal, Trash2, X } from 'lucide-react'
import type { Node } from '@xyflow/react'
import ConfirmDialog from '../ui/ConfirmDialog'
import Eyebrow from '../ui/Eyebrow'
import { FEATURES } from '../../config/features'
import {
  formatUserOptionLabel,
  useAssignableUsers,
} from '../../hooks/useAssignableUsers'
import type { ApiApprovalType } from '../../types/document'
import type { DecisionField, DecisionOperator } from '../../types/workflowTemplate'

interface NodeConfigPanelProps {
  node: Node | null
  onUpdate: (id: string, patch: Record<string, unknown>) => void
  onDelete: (id: string) => void
  onClose: () => void
}

const APPROVAL_TYPE_OPTIONS: { value: ApiApprovalType; label: string }[] = [
  { value: 'REVIEWER', label: 'Reviewer' },
  { value: 'APPROVER', label: 'Approver' },
  { value: 'FINAL_APPROVER', label: 'Final Approver' },
]

const CONDITION_FIELDS: { value: DecisionField; label: string }[] = [
  { value: 'title', label: 'Document title' },
  { value: 'description', label: 'Document description' },
]

const CONDITION_OPERATORS: { value: DecisionOperator; label: string }[] = [
  { value: 'contains', label: 'contains' },
  { value: 'equals', label: 'equals' },
  { value: 'startsWith', label: 'starts with' },
]

const NODE_TYPE_LABELS: Record<string, string> = {
  start: 'Start',
  end: 'End',
  approval: 'Approval',
  decision: 'Decision',
}

function Field({
  label,
  htmlFor,
  children,
  required,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
  required?: boolean
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-meta text-dark-content-subtle">
        {label}
        {required && (
          <span className="text-dark-danger" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {children}
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-control border border-dark-line bg-dark-canvas p-2.5 text-meta leading-relaxed text-dark-content-muted">
      {children}
    </p>
  )
}

function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} className="mt-1.5 flex items-start gap-1.5 text-data text-dark-danger">
      <AlertCircle size={12} className="mt-px flex-shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

export default function NodeConfigPanel({
  node,
  onUpdate,
  onDelete,
  onClose,
}: NodeConfigPanelProps) {
  const { users, total, error: directoryError } = useAssignableUsers()

  const labelId = useId()
  const typeId = useId()
  const assignId = useId()
  const fieldId = useId()
  const operatorId = useId()
  const valueId = useId()
  const slaId = useId()
  const assignErrorId = useId()
  const valueErrorId = useId()

  const sortedUsers = useMemo(
    () =>
      [...users].sort((a, b) =>
        formatUserOptionLabel(a).localeCompare(formatUserOptionLabel(b))
      ),
    [users]
  )

  // Declared above the early return below, so the hook order does not change
  // between a selected node and no selection.
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (!node) {
    return (
      <aside className="hidden flex-shrink-0 flex-col border-t border-dark-line bg-dark-canvas lg:flex lg:w-72 lg:border-l lg:border-t-0">
        <div className="px-3.5 pb-2 pt-3.5">
          <Eyebrow as="h2" tone="dark">
            Inspector
          </Eyebrow>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center px-6 pb-10 text-center">
          <SlidersHorizontal
            size={20}
            className="mb-3 text-dark-content-subtle"
            aria-hidden="true"
          />
          <p className="text-meta leading-relaxed text-dark-content-muted">
            Select a node on the canvas to configure it here.
          </p>
        </div>
      </aside>
    )
  }

  const data = node.data as Record<string, unknown>
  const isStart = node.type === 'start'
  const isEnd = node.type === 'end'
  const isApproval = node.type === 'approval'
  const isDecision = node.type === 'decision'

  const nodeLabel =
    (data.label as string) ||
    (data.approverName as string) ||
    NODE_TYPE_LABELS[String(node.type)] ||
    'Node'

  const missingApprover = isApproval && !data.approverId
  const missingValue = isDecision && !(data.conditionValue as string)?.trim()

  const selectedApprover = sortedUsers.find(u => u.id === data.approverId)

  /** An assignee the loaded page does not contain. See the select below. */
  const assignedButUnlisted =
    typeof data.approverId === 'string' && data.approverId && !selectedApprover
      ? data.approverId
      : null

  return (
    <aside className="max-h-[45vh] flex-shrink-0 overflow-y-auto border-t border-dark-line bg-dark-canvas lg:max-h-none lg:w-72 lg:border-l lg:border-t-0">
      <div className="sticky top-0 z-10 flex items-start justify-between gap-2 bg-dark-canvas px-3.5 pb-2 pt-3.5">
        <div className="min-w-0">
          <Eyebrow as="h2" tone="dark">
            Inspector
          </Eyebrow>
          {/* The internal node id is a timestamp key and means nothing to
              an administrator, so the panel names the node instead. */}
          <p className="mt-1 truncate text-ui font-medium text-dark-content">{nodeLabel}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex-shrink-0 rounded-control p-1 text-dark-content-subtle transition-colors hover:bg-dark-line hover:text-dark-content"
          aria-label="Close the inspector"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="space-y-3.5 px-3.5 pb-4 pt-1">
        <Field label="Label" htmlFor={labelId}>
          <input
            id={labelId}
            type="text"
            value={(data.label as string) ?? ''}
            onChange={e => onUpdate(node.id, { label: e.target.value })}
            disabled={isStart}
            placeholder={isApproval ? 'e.g. Finance review' : 'Optional label'}
            className="dark-field h-8.5"
          />
        </Field>

        {isApproval && (
          <>
            <Field label="Approval type" htmlFor={typeId}>
              <select
                id={typeId}
                value={(data.approvalType as ApiApprovalType) ?? 'REVIEWER'}
                onChange={e => onUpdate(node.id, { approvalType: e.target.value })}
                className="dark-field h-8.5"
              >
                {APPROVAL_TYPE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {data.approvalType === 'FINAL_APPROVER' && (
                <p className="mt-1.5 flex items-start gap-1.5 rounded-control border border-dark-warning/30 bg-dark-warning/8 p-2 text-data leading-relaxed text-dark-warning">
                  <AlertCircle size={12} className="mt-px flex-shrink-0" aria-hidden="true" />
                  <span>
                    The workflow must have exactly one Final Approver, and it must be
                    the last step before End.
                  </span>
                </p>
              )}
            </Field>

            <Field label="Assignee" htmlFor={assignId} required>
              <select
                id={assignId}
                value={(data.approverId as string) ?? ''}
                aria-invalid={missingApprover || undefined}
                aria-describedby={missingApprover ? assignErrorId : undefined}
                onChange={e => {
                  const userId = e.target.value
                  const user = sortedUsers.find(u => u.id === userId)
                  onUpdate(node.id, {
                    approverId: userId || undefined,
                    approverName: user ? formatUserOptionLabel(user) : undefined,
                  })
                }}
                className={`dark-field h-8.5 ${missingApprover ? 'border-dark-danger' : ''}`}
              >
                <option value="">Select a person…</option>

                {/*
                  * The person this step is already assigned to, when they are
                  * not on the page that was loaded.
                  *
                  * The directory comes back a page at a time and the stored
                  * `approverId` was matched against it - so a template
                  * assigned to anybody past the hundredth row rendered an
                  * EMPTY select on a step that was in fact assigned, with no
                  * "needs an assignee" warning either, because the id was
                  * set. It read as unassigned, and re-picking silently
                  * reassigned the step to somebody else.
                  */}
                {assignedButUnlisted && (
                  <option value={assignedButUnlisted}>
                    {typeof data.approverName === 'string' && data.approverName
                      ? data.approverName
                      : 'Assigned — not on this page of the directory'}
                  </option>
                )}

                {sortedUsers.map(u => (
                  <option key={u.id} value={u.id}>
                    {formatUserOptionLabel(u)}
                  </option>
                ))}
              </select>

              {/* The hook exposes `error` and `total` precisely so a caller
                  can say these two things, and this one used to drop both. A
                  failed request left a select holding nothing but "Select a
                  person…", which reads as "this organisation has no
                  assignable people" rather than "ask again"; and an
                  administrator who could not find a colleague had no way to
                  tell somebody without an account from somebody past the
                  hundredth row. */}
              {directoryError ? (
                <Note>
                  The list of people could not be loaded, so this step cannot be
                  assigned yet. Close the panel and try again.
                </Note>
              ) : (
                total > sortedUsers.length && (
                  <Note>
                    Showing {sortedUsers.length} of {total} people. Anybody not
                    listed is further down the directory, not missing an account.
                  </Note>
                )
              )}

              {selectedApprover && (
                <p className="mt-1.5 flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-pill bg-dark-line text-eyebrow font-semibold text-dark-content-muted"
                  >
                    {`${selectedApprover.firstName.charAt(0)}${selectedApprover.lastName.charAt(0)}`.toUpperCase()}
                  </span>
                  <span className="min-w-0 truncate text-data text-dark-content-subtle">
                    {formatUserOptionLabel(selectedApprover)}
                  </span>
                </p>
              )}

              {missingApprover && (
                <FieldError id={assignErrorId}>
                  This step needs an assignee before the workflow can be saved.
                </FieldError>
              )}
            </Field>

{/* The design also drew an "On breach" select — reassign, escalate to a
                named person, and so on. That one is still absent, and stays absent:
                every option in it is an action the workflow has no way to take, and
                a select whose choices do nothing is worse than no select. What a
                breach does do is written below, plainly, because it is one thing
                and it is worth being sure about. */}
            {FEATURES.sla && (
              <>
                <Field label="Deadline" htmlFor={slaId}>
                  <select
                    id={slaId}
                    value={typeof data.slaDays === 'number' ? String(data.slaDays) : ''}
                    onChange={e =>
                      onUpdate(node.id, {
                        slaDays: e.target.value ? Number(e.target.value) : undefined,
                      })
                    }
                    className="dark-field h-8.5"
                  >
                    {/* The empty option is not "no opinion", it is a real
                        choice: this step falls back to whatever the server's
                        default is, and where there is none it has no deadline
                        at all. */}
                    <option value="">Server default</option>
                    {[1, 2, 3, 5, 7, 10, 14, 21, 30].map(days => (
                      <option key={days} value={days}>
                        {days} working {days === 1 ? 'day' : 'days'}
                      </option>
                    ))}
                  </select>
                </Field>
                <Note>
                  Counted in working days from when the memo reaches this approver.
                  Once it is past, the approver and the person who prepared the memo
                  are each told once. Nothing is reassigned and nothing is skipped —
                  the memo still needs this signature.
                </Note>
              </>
            )}
          </>
        )}

        {isDecision && (
          <>
            <Field label="If field" htmlFor={fieldId}>
              <select
                id={fieldId}
                value={(data.conditionField as DecisionField) ?? 'title'}
                onChange={e => onUpdate(node.id, { conditionField: e.target.value })}
                className="dark-field h-8.5"
              >
                {CONDITION_FIELDS.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Operator" htmlFor={operatorId}>
              <select
                id={operatorId}
                value={(data.conditionOperator as DecisionOperator) ?? 'contains'}
                onChange={e => onUpdate(node.id, { conditionOperator: e.target.value })}
                className="dark-field h-8.5"
              >
                {CONDITION_OPERATORS.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Value" htmlFor={valueId} required>
              <input
                id={valueId}
                type="text"
                value={(data.conditionValue as string) ?? ''}
                aria-invalid={missingValue || undefined}
                aria-describedby={missingValue ? valueErrorId : undefined}
                onChange={e => onUpdate(node.id, { conditionValue: e.target.value })}
                placeholder="e.g. Confidential"
                className={`dark-field h-8.5 ${missingValue ? 'border-dark-danger' : ''}`}
              />
              {missingValue && (
                <FieldError id={valueErrorId}>
                  Enter the value this branch compares against.
                </FieldError>
              )}
            </Field>

            <div className="space-y-1 rounded-control border border-dark-line bg-dark-canvas p-2.5 text-data text-dark-content-muted">
              <div className="font-medium text-dark-content">Branch handles</div>
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-block h-1.5 w-1.5 rounded-pill bg-dark-accent"
                />
                <span>Upper handle = &ldquo;Yes&rdquo; (condition matched)</span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-block h-1.5 w-1.5 rounded-pill bg-dark-danger"
                />
                <span>Lower handle = &ldquo;No&rdquo; (condition not matched)</span>
              </div>
            </div>
          </>
        )}

        {isStart && (
          <Note>
            Every workflow starts here, and there can only be one Start node.
          </Note>
        )}

        {isEnd && <Note>The End node marks the workflow complete.</Note>}

        {!isStart && (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="inline-flex h-8.5 w-full items-center justify-center gap-1.75 rounded-control border border-dark-danger/40 text-ui font-medium text-dark-danger transition-colors hover:bg-dark-danger/10"
          >
            <Trash2 size={14} aria-hidden="true" />
            Delete node
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${NODE_TYPE_LABELS[String(node.type)] ?? 'node'} step?`}
        confirmLabel="Delete step"
        destructive
        onConfirm={() => {
          setConfirmDelete(false)
          onDelete(node.id)
        }}
        onCancel={() => setConfirmDelete(false)}
      >
        <span className="font-medium text-content">{nodeLabel}</span> and every
        connection into or out of it will be removed from the canvas. The
        workflow is not saved until you save it.
      </ConfirmDialog>
    </aside>
  )
}
