import { describe, expect, it } from 'vitest'
import { templateHasBranching } from './workflowTemplateCompile'
import type { WorkflowGraph } from '../types/workflowTemplate'

// The route itself is compiled on the server, which has its own tests
// (workflow-templates.service.test.ts); the screen asks it for each memo.

const node = (id: string, type: 'start' | 'approval' | 'decision' | 'end') =>
  ({ id, type, position: { x: 0, y: 0 }, data: {} }) as WorkflowGraph['nodes'][number]

describe('templateHasBranching', () => {
  it('is true when a decision node is present', () => {
    expect(
      templateHasBranching({ nodes: [node('d', 'decision')], edges: [] }),
    ).toBe(true)
  })

  it('is false for a linear template', () => {
    expect(
      templateHasBranching({ nodes: [node('s', 'start')], edges: [] }),
    ).toBe(false)
  })
})
