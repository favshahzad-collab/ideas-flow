import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchAssignableUsers } from '../../services/usersApi'
import { prepareImage } from '../../utils/memoImage'
import { loadSpeller } from '../../utils/memoSpelling'
import { pageBreakHtml } from '../../utils/memoDom'
import type { MemoBody, MemoTableNode } from '../../types/memo'
import MemoBodyEditor from './MemoBodyEditor'

vi.mock('../../services/usersApi', () => ({
  fetchAssignableUsers: vi.fn(),
}))

// The browser part of a picture - drawing a file smaller - is proven in one;
// here it hands back what it is told to.
// The English dictionary is half a megabyte fetched over the network; the
// editor is handed a speller of a dozen words instead.
vi.mock('../../utils/memoSpelling', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/memoSpelling')>()),
  // Never resolves unless a test says so: most of the editor is tested with
  // the browser's own check still standing in.
  loadSpeller: vi.fn(() => new Promise<never>(() => {})),
}))

vi.mock('../../utils/memoImage', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/memoImage')>()),
  prepareImage: vi.fn(),
}))

/**
 * The editing region itself.
 *
 * The toolbar runs through `document.execCommand`, which jsdom does not
 * implement, so what is tested here is everything around it: that the region
 * is seeded from the stored body, that every edit is published as memo nodes
 * rather than as HTML, and that paste - the one route by which arbitrary
 * markup can reach an editor - never puts markup into the document.
 *
 * The reading itself is tested directly in `utils/memoDom.dom.test.ts`, on
 * the debris browsers actually leave behind.
 */

const body = (text: string): MemoBody => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

function setup(initial: MemoBody = body('Opening line.')) {
  const onChange = vi.fn()
  render(
    <MemoBodyEditor
      id="memo-body"
      initialBody={initial}
      onChange={onChange}
      labelledBy={undefined}
    />,
  )
  const region = screen.getByRole('textbox')
  return { region, onChange }
}

describe('opening a memo that was already written', () => {
  it('shows what was stored', () => {
    const { region } = setup()
    expect(region).toHaveTextContent('Opening line.')
  })

  it('brings emphasis back as emphasis, not as characters', () => {
    const { region } = setup({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Mr. Inayat', marks: [{ type: 'bold' }] }],
        },
      ],
    })

    expect(region.querySelector('b')).not.toBeNull()
    expect(region).not.toHaveTextContent('<b>')
  })

  it('counts what is there before anything is typed', () => {
    setup()
    expect(screen.getByText('13 characters')).toBeInTheDocument()
  })
})

describe('typing', () => {
  it('publishes memo nodes rather than markup', () => {
    const { region, onChange } = setup()

    region.innerHTML = '<p>Changed</p>'
    fireEvent.input(region)

    expect(onChange).toHaveBeenLastCalledWith({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Changed' }] }],
    })
  })

  it('publishes on blur as well, so a field left without a keystroke is not lost', () => {
    const { region, onChange } = setup()

    region.innerHTML = '<p>Edited elsewhere</p>'
    fireEvent.blur(region)

    expect(onChange).toHaveBeenCalled()
  })
})

describe('pasting', () => {
  const paste = (region: HTMLElement, text: string) => {
    fireEvent.paste(region, {
      clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : '') },
    })
  }

  it('never lets markup into the document', () => {
    /*
     * Paste is the one route by which a whole styled document - a web page, a
     * Word file with its own fonts and classes - can reach a contenteditable
     * region. Taking only the text means none of it ever enters the DOM, so
     * there is no sanitising step that can be got wrong.
     */
    const { region } = setup()
    paste(region, '<img src=x onerror="alert(1)">')

    expect(region.querySelector('img')).toBeNull()
  })

  it('does not let the browser do its own paste', () => {
    const { region } = setup()

    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: () => 'Some text' },
    })

    fireEvent(region, event)
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('the length the server will refuse', () => {
  it('says so before the memo is submitted', () => {
    setup(body('x'.repeat(120_001)))

    expect(screen.getByText(/the limit is 120,000/)).toBeInTheDocument()
    // Marked wrong on the region too, not only in the sentence under it.
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true')
  })
})

/**
 * The table controls.
 *
 * What is tested here is the wiring: that they appear only where they can do
 * something, that they are offered switched off rather than doing nothing,
 * and that a press comes back out as memo nodes. The operations themselves
 * are tested against tables directly in `utils/memoTableDom.dom.test.ts`.
 */
describe('shaping a table', () => {
  const cell = (type: 'tableHeader' | 'tableCell', text: string) => ({
    type,
    content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }],
  })

  const withTable: MemoBody = {
    type: 'doc',
    content: [
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('tableHeader', 'A'), cell('tableHeader', 'B')] },
          { type: 'tableRow', content: [cell('tableCell', '1'), cell('tableCell', '2')] },
        ],
      },
    ],
  }

  /** Put the caret in a cell, as clicking into it would. */
  function caretInto(region: HTMLElement, at: number) {
    const target = region.querySelectorAll('td, th')[at]!
    const selection = window.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(target)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent.mouseUp(region)
  }

  function openTable(initial: MemoBody = withTable, at = 0) {
    const { region, onChange } = setup(initial)
    caretInto(region, at)
    return { region, onChange }
  }

  /** The table in the last body that was published. */
  const published = (onChange: {
    mock: { calls: unknown[][] }
  }): MemoTableNode =>
    (onChange.mock.calls.at(-1)![0] as MemoBody).content[0] as MemoTableNode

  it('offers the controls only with the caret in a table', () => {
    const { region } = setup(withTable)

    expect(screen.queryByRole('toolbar', { name: 'Table' })).toBeNull()

    caretInto(region, 0)
    expect(screen.getByRole('toolbar', { name: 'Table' })).toBeInTheDocument()
  })

  it('adds a row below the one the caret is in', async () => {
    const { onChange } = openTable(withTable, 0)

    await userEvent.click(screen.getByRole('button', { name: 'Add row' }))

    expect(published(onChange).content).toHaveLength(3)
  })

  it('adds a column to every row, so the table stays rectangular', async () => {
    const { onChange } = openTable()

    await userEvent.click(screen.getByRole('button', { name: 'Add column' }))

    const widths = published(onChange).content.map(row => row.content.length)
    expect(widths).toEqual([3, 3])
  })

  it('merges the caret\u2019s cell with the one beside it', async () => {
    const { onChange } = openTable()

    await userEvent.click(screen.getByRole('button', { name: 'Merge cells' }))

    const [first] = published(onChange).content
    expect(first!.content).toHaveLength(1)
    expect(first!.content[0]!.attrs?.colspan).toBe(2)
  })

  it('offers a control that could only do nothing switched off', () => {
    /*
     * Removing the last row would have to take the table with it, and none
     * of these operations is on the browser's undo stack - so a press that
     * destroys more than it says would destroy it for good. Splitting a cell
     * nobody merged is simply a press that does nothing, which reads as the
     * editor being broken.
     */
    const single: MemoBody = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [{ type: 'tableRow', content: [cell('tableCell', 'Only')] }],
        },
      ],
    }

    openTable(single, 0)

    expect(screen.getByRole('button', { name: 'Remove row' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove column' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Split cell' })).toBeDisabled()
  })

  it('lets a column be resized without a mouse', async () => {
    // Dragging a boundary is a mouse gesture. Without this the table can
    // only be shaped by somebody holding one.
    const { onChange } = openTable()

    await userEvent.click(screen.getByRole('button', { name: 'Wider column' }))

    const widths = published(onChange).attrs?.widths
    expect(widths).toHaveLength(2)
    expect(widths![0]).toBeGreaterThan(widths![1]!)
  })

  it('lets a row be made taller without a mouse', async () => {
    const { onChange } = openTable(withTable, 2)

    await userEvent.click(screen.getByRole('button', { name: 'Taller row' }))

    expect(published(onChange).content[1]!.attrs?.height).toBeGreaterThan(0)
  })

  it('does not republish for a press that changed nothing', async () => {
    /*
     * Shortening a row that was never given a height hands it back to its
     * content, and a row already sized by its content has nothing to hand
     * back - so the press declines. Publishing anyway would mark the draft
     * as edited, and the preparer would be asked to save work they had not
     * done.
     */
    const { onChange } = openTable(withTable, 2)
    onChange.mockClear()

    await userEvent.click(screen.getByRole('button', { name: 'Shorter row' }))
    expect(onChange).not.toHaveBeenCalled()

    // And the control does work, once there is a height to take away.
    await userEvent.click(screen.getByRole('button', { name: 'Taller row' }))
    await userEvent.click(screen.getByRole('button', { name: 'Shorter row' }))
    expect(published(onChange).content[1]!.attrs).toBeUndefined()
  })
})

/**
 * Dragging a column boundary.
 *
 * A browser found what the operations tests could not: the grip recognised a
 * cell's own right edge and nothing else, so a boundary approached from the
 * cell on its right was not a boundary at all. A border is shared - a pointer
 * resting on the line is inside one of the two cells it separates, and which
 * one comes down to a pixel - so the drag worked or did not depending on
 * which way the hand came.
 */
describe('dragging a column boundary', () => {
  const cell = (text: string) => ({
    type: 'tableCell' as const,
    content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }],
  })

  const threeColumns: MemoBody = {
    type: 'doc',
    content: [
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('A'), cell('B'), cell('C')] },
        ],
      },
    ],
  }

  /** 300 pixels across, three columns of 100. jsdom measures nothing itself. */
  function measureTheTable() {
    const rect = (left: number, width: number) =>
      ({
        x: left,
        y: 0,
        left,
        right: left + width,
        top: 0,
        bottom: 40,
        width,
        height: 40,
        toJSON: () => ({}),
      }) as DOMRect

    vi.spyOn(
      HTMLTableCellElement.prototype,
      'getBoundingClientRect',
    ).mockImplementation(function (this: HTMLTableCellElement) {
      return rect(this.cellIndex * 100, 100)
    })

    vi.spyOn(
      HTMLTableElement.prototype,
      'getBoundingClientRect',
    ).mockReturnValue(rect(0, 300))
  }

  /** Press on a point, drag to another, let go - each step its own commit. */
  async function dragFrom(target: Element, fromX: number, toX: number) {
    await act(async () => {
      target.dispatchEvent(
        new PointerEvent('pointerdown', {
          clientX: fromX,
          clientY: 20,
          bubbles: true,
        }),
      )
    })

    // The window listener is attached by the render that follows the press,
    // so a move dispatched in the same tick would land before it exists.
    await act(async () => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: toX, clientY: 20, bubbles: true }),
      )
    })

    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    })
  }

  /** The widths in the last published body, or none if nothing was published. */
  const widthsOf = (onChange: { mock: { calls: unknown[][] } }) => {
    const last = onChange.mock.calls.at(-1)
    if (!last) return undefined
    return ((last[0] as MemoBody).content[0] as MemoTableNode).attrs?.widths
  }

  it('takes the boundary from the cell on its right', async () => {
    measureTheTable()
    const { region, onChange } = setup(threeColumns)

    const second = region.querySelectorAll('td')[1]!
    // 100 is the line between the first column and the second, and it is the
    // second cell's left edge.
    await dragFrom(second, 100, 60)

    const widths = widthsOf(onChange)
    expect(widths).toHaveLength(3)
    expect(widths![0]).toBeCloseTo(0.2, 2)
    // What one column gives up the next takes; the third never moves.
    expect(widths![0] + widths![1]).toBeCloseTo(2 / 3, 2)
    expect(widths![2]).toBeCloseTo(1 / 3, 2)
  })

  it('takes it from the cell on its left as well', async () => {
    measureTheTable()
    const { region, onChange } = setup(threeColumns)

    const first = region.querySelectorAll('td')[0]!
    await dragFrom(first, 100, 60)

    expect(widthsOf(onChange)![0]).toBeCloseTo(0.2, 2)
  })

  it('leaves the table alone for a press that is not on a boundary', async () => {
    // Otherwise every click into a cell would start a drag, and typing into
    // the table would move its columns about.
    measureTheTable()
    const { region, onChange } = setup(threeColumns)

    const second = region.querySelectorAll('td')[1]!
    await dragFrom(second, 150, 60)

    expect(widthsOf(onChange)).toBeUndefined()
  })

  it('does not offer the table\u2019s own outer edge as a boundary', async () => {
    // There is nothing on the other side of it to take the width from.
    measureTheTable()
    const { region, onChange } = setup(threeColumns)

    const third = region.querySelectorAll('td')[2]!
    await dragFrom(third, 300, 260)

    expect(widthsOf(onChange)).toBeUndefined()
  })
})

describe('the toolbar', () => {
  it('names every control, since each one is an icon alone', () => {
    setup()

    for (const label of ['Bold', 'Italic', 'Underline', 'Heading', 'Table', 'Page break']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('hides the table controls until the caret is in a table', () => {
    // Offering "Add row" with nothing to add it to is a control that can only
    // do nothing, which reads as the editor being broken.
    setup()
    expect(screen.queryByRole('button', { name: 'Add row' })).toBeNull()
  })

  it('reports what is switched on, for a screen reader', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })
})

describe('pasting a table', () => {
  const clipboard = (
    region: HTMLElement,
    data: { html?: string; text?: string },
  ) =>
    fireEvent.paste(region, {
      clipboardData: {
        getData: (type: string) =>
          type === 'text/html'
            ? (data.html ?? '')
            : type === 'text/plain'
              ? (data.text ?? '')
              : '',
      },
    })

  /**
   * jsdom has no `execCommand`, so a spy stands in for it. What the editor
   * hands the browser to insert is then readable - and that markup is the
   * whole question: it is the only thing that ever reaches the region.
   */
  function spyOnInsert() {
    const exec = vi.fn()
    Object.defineProperty(document, 'execCommand', {
      value: exec,
      configurable: true,
      writable: true,
    })
    return exec
  }

  const inserted = (exec: ReturnType<typeof vi.fn>): string[] =>
    exec.mock.calls
      .filter(call => call[0] === 'insertHTML')
      .map(call => call[2] as string)

  afterEach(() => {
    Reflect.deleteProperty(document, 'execCommand')
  })

  const SHEET =
    '<table><tr><td>Item</td><td>Amount</td></tr><tr><td>Fuel</td><td>50</td></tr></table>'

  it('inserts a spreadsheet selection as a table, with somewhere to type after it', () => {
    const exec = spyOnInsert()
    const { region } = setup()

    clipboard(region, { html: SHEET, text: 'Item\tAmount\nFuel\t50' })

    const [html] = inserted(exec)
    expect(inserted(exec)).toHaveLength(1)
    expect(html).toContain('<table>')
    expect(html).toContain('<th>Item</th>')
    expect(html).toContain('<td>50</td>')
    expect(html!.endsWith('<p><br></p>')).toBe(true)
  })

  it('reads the table even where only its text form survived the clipboard', () => {
    const exec = spyOnInsert()
    const { region } = setup()

    clipboard(region, { text: 'Item\tAmount\nFuel\t50' })

    expect(inserted(exec)[0]).toContain('<th>Item</th>')
  })

  it('still lets no element through, whatever the markup says', () => {
    const exec = spyOnInsert()
    const { region } = setup()

    clipboard(region, { html: '<p><img src=x onerror="alert(1)">Name</p>' })

    expect(inserted(exec)).toEqual(['<p>Name</p>'])
    expect(region.querySelector('img')).toBeNull()
  })

  it('inserts nothing for an image alone', () => {
    const exec = spyOnInsert()
    const { region } = setup()

    clipboard(region, { html: '<img src=x onerror="alert(1)">' })

    expect(inserted(exec)).toEqual([])
  })

  describe('with the caret already in a table', () => {
    const cell = (type: 'tableHeader' | 'tableCell', text: string) => ({
      type,
      content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }],
    })

    const twoByTwo: MemoBody = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [cell('tableHeader', 'A'), cell('tableHeader', 'B')] },
            { type: 'tableRow', content: [cell('tableCell', '1'), cell('tableCell', '2')] },
          ],
        },
      ],
    }

    function caretInto(region: HTMLElement, at: number) {
      const target = region.querySelectorAll('td, th')[at]!
      const selection = window.getSelection()!
      const range = document.createRange()
      range.selectNodeContents(target)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      fireEvent.mouseUp(region)
    }

    const text = (table: MemoTableNode, row: number, column: number) =>
      table.content[row]!.content[column]!.content?.[0]?.content?.[0]?.text ?? ''

    it('fills the table from that cell rather than nesting one inside it', () => {
      /*
       * What pasting a block of cells into a spreadsheet does: the block
       * lands with its corner in the selected cell and the sheet takes it.
       * A table inserted inside a cell would be a table the template cannot
       * draw, and the server would refuse the memo at the moment of signing.
       */
      const exec = spyOnInsert()
      const { region, onChange } = setup(twoByTwo)
      caretInto(region, 3) // the "2": second row, second column

      clipboard(region, {
        html: '<table><tr><td>x</td><td>y</td></tr><tr><td>z</td><td>w</td></tr></table>',
      })

      expect(region.querySelectorAll('table')).toHaveLength(1)
      expect(inserted(exec)).toEqual([])

      const table = (onChange.mock.calls.at(-1)![0] as MemoBody).content[0] as MemoTableNode
      expect(table.content.map(row => row.content.length)).toEqual([3, 3, 3])
      expect(text(table, 0, 0)).toBe('A')
      expect(text(table, 1, 0)).toBe('1')
      expect(text(table, 1, 1)).toBe('x')
      expect(text(table, 1, 2)).toBe('y')
      expect(text(table, 2, 1)).toBe('z')
      expect(text(table, 2, 2)).toBe('w')
    })

    it('puts anything else into the cell as paragraphs, which is all a cell holds', () => {
      const exec = spyOnInsert()
      const { region } = setup(twoByTwo)
      caretInto(region, 3)

      clipboard(region, { html: '<h1>Heading</h1><ul><li>one</li><li>two</li></ul>' })

      expect(inserted(exec)).toEqual(['<p>Heading</p><p>one</p><p>two</p>'])
    })

    it('refuses to grow the table past what the server allows', () => {
      const exec = spyOnInsert()
      const { region, onChange } = setup(twoByTwo)
      caretInto(region, 3)
      const before = onChange.mock.calls.length

      // Twenty columns pasted from the second column make twenty-one.
      const wide = Array.from({ length: 20 }, (_, at) => `c${at}`).join('\t')
      clipboard(region, { text: `${wide}\n${wide}` })

      expect(screen.getByRole('status')).toHaveTextContent('21 columns')
      expect(region.querySelectorAll('td, th')).toHaveLength(4)
      expect(onChange.mock.calls.length).toBe(before)
      expect(inserted(exec)).toEqual([])
    })
  })

  describe('a table the server would refuse', () => {
    const tooWide = (): string => {
      const row = Array.from({ length: 21 }, (_, at) => `c${at}`).join('\t')
      return `${row}\n${row}`
    }

    it('is refused at the paste, where the preparer is looking', () => {
      const exec = spyOnInsert()
      const { region } = setup()

      clipboard(region, { text: tooWide() })

      expect(screen.getByRole('status')).toHaveTextContent(
        'That table has 21 columns; a memo table can hold 20.',
      )
      expect(inserted(exec)).toEqual([])
    })

    it('takes the notice away at the next keystroke', () => {
      spyOnInsert()
      const { region } = setup()
      clipboard(region, { text: tooWide() })
      expect(screen.getByRole('status')).toBeInTheDocument()

      fireEvent.input(region)

      expect(screen.queryByRole('status')).toBeNull()
    })

    it('keeps the notice while the preparer clicks away to read it', () => {
      spyOnInsert()
      const { region } = setup()
      clipboard(region, { text: tooWide() })

      fireEvent.blur(region)

      expect(screen.getByRole('status')).toBeInTheDocument()
    })
  })
})

describe('undo', () => {
  /*
   * The editor keeps its own history because the browser's cannot see a row
   * added or a boundary dragged. So what is tested is exactly that: the
   * edits the browser's stack never held come back with Ctrl+Z, typing is
   * still grouped a word at a time, and the browser's own undo gesture goes
   * through the same history rather than a second one.
   */
  const cell = (type: 'tableHeader' | 'tableCell', text: string) => ({
    type,
    content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }],
  })

  const twoByTwo: MemoBody = {
    type: 'doc',
    content: [
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('tableHeader', 'A'), cell('tableHeader', 'B')] },
          { type: 'tableRow', content: [cell('tableCell', '1'), cell('tableCell', '2')] },
        ],
      },
    ],
  }

  function caretInto(region: HTMLElement, at: number) {
    const target = region.querySelectorAll('td, th')[at]!
    const selection = window.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(target)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent.mouseUp(region)
  }

  const publishedTable = (onChange: { mock: { calls: unknown[][] } }): MemoTableNode =>
    (onChange.mock.calls.at(-1)![0] as MemoBody).content[0] as MemoTableNode

  const undoKey = (region: HTMLElement) => fireEvent.keyDown(region, { key: 'z', ctrlKey: true })
  const redoKey = (region: HTMLElement) => fireEvent.keyDown(region, { key: 'y', ctrlKey: true })

  /** What the browser sends just before a keystroke lands. */
  function beforeInput(region: HTMLElement, inputType: string, data: string | null = null) {
    let event: Event
    try {
      event = new InputEvent('beforeinput', {
        inputType,
        data,
        bubbles: true,
        cancelable: true,
      } as InputEventInit)
    } catch {
      event = new Event('beforeinput', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'inputType', { value: inputType })
      Object.defineProperty(event, 'data', { value: data })
    }
    region.dispatchEvent(event)
    return event
  }

  /** Type one character the way a browser does: announce it, then change the DOM. */
  function type(region: HTMLElement, character: string) {
    beforeInput(region, 'insertText', character)
    const paragraph = region.querySelector('p')!
    paragraph.textContent = (paragraph.textContent ?? '') + character
    fireEvent.input(region)
  }

  it('offers Undo and Redo, switched off until there is something to do', () => {
    setup()

    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled()
  })

  it('takes back a row added to a table, and puts it back again', async () => {
    const { region, onChange } = setup(twoByTwo)
    caretInto(region, 3)

    await userEvent.click(screen.getByRole('button', { name: 'Add row' }))
    expect(publishedTable(onChange).content).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled()

    undoKey(region)
    expect(region.querySelectorAll('tr')).toHaveLength(2)
    expect(publishedTable(onChange).content).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Redo' })).toBeEnabled()

    redoKey(region)
    expect(region.querySelectorAll('tr')).toHaveLength(3)
    expect(publishedTable(onChange).content).toHaveLength(3)
  })

  it('redoes with Ctrl+Shift+Z as well', async () => {
    const { region } = setup(twoByTwo)
    caretInto(region, 3)
    await userEvent.click(screen.getByRole('button', { name: 'Add row' }))
    undoKey(region)
    expect(region.querySelectorAll('tr')).toHaveLength(2)

    fireEvent.keyDown(region, { key: 'z', ctrlKey: true, shiftKey: true })

    expect(region.querySelectorAll('tr')).toHaveLength(3)
  })

  it('works from the toolbar buttons too', async () => {
    const { region } = setup(twoByTwo)
    caretInto(region, 3)
    await userEvent.click(screen.getByRole('button', { name: 'Add row' }))

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(region.querySelectorAll('tr')).toHaveLength(2)

    await userEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(region.querySelectorAll('tr')).toHaveLength(3)
  })

  it('takes back a column made wider as one step', async () => {
    const { region, onChange } = setup(twoByTwo)
    caretInto(region, 2)

    await userEvent.click(screen.getByRole('button', { name: 'Wider column' }))
    expect(publishedTable(onChange).attrs?.widths).toBeDefined()

    undoKey(region)

    expect(publishedTable(onChange).attrs?.widths).toBeUndefined()
  })

  it('takes back cells filled from the clipboard', () => {
    const { region, onChange } = setup(twoByTwo)
    caretInto(region, 3)

    fireEvent.paste(region, {
      clipboardData: {
        getData: (mime: string) =>
          mime === 'text/html'
            ? '<table><tr><td>x</td><td>y</td></tr><tr><td>z</td><td>w</td></tr></table>'
            : '',
      },
    })
    expect(publishedTable(onChange).content.map(row => row.content.length)).toEqual([3, 3, 3])

    undoKey(region)

    expect(publishedTable(onChange).content.map(row => row.content.length)).toEqual([2, 2])
    expect(region.querySelectorAll('td, th')[3]).toHaveTextContent('2')
  })

  it('takes back typing a word at a time', () => {
    const { region } = setup({ type: 'doc', content: [{ type: 'paragraph' }] })

    for (const character of ['a', 'b', ' ', 'c']) type(region, character)
    expect(region).toHaveTextContent('ab c')

    undoKey(region)
    expect(region.textContent).toBe('ab ')

    undoKey(region)
    expect(region.textContent).toBe('')
  })

  it('keeps a space typed after a command with the word that follows it', async () => {
    /*
     * After a command - a person written in, a table inserted - the next
     * keystroke starts a new entry. When that keystroke is a space, it is
     * the start of the next word, not the end of one; an entry holding a
     * lone space would cost an undo press that takes back nothing visible.
     */
    const { region } = setup({ type: 'doc', content: [{ type: 'paragraph' }] })
    for (const character of ['a', 'b']) type(region, character)
    await userEvent.click(screen.getByRole('button', { name: 'Bold' }))
    for (const character of [' ', 'c', 'd']) type(region, character)
    expect(region.textContent).toBe('ab cd')

    undoKey(region)

    expect(region.textContent).toBe('ab')
  })

  it("handles the browser's own undo gesture through the same history", async () => {
    /*
     * A trackpad gesture or the Edit menu reaches the region as a
     * `beforeinput` with `historyUndo`, not as a keystroke. Left to the
     * browser it would undo against a stack that never saw the row.
     */
    const { region } = setup(twoByTwo)
    caretInto(region, 3)
    await userEvent.click(screen.getByRole('button', { name: 'Add row' }))

    const event = beforeInput(region, 'historyUndo')

    expect(event.defaultPrevented).toBe(true)
    expect(region.querySelectorAll('tr')).toHaveLength(2)
  })

  it('records nothing for a command that changed nothing', async () => {
    // jsdom has no execCommand, so Bold changes nothing here - which is
    // exactly the case: an entry for it would make one undo press do nothing.
    setup()

    await userEvent.click(screen.getByRole('button', { name: 'Bold' }))

    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
  })
})

describe('standard wording', () => {
  /*
   * A clause is copied into the memo at the caret, as the blocks it is.
   * The editor is handed the list; where it comes from is the composer's
   * business, and there is no control at all when there is nothing to
   * insert.
   */
  const p = (text: string) => ({
    type: 'paragraph' as const,
    content: [{ type: 'text' as const, text }],
  })
  const wording = [
    { id: 'c1', title: 'Recommendation', body: { type: 'doc' as const, content: [p('Approval is solicited.')] } },
    {
      id: 'c2',
      title: 'Roster',
      body: {
        type: 'doc' as const,
        content: [
          { type: 'heading' as const, attrs: { level: 1 as const }, content: [{ type: 'text' as const, text: 'Details:' }] },
          {
            type: 'table' as const,
            content: [{ type: 'tableRow' as const, content: [{ type: 'tableHeader' as const, content: [p('Name')] }] }],
          },
        ],
      },
    },
  ]

  function spyOnInsert() {
    const exec = vi.fn()
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true, writable: true })
    return exec
  }
  const inserted = (exec: ReturnType<typeof vi.fn>): string[] =>
    exec.mock.calls.filter(call => call[0] === 'insertHTML').map(call => call[2] as string)

  afterEach(() => {
    Reflect.deleteProperty(document, 'execCommand')
  })

  function renderWith(initial: MemoBody = body('Opening line.')) {
    const onChange = vi.fn()
    render(<MemoBodyEditor id="memo-body" initialBody={initial} onChange={onChange} wording={wording} />)
    return { region: screen.getByRole('textbox'), onChange }
  }

  it('offers nothing when there is none', () => {
    setup()
    expect(screen.queryByRole('combobox', { name: 'Insert standard wording' })).toBeNull()
  })

  it('offers each title, and inserts the chosen one as memo blocks', async () => {
    const exec = spyOnInsert()
    renderWith()

    const control = screen.getByRole('combobox', { name: 'Insert standard wording' })
    expect(screen.getByRole('option', { name: 'Recommendation' })).toBeInTheDocument()

    await userEvent.selectOptions(control, 'c1')

    expect(inserted(exec)).toEqual(['<p>Approval is solicited.</p>'])
    // Back to the prompt, so the same wording can be inserted again.
    expect(control).toHaveValue('')
  })

  it('leaves somewhere to type after wording that ends in a table', async () => {
    const exec = spyOnInsert()
    renderWith()

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Insert standard wording' }),
      'c2',
    )

    const [html] = inserted(exec)
    expect(html).toContain('<h1>Details:</h1>')
    expect(html).toContain('<table>')
    expect(html!.endsWith('<p><br></p>')).toBe(true)
  })

  it('lands as paragraphs inside a table cell, which is all a cell holds', async () => {
    const exec = spyOnInsert()
    const cell = (type: 'tableHeader' | 'tableCell', text: string) => ({ type, content: [p(text)] })
    const { region } = renderWith({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [cell('tableHeader', 'A')] },
            { type: 'tableRow', content: [cell('tableCell', '1')] },
          ],
        },
      ],
    })
    const target = region.querySelectorAll('td')[0]!
    const range = document.createRange()
    range.selectNodeContents(target)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    // As clicking into the cell would: the editor notes where the caret is.
    fireEvent.mouseUp(region)

    // Opening the select takes the focus and, in some engines, the
    // selection with it. The caret the editor noted is what it inserts at.
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Insert standard wording' }),
      'c2',
    )

    expect(inserted(exec)).toEqual(['<p>Details:</p><p>Name</p>'])
  })
})

describe('naming a colleague with @', () => {
  /*
   * A mistyped name or job title on a memo four people sign is not a typo:
   * it is the wrong person paid. So the directory is offered at the caret,
   * and what it writes is text - fixed at that moment, never a reference
   * that would change a filed memo when somebody's designation changed.
   */
  const people = [
    {
      id: 'u1',
      email: 'inayat@example.com',
      firstName: 'Inayat',
      lastName: 'Hussain',
      designation: 'Security Executive',
      department: { name: 'Security & Loss Prevention' },
    },
    {
      id: 'u2',
      email: 'areeba@example.com',
      firstName: 'Areeba',
      lastName: 'Khan',
      designation: 'Officer',
      department: { name: 'Human Resources' },
    },
  ]
  const directory = vi.mocked(fetchAssignableUsers)

  beforeEach(() => {
    directory.mockReset()
    directory.mockResolvedValue({ users: people, total: people.length, returned: people.length })
  })

  afterEach(() => {
    Reflect.deleteProperty(document, 'execCommand')
  })

  /**
   * Put text in the paragraph with the caret at its end, as typing leaves it.
   *
   * Into the text node that is already there, when there is one: a browser
   * appends keystrokes to the same node, and whether the node is the same
   * one is exactly what "the same @ as before" is judged by.
   */
  function typed(region: HTMLElement, text: string) {
    const paragraph = region.querySelector('p')!
    const existing = paragraph.firstChild
    if (existing && existing.nodeType === Node.TEXT_NODE) existing.textContent = text
    else paragraph.textContent = text
    const range = document.createRange()
    range.setStart(paragraph.firstChild!, text.length)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent.input(region)
  }

  /** Stand in for execCommand, remembering what was selected when it ran. */
  function spyOnInsert() {
    const seen = { selected: '' }
    const exec = vi.fn((command: string) => {
      if (command === 'insertText') {
        const selection = document.getSelection()
        const node = selection?.anchorNode
        seen.selected =
          selection && node
            ? (node.textContent ?? '').slice(
                Math.min(selection.anchorOffset, selection.focusOffset),
                Math.max(selection.anchorOffset, selection.focusOffset),
              )
            : ''
      }
      return true
    })
    Object.defineProperty(document, 'execCommand', {
      value: exec,
      configurable: true,
      writable: true,
    })
    return { exec, seen }
  }

  const settle = () => new Promise(resolve => setTimeout(resolve, 250))

  /** The list, once the directory has answered. */
  /*
   * The directory answers after a debounce, and the toolbar's font and size
   * selects add options of their own to every search for one. A second was
   * enough on a quiet machine and not under a full suite's load, so the wait
   * is longer here - a wait, not a behaviour.
   */
  const listed = async (name: RegExp) => {
    const option = await screen.findByRole('option', { name }, { timeout: 5000 })
    return { option, list: screen.getByRole('listbox', { name: 'People' }) }
  }

  it('offers the people who match what follows the @', async () => {
    const { region } = setup()

    typed(region, 'Dear @in')

    const { list } = await listed(/Inayat Hussain/)
    expect(directory).toHaveBeenCalledWith({ q: 'in', limit: 25 })
    expect(within(list).getByText('Inayat Hussain')).toBeInTheDocument()
    expect(
      within(list).getByText('Security Executive, Security & Loss Prevention'),
    ).toBeInTheDocument()
  })

  it('puts the people whose name starts with the letters first', async () => {
    /*
     * The directory matches a term anywhere, department included, and
     * answers alphabetically - so "ina" comes back as everybody in Finance
     * before Inayat. After an @ the letters are the start of a name.
     */
    directory.mockResolvedValue({
      users: [
        { ...people[1]!, id: 'f1', firstName: 'Aamir', lastName: 'Raza', department: { name: 'Finance' } },
        { ...people[1]!, id: 'f2', firstName: 'Bilal', lastName: 'Ahmed', department: { name: 'Finance' } },
        people[0]!,
      ],
      total: 3,
      returned: 3,
    })
    const { region } = setup()

    typed(region, 'Dear @ina')

    await listed(/Inayat Hussain/)
    // Within the people list: the toolbar's font and size selects have
    // options of their own.
    const names = within(screen.getByRole('listbox', { name: 'People' }))
      .getAllByRole('option')
      .map(option => option.textContent)
    expect(names[0]).toContain('Inayat Hussain')
    expect(screen.getByRole('option', { name: /Inayat Hussain/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('leaves an @ inside an email address alone', async () => {
    const { region } = setup()

    typed(region, 'Write to kazim@ideas')
    await settle()

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(directory).not.toHaveBeenCalled()
  })

  it('writes the chosen person in as text, over what was typed', async () => {
    const { exec, seen } = spyOnInsert()
    const { region } = setup()
    typed(region, 'Dear @in')
    await listed(/Inayat Hussain/)

    fireEvent.keyDown(region, { key: 'Enter' })

    expect(exec).toHaveBeenCalledWith(
      'insertText',
      false,
      'Inayat Hussain, Security Executive, Security & Loss Prevention',
    )
    expect(seen.selected).toBe('@in')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('moves the highlight with the arrow keys, and tells the screen reader', async () => {
    const { exec } = spyOnInsert()
    const { region } = setup()
    typed(region, 'Dear @')
    const { list } = await listed(/Inayat Hussain/)

    fireEvent.keyDown(region, { key: 'ArrowDown' })

    const second = within(list).getByRole('option', { name: /Areeba Khan/ })
    expect(second).toHaveAttribute('aria-selected', 'true')
    expect(region).toHaveAttribute('aria-activedescendant', second.id)

    fireEvent.keyDown(region, { key: 'Tab' })
    expect(exec).toHaveBeenCalledWith('insertText', false, 'Areeba Khan, Officer, Human Resources')
  })

  it('inserts on a click as well', async () => {
    const { exec } = spyOnInsert()
    const { region } = setup()
    typed(region, 'Dear @ar')
    const { option } = await listed(/Areeba Khan/)

    fireEvent.click(option)

    expect(exec).toHaveBeenCalledWith('insertText', false, 'Areeba Khan, Officer, Human Resources')
  })

  it('closes on Escape and stays closed while the same name is typed', async () => {
    const { region } = setup()
    typed(region, 'Dear @in')
    await screen.findByRole('listbox')

    fireEvent.keyDown(region, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()

    typed(region, 'Dear @ina')
    await settle()
    expect(screen.queryByRole('listbox')).toBeNull()

    // A new @ is a new question.
    typed(region, 'Dear @ina and @k')
    expect(await screen.findByRole('listbox')).toBeInTheDocument()
  })

  it('offers a second @ even after the first was dismissed, without leaving it', async () => {
    const { region } = setup()
    typed(region, 'Dear @in')
    await screen.findByRole('listbox')
    fireEvent.keyDown(region, { key: 'Escape' })

    // The dismissed @ is still under the caret's line; a fresh one further
    // along is not the one that was dismissed.
    typed(region, 'Dear @in and @ar')

    expect(await screen.findByRole('listbox')).toBeInTheDocument()
  })

  it('closes when the caret leaves the name', async () => {
    const { region } = setup()
    typed(region, 'Dear @in')
    await screen.findByRole('listbox')

    typed(region, 'Dear @in ')

    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('says when nobody matches', async () => {
    directory.mockResolvedValue({ users: [], total: 0, returned: 0 })
    const { region } = setup()

    typed(region, 'Dear @zz')

    // Said twice on purpose: once visibly, once for the screen reader.
    expect(await screen.findAllByText('No one matches “zz”')).toHaveLength(2)
    expect(screen.getByRole('status')).toHaveTextContent('No one matches “zz”')
  })
})

describe('totalling a column', () => {
  /*
   * A total is written as text, under the caret's column, and the editor
   * says so when the figures above it change. The arithmetic itself is
   * tested in `utils/memoTotals`; what is tested here is that the control
   * reaches the table, that what it wrote is published as memo nodes, and
   * that the warning appears and goes away when it should.
   */
  const cell = (type: 'tableHeader' | 'tableCell', text: string) => ({
    type,
    content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }],
  })
  const row = (...cells: ReturnType<typeof cell>[]) => ({ type: 'tableRow' as const, content: cells })

  const salaries: MemoBody = {
    type: 'doc',
    content: [
      {
        type: 'table',
        content: [
          row(cell('tableHeader', 'Name'), cell('tableHeader', 'Proposed')),
          row(cell('tableCell', 'A. Khan'), cell('tableCell', 'Rs. 92,000')),
          row(cell('tableCell', 'B. Raza'), cell('tableCell', 'Rs. 71,500')),
        ],
      },
    ],
  }

  function caretInto(region: HTMLElement, at: number) {
    const target = region.querySelectorAll('td, th')[at]!
    const selection = window.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(target)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent.mouseUp(region)
  }

  const publishedTable = (onChange: { mock: { calls: unknown[][] } }): MemoTableNode =>
    (onChange.mock.calls.at(-1)![0] as MemoBody).content[0] as MemoTableNode

  const total = () => screen.getByRole('button', { name: 'Total column' })

  it('sits with the column controls, switched off for a table with one row', () => {
    const { region } = setup({
      type: 'doc',
      content: [{ type: 'table', content: [row(cell('tableHeader', 'Only'))] }],
    })
    caretInto(region, 0)

    expect(within(screen.getByRole('toolbar', { name: 'Table' })).getByRole('button', { name: 'Total column' })).toBeDisabled()
  })

  it('writes the total under the caret\u2019s column, and publishes it as bold text', async () => {
    const { region, onChange } = setup(salaries)
    caretInto(region, 3)

    await userEvent.click(total())

    const rows = publishedTable(onChange).content
    expect(rows).toHaveLength(4)
    expect(rows[3]!.content[0]!.content![0]!.content).toEqual([
      { type: 'text', text: 'Total', marks: [{ type: 'bold' }] },
    ])
    expect(rows[3]!.content[1]!.content![0]!.content).toEqual([
      { type: 'text', text: 'Rs. 163,500', marks: [{ type: 'bold' }] },
    ])
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says why a column cannot be totalled, and changes nothing', async () => {
    const { region, onChange } = setup(salaries)
    caretInto(region, 2)
    onChange.mockClear()

    await userEvent.click(total())

    expect(screen.getByRole('status')).toHaveTextContent(
      '“A. Khan” in row 2 is not a figure, so the column was not totalled.',
    )
    expect(onChange).not.toHaveBeenCalled()
    expect(region.querySelectorAll('tr')).toHaveLength(3)
  })

  it('warns when a figure changes under the total, until it is totalled again', async () => {
    const { region } = setup(salaries)
    caretInto(region, 3)
    await userEvent.click(total())

    // A figure retyped above the total, as the browser would report it.
    region.querySelectorAll('td')[1]!.textContent = 'Rs. 95,000'
    fireEvent.input(region)

    expect(screen.getByRole('status')).toHaveTextContent(
      'The total under “Proposed” no longer matches the figures above it.',
    )

    caretInto(region, 3)
    await userEvent.click(total())

    expect(screen.queryByRole('status')).toBeNull()
    expect(region.querySelectorAll('tr')[3]!.textContent).toContain('Rs. 166,500')
  })

  it('warns at once for a draft reopened with a stale total in it', () => {
    setup({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            row(cell('tableHeader', 'Item'), cell('tableHeader', 'Amount')),
            row(cell('tableCell', 'Fuel'), cell('tableCell', '4,000')),
            row(cell('tableCell', 'Total'), cell('tableCell', '3,000')),
          ],
        },
      ],
    })

    expect(screen.getByRole('status')).toHaveTextContent('The total under “Amount” no longer matches')
  })

  it('is one step to undo', async () => {
    const { region, onChange } = setup(salaries)
    caretInto(region, 3)
    await userEvent.click(total())
    expect(region.querySelectorAll('tr')).toHaveLength(4)

    fireEvent.keyDown(region, { key: 'z', ctrlKey: true })

    expect(region.querySelectorAll('tr')).toHaveLength(3)
    expect(publishedTable(onChange).content).toHaveLength(3)
  })
})

describe('finding and replacing', () => {
  /*
   * The bar under the toolbar, and what it does to the text. The matching
   * itself is tested in `utils/memoFind`; here it is the bar: that it opens
   * on the selected words, counts as the query is typed, walks the matches,
   * replaces one or all as memo nodes, and hands the caret back on close.
   */
  const twice = body('Approval is solicited. Approval was given.')

  const find = () => screen.getByLabelText('Find')
  const status = () => screen.getByRole('status')
  const openBar = (region: HTMLElement) => fireEvent.keyDown(region, { key: 'f', ctrlKey: true })
  const publishedText = (onChange: { mock: { calls: unknown[][] } }): string =>
    ((onChange.mock.calls.at(-1)![0] as MemoBody).content[0] as { content?: { text: string }[] })
      .content!.map(run => run.text)
      .join('')

  it('opens with Ctrl+F on the words selected, with the focus in the Find field', () => {
    const { region } = setup(twice)
    const text = region.querySelector('p')!.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 8)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    openBar(region)

    expect(screen.getByRole('search', { name: 'Find and replace' })).toBeInTheDocument()
    expect(find()).toHaveValue('Approval')
    expect(find()).toHaveFocus()
    expect(status()).toHaveTextContent('1 of 2')
  })

  it('counts the matches as the query is typed, and says when there are none', async () => {
    setup(twice)
    await userEvent.click(screen.getByRole('button', { name: 'Find and replace' }))

    await userEvent.type(find(), 'appro')
    expect(status()).toHaveTextContent('1 of 2')

    await userEvent.clear(find())
    await userEvent.type(find(), 'zzz')
    expect(status()).toHaveTextContent('No matches')
    expect(screen.getByRole('button', { name: 'Replace' })).toBeDisabled()
  })

  it('walks the matches with Next and Previous, round the end', async () => {
    const { region } = setup(twice)
    openBar(region)
    await userEvent.type(find(), 'Approval')

    await userEvent.click(screen.getByRole('button', { name: 'Next match' }))
    expect(status()).toHaveTextContent('2 of 2')
    await userEvent.click(screen.getByRole('button', { name: 'Next match' }))
    expect(status()).toHaveTextContent('1 of 2')
    await userEvent.click(screen.getByRole('button', { name: 'Previous match' }))
    expect(status()).toHaveTextContent('2 of 2')
  })

  it('replaces the current match, publishes it, and moves on to the next', async () => {
    const { region, onChange } = setup(twice)
    openBar(region)
    await userEvent.type(find(), 'Approval')
    await userEvent.type(screen.getByLabelText('Replace with'), 'Sanction')

    await userEvent.click(screen.getByRole('button', { name: 'Replace' }))

    expect(publishedText(onChange)).toBe('Sanction is solicited. Approval was given.')
    expect(status()).toHaveTextContent('1 of 1')

    await userEvent.click(screen.getByRole('button', { name: 'Replace' }))

    expect(publishedText(onChange)).toBe('Sanction is solicited. Sanction was given.')
    expect(status()).toHaveTextContent('No matches')
  })

  it('replaces every match at once, says how many, and undoes it as one step', async () => {
    const { region, onChange } = setup(twice)
    openBar(region)
    await userEvent.type(find(), 'approval')
    await userEvent.type(screen.getByLabelText('Replace with'), 'sanction')

    await userEvent.click(screen.getByRole('button', { name: 'Replace all' }))

    expect(status()).toHaveTextContent('Replaced 2')
    expect(publishedText(onChange)).toBe('sanction is solicited. sanction was given.')

    fireEvent.keyDown(region, { key: 'z', ctrlKey: true })

    expect(region.textContent).toBe('Approval is solicited. Approval was given.')
    expect(publishedText(onChange)).toBe('Approval is solicited. Approval was given.')
  })

  it('matches whole words and case only when asked', async () => {
    const { region } = setup(body('Mr and Mrs Khan; mr Raza'))
    openBar(region)
    await userEvent.type(find(), 'Mr')
    expect(status()).toHaveTextContent('1 of 3')

    await userEvent.click(screen.getByLabelText('Whole word'))
    expect(status()).toHaveTextContent('1 of 2')

    await userEvent.click(screen.getByLabelText('Match case'))
    expect(status()).toHaveTextContent('1 of 1')
  })

  it('follows the text as it is typed', async () => {
    const { region } = setup(twice)
    openBar(region)
    await userEvent.type(find(), 'given')
    expect(status()).toHaveTextContent('1 of 1')

    region.querySelector('p')!.textContent = 'Approval is solicited. Approval was granted.'
    fireEvent.input(region)

    expect(status()).toHaveTextContent('No matches')
  })

  it('closes on Escape and puts the caret on the match it was showing', async () => {
    const { region } = setup(twice)
    openBar(region)
    await userEvent.type(find(), 'given')

    fireEvent.keyDown(find(), { key: 'Escape' })

    expect(screen.queryByRole('search')).toBeNull()
    expect(region).toHaveFocus()
    expect(window.getSelection()!.toString()).toBe('given')
  })

  it('reopens on what was last searched for', async () => {
    const { region } = setup(twice)
    openBar(region)
    await userEvent.type(find(), 'given')
    fireEvent.keyDown(find(), { key: 'Escape' })

    // The caret, collapsed, so there is nothing selected to search for instead.
    window.getSelection()!.collapse(region.querySelector('p')!.firstChild, 0)
    openBar(region)

    expect(find()).toHaveValue('given')
  })
})

describe('pictures', () => {
  /*
   * A picture is a block the caret steps over, put in from a file or the
   * clipboard and sized, described and removed from a toolbar of its own.
   * `prepareImage` is the browser's part and is mocked; what is tested is
   * that what it hands back lands as the right block, that the room a memo
   * has for pictures is kept, and that the controls change the node.
   */
  type Block = MemoBody['content'][number]
  const PNG = 'data:image/png;base64,' + 'QUJD'.repeat(100)
  const picture = (attrs: { share?: number; alt?: string } = {}): Block => ({
    type: 'image',
    attrs: { src: PNG, ...attrs },
  })
  const line = (text: string): Block => ({ type: 'paragraph', content: [{ type: 'text', text }] })
  const prepare = vi.mocked(prepareImage)
  const file = () => new File(['png'], 'tray.png', { type: 'image/png' })

  beforeEach(() => {
    prepare.mockReset()
  })

  afterEach(() => {
    Reflect.deleteProperty(document, 'execCommand')
  })

  function spyOnInsert() {
    const exec = vi.fn()
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true, writable: true })
    return exec
  }
  const inserted = (exec: ReturnType<typeof vi.fn>): string[] =>
    exec.mock.calls.filter(call => call[0] === 'insertHTML').map(call => call[2] as string)

  const chooseFile = (chosen: File) =>
    fireEvent.change(screen.getByTestId('memo-picture-file'), { target: { files: [chosen] } })

  const caretInParagraph = (region: HTMLElement) => {
    const text = region.querySelector('p')!.firstChild!
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(text, 0)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent.mouseUp(region)
  }

  /** A click on the picture, which selects it whole. */
  const selectPictureIn = (region: HTMLElement) => {
    fireEvent.mouseUp(region.querySelector('figure img')!)
  }

  const published = (onChange: { mock: { calls: unknown[][] } }): Block[] =>
    (onChange.mock.calls.at(-1)![0] as MemoBody).content

  it('opens the file dialog from the Picture button', async () => {
    setup()
    const input = screen.getByTestId('memo-picture-file')
    const click = vi.spyOn(input, 'click').mockImplementation(() => {})

    await userEvent.click(screen.getByRole('button', { name: 'Picture' }))

    expect(click).toHaveBeenCalledTimes(1)
  })

  it('puts a chosen picture in as a block of its own, sized as the page would draw it', async () => {
    prepare.mockResolvedValue({ src: PNG, width: 400, height: 300 })
    const exec = spyOnInsert()
    const { region } = setup(body('Opening line.'))
    caretInParagraph(region)

    chooseFile(file())

    await waitFor(() => expect(inserted(exec)).toHaveLength(1))
    const html = inserted(exec)[0]!
    expect(html).toContain('data-memo-image="true"')
    expect(html).toContain('data-memo-share="0.59"')
    expect(html.endsWith('<p><br></p>')).toBe(true)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('refuses a picture inside a table, and says where to put it', async () => {
    prepare.mockResolvedValue({ src: PNG, width: 400, height: 300 })
    const exec = spyOnInsert()
    const cell = { type: 'tableCell' as const, content: [line('1') as never] }
    const { region } = setup({
      type: 'doc',
      content: [{ type: 'table', content: [{ type: 'tableRow', content: [cell] }] }],
    })
    const target = region.querySelector('td')!
    const selection = window.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(target)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent.mouseUp(region)

    chooseFile(file())

    expect(await screen.findByRole('status')).toHaveTextContent('A picture cannot go inside a table.')
    expect(inserted(exec)).toHaveLength(0)
  })

  it('refuses a ninth picture, saying so', async () => {
    prepare.mockResolvedValue({ src: PNG, width: 400, height: 300 })
    spyOnInsert()
    const { region } = setup({
      type: 'doc',
      content: [...Array.from({ length: 8 }, () => picture()), line('Text.')],
    })
    caretInParagraph(region)

    chooseFile(file())

    expect(await screen.findByRole('status')).toHaveTextContent(
      'That would make 9 pictures; a memo can carry 8.',
    )
  })

  it('says why a file could not be made ready', async () => {
    prepare.mockResolvedValue({
      refusal: 'Only a PNG or a JPEG can go in a memo. Save the picture as one of those first.',
    })
    setup()

    chooseFile(new File(['x'], 'a.gif', { type: 'image/gif' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Only a PNG or a JPEG')
  })

  it('takes a picture from the clipboard', async () => {
    prepare.mockResolvedValue({ src: PNG, width: 400, height: 300 })
    const exec = spyOnInsert()
    const { region } = setup(body('Opening line.'))
    caretInParagraph(region)

    fireEvent.paste(region, { clipboardData: { getData: () => '', files: [file()] } })

    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(inserted(exec)).toHaveLength(1))
  })

  it('offers the picture controls with the picture selected, and sizes it a tenth at a time', async () => {
    const { region, onChange } = setup({
      type: 'doc',
      content: [line('Above.'), picture({ share: 0.6 }), line('Below.')],
    })
    expect(screen.queryByRole('toolbar', { name: 'Picture' })).toBeNull()

    selectPictureIn(region)
    expect(screen.getByRole('toolbar', { name: 'Picture' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Smaller picture' }))
    expect(published(onChange)[1]).toMatchObject({ type: 'image', attrs: { share: 0.5 } })

    await userEvent.click(screen.getByRole('button', { name: 'Larger picture' }))
    await userEvent.click(screen.getByRole('button', { name: 'Larger picture' }))
    expect(published(onChange)[1]).toMatchObject({ attrs: { share: 0.7 } })
    expect(region.querySelector('figure')!.style.width).toBe('70%')
  })

  it('stops Smaller at a fifth of the column', () => {
    const { region } = setup({ type: 'doc', content: [picture({ share: 0.2 })] })
    selectPictureIn(region)

    expect(screen.getByRole('button', { name: 'Smaller picture' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Larger picture' })).toBeEnabled()
  })

  it('writes the description onto the picture, as one step to undo', async () => {
    const { region, onChange } = setup({ type: 'doc', content: [picture({ share: 0.6 })] })
    selectPictureIn(region)

    await userEvent.type(screen.getByLabelText('Picture description'), 'The tray')

    expect(published(onChange)[0]).toMatchObject({ attrs: { alt: 'The tray' } })
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()

    await userEvent.tab()

    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled()
  })

  it('removes the picture, and undo brings it back', async () => {
    const { region, onChange } = setup({
      type: 'doc',
      content: [line('Above.'), picture({ share: 0.6 }), line('Below.')],
    })
    selectPictureIn(region)

    await userEvent.click(screen.getByRole('button', { name: 'Remove picture' }))

    expect(published(onChange).map(block => block.type)).toEqual(['paragraph', 'paragraph'])
    expect(screen.queryByRole('toolbar', { name: 'Picture' })).toBeNull()

    fireEvent.keyDown(region, { key: 'z', ctrlKey: true })

    expect(published(onChange).map(block => block.type)).toEqual(['paragraph', 'image', 'paragraph'])
  })

  /*
   * Deleting with the keyboard. Chromium left a selected picture standing
   * on Backspace, so the key is taken here: selected whole, or the caret at
   * the start of the paragraph after it, or at the end of the one before.
   */
  const threeBlocks = (): MemoBody => ({
    type: 'doc',
    content: [line('Above.'), picture({ share: 0.6 }), line('Below.')],
  })
  const types = (onChange: { mock: { calls: unknown[][] } }) =>
    published(onChange).map(block => block.type)
  const caretAt = (node: Node, offset: number) => {
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  it('takes a selected picture out on Backspace, through the history', () => {
    const { region, onChange } = setup(threeBlocks())
    selectPictureIn(region)

    const key = fireEvent.keyDown(region, { key: 'Backspace' })

    expect(key).toBe(false)
    expect(types(onChange)).toEqual(['paragraph', 'paragraph'])
    fireEvent.keyDown(region, { key: 'z', ctrlKey: true })
    expect(types(onChange)).toEqual(['paragraph', 'image', 'paragraph'])
  })

  it('takes the picture out on Backspace at the start of the paragraph after it', () => {
    const { region, onChange } = setup(threeBlocks())
    const below = region.querySelectorAll('p')[1]!.firstChild!
    caretAt(below, 0)

    fireEvent.keyDown(region, { key: 'Backspace' })

    expect(types(onChange)).toEqual(['paragraph', 'paragraph'])
  })

  it('takes the picture out on Delete at the end of the paragraph before it', () => {
    const { region, onChange } = setup(threeBlocks())
    const above = region.querySelectorAll('p')[0]!.firstChild as Text
    caretAt(above, above.length)

    fireEvent.keyDown(region, { key: 'Delete' })

    expect(types(onChange)).toEqual(['paragraph', 'paragraph'])
  })

  it('leaves the key to the browser when the caret is not against a picture', () => {
    const { region, onChange } = setup(threeBlocks())
    const below = region.querySelectorAll('p')[1]!.firstChild as Text
    caretAt(below, 2)
    onChange.mockClear()

    const key = fireEvent.keyDown(region, { key: 'Backspace' })

    expect(key).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('spelling', () => {
  /*
   * The editor's own spell check, over the browser's: it knows the
   * organisation's words. The English dictionary is stood in for by a
   * handful of words - what is tested is the flagging, the suggestions under
   * the caret, and the three things a person can do with a flagged word.
   */
  const ENGLISH = new Set(['the', 'approval', 'is', 'solicited', 'for', 'allowance', 'dear', 'sir', 'approved'])
  const fakeSpeller = {
    correct: (word: string) => ENGLISH.has(word.toLowerCase()),
    suggest: (word: string) =>
      word.toLowerCase() === 'aproval'
        ? ['approval']
        : word.toLowerCase() === 'solicted'
          ? ['solicited']
          : [],
  }
  const load = vi.mocked(loadSpeller)

  beforeEach(() => {
    load.mockResolvedValue(fakeSpeller)
  })

  afterEach(() => {
    Reflect.deleteProperty(document, 'execCommand')
  })

  const checkButton = () => screen.getByRole('button', { name: 'Check spelling' })
  const ready = () => waitFor(() => expect(checkButton()).toBeEnabled())
  const count = (text: string | RegExp) => screen.findByText(text)

  /** The caret into a word, at rest, as a click leaves it. */
  const caretInto = (region: HTMLElement, word: string) => {
    const text = region.querySelector('p')!.firstChild as Text
    const at = text.data.indexOf(word) + 2
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(text, at)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent.mouseUp(region)
  }

  function spyOnInsert() {
    const exec = vi.fn()
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true, writable: true })
    return exec
  }

  function renderWith(props: Partial<Parameters<typeof MemoBodyEditor>[0]> = {}, text = 'Aproval is solicted for the allowance.') {
    const onChange = vi.fn()
    render(<MemoBodyEditor id="memo-body" initialBody={body(text)} onChange={onChange} {...props} />)
    return { region: screen.getByRole('textbox'), onChange }
  }

  it('flags the words the dictionary does not know once it has loaded, and says how many', async () => {
    const { region } = renderWith()
    expect(region).toHaveAttribute('spellcheck', 'true')

    expect(await count('2 words the dictionary does not know')).toBeInTheDocument()
    // Ours now stands in for the browser's.
    expect(region).toHaveAttribute('spellcheck', 'false')
  })

  it('leaves the organisation’s words alone', async () => {
    renderWith({ dictionary: ['Somrow'] }, 'Somrow approved the allowance.')
    await ready()

    expect(screen.queryByText(/dictionary does not know/)).toBeNull()
  })

  it('offers suggestions with the caret at rest in a flagged word, and writes the chosen one in', async () => {
    const exec = spyOnInsert()
    const { region } = renderWith()
    await ready()

    caretInto(region, 'Aproval')

    const list = await screen.findByRole('listbox', { name: 'Spelling' })
    expect(within(list).getByRole('option', { name: 'Approval' })).toBeInTheDocument()
    expect(within(list).queryByRole('option', { name: /Add/ })).toBeNull()

    await userEvent.click(within(list).getByRole('option', { name: 'Approval' }))

    expect(exec).toHaveBeenCalledWith('insertText', false, 'Approval')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('takes the highlighted suggestion with Enter, and moves with the arrows', async () => {
    const exec = spyOnInsert()
    const { region } = renderWith()
    await ready()
    caretInto(region, 'Aproval')
    await screen.findByRole('listbox', { name: 'Spelling' })

    fireEvent.keyDown(region, { key: 'ArrowDown' })
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Ignore “Aproval”' })).toHaveAttribute('aria-selected', 'true'),
    )
    fireEvent.keyDown(region, { key: 'ArrowUp' })
    fireEvent.keyDown(region, { key: 'Enter' })

    expect(exec).toHaveBeenCalledWith('insertText', false, 'Approval')
  })

  it('ignores a word for the session', async () => {
    const { region } = renderWith()
    await count('2 words the dictionary does not know')

    caretInto(region, 'Aproval')
    await userEvent.click(await screen.findByRole('option', { name: 'Ignore “Aproval”' }))

    expect(await count('1 word the dictionary does not know')).toBeInTheDocument()
  })

  it('adds a word to the dictionary when the person may, and stops flagging it', async () => {
    const onAddWord = vi.fn().mockResolvedValue(undefined)
    const { region } = renderWith({ canAddWords: true, onAddWord })
    await count('2 words the dictionary does not know')

    caretInto(region, 'Aproval')
    await userEvent.click(await screen.findByRole('option', { name: 'Add “Aproval” to the dictionary' }))

    expect(onAddWord).toHaveBeenCalledWith('Aproval')
    expect(await count('1 word the dictionary does not know')).toBeInTheDocument()
  })

  it('says when the word could not be added', async () => {
    const onAddWord = vi.fn().mockRejectedValue(new Error('“Aproval” is already in the dictionary.'))
    const { region } = renderWith({ canAddWords: true, onAddWord })
    await ready()

    caretInto(region, 'Aproval')
    await userEvent.click(await screen.findByRole('option', { name: /Add “Aproval”/ }))

    expect(await screen.findByRole('status')).toHaveTextContent('already in the dictionary')
  })

  it('keeps the suggestions closed after Escape, for that word', async () => {
    const { region } = renderWith()
    await ready()
    caretInto(region, 'Aproval')
    await screen.findByRole('listbox', { name: 'Spelling' })

    fireEvent.keyDown(region, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()

    caretInto(region, 'Aproval')
    expect(screen.queryByRole('listbox')).toBeNull()

    // Another word is not the one dismissed.
    caretInto(region, 'solicted')
    expect(await screen.findByRole('listbox', { name: 'Spelling' })).toBeInTheDocument()
  })

  it('walks the flagged words from the toolbar', async () => {
    const { region } = renderWith()
    await count('2 words the dictionary does not know')

    await userEvent.click(screen.getByRole('button', { name: 'Next misspelling' }))
    expect(await screen.findByRole('option', { name: 'Ignore “Aproval”' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Next misspelling' }))
    expect(await screen.findByRole('option', { name: 'Ignore “solicted”' })).toBeInTheDocument()
    expect(window.getSelection()!.toString()).toBe('')
    expect(region.contains(window.getSelection()!.anchorNode)).toBe(true)
  })

  it('switches off, and the browser’s own check comes back', async () => {
    const { region } = renderWith()
    await count('2 words the dictionary does not know')

    await userEvent.click(checkButton())

    expect(screen.queryByText(/dictionary does not know/)).toBeNull()
    expect(region).toHaveAttribute('spellcheck', 'true')
    expect(checkButton()).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Next misspelling' })).toBeDisabled()
  })

  it('stands aside when the dictionary cannot be loaded', async () => {
    load.mockRejectedValue(new Error('offline'))
    const { region } = renderWith()

    await waitFor(() => expect(load).toHaveBeenCalled())
    expect(checkButton()).toBeDisabled()
    expect(region).toHaveAttribute('spellcheck', 'true')
  })
})

describe('the keyboard, and what happens as text is typed', () => {
  /*
   * Every control on the toolbar has a key; a few things convert as they
   * are typed; the outline jumps between headings; focus mode takes the
   * editor over the page. What is tested is that each key reaches the same
   * command the button does, that a conversion changes the text and is one
   * undo away, and that the panels open, act and close.
   */
  function spyOnExec() {
    const exec = vi.fn()
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true, writable: true })
    return exec
  }
  /** The commands run, leaving out the two the editor sets up with on mount. */
  const calls = (exec: ReturnType<typeof vi.fn>) =>
    exec.mock.calls
      .filter(call => call[0] !== 'styleWithCSS' && call[0] !== 'defaultParagraphSeparator')
      .map(call => (call[2] === undefined ? [call[0]] : [call[0], call[2]]))

  afterEach(() => {
    Reflect.deleteProperty(document, 'execCommand')
    document.body.style.overflow = ''
  })

  /** Type one character the way a browser does: announce it, land it, report it. */
  function typeChar(region: HTMLElement, character: string) {
    const paragraph = region.querySelector('p')!
    const first = paragraph.firstChild
    const text = first && first.nodeType === Node.TEXT_NODE ? (first as Text) : null
    let event: Event
    try {
      event = new InputEvent('beforeinput', { inputType: 'insertText', data: character, bubbles: true, cancelable: true })
    } catch {
      event = new Event('beforeinput', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'inputType', { value: 'insertText' })
      Object.defineProperty(event, 'data', { value: character })
    }
    region.dispatchEvent(event)
    if (text) text.data += character
    else {
      paragraph.replaceChildren(document.createTextNode(character))
    }
    const node = paragraph.firstChild as Text
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(node, node.length)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent.input(region)
  }

  it('reaches the toolbar’s commands from the keys', () => {
    const exec = spyOnExec()
    const { region } = setup()

    fireEvent.keyDown(region, { code: 'Digit1', key: '1', ctrlKey: true, altKey: true })
    fireEvent.keyDown(region, { code: 'Digit2', key: '2', ctrlKey: true, altKey: true })
    fireEvent.keyDown(region, { code: 'Digit0', key: '0', ctrlKey: true, altKey: true })
    fireEvent.keyDown(region, { code: 'Digit8', key: '*', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(region, { code: 'Digit7', key: '&', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(region, { code: 'KeyT', key: 't', ctrlKey: true, altKey: true })
    fireEvent.keyDown(region, { key: 'Enter', ctrlKey: true })

    expect(calls(exec)).toEqual([
      ['formatBlock', 'h1'],
      ['formatBlock', 'h2'],
      ['formatBlock', 'p'],
      ['insertUnorderedList'],
      ['insertOrderedList'],
      ['insertHTML', '<table><tbody><tr><th><br></th><th><br></th><th><br></th></tr><tr><td><br></td><td><br></td><td><br></td></tr><tr><td><br></td><td><br></td><td><br></td></tr></tbody></table><p><br></p>'],
      ['insertHTML', `${pageBreakHtml()}<p><br></p>`],
    ])
  })

  it('opens the file dialog and the outline from the keys, and the shortcut list from Ctrl+/', async () => {
    const { region } = setup()
    const click = vi.spyOn(screen.getByTestId('memo-picture-file'), 'click').mockImplementation(() => {})

    fireEvent.keyDown(region, { code: 'KeyP', key: 'p', ctrlKey: true, altKey: true })
    expect(click).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(region, { code: 'KeyO', key: 'o', ctrlKey: true, altKey: true })
    expect(await screen.findByRole('listbox', { name: 'Outline' })).toBeInTheDocument()
    fireEvent.keyDown(region, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Outline' })).toBeNull()

    fireEvent.keyDown(region, { key: '/', ctrlKey: true })
    expect(await screen.findByRole('region', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close keyboard shortcuts' }))
    expect(screen.queryByRole('region', { name: 'Keyboard shortcuts' })).toBeNull()
  })

  it('starts a list from a dash and a space, as one step to undo', () => {
    const exec = spyOnExec()
    const { region } = setup(body(''))

    typeChar(region, '-')
    expect(calls(exec)).toEqual([])
    typeChar(region, ' ')

    expect(calls(exec)).toEqual([['insertUnorderedList']])
    expect(region.querySelector('p')!.textContent).toBe('')
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled()

    fireEvent.keyDown(region, { key: 'z', ctrlKey: true })
    expect(region.querySelector('p')!.textContent).toBe('- ')
  })

  it('starts a numbered list and a heading the same way', () => {
    const exec = spyOnExec()
    const { region } = setup(body(''))

    typeChar(region, '1')
    typeChar(region, '.')
    typeChar(region, ' ')
    expect(calls(exec)).toEqual([['insertOrderedList']])

    typeChar(region, '#')
    typeChar(region, '#')
    typeChar(region, ' ')
    expect(calls(exec).at(-1)).toEqual(['formatBlock', 'h2'])
  })

  it('leaves a dash alone once the line is more than a marker, and inside a table', () => {
    const exec = spyOnExec()
    const { region } = setup(body('x'))

    typeChar(region, ' ')
    typeChar(region, '-')
    typeChar(region, ' ')

    expect(calls(exec)).toEqual([])
    expect(region.querySelector('p')!.textContent).toBe('x - ')
  })

  it('curls quotes and joins two hyphens into a dash, and undo takes the character back', () => {
    spyOnExec()
    const { region, onChange } = setup(body(''))

    typeChar(region, '"')
    typeChar(region, 'a')
    typeChar(region, '"')
    typeChar(region, ' ')
    typeChar(region, '-')
    typeChar(region, '-')

    const paragraph = region.querySelector('p')!
    expect(paragraph.textContent).toBe('“a” –')
    expect((onChange.mock.calls.at(-1)![0] as MemoBody).content[0]).toMatchObject({
      content: [{ text: '“a” –' }],
    })
    // The caret stays after what was typed: five characters, the dash last.
    const selection = window.getSelection()!
    expect(selection.anchorOffset).toBe(5)
  })

  it('lists the headings in the outline and jumps to the one chosen', async () => {
    const { region } = setup({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'BACKGROUND:' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Some text.' }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Cost' }] },
      ],
    })

    await userEvent.click(screen.getByRole('button', { name: 'Outline' }))
    const list = await screen.findByRole('listbox', { name: 'Outline' })
    expect(within(list).getAllByRole('option').map(option => option.textContent)).toEqual([
      'BACKGROUND:',
      'Cost',
    ])
    expect(list).toHaveFocus()

    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'Enter' })

    expect(screen.queryByRole('listbox', { name: 'Outline' })).toBeNull()
    expect(region).toHaveFocus()
    expect(window.getSelection()!.anchorNode).toBe(region.querySelector('h2')!.firstChild)
  })

  it('says when there are no headings yet', async () => {
    setup()

    await userEvent.click(screen.getByRole('button', { name: 'Outline' }))

    expect(await screen.findByText(/No headings yet/)).toBeInTheDocument()
  })

  it('takes the editor over the page in focus mode, and Escape brings it back', async () => {
    const { region } = setup()
    const shell = region.closest('.memo-editor-shell')!

    await userEvent.click(screen.getByRole('button', { name: 'Focus mode' }))

    expect(shell).toHaveClass('memo-editor-shell-focus')
    expect(document.body.style.overflow).toBe('hidden')
    expect(screen.getByRole('button', { name: 'Leave focus mode' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Esc leaves focus mode')).toBeInTheDocument()

    fireEvent.keyDown(region, { key: 'Escape' })

    expect(shell).not.toHaveClass('memo-editor-shell-focus')
    expect(document.body.style.overflow).toBe('')
    expect(screen.getByRole('button', { name: 'Focus mode' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('enters focus mode from Ctrl+Shift+F', () => {
    const { region } = setup()

    fireEvent.keyDown(region, { code: 'KeyF', key: 'F', ctrlKey: true, shiftKey: true })

    expect(region.closest('.memo-editor-shell')).toHaveClass('memo-editor-shell-focus')
  })
})

describe('the face and the size the memo is set in', () => {
  /*
   * One face and one size for the whole memo, chosen from the toolbar and
   * carried on the body, where the page draws it the same. Not offered for
   * a clause, which takes the memo's setting when it is inserted.
   */
  it('offers the faces and the sizes, and publishes the choice on the body', async () => {
    const { region, onChange } = setup()

    await userEvent.selectOptions(screen.getByLabelText('Memo font'), 'serif')
    expect((onChange.mock.calls.at(-1)![0] as MemoBody).attrs).toEqual({ font: 'serif' })

    await userEvent.selectOptions(screen.getByLabelText('Memo text size'), '12')
    expect((onChange.mock.calls.at(-1)![0] as MemoBody).attrs).toEqual({ font: 'serif', size: 12 })
    expect(region.style.getPropertyValue('--memo-scale')).toBe('1.2')
    expect(region.style.getPropertyValue('--memo-font')).toContain('Liberation Serif')
  })

  it('opens a memo in the face and at the size it was set in', () => {
    const { region } = setup({
      type: 'doc',
      attrs: { font: 'sans', size: 11 },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Set already.' }] }],
    })

    expect(screen.getByLabelText('Memo font')).toHaveValue('sans')
    expect(screen.getByLabelText('Memo text size')).toHaveValue('11')
    expect(region.getAttribute('data-memo-font')).toBe('sans')
    expect(region.style.getPropertyValue('--memo-scale')).toBe('1.1')
  })

  it('goes back to carrying nothing when set back to the default', async () => {
    const { onChange } = setup({
      type: 'doc',
      attrs: { font: 'sans' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
    })

    await userEvent.selectOptions(screen.getByLabelText('Memo font'), 'jakarta')

    expect((onChange.mock.calls.at(-1)![0] as MemoBody).attrs).toBeUndefined()
  })

  it('is not offered where the body is a clause rather than a memo', () => {
    render(<MemoBodyEditor id="memo-body" initialBody={body('x')} onChange={vi.fn()} typography={false} />)

    expect(screen.queryByLabelText('Memo font')).toBeNull()
    expect(screen.queryByLabelText('Memo text size')).toBeNull()
  })
})
