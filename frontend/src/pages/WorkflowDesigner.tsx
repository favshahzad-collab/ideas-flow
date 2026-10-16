import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ROUTES } from '../types/routes'
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react'
import {
  ArrowLeft,
  Save,
  AlertCircle,
  CheckCircle2,
  Eye,
  X,
  Crosshair,
} from 'lucide-react'
import NodePalette from '../components/designer/NodePalette'
import NodeConfigPanel from '../components/designer/NodeConfigPanel'
import WorkflowCanvas from '../components/designer/WorkflowCanvas'
import Eyebrow from '../components/ui/Eyebrow'
import Modal from '../components/Modal'
import ConfirmDialog from '../components/ui/ConfirmDialog'
import { LoadingAnnouncer } from '../components/ui/Skeleton'
import {
  createAdminTemplate,
  fetchAdminTemplate,
  updateAdminTemplate,
} from '../services/workflowTemplateApi'
import type { WorkflowGraph, WorkflowNodeType } from '../types/workflowTemplate'
import { graphToRf, rfToGraph } from '../utils/workflowGraphMap'
import {
  formatUserOptionLabel,
  useAssignableUsers,
} from '../hooks/useAssignableUsers'
import type { ApiApprovalType } from '../types/document'

const APPROVAL_TYPE_LABELS: Record<ApiApprovalType, string> = {
  REVIEWER: 'Reviewer',
  APPROVER: 'Approver',
  FINAL_APPROVER: 'Final Approver',
}

const DEFAULT_APPROVAL_TYPE_BY_LABEL: Record<string, ApiApprovalType> = {
  Reviewer: 'REVIEWER',
  Approver: 'APPROVER',
  'Final Approver': 'FINAL_APPROVER',
}

/** A validation failure, tied to the node that caused it. */
interface ValidationIssue {
  message: string
  nodeId?: string
}

function defaultGraph(): WorkflowGraph {
  return {
    nodes: [
      {
        id: 'start-1',
        type: 'start',
        position: { x: 60, y: 200 },
        data: { label: 'Start' },
      },
      {
        id: 'end-1',
        type: 'end',
        position: { x: 760, y: 200 },
        data: { label: 'End' },
      },
    ],
    edges: [],
  }
}

/** A human name for a node, for use in validation messages. */
function nodeName(node: Node): string {
  const data = node.data as Record<string, unknown>
  return (
    (data.label as string) ||
    (data.approverName as string) ||
    (data.approvalType
      ? APPROVAL_TYPE_LABELS[data.approvalType as ApiApprovalType]
      : '') ||
    'Untitled step'
  )
}

export default function WorkflowDesigner() {
  const { id } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const isEditing = Boolean(id)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isActive, setIsActive] = useState(true)
  /* Archived templates open for reading. The server refuses a save anyway;
     this says so before anybody spends ten minutes on an edit. */
  const [archived, setArchived] = useState(false)
  // A new template starts from the default graph. That was an effect that set
  // three pieces of state on the first render; it is just the initial value,
  // so it belongs in the initialiser. `/new` and `/:id` are separate routes,
  // so `id` never changes without a remount.
  const [starterGraph] = useState(() => graphToRf(defaultGraph()))
  const [nodes, setNodes] = useState<Node[]>(() => (id ? [] : starterGraph.nodes))
  const [edges, setEdges] = useState<Edge[]>(() => (id ? [] : starterGraph.edges))
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [loading, setLoading] = useState(Boolean(id))
  const [saving, setSaving] = useState(false)
  const [issue, setIssue] = useState<ValidationIssue | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)

  const { users } = useAssignableUsers()

  const spawnOffset = useRef(0)

  // Load template if editing
  useEffect(() => {
    if (!id) return

    let cancelled = false
    fetchAdminTemplate(id)
      .then(template => {
        if (cancelled) return
        setName(template.name)
        setDescription(template.description ?? '')
        setIsActive(template.isActive)
        setArchived(Boolean(template.archivedAt))
        const { nodes: n, edges: e } = graphToRf(template.graph)
        setNodes(n)
        setEdges(e)
        setDirty(false)
      })
      .catch(err => {
        if (cancelled) return
        setIssue({
          message: err instanceof Error ? err.message : 'Failed to load template',
        })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  // Warn before a browser navigation discards unsaved graph edits.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const markDirty = useCallback(() => setDirty(true), [])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Functional update: the previous version closed over `nodes`, so a
    // stale snapshot could overwrite concurrent edits.
    setNodes(curr => applyNodeChanges(changes, curr))
    if (changes.some(c => c.type !== 'select' && c.type !== 'dimensions')) {
      setDirty(true)
    }
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges(curr => applyEdgeChanges(changes, curr))
    if (changes.some(c => c.type !== 'select')) setDirty(true)
  }, [])

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges(eds => addEdge({ ...connection, type: 'default' }, eds))
      setDirty(true)
    },
    []
  )

  const addNode = useCallback(
    (type: WorkflowNodeType, label: string, position?: { x: number; y: number }) => {
      const nodeId = `${type}-${Date.now()}`
      const data: Record<string, unknown> = { label: label || undefined }

      if (type === 'approval') {
        data.approvalType = DEFAULT_APPROVAL_TYPE_BY_LABEL[label] ?? 'REVIEWER'
      }
      if (type === 'decision') {
        data.conditionField = 'title'
        data.conditionOperator = 'contains'
        data.conditionValue = ''
      }

      // Keyboard-added nodes cascade so they never land on top of each other.
      let placed = position
      if (!placed) {
        spawnOffset.current = (spawnOffset.current + 1) % 8
        placed = { x: 320 + spawnOffset.current * 36, y: 120 + spawnOffset.current * 44 }
      }

      setNodes(curr => [...curr, { id: nodeId, type, position: placed, data }])
      setSelectedNodeId(nodeId)
      setDirty(true)
    },
    []
  )

  const selectedNode = useMemo(
    () => nodes.find(n => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  )


  const updateNode = useCallback((nodeId: string, patch: Record<string, unknown>) => {
    setNodes(curr =>
      curr.map(n =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...patch, invalid: false } } : n
      )
    )
    setDirty(true)
  }, [])

  const deleteNode = useCallback((nodeId: string) => {
    setNodes(curr => curr.filter(n => n.id !== nodeId))
    setEdges(curr => curr.filter(e => e.source !== nodeId && e.target !== nodeId))
    setSelectedNodeId(null)
    setDirty(true)
  }, [])

  /**
   * Every reason this template cannot be saved, not just the first.
   *
   * It used to return one issue and run only on Save, so fixing a graph with
   * four problems in it meant four round trips through the button to discover
   * them one at a time. The header now carries a live count, and the whole
   * list is what the banner offers to walk through.
   */
  const issues = useMemo((): ValidationIssue[] => {
    const found: ValidationIssue[] = []

    if (!name.trim()) found.push({ message: 'Give the template a name before saving.' })

    const startNodes = nodes.filter(n => n.type === 'start')
    if (startNodes.length !== 1) {
      found.push({
        message:
          startNodes.length === 0
            ? 'The workflow needs a Start node.'
            : `The workflow has ${startNodes.length} Start nodes; it needs exactly one.`,
      })
    }

    const endNodes = nodes.filter(n => n.type === 'end')
    if (endNodes.length < 1) {
      found.push({ message: 'The workflow needs at least one End node.' })
    }

    const approvals = nodes.filter(n => n.type === 'approval')
    if (approvals.length === 0) {
      found.push({ message: 'The workflow needs at least one approval step.' })
    }

    // Validation names the step the way the canvas labels it, and carries
    // the node id so the offending node can be selected and highlighted.
    for (const n of approvals) {
      if (!n.data.approverId) {
        found.push({ message: `"${nodeName(n)}" has no assignee.`, nodeId: n.id })
      }
      if (!n.data.approvalType) {
        found.push({ message: `"${nodeName(n)}" has no approval type.`, nodeId: n.id })
      }
    }

    const decisions = nodes.filter(n => n.type === 'decision')
    for (const n of decisions) {
      if (!((n.data.conditionValue as string) ?? '').trim()) {
        found.push({
          message: `"${nodeName(n)}" has no value to compare against.`,
          nodeId: n.id,
        })
      }

      // Both branches have to go somewhere, or one outcome silently stops.
      const branches = new Set(
        edges
          .filter(e => e.source === n.id)
          .map(e => (e.data as { branch?: string } | undefined)?.branch ?? 'default')
      )
      if (!branches.has('yes') || !branches.has('no')) {
        found.push({
          message: `"${nodeName(n)}" needs both a Yes and a No branch connected.`,
          nodeId: n.id,
        })
      }
    }

    // Anything that is not an End must lead somewhere, or the run stops there.
    for (const n of nodes) {
      if (n.type === 'end') continue
      if (!edges.some(e => e.source === n.id)) {
        found.push({
          message: `"${nodeName(n)}" has no outgoing connection.`,
          nodeId: n.id,
        })
      }
    }

    const finalApprovers = approvals.filter(
      n => n.data.approvalType === 'FINAL_APPROVER'
    )
    if (finalApprovers.length !== 1) {
      found.push({
        message:
          finalApprovers.length === 0
            ? 'The workflow needs one Final Approver step.'
            : `The workflow has ${finalApprovers.length} Final Approver steps; it needs exactly one.`,
      })
    }

    return found
  }, [name, nodes, edges])

  /** Selects and visibly marks the node a validation message refers to. */
  const focusIssueNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId)
    setNodes(curr =>
      curr.map(n => ({
        ...n,
        selected: n.id === nodeId,
        data: { ...n.data, invalid: n.id === nodeId },
      }))
    )
  }, [])

  const handleSave = useCallback(async () => {
    setIssue(null)
    setSuccess(null)

    const [firstIssue] = issues
    if (firstIssue) {
      setIssue(firstIssue)
      if (firstIssue.nodeId) focusIssueNode(firstIssue.nodeId)
      return
    }

    setNodes(curr => curr.map(n => ({ ...n, data: { ...n.data, invalid: false } })))
    setSaving(true)
    try {
      const graph = rfToGraph(nodes, edges)
      if (isEditing && id) {
        await updateAdminTemplate(id, {
          name: name.trim(),
          description: description.trim(),
          isActive,
          graph,
        })
        setSuccess('Template updated')
        setDirty(false)
      } else {
        const created = await createAdminTemplate({
          name: name.trim(),
          description: description.trim(),
          isActive,
          graph,
        })
        setSuccess('Template created')
        setDirty(false)
        navigate(ROUTES.workflowTemplate(created.id), { replace: true })
      }
    } catch (err) {
      setIssue({
        message: err instanceof Error ? err.message : 'Failed to save template',
      })
    } finally {
      setSaving(false)
    }
  }, [
    edges,
    isEditing,
    id,
    name,
    description,
    isActive,
    nodes,
    issues,
    navigate,
    focusIssueNode,
  ])

  const handleBack = useCallback(() => {
    if (dirty) {
      setConfirmLeave(true)
      return
    }
    navigate(ROUTES.workflowStudio)
  }, [dirty, navigate])

  /**
   * An approver's NAME is not part of the saved graph — only their id is, and
   * that is deliberate: a graph that carried the name too would keep printing
   * a stale one after somebody was renamed. So the name is resolved here, for
   * display only, and never travels back through `rfToGraph`.
   *
   * Without this every approval node read "Assign a person" in the danger
   * tint the moment a saved template was reopened, whether or not it had an
   * assignee, because the name had nowhere to come from.
   */
  const canvasNodes = useMemo(() => {
    if (users.length === 0) return nodes
    const nameById = new Map(users.map(u => [u.id, formatUserOptionLabel(u)]))

    return nodes.map(node => {
      const approverId = (node.data as { approverId?: string }).approverId
      if (!approverId) return node
      const approverName = nameById.get(approverId)
      if (!approverName) return node
      return { ...node, data: { ...node.data, approverName } }
    })
  }, [nodes, users])

  const approvalSteps = useMemo(
    () => canvasNodes.filter(n => n.type === 'approval'),
    [canvasNodes]
  )

  if (loading) {
    return (
      <div className="flex h-full flex-col bg-dark-canvas">
        <div
          aria-hidden="true"
          className="flex h-14 flex-shrink-0 items-center gap-3 border-b border-dark-line px-4"
        >
          <div className="h-7 w-7 animate-pulse rounded-control bg-dark-surface" />
          <div className="h-4 w-56 animate-pulse rounded bg-dark-surface" />
          <div className="ml-auto h-8 w-24 animate-pulse rounded-control bg-dark-surface" />
        </div>
        <div className="flex flex-1 overflow-hidden">
          <div
            aria-hidden="true"
            className="hidden w-54 flex-shrink-0 space-y-1.5 border-r border-dark-line p-3.5 lg:block"
          >
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="h-10 animate-pulse rounded-control bg-dark-surface" />
            ))}
          </div>
          <div className="flex-1 bg-dark-canvas" />
        </div>
        <LoadingAnnouncer loading label="Loading workflow template" />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-dark-canvas">
      <header className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-dark-line px-3 py-2.5 sm:gap-2.5 sm:px-4">
        {/* The template-name input is this screen's title, so the page had no
            heading at all and its panels started the outline at <h2>. */}
        <h1 className="sr-only">
          {id ? `Edit workflow template${name ? `: ${name}` : ''}` : 'New workflow template'}
        </h1>
        <button
          type="button"
          onClick={handleBack}
          className="flex-shrink-0 rounded-control p-1.5 text-dark-content-subtle transition-colors hover:bg-dark-surface hover:text-dark-content"
          aria-label="Back to templates"
        >
          <ArrowLeft size={17} aria-hidden="true" />
        </button>

        <div className="order-last w-full min-w-0 sm:order-none sm:w-auto sm:flex-1">
          <Eyebrow tone="dark" className="px-2">
            {id
              ? `Template · ${archived ? 'Archived' : isActive ? 'Active' : 'Inactive'}`
              : 'New template'}
            {dirty && ' · Unsaved'}
          </Eyebrow>
          <label htmlFor="template-name" className="sr-only">
            Template name
          </label>
          <input
            id="template-name"
            type="text"
            value={name}
            onChange={e => {
              setName(e.target.value)
              markDirty()
            }}
            placeholder="Template name (e.g. Standard HR Letter)"
            className="w-full rounded-control border-0 bg-transparent px-2 py-0.5 text-pane font-semibold text-dark-content outline-none placeholder:font-normal placeholder:text-dark-content-subtle"
          />
        </div>

        <label className="flex flex-shrink-0 select-none items-center gap-2 text-ui text-dark-content-muted">
          <input
            type="checkbox"
            checked={isActive}
            disabled={archived}
            onChange={e => {
              setIsActive(e.target.checked)
              markDirty()
            }}
            className="h-3.75 w-3.75 rounded-sm border-dark-line-strong accent-accent"
          />
          Active
        </label>

        {/* A live count, not a post-Save surprise. Pressing it selects the
            first offending node and says what is wrong with it. */}
        {issues.length > 0 && (
          <button
            type="button"
            onClick={() => {
              const [first] = issues
              setIssue(first)
              if (first.nodeId) focusIssueNode(first.nodeId)
            }}
            className="inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-control border border-dark-danger/40 bg-dark-danger/12 px-2.5 text-ui font-medium text-dark-danger transition-colors hover:bg-dark-danger/20"
          >
            <AlertCircle size={14} aria-hidden="true" />
            {issues.length} issue{issues.length === 1 ? '' : 's'}
          </button>
        )}

        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          className="inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-control border border-dark-line-strong px-2.5 text-ui font-medium text-dark-content-muted transition-colors hover:bg-dark-surface hover:text-dark-content"
        >
          <Eye size={14} aria-hidden="true" />
          Preview
        </button>

        <button
          type="button"
          onClick={handleSave}
          disabled={saving || archived}
          aria-busy={saving || undefined}
          className="inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-control bg-accent px-3 text-ui font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Save size={14} aria-hidden="true" />
          {saving ? 'Saving…' : 'Save'}
        </button>
      </header>

      {archived && (
        <p className="border-b border-dark-line bg-dark-surface px-4 py-2.5 text-ui text-dark-content-muted">
          This template is archived: it is kept for the record and cannot be
          changed. To edit it, restore it from Workflow studio, under Archived.
        </p>
      )}

      <div aria-live="polite" aria-atomic="true">
        {(issue || success) && (
          <div
            role={issue ? 'alert' : undefined}
            className={`flex items-center gap-2 border-b border-dark-line px-4 py-2.5 text-ui ${
              issue
                ? 'bg-dark-danger/12 text-dark-danger'
                : 'bg-dark-accent/12 text-dark-accent'
            }`}
          >
            {issue ? (
              <AlertCircle size={15} className="flex-shrink-0" aria-hidden="true" />
            ) : (
              <CheckCircle2 size={15} className="flex-shrink-0" aria-hidden="true" />
            )}
            <span className="flex-1">{issue?.message ?? success}</span>
            {issue?.nodeId && (
              <button
                type="button"
                onClick={() => focusIssueNode(issue.nodeId!)}
                className="inline-flex items-center gap-1 rounded-chip px-1.5 py-0.5 text-meta font-semibold underline underline-offset-2 hover:bg-dark-danger/20"
              >
                <Crosshair size={12} aria-hidden="true" />
                Show me
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setIssue(null)
                setSuccess(null)
              }}
              aria-label="Dismiss message"
              className="rounded p-0.5 text-current opacity-70 transition-opacity hover:opacity-100"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {/* Below lg the three panes stack instead of competing for width:
          the palette becomes a horizontal strip and the configuration
          panel drops beneath the canvas, so every control stays reachable
          rather than being hidden on smaller screens. */}
      <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
        <NodePalette onAddNode={(type, label) => addNode(type, label)} />

        <div className="flex min-h-[320px] min-w-0 flex-1 flex-col">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-dark-line px-4 py-1.75 text-meta text-dark-content-subtle">
            <span>Drag nodes from the left onto the canvas, or press Enter on one to add it.</span>
            <span aria-hidden="true" className="text-dark-content-faint">&bull;</span>
            <span>Drag from a node&rsquo;s right edge to another node to connect them.</span>
            <span aria-hidden="true" className="text-dark-content-faint">&bull;</span>
            <span>Click a node to configure it.</span>
          </p>

          <WorkflowCanvas
            nodes={canvasNodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDropNode={(type, label, position) => addNode(type, label, position)}
            onSelectNode={setSelectedNodeId}
          />
        </div>

        <NodeConfigPanel
          node={selectedNode}
          onUpdate={updateNode}
          onDelete={deleteNode}
          onClose={() => setSelectedNodeId(null)}
        />
      </div>

      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title="Template preview"
        description="How the chain will look to a preparer"
        size="lg"
      >
        <div className="space-y-4">
          <div>
            <div className="mb-1 text-2xs font-semibold text-content-subtle">
              Name
            </div>
            <div className="text-ui text-content">
              {name || <span className="text-content-subtle">(unnamed)</span>}
            </div>
          </div>

          <div>
            <div className="mb-1 text-2xs font-semibold text-content-subtle">
              Description
            </div>
            <div className="text-ui text-content-muted">
              {description || (
                <span className="text-content-subtle">(no description)</span>
              )}
            </div>
          </div>

          <div>
            <div className="mb-2 text-2xs font-semibold text-content-subtle">
              Approval chain (in order)
            </div>
            {approvalSteps.length === 0 ? (
              <p className="rounded-control border border-line bg-sunken p-3 text-ui text-content-muted">
                No approval steps defined yet.
              </p>
            ) : (
              <ol className="space-y-1.5">
                {approvalSteps.map((n, i) => (
                  <li
                    key={n.id}
                    className="flex items-center gap-3 rounded-control border border-line bg-sunken px-3 py-2 text-ui"
                  >
                    <span
                      aria-hidden="true"
                      className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-pill bg-accent-soft text-2xs font-semibold text-accent-ink tabular-nums"
                    >
                      {i + 1}
                    </span>
                    <span className="font-medium text-content-muted">
                      {/* Humanised, matching how the rest of the app prints
                          approval types — the raw enum used to leak here. */}
                      {n.data.approvalType
                        ? APPROVAL_TYPE_LABELS[n.data.approvalType as ApiApprovalType]
                        : 'Approval'}
                    </span>
                    <span aria-hidden="true" className="text-content-subtle">
                      &rarr;
                    </span>
                    <span className="min-w-0 truncate text-content">
                      {(n.data.approverName as string) || 'Unassigned'}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmLeave}
        title="Leave without saving?"
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => {
          setConfirmLeave(false)
          navigate(ROUTES.workflowStudio)
        }}
        onCancel={() => setConfirmLeave(false)}
      >
        You have unsaved edits to this workflow. Leaving now discards them.
      </ConfirmDialog>
    </div>
  )
}
