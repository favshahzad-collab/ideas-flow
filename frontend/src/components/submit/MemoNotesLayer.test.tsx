import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { MemoNote } from '../../types/memo'
import MemoNotesLayer from './MemoNotesLayer'

/**
 * Placing a note on the page.
 *
 * The geometry is the part worth pinning down: a note is defined by where it
 * sits, and the coordinates it reports are the ones the renderer draws with.
 * A layer that reported pixels, or reported them from the wrong corner, would
 * put the note somewhere else on a document that cannot be redrawn.
 */

const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89

/**
 * The layer has no size in jsdom, which measures nothing.
 *
 * Stubbed to exactly one A4 page at one point per pixel, so a click at
 * (320, 300) is a note at (320, 300) and the arithmetic under test is the
 * conversion rather than the stub.
 */
function sizeTheLayer() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: PAGE_WIDTH,
    bottom: PAGE_HEIGHT,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    toJSON: () => ({}),
  } as DOMRect)
}

const note = (over: Partial<MemoNote> = {}): MemoNote => ({
  page: 1,
  x: 100,
  y: 200,
  width: 170,
  height: 56,
  text: 'Checked against the register.',
  ...over,
})

function setup(
  props: Partial<React.ComponentProps<typeof MemoNotesLayer>> = {},
) {
  const onChange = vi.fn()
  const onPlacingChange = vi.fn()

  const view = render(
    <MemoNotesLayer
      notes={[]}
      onChange={onChange}
      placing={false}
      onPlacingChange={onPlacingChange}
      {...props}
    />,
  )

  return { onChange, onPlacingChange, view }
}

/**
 * A click on the layer at a point on the page.
 *
 * The two halves are committed separately on purpose. Pressing sets the drag,
 * and only the render that follows attaches the window listener that watches
 * for the release - so a `pointerup` dispatched in the same tick would land
 * before anything was listening for it.
 */
async function clickAt(element: Element, x: number, y: number) {
  await act(async () => {
    element.dispatchEvent(
      new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true }),
    )
  })

  await act(async () => {
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: x, clientY: y, bubbles: true }),
    )
  })
}

describe('placing a note', () => {
  it('does nothing until the tool is armed', async () => {
    sizeTheLayer()
    const { onChange } = setup({ placing: false })

    await clickAt(screen.getByTestId('memo-notes-layer'), 320, 300)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('puts a note where the page was clicked', async () => {
    sizeTheLayer()
    const { onChange } = setup({ placing: true })

    await clickAt(screen.getByTestId('memo-notes-layer'), 320, 300)

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ page: 1, x: 320, y: 300, text: '' }),
    ])
  })

  it('gives a clicked note a size somebody can read', async () => {
    // A click is not a drag, so there is no box to take a size from. A
    // sliver would be a note nothing fits in on a document nobody can redraw.
    sizeTheLayer()
    const { onChange } = setup({ placing: true })

    await clickAt(screen.getByTestId('memo-notes-layer'), 100, 100)

    const [[placed]] = onChange.mock.calls
    expect(placed[0].width).toBeGreaterThan(24)
    expect(placed[0].height).toBeGreaterThan(24)
  })

  it('disarms the tool once one is placed', async () => {
    // A layer that stayed armed would swallow the next click, which is
    // usually somebody going back to typing the memo.
    sizeTheLayer()
    const { onPlacingChange } = setup({ placing: true })

    await clickAt(screen.getByTestId('memo-notes-layer'), 320, 300)

    expect(onPlacingChange).toHaveBeenCalledWith(false)
  })

  it('keeps a note placed at the far edge on the page', async () => {
    sizeTheLayer()
    const { onChange } = setup({ placing: true })

    await clickAt(screen.getByTestId('memo-notes-layer'), PAGE_WIDTH, PAGE_HEIGHT)

    const [[placed]] = onChange.mock.calls
    expect(placed[0].x + placed[0].width).toBeLessThanOrEqual(PAGE_WIDTH)
    expect(placed[0].y + placed[0].height).toBeLessThanOrEqual(PAGE_HEIGHT)
  })
})

describe('a note already on the page', () => {
  it('shows what it says', () => {
    setup({ notes: [note()] })

    expect(screen.getByLabelText('Note 1')).toHaveValue(
      'Checked against the register.',
    )
  })

  it('reports what is typed into it', async () => {
    const { onChange } = setup({ notes: [note({ text: '' })] })

    await userEvent.type(screen.getByLabelText('Note 1'), 'X')

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ text: 'X' }),
    ])
  })

  it('can be removed', async () => {
    const { onChange } = setup({ notes: [note(), note({ x: 300 })] })

    await userEvent.click(screen.getByLabelText('Remove note 1'))

    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ x: 300 })])
  })

  it('can be moved with the keyboard, not only dragged', async () => {
    // Dragging is a mouse gesture. Without this the feature is unusable
    // without one, which is not a feature that ships.
    const { onChange } = setup({ notes: [note()] })

    screen.getByLabelText('Move note 1').focus()
    await userEvent.keyboard('{ArrowRight}')

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ x: 104, y: 200 }),
    ])
  })

  it('moves further with shift held', async () => {
    const { onChange } = setup({ notes: [note()] })

    screen.getByLabelText('Move note 1').focus()
    await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}')

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ x: 100, y: 224 }),
    ])
  })

  it('will not be nudged off the page', () => {
    const { onChange } = setup({ notes: [note({ x: 0, y: 0 })] })

    screen.getByLabelText('Move note 1').focus()
    screen
      .getByLabelText('Move note 1')
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      )

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ x: 0, y: 0 }),
    ])
  })

  it('locks its controls while the memo is being drawn', () => {
    setup({ notes: [note()], disabled: true })

    expect(screen.getByLabelText('Note 1')).toBeDisabled()
    expect(screen.getByLabelText('Remove note 1')).toBeDisabled()
  })
})
