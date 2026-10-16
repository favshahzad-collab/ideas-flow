import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type ReactFlowInstance,
  ReactFlowProvider,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ApprovalNode, DecisionNode, EndNode, StartNode } from './nodes'
import type { WorkflowNodeType } from '../../types/workflowTemplate'

/**
 * Lives here rather than beside the node components: it was the one
 * non-component export in `nodes.tsx`, which cost that file fast refresh.
 * Module scope keeps the identity stable, which React Flow requires.
 */
const nodeTypes = {
  start: StartNode,
  approval: ApprovalNode,
  decision: DecisionNode,
  end: EndNode,
}

interface WorkflowCanvasProps {
  nodes: Node[]
  edges: Edge[]
  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  onConnect: (connection: Connection) => void
  onDropNode: (type: WorkflowNodeType, label: string, position: { x: number; y: number }) => void
  onSelectNode: (id: string | null) => void
}

const MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function subscribeToMotionPreference(onChange: () => void) {
  const query = window.matchMedia(MOTION_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/** Honours the OS "reduce motion" setting for the animated edge dashes. */
function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribeToMotionPreference,
    () => window.matchMedia(MOTION_QUERY).matches,
    () => false
  )
}

function WorkflowCanvasInner({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onDropNode,
  onSelectNode,
}: WorkflowCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const instanceRef = useRef<ReactFlowInstance | null>(null)
  const reducedMotion = usePrefersReducedMotion()

  const handleConnect = useCallback(
    (connection: Connection) => {
      const sourceNode = nodes.find(n => n.id === connection.source)
      let branch: 'yes' | 'no' | 'default' | undefined
      if (sourceNode?.type === 'decision' && connection.sourceHandle) {
        branch =
          connection.sourceHandle === 'yes'
            ? 'yes'
            : connection.sourceHandle === 'no'
              ? 'no'
              : 'default'
      }
      const id = `e-${connection.source}-${connection.target}-${Date.now()}`
      const label = branch === 'yes' ? 'Yes' : branch === 'no' ? 'No' : undefined
      onConnect({
        ...connection,
        id,
        ...(branch ? { branch } : {}),
        ...(label ? { label } : {}),
      } as Connection)
    },
    [nodes, onConnect]
  )

  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      const type = event.dataTransfer.getData(
        'application/reactflow-type'
      ) as WorkflowNodeType
      const labelHint = event.dataTransfer.getData('application/reactflow-label')

      if (!type || !instanceRef.current || !wrapperRef.current) return

      const bounds = wrapperRef.current.getBoundingClientRect()
      const position = instanceRef.current.screenToFlowPosition({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      })

      onDropNode(type, labelHint, position)
    },
    [onDropNode]
  )

  const defaultEdgeOptions = useMemo(
    () => ({
      // Constantly animating every edge was a persistent distraction and
      // ignored the OS reduced-motion preference.
      animated: !reducedMotion,
      style: { stroke: 'var(--color-dark-accent)', strokeWidth: 1.5, opacity: 0.55 },
    }),
    [reducedMotion]
  )

  return (
    <div ref={wrapperRef} className="relative h-full flex-1 bg-dark-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onInit={instance => {
          instanceRef.current = instance
        }}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        onPaneClick={() => onSelectNode(null)}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        fitView
        proOptions={{ hideAttribution: true }}
        className="bg-dark-canvas"
      >
        {/* `size` is a radius in FLOW units, so it shrinks with the zoom: at
            the 0.55 `fitView` lands on, a size of 1 draws a 0.27px dot and
            the grid is simply not there. 2 survives the range people
            actually work at. */}
        <Background gap={20} size={2} color="var(--color-dark-grid)" />
        <Controls
          showInteractive={false}
          className="!border !border-dark-line !bg-dark-surface [&_button]:!border-dark-line [&_button]:!bg-dark-surface [&_button:hover]:!bg-dark-header [&_button_svg]:!fill-dark-content-muted [&_button:hover_svg]:!fill-dark-content"
        />
        <MiniMap
          pannable
          zoomable
          className="!hidden !border !border-dark-line !bg-dark-surface sm:!block"
          maskColor="rgb(11 15 23 / 0.75)"
          nodeColor={n => {
            switch (n.type) {
              case 'start':
                return 'var(--color-dark-accent)'
              case 'end':
                return 'var(--color-dark-danger)'
              case 'decision':
                return 'var(--color-dark-revision)'
              case 'approval':
                return 'var(--color-dark-info)'
              default:
                return 'var(--color-dark-line-strong)'
            }
          }}
        />
      </ReactFlow>
    </div>
  )
}

export default function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvasInner {...props} />
    </ReactFlowProvider>
  )
}
