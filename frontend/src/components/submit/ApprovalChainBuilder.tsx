import { useState } from 'react'
import { ChevronDown, GripVertical, History, Plus, X } from 'lucide-react'
import type { ApiApprovalType } from '../../types/document'
import type { AssignableUser } from '../../types/submitDocument'
import {
  APPROVAL_TYPE_OPTIONS,
  type ApprovalStepForm,
} from '../../utils/submitDocument'
import { formatFullName } from '../../utils/user'
import { Avatar, Badge, type Tone } from '../ui/Card'
import Button from '../ui/Button'
import ApproverCombobox from './ApproverCombobox'

/** Per-type chip tone on a step row, so the chain reads at a glance. */
const TYPE_TONE: Record<ApiApprovalType, Tone> = {
  REVIEWER: 'info',
  APPROVER: 'accent',
  FINAL_APPROVER: 'warning',
}

interface Props {
  steps: ApprovalStepForm[]
  usersById: Map<string, AssignableUser>
  stepErrors: Record<string, string>
  /** Never offered as an approver — the preparer cannot act on their own document. */
  excludeIds: Set<string>
  /** A chain from the preparer's last submission, offered as a starting point. */
  reusable: { label: string; steps: ApprovalStepForm[] } | null
  onAdd: () => void
  onRemove: (id: string) => void
  onMove: (index: number, direction: -1 | 1) => void
  /** Drag-and-drop lands a row at an arbitrary index, not one place at a time. */
  onReorder: (from: number, to: number) => void
  onUpdate: (id: string, field: 'userId' | 'approvalType', value: string) => void
  onReuse: () => void
  onUserResolved: (user: AssignableUser) => void
  /** Administrators only — see ApproverCombobox's `canAddPerson`. */
  canAddPerson?: boolean
  /** Which step asked, and what was typed, so the parent can prefill. */
  onAddPerson?: (stepId: string, query: string) => void
}

export default function ApprovalChainBuilder({
  steps,
  usersById,
  stepErrors,
  excludeIds,
  reusable,
  onAdd,
  onRemove,
  onMove,
  onReorder,
  onUpdate,
  onReuse,
  onUserResolved,
  canAddPerson = false,
  onAddPerson,
}: Props) {
  /** The row being dragged, and the gap it is currently hovering over. */
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  const endDrag = () => {
    setDragIndex(null)
    setOverIndex(null)
  }

  return (
    <>
      {reusable && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-control border border-line bg-sunken/40 px-3 py-2.5">
          <p className="min-w-0 text-meta text-content-muted">
            Your last submission routed to{' '}
            <span className="font-medium text-content">{reusable.label}</span>.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={onReuse}
            icon={<History size={13} aria-hidden="true" />}
          >
            Reuse that chain
          </Button>
        </div>
      )}

      <h3 id="approval-chain-heading" tabIndex={-1} className="sr-only">
        Approval steps
      </h3>

      <ol className="space-y-2">
        {steps.map((step, index) => {
          const assignee = usersById.get(step.userId) ?? null
          const stepError = stepErrors[step.id] ?? null
          const typeOption = APPROVAL_TYPE_OPTIONS.find(
            option => option.value === step.approvalType,
          )
          const takenElsewhere = new Set(
            steps
              .filter(other => other.id !== step.id && other.userId)
              .map(other => other.userId),
          )

          const dragging = dragIndex === index
          const isDropTarget = overIndex === index && dragIndex !== null && !dragging

          return (
            <li
              key={step.id}
              onDragOver={event => {
                if (dragIndex === null) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setOverIndex(index)
              }}
              onDrop={event => {
                event.preventDefault()
                if (dragIndex !== null && dragIndex !== index) onReorder(dragIndex, index)
                endDrag()
              }}
              className={`rounded-card border bg-surface transition-colors ${
                stepError ? 'border-danger-line' : 'border-line'
              } ${dragging ? 'opacity-40' : ''} ${
                isDropTarget ? 'border-accent bg-accent-soft/40' : ''
              }`}
            >
              <div className="flex items-center gap-2 px-3 py-2.75">
                {/*
                  The grip drags, and ↑/↓ move the row while it holds focus.
                  Drag is never the only way: it is unusable by keyboard, on a
                  screen reader, and with a tremor, so the same two keys that
                  the arrow buttons used to own now live on the handle itself.
                */}
                <button
                  type="button"
                  draggable={steps.length > 1}
                  onDragStart={event => {
                    setDragIndex(index)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', String(index))
                  }}
                  onDragEnd={endDrag}
                  onKeyDown={event => {
                    if (event.key === 'ArrowUp' && index > 0) {
                      event.preventDefault()
                      onMove(index, -1)
                    } else if (event.key === 'ArrowDown' && index < steps.length - 1) {
                      event.preventDefault()
                      onMove(index, 1)
                    }
                  }}
                  disabled={steps.length < 2}
                  aria-label={`Reorder step ${index + 1}${
                    assignee
                      ? `, ${formatFullName(assignee.firstName, assignee.lastName)}`
                      : ''
                  }. Use the up and down arrow keys.`}
                  className="flex h-7 w-5 flex-shrink-0 cursor-grab items-center justify-center rounded-chip text-line-strong transition-colors hover:bg-sunken hover:text-content-muted active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
                >
                  <GripVertical size={15} aria-hidden="true" />
                </button>

                <span
                  aria-hidden="true"
                  className="flex h-5.5 w-5.5 flex-shrink-0 items-center justify-center rounded-chip bg-sunken font-mono text-data font-semibold tabular-nums text-content-muted"
                >
                  {index + 1}
                </span>

                {assignee && (
                  <Avatar
                    firstName={assignee.firstName}
                    lastName={assignee.lastName}
                    size="sm"
                    tone={
                      step.approvalType === 'FINAL_APPROVER'
                        ? 'success'
                        : step.approvalType === 'APPROVER'
                          ? 'accent'
                          : 'info'
                    }
                  />
                )}

                <div className="min-w-0 flex-1">
                  <label htmlFor={`step-${step.id}-user`} className="sr-only">
                    Approver for step {index + 1}
                  </label>
                  <ApproverCombobox
                    id={`step-${step.id}-user`}
                    value={step.userId}
                    selected={assignee}
                    takenIds={takenElsewhere}
                    excludeIds={excludeIds}
                    invalid={Boolean(stepError)}
                    describedBy={stepError ? `step-${step.id}-user-error` : undefined}
                    onChange={user => onUpdate(step.id, 'userId', user.id)}
                    onResolved={onUserResolved}
                    canAddPerson={canAddPerson}
                    onAddPerson={
                      onAddPerson ? query => onAddPerson(step.id, query) : undefined
                    }
                  />
                </div>

                <div className="relative flex-shrink-0">
                  <label htmlFor={`step-${step.id}-type`} className="sr-only">
                    Approval type for step {index + 1}
                  </label>
                  <select
                    id={`step-${step.id}-type`}
                    value={step.approvalType}
                    onChange={event =>
                      onUpdate(step.id, 'approvalType', event.target.value)
                    }
                    aria-describedby={`step-${step.id}-type-hint`}
                    className="field h-10 w-36 appearance-none pr-8 text-meta"
                  >
                    {APPROVAL_TYPE_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={13}
                    aria-hidden="true"
                    className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-content-subtle"
                  />
                </div>

                {steps.length > 1 && (
                  <button
                    type="button"
                    onClick={() => onRemove(step.id)}
                    aria-label={`Remove step ${index + 1}`}
                    className="flex h-6.5 w-6.5 flex-shrink-0 items-center justify-center rounded-control text-content-subtle transition-colors hover:bg-danger-soft hover:text-danger-ink"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2.5 pl-12.5">
                <Badge tone={TYPE_TONE[step.approvalType]}>{typeOption?.label}</Badge>
                <span
                  id={`step-${step.id}-type-hint`}
                  className="min-w-0 text-meta text-content-subtle"
                >
                  {assignee
                    ? assignee.department?.name
                      ? `${assignee.department.name} · ${assignee.email}`
                      : assignee.email
                    : typeOption?.description}
                </span>
              </div>

              {stepError && (
                <p
                  id={`step-${step.id}-user-error`}
                  role="alert"
                  className="px-3 pb-2.5 pl-12.5 text-2xs text-danger-ink"
                >
                  {stepError}
                </p>
              )}
            </li>
          )
        })}
      </ol>

      <button
        type="button"
        onClick={onAdd}
        className="mt-2 flex h-9.5 w-full items-center justify-center gap-2 rounded-card border border-dashed border-line-strong text-ui font-medium text-content-muted transition-colors hover:border-accent hover:bg-accent-soft hover:text-accent-ink"
      >
        <Plus size={15} aria-hidden="true" />
        Add step
      </button>
    </>
  )
}
