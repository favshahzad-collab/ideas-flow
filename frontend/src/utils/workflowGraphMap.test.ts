import { describe, expect, it } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import type { WorkflowGraph } from '../types/workflowTemplate'
import { graphToRf, rfToGraph } from './workflowGraphMap'

describe('rfToGraph', () => {
  it('nests a decision condition into the shape the API accepts', () => {
    const nodes: Node[] = [
      {
        id: 'decision-1',
        type: 'decision',
        position: { x: 0, y: 0 },
        data: {
          label: 'High value?',
          conditionField: 'title',
          conditionOperator: 'contains',
          conditionValue: 'Capex',
        },
      },
    ]

    const graph = rfToGraph(nodes, [])

    expect(graph.nodes[0].data).toEqual({
      label: 'High value?',
      condition: { field: 'title', operator: 'contains', value: 'Capex' },
    })
  })

  it('omits an incomplete condition instead of sending an empty value', () => {
    // The API requires a non-empty value; sending one would fail validation
    // for the whole template rather than the node still being edited.
    const nodes: Node[] = [
      {
        id: 'decision-1',
        type: 'decision',
        position: { x: 0, y: 0 },
        data: { conditionField: 'title', conditionOperator: 'equals', conditionValue: '  ' },
      },
    ]

    expect(rfToGraph(nodes, []).nodes[0].data).toEqual({})
  })

  it('trims the value and falls back on an unrecognised field or operator', () => {
    const nodes: Node[] = [
      {
        id: 'd',
        type: 'decision',
        position: { x: 0, y: 0 },
        data: { conditionField: 'nonsense', conditionOperator: 'nope', conditionValue: ' x ' },
      },
    ]

    expect(rfToGraph(nodes, []).nodes[0].data).toEqual({
      condition: { field: 'title', operator: 'contains', value: 'x' },
    })
  })

  it('drops canvas-only keys', () => {
    const nodes: Node[] = [
      {
        id: 'approval-1',
        type: 'approval',
        position: { x: 0, y: 0 },
        data: {
          label: 'Finance',
          approverId: 'u1',
          approverName: 'Priya Nair',
          approvalType: 'APPROVER',
          invalid: true,
        },
      },
    ]

    expect(rfToGraph(nodes, []).nodes[0].data).toEqual({
      label: 'Finance',
      approverId: 'u1',
      approvalType: 'APPROVER',
    })
  })

  it('keeps a decision edge branch', () => {
    const edges: Edge[] = [
      { id: 'e1', source: 'a', target: 'b', label: 'Yes', data: { branch: 'yes' } },
      { id: 'e2', source: 'a', target: 'c' },
    ]

    expect(rfToGraph([], edges)).toMatchObject({
      edges: [
        { id: 'e1', source: 'a', target: 'b', label: 'Yes', branch: 'yes' },
        { id: 'e2', source: 'a', target: 'c' },
      ],
    })
  })
})

describe('graphToRf', () => {
  it('flattens a stored condition back onto the node', () => {
    const graph: WorkflowGraph = {
      nodes: [
        {
          id: 'decision-1',
          type: 'decision',
          position: { x: 10, y: 20 },
          data: {
            label: 'High value?',
            condition: { field: 'description', operator: 'startsWith', value: 'URGENT' },
          },
        },
      ],
      edges: [],
    }

    expect(graphToRf(graph).nodes[0].data).toEqual({
      label: 'High value?',
      conditionField: 'description',
      conditionOperator: 'startsWith',
      conditionValue: 'URGENT',
    })
  })

  it('round-trips a condition unchanged', () => {
    const graph: WorkflowGraph = {
      nodes: [
        {
          id: 'd',
          type: 'decision',
          position: { x: 0, y: 0 },
          data: { condition: { field: 'title', operator: 'equals', value: 'Capex' } },
        },
      ],
      edges: [{ id: 'e', source: 'a', target: 'b', branch: 'no', label: 'No' }],
    }

    const { nodes, edges } = graphToRf(graph)
    expect(rfToGraph(nodes, edges)).toEqual(graph)
  })

  it('leaves a node with no condition alone', () => {
    const graph: WorkflowGraph = {
      nodes: [{ id: 's', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start' } }],
      edges: [],
    }

    expect(graphToRf(graph).nodes[0].data).toEqual({ label: 'Start' })
  })
})
