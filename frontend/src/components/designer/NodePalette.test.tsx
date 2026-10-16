import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import NodePalette from './NodePalette'

/**
 * The only way a step gets onto the workflow canvas. Two things make this
 * more than a list of tiles.
 *
 * The first is the label. It is not decoration: `WorkflowDesigner` keys
 * `DEFAULT_APPROVAL_TYPE_BY_LABEL` on the exact strings this palette sends,
 * so the three approval items are the difference between a step that ends the
 * workflow and one that only reads the document. Rename "Final Approver" here
 * and every final approver dragged out afterwards is created as a REVIEWER,
 * with nothing on screen to say so.
 *
 * The second is that dragging is not a keyboard gesture and never can be. If
 * these are not real buttons, an administrator who works from the keyboard or
 * through a screen reader cannot build a template at all - the designer is
 * admin-only, so there is nobody else to do it for them.
 */

/** The accessible names, in the order the palette lays them out. */
const ITEMS: { name: string; label: string; type: string }[] = [
  { name: 'Add Start node — Beginning of the workflow', label: 'Start', type: 'start' },
  {
    name: 'Add Reviewer node — Reviews the document (read-only)',
    label: 'Reviewer',
    type: 'approval',
  },
  {
    name: 'Add Approver node — Signs and advances the workflow',
    label: 'Approver',
    type: 'approval',
  },
  {
    name: 'Add Final Approver node — Last step; marks the document approved',
    label: 'Final Approver',
    type: 'approval',
  },
  {
    name: 'Add Decision node — Branch based on a document field',
    label: 'Decision',
    type: 'decision',
  },
  { name: 'Add End node — Workflow complete', label: 'End', type: 'end' },
]

function renderPalette() {
  const onAddNode = vi.fn()
  const view = render(<NodePalette onAddNode={onAddNode} />)
  return { ...view, onAddNode }
}

describe('NodePalette', () => {
  it('announces itself as a named region, so it can be found among the designer landmarks', () => {
    renderPalette()

    // The canvas and the inspector sit either side of it; "complementary" on
    // its own does not tell somebody jumping between landmarks which is which.
    expect(
      screen.getByRole('complementary', { name: 'Workflow node palette' })
    ).toBeInTheDocument()
  })

  it('offers every kind of step as a real button rather than a drag-only tile', () => {
    renderPalette()

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(ITEMS.length)

    // A div carrying role="button" would look identical and behave identically
    // to a mouse, while silently dropping Enter, Space and form-control
    // semantics. The element itself is the contract.
    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON')
      expect(button).not.toBeDisabled()
    }
  })

  it('names each item by the step it adds and what that step does', () => {
    renderPalette()

    const names = screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))

    // "Reviewer" and "Approver" are one word apart and decide whether a person
    // can sign. The description is in the name so the difference is heard, not
    // inferred from a tooltip a screen reader never reaches.
    expect(names).toEqual(ITEMS.map(item => item.name))
  })

  it('keeps the visible word inside the spoken name, so "click Approver" matches', () => {
    renderPalette()

    for (const button of screen.getAllByRole('button')) {
      const spoken = button.getAttribute('aria-label') ?? ''
      const seen = button.textContent?.trim() ?? ''

      expect(seen).not.toBe('')
      // WCAG 2.5.3: an aria-label that replaces rather than extends the
      // visible label leaves a voice-control user saying a word the browser
      // cannot match, and the item unusable by them.
      expect(spoken).toContain(seen)
    }
  })

  it('adds the node that was pressed, and only that one', async () => {
    const user = userEvent.setup({ delay: null })
    const { onAddNode } = renderPalette()

    await user.click(screen.getByRole('button', { name: ITEMS[4].name }))

    expect(onAddNode).toHaveBeenCalledTimes(1)
    expect(onAddNode).toHaveBeenCalledWith('decision', 'Decision')
  })

  it('gives each item its own pair, not the pair of the tile beside it', async () => {
    const user = userEvent.setup({ delay: null })
    const { onAddNode } = renderPalette()

    for (const [index, item] of ITEMS.entries()) {
      await user.click(screen.getByRole('button', { name: item.name }))

      // Six handlers built in a loop, and a click test that presses one of
      // them, agree with each other whatever the other five send: a handler
      // closing over the wrong item still shows the right word on the tile and
      // still puts a step on the canvas - just the wrong kind of one. Pressing
      // each in turn is the only thing that says which pair each one carries,
      // and a count that rises by exactly one rules out a tile that adds twice
      // for a single press.
      expect(onAddNode, item.label).toHaveBeenCalledTimes(index + 1)
      expect(onAddNode, item.label).toHaveBeenLastCalledWith(item.type, item.label)
    }
  })

  it('sends the exact label the designer maps to an approval type', async () => {
    const user = userEvent.setup({ delay: null })
    const { onAddNode } = renderPalette()

    for (const item of ITEMS.filter(entry => entry.type === 'approval')) {
      await user.click(screen.getByRole('button', { name: item.name }))
      // `DEFAULT_APPROVAL_TYPE_BY_LABEL` in WorkflowDesigner is keyed on these
      // three strings and falls back to REVIEWER for anything it does not
      // recognise. A tidied-up label here would demote a Final Approver to a
      // read-only reviewer, and the canvas would still say "Final Approver".
      expect(onAddNode).toHaveBeenLastCalledWith('approval', item.label)
    }

    expect(onAddNode).toHaveBeenCalledTimes(3)
  })

  it('adds a node from the keyboard, which dragging can never do', async () => {
    const user = userEvent.setup({ delay: null })
    const { onAddNode } = renderPalette()

    await user.tab()
    expect(screen.getByRole('button', { name: ITEMS[0].name })).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(onAddNode).toHaveBeenCalledWith('start', 'Start')

    // Space as well as Enter: a button that only answered Enter would fail the
    // half of the audience who reach for the other one.
    await user.keyboard(' ')
    expect(onAddNode).toHaveBeenCalledTimes(2)
    expect(onAddNode).toHaveBeenLastCalledWith('start', 'Start')
  })

  it('reaches every item with Tab, in the order they are shown', async () => {
    const user = userEvent.setup({ delay: null })
    renderPalette()

    for (const item of ITEMS) {
      await user.tab()
      // Nothing here may be skipped by the tab sequence: a step that can only
      // be added by dragging is a step a keyboard user cannot add at all.
      expect(screen.getByRole('button', { name: item.name }), item.label).toHaveFocus()
    }
  })

  it('carries the type and the label through a drag onto the canvas', () => {
    renderPalette()

    const tile = screen.getByRole('button', { name: ITEMS[3].name })

    // `fireEvent.dragStart` fires on anything; a browser refuses to start a
    // drag on an element that is not draggable. Without this line the whole
    // attribute could be deleted and every assertion below would stay green
    // while the palette stopped dragging.
    expect(tile).toHaveAttribute('draggable', 'true')

    const dataTransfer = { setData: vi.fn(), effectAllowed: 'none' }
    fireEvent.dragStart(tile, { dataTransfer })

    // WorkflowCanvas reads these two exact keys on drop. If either side is
    // renamed the drop is ignored: the node never appears, and nothing tells
    // the administrator why the drag did nothing.
    expect(dataTransfer.setData).toHaveBeenCalledWith('application/reactflow-type', 'approval')
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      'application/reactflow-label',
      'Final Approver'
    )
    expect(dataTransfer.setData).toHaveBeenCalledTimes(2)
    expect(dataTransfer.effectAllowed).toBe('move')
  })

  it('drags every item as itself, including the three that share a type', () => {
    renderPalette()

    for (const item of ITEMS) {
      const tile = screen.getByRole('button', { name: item.name })
      expect(tile, item.label).toHaveAttribute('draggable', 'true')

      const dataTransfer = { setData: vi.fn(), effectAllowed: 'none' }
      fireEvent.dragStart(tile, { dataTransfer })

      // Reviewer, Approver and Final Approver all send type `approval` and
      // differ only in the label - the same label `DEFAULT_APPROVAL_TYPE_BY_LABEL`
      // reads to decide whether the dropped step can sign. Proving one tile's
      // payload therefore proves nothing at all about the two that matter most:
      // a drag handler carrying the wrong item drops a Final Approver that the
      // designer creates as a read-only reviewer, under a tile that says
      // "Final Approver" and a node that goes on saying it.
      expect(dataTransfer.setData, item.label).toHaveBeenCalledWith(
        'application/reactflow-type',
        item.type
      )
      expect(dataTransfer.setData, item.label).toHaveBeenCalledWith(
        'application/reactflow-label',
        item.label
      )
      expect(dataTransfer.setData, item.label).toHaveBeenCalledTimes(2)
      expect(dataTransfer.effectAllowed, item.label).toBe('move')
    }
  })

  it('adds nothing for picking an item up, only for dropping it', () => {
    const { onAddNode } = renderPalette()

    fireEvent.dragStart(screen.getByRole('button', { name: ITEMS[1].name }), {
      dataTransfer: { setData: vi.fn(), effectAllowed: 'none' },
    })

    // The drop handler on the canvas is what places the node. A palette that
    // also added on drag start would put two Reviewer steps down for one
    // gesture - the spare one wherever the drag happened to begin.
    expect(onAddNode).not.toHaveBeenCalled()
  })

  it('tells the steps apart by their words, not only by tile colour', () => {
    renderPalette()

    // Read off the DOM rather than looked up by label: mapping the expected
    // labels back through `getByText` can only ever hand back the strings the
    // test supplied, so it would agree with itself whatever is on screen.
    const seen = screen.getAllByRole('button').map(button => button.textContent?.trim())

    // Reviewer, Approver and Final Approver all create the same node type and
    // differ only in the accent on their tile and the icon in it. Neither is
    // available to a screen reader, or to anyone who cannot tell an amber tile
    // from a green one, so each has to say which it is in words.
    expect(seen).toEqual(ITEMS.map(item => item.label))
  })

  it('adds nothing until an item is used', () => {
    const { onAddNode } = renderPalette()

    // Rendering the palette must not put a node on the canvas; the designer
    // marks the template dirty on every add, and a phantom add would arm the
    // unsaved-changes prompt before anybody touched anything.
    expect(onAddNode).not.toHaveBeenCalled()
  })
})
