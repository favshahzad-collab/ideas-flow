import { Play, Flag, GitBranch, Tag, CircleDot, CheckCircle2 } from 'lucide-react'
import type { WorkflowNodeType } from '../../types/workflowTemplate'
import Eyebrow from '../ui/Eyebrow'

interface PaletteItem {
  type: WorkflowNodeType
  label: string
  description: string
  icon: React.ReactNode
  /** Matches the accent the node it creates uses on the canvas. */
  tile: string
}

const ITEMS: PaletteItem[] = [
  {
    type: 'start',
    label: 'Start',
    description: 'Beginning of the workflow',
    icon: <Play size={13} aria-hidden="true" />,
    tile: 'bg-dark-accent/15 text-dark-accent',
  },
  {
    type: 'approval',
    label: 'Reviewer',
    description: 'Reviews the document (read-only)',
    icon: <Tag size={13} aria-hidden="true" />,
    tile: 'bg-dark-info/15 text-dark-info',
  },
  {
    type: 'approval',
    label: 'Approver',
    description: 'Signs and advances the workflow',
    icon: <CircleDot size={13} aria-hidden="true" />,
    tile: 'bg-dark-accent/15 text-dark-accent',
  },
  {
    type: 'approval',
    label: 'Final Approver',
    description: 'Last step; marks the document approved',
    icon: <CheckCircle2 size={13} aria-hidden="true" />,
    tile: 'bg-dark-warning/15 text-dark-warning',
  },
  {
    type: 'decision',
    label: 'Decision',
    description: 'Branch based on a document field',
    icon: <GitBranch size={13} aria-hidden="true" />,
    tile: 'bg-dark-revision/15 text-dark-revision',
  },
  {
    type: 'end',
    label: 'End',
    description: 'Workflow complete',
    icon: <Flag size={13} aria-hidden="true" />,
    tile: 'bg-dark-danger/15 text-dark-danger',
  },
]

interface NodePaletteProps {
  /**
   * Places a node without dragging. Drag-and-drop remains, but it is no
   * longer the only way in — the palette items are real buttons, so the
   * canvas can be built from the keyboard.
   */
  onAddNode: (type: WorkflowNodeType, label: string) => void
}

export default function NodePalette({ onAddNode }: NodePaletteProps) {
  function onDragStart(
    event: React.DragEvent<HTMLButtonElement>,
    type: WorkflowNodeType,
    label: string
  ) {
    event.dataTransfer.setData('application/reactflow-type', type)
    event.dataTransfer.setData('application/reactflow-label', label)
    event.dataTransfer.effectAllowed = 'move'
  }

  return (
    <aside
      className="flex-shrink-0 overflow-x-auto border-b border-dark-line bg-dark-canvas
                 lg:w-54 lg:overflow-x-visible lg:overflow-y-auto lg:border-b-0 lg:border-r"
      aria-label="Workflow node palette"
    >
      <div className="hidden px-3.5 pb-2 pt-3.5 lg:block">
        <Eyebrow as="h2" tone="dark">
          Nodes
        </Eyebrow>
        <p className="mt-1 text-data leading-relaxed text-dark-content-subtle">
          Drag onto the canvas, or press Enter to add
        </p>
      </div>

      <div className="flex gap-2 p-3 lg:flex-col lg:gap-1.5 lg:px-3.5 lg:pt-0">
        {ITEMS.map(item => (
          <button
            key={`${item.type}-${item.label}`}
            type="button"
            draggable
            onDragStart={e => onDragStart(e, item.type, item.label)}
            onClick={() => onAddNode(item.type, item.label)}
            aria-label={`Add ${item.label} node — ${item.description}`}
            title={item.description}
            className="flex flex-shrink-0 cursor-grab select-none items-center gap-2.25
                       rounded-control border border-dark-line bg-dark-surface px-2.25 py-2
                       text-left transition-colors hover:border-dark-line-strong
                       hover:bg-dark-header active:cursor-grabbing lg:w-full lg:flex-shrink"
          >
            <span
              aria-hidden="true"
              className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-chip ${item.tile}`}
            >
              {item.icon}
            </span>
            <span className="whitespace-nowrap text-ui font-medium text-dark-content-muted">
              {item.label}
            </span>
          </button>
        ))}
      </div>
    </aside>
  )
}
