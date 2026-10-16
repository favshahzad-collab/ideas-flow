import { Handle, Position, type NodeProps } from '@xyflow/react'
import {
  CheckCircle2,
  GitBranch,
  Play,
  Flag,
  User as UserIcon,
  Tag,
  CircleDot,
} from 'lucide-react'
import { FEATURES } from '../../config/features'
import type { ApiApprovalType } from '../../types/document'

export interface DesignerNodeData {
  label?: string
  approverId?: string
  approvalType?: ApiApprovalType
  approverName?: string
  conditionField?: 'title' | 'description'
  conditionOperator?: 'contains' | 'equals' | 'startsWith'
  conditionValue?: string
  /** Set by the designer when validation fails, so the node can show it. */
  invalid?: boolean
  [key: string]: unknown
}

const APPROVAL_TYPE_LABELS: Record<ApiApprovalType, string> = {
  REVIEWER: 'Reviewer',
  APPROVER: 'Approver',
  FINAL_APPROVER: 'Final Approver',
}

/**
 * The canvas is a dark surface in both themes, so a node's accent is drawn
 * from the fixed `dark-*` semantic tokens rather than the theme's own. The
 * kind label is set in that accent as TEXT, which is why each one is
 * contrast-checked against `dark-header` in `audit:contrast`.
 */
type Accent = 'start' | 'end' | 'decision' | 'reviewer' | 'approver' | 'final' | 'idle'

const ACCENT: Record<Accent, { ink: string; tile: string; ring: string }> = {
  start: { ink: 'text-dark-accent', tile: 'text-dark-accent', ring: 'border-dark-accent' },
  end: { ink: 'text-dark-danger', tile: 'text-dark-danger', ring: 'border-dark-danger' },
  decision: {
    ink: 'text-dark-revision',
    tile: 'text-dark-revision',
    ring: 'border-dark-revision',
  },
  reviewer: { ink: 'text-dark-info', tile: 'text-dark-info', ring: 'border-dark-info' },
  approver: {
    ink: 'text-dark-accent',
    tile: 'text-dark-accent',
    ring: 'border-dark-accent',
  },
  final: {
    ink: 'text-dark-warning',
    tile: 'text-dark-warning',
    ring: 'border-dark-warning',
  },
  idle: {
    ink: 'text-dark-content-subtle',
    tile: 'text-dark-content-subtle',
    ring: 'border-dark-content-subtle',
  },
}

const ACCENT_BY_APPROVAL: Record<ApiApprovalType, Accent> = {
  REVIEWER: 'reviewer',
  APPROVER: 'approver',
  FINAL_APPROVER: 'final',
}

const HANDLE_CLASS = '!h-2.5 !w-2.5 !border-2 !border-dark-surface !bg-dark-accent'

function NodeShell({
  selected,
  accent,
  invalid,
  icon,
  kind,
  title,
  meta,
  body,
  children,
  hasSource = true,
  hasTarget = true,
}: {
  selected?: boolean
  accent: Accent
  invalid?: boolean
  icon: React.ReactNode
  /** The node's type, in mono, in its accent — "REVIEWER", "DECISION". */
  kind: string
  title: string
  /** The mono line under the body — "SLA 3 days · escalates". */
  meta?: React.ReactNode
  body?: React.ReactNode
  children?: React.ReactNode
  hasSource?: boolean
  hasTarget?: boolean
}) {
  const tone = ACCENT[accent]

  const border = invalid
    ? 'border-dark-danger/45'
    : selected
      ? tone.ring
      : 'border-dark-line'

  return (
    <div
      className={`w-61 overflow-hidden rounded-card border bg-dark-surface shadow-node transition-colors ${border}`}
    >
      {hasTarget && (
        <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
      )}

      <div className="flex items-center gap-2 bg-dark-header px-2.75 py-2">
        <span
          aria-hidden="true"
          className={`flex h-4.5 w-4.5 flex-shrink-0 items-center justify-center rounded-chip bg-white/6 ${tone.tile}`}
        >
          {icon}
        </span>
        <span
          className={`font-mono text-data font-medium uppercase tracking-wide ${tone.ink}`}
        >
          {kind}
        </span>
        {invalid && (
          <span className="ml-auto rounded-chip bg-dark-danger/18 px-1.5 py-px font-mono text-eyebrow font-semibold uppercase tracking-eyebrow text-dark-danger">
            Incomplete
          </span>
        )}
      </div>

      <div className="p-2.75">
        <div className="truncate text-section font-semibold text-dark-content">
          {title}
        </div>
        {body}
        {meta && (
          <div className="mt-1.5 font-mono text-data text-dark-content-subtle">{meta}</div>
        )}
        {children}
      </div>

      {hasSource && (
        <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />
      )}
    </div>
  )
}

/** The assignee pill in the node body. */
function AssigneeChip({ name, missing }: { name?: string; missing: boolean }) {
  return (
    <span
      className={`mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-chip px-2 py-0.5 text-data font-medium ${
        missing ? 'bg-dark-danger/15 text-dark-danger' : 'bg-white/5 text-dark-content-muted'
      }`}
    >
      <UserIcon size={10} className="flex-shrink-0" aria-hidden="true" />
      <span className="truncate">{name || 'Assign a person'}</span>
    </span>
  )
}

export function StartNode({ data, selected }: NodeProps) {
  const d = data as DesignerNodeData
  return (
    <NodeShell
      selected={selected}
      accent="start"
      icon={<Play size={11} aria-hidden="true" />}
      kind="Start"
      title={d.label || 'Begin workflow'}
      hasTarget={false}
    />
  )
}

export function EndNode({ data, selected }: NodeProps) {
  const d = data as DesignerNodeData
  return (
    <NodeShell
      selected={selected}
      accent="end"
      icon={<Flag size={11} aria-hidden="true" />}
      kind="End"
      title={d.label || 'Workflow complete'}
      hasSource={false}
    />
  )
}

export function ApprovalNode({ data, selected }: NodeProps) {
  const d = data as DesignerNodeData
  const accent: Accent = d.approvalType ? ACCENT_BY_APPROVAL[d.approvalType] : 'idle'

  return (
    <NodeShell
      selected={selected}
      accent={accent}
      invalid={d.invalid}
      icon={
        d.approvalType === 'FINAL_APPROVER' ? (
          <CheckCircle2 size={11} aria-hidden="true" />
        ) : d.approvalType === 'APPROVER' ? (
          <CircleDot size={11} aria-hidden="true" />
        ) : (
          <Tag size={11} aria-hidden="true" />
        )
      }
      kind={d.approvalType ? APPROVAL_TYPE_LABELS[d.approvalType] : 'Approval'}
      title={d.label || d.approverName || 'Untitled step'}
      body={<AssigneeChip name={d.approverName} missing={!d.approverName} />}
      /* The design put "SLA 3 days · escalates" here. The first half is real
         and shown when the step names a number of days; the second is not —
         nothing is reassigned or escalated on a breach, the holder is simply
         told — so it is not claimed. A step with no deadline of its own says
         nothing rather than "not configured", because falling back to the
         server default is a normal thing for a step to do. */
      meta={
        FEATURES.sla && typeof d.slaDays === 'number'
          ? `${d.slaDays} working ${d.slaDays === 1 ? 'day' : 'days'}`
          : undefined
      }
    />
  )
}

export function DecisionNode({ data, selected }: NodeProps) {
  const d = data as DesignerNodeData
  const field = d.conditionField || 'title'
  const operator = d.conditionOperator || 'contains'
  const value = d.conditionValue

  return (
    <NodeShell
      selected={selected}
      accent="decision"
      invalid={d.invalid}
      icon={<GitBranch size={11} aria-hidden="true" />}
      kind="Decision"
      title={d.label || 'Conditional branch'}
      body={
        <>
          <div className="mt-1.5 rounded-chip border border-dark-line bg-dark-canvas px-2 py-1 font-mono text-data text-dark-content-muted">
            {field} {operator}{' '}
            {value ? (
              <strong className="text-dark-content">&ldquo;{value}&rdquo;</strong>
            ) : (
              <span className="text-dark-danger">(no value set)</span>
            )}
          </div>
          <div className="mt-1.5 space-y-0.5 text-data text-dark-content-subtle">
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-1.25 w-1.25 rounded-pill bg-dark-accent"
              />
              Upper handle &rarr; Yes
            </div>
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-1.25 w-1.25 rounded-pill bg-dark-danger"
              />
              Lower handle &rarr; No
            </div>
          </div>
        </>
      }
    >
      <Handle
        type="source"
        position={Position.Right}
        id="yes"
        className="!h-2.5 !w-2.5 !border-2 !border-dark-surface !bg-dark-accent"
        style={{ top: '38%' }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="no"
        className="!h-2.5 !w-2.5 !border-2 !border-dark-surface !bg-dark-danger"
        style={{ top: '68%' }}
      />
    </NodeShell>
  )
}
