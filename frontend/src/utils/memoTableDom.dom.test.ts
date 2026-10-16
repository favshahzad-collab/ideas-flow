import { describe, expect, it } from 'vitest'

import { htmlToMemoBody } from './memoDom'
import {
  MIN_COLUMN_FRACTION,
  MAX_ROW_HEIGHT,
  addColumn,
  addRow,
  cellAt,
  cellsOf,
  columnCount,
  columnOf,
  fillTableFrom,
  heightOf,
  mergeCells,
  mergeTarget,
  removeColumn,
  removeRow,
  resizeColumn,
  rowsOf,
  setRowHeight,
  setWidths,
  spanOf,
  splitCell,
  widthsOf,
} from './memoTableDom'
import type { MemoTableNode } from '../types/memo'

/**
 * Shaping a table the way a word processor does.
 *
 * Two invariants run through every one of these, because the server enforces
 * both and refuses a body that breaks either: every row covers the same
 * number of columns, and the widths - when a table has any - number exactly
 * as many as there are columns. A control that quietly broke one of them
 * would be discovered at the moment of submitting, which is the moment a
 * preparer can least afford to lose their work.
 */

function tableFrom(html: string): HTMLTableElement {
  const host = document.createElement('div')
  host.innerHTML = html
  return host.querySelector('table')!
}

/** A plain table of `columns` by `rows`, the shape the editor inserts. */
function grid(rows: number, columns: number): HTMLTableElement {
  const head = `<tr>${'<th><br></th>'.repeat(columns)}</tr>`
  const body = `<tr>${'<td><br></td>'.repeat(columns)}</tr>`.repeat(rows - 1)
  return tableFrom(`<table><tbody>${head}${body}</tbody></table>`)
}

/** What each row covers, counting a merged cell as the columns it spans. */
const shape = (table: HTMLTableElement): number[] =>
  rowsOf(table).map(row =>
    cellsOf(row).reduce((total, cell) => total + spanOf(cell), 0),
  )

/** The table as the server would receive it. */
function asNode(table: HTMLTableElement): MemoTableNode {
  const host = table.closest('div') ?? table.parentElement!
  return htmlToMemoBody(host as HTMLElement).content[0] as MemoTableNode
}

describe('rows', () => {
  it('adds one below the row the caret is in, not at the end', () => {
    // Adding at the end is what a table does when it is a list. A person
    // editing a table means "another one here", beside what they are reading.
    const table = grid(3, 3)
    addRow(table, rowsOf(table)[0]!)

    expect(rowsOf(table)).toHaveLength(4)
    expect(shape(table)).toEqual([3, 3, 3, 3])
    expect(cellsOf(rowsOf(table)[1]!)[0]!.tagName).toBe('TD')
  })

  it('gives the new row a cell for every column, merges included', () => {
    const table = tableFrom(
      '<table><tbody><tr><th colspan="3"><br></th></tr></tbody></table>',
    )
    addRow(table, rowsOf(table)[0]!)

    expect(shape(table)).toEqual([3, 3])
  })

  it('removes one', () => {
    const table = grid(3, 2)
    expect(removeRow(table, rowsOf(table)[1]!)).toBe(true)
    expect(rowsOf(table)).toHaveLength(2)
  })

  it('declines to remove the only one', () => {
    /*
     * Removing it would have to take the table with it, and none of these
     * operations sits on the browser's undo stack - so a press that destroys
     * more than it says would destroy it for good. The editor offers the
     * control switched off instead.
     */
    const table = grid(1, 3)
    expect(removeRow(table, rowsOf(table)[0]!)).toBe(false)
    expect(rowsOf(table)).toHaveLength(1)
  })
})

describe('columns', () => {
  it('adds one to every row, so the table stays rectangular', () => {
    const table = grid(3, 3)
    addColumn(table, 0)

    expect(shape(table)).toEqual([4, 4, 4])
    expect(cellsOf(rowsOf(table)[0]!)[1]!.tagName).toBe('TH')
  })

  it('widens a merged cell the new column lands inside', () => {
    // The merge is what somebody asked for. A new column is not a reason to
    // undo it, and splitting the cell would move their text.
    const table = tableFrom(
      '<table><tbody>' +
        '<tr><th><br></th><th><br></th><th><br></th></tr>' +
        '<tr><td colspan="3">Total</td></tr>' +
        '</tbody></table>',
    )

    addColumn(table, 1)

    expect(shape(table)).toEqual([4, 4])
    expect(spanOf(cellsOf(rowsOf(table)[1]!)[0]!)).toBe(4)
  })

  it('removes one from every row', () => {
    const table = grid(2, 3)
    expect(removeColumn(table, 1)).toBe(true)
    expect(shape(table)).toEqual([2, 2])
  })

  it('narrows a merged cell rather than taking it away', () => {
    // It still covers the columns either side. Removing it would take
    // somebody else's text with it.
    const table = tableFrom(
      '<table><tbody>' +
        '<tr><th><br></th><th><br></th><th><br></th></tr>' +
        '<tr><td colspan="3">Total</td></tr>' +
        '</tbody></table>',
    )

    removeColumn(table, 1)

    expect(shape(table)).toEqual([2, 2])
    expect(cellsOf(rowsOf(table)[1]!)[0]!).toHaveTextContent('Total')
  })

  it('declines to remove the only one', () => {
    const table = grid(2, 1)
    expect(removeColumn(table, 0)).toBe(false)
    expect(shape(table)).toEqual([1, 1])
  })
})

describe('column widths', () => {
  it('reports none for a table nobody has sized', () => {
    // Which is what lets the renderer size it from its content, exactly as
    // it did before any of this existed.
    expect(widthsOf(grid(2, 3))).toBeNull()
  })

  it('moves one boundary and leaves the rest of the table alone', () => {
    const table = grid(2, 3)
    setWidths(table, [1 / 3, 1 / 3, 1 / 3])

    resizeColumn(table, 0, 0.5)

    const widths = widthsOf(table)!
    expect(widths[0]).toBeCloseTo(0.5, 3)
    // The second column gave up what the first took; the third never moved.
    expect(widths[1]).toBeCloseTo(1 / 6, 3)
    expect(widths[2]).toBeCloseTo(1 / 3, 3)
  })

  it('will not drag a column away to nothing', () => {
    const table = grid(2, 2)
    setWidths(table, [0.5, 0.5])

    resizeColumn(table, 0, 0.001)

    expect(widthsOf(table)![0]).toBeCloseTo(MIN_COLUMN_FRACTION, 3)
  })

  it('keeps as many widths as there are columns when one is added', () => {
    /*
     * The one that would bite. Somebody resizes a column, then adds another;
     * the widths now describe a table that no longer exists, and the server
     * refuses the submission rather than guess which column the missing width
     * belonged to.
     */
    const table = grid(2, 3)
    setWidths(table, [0.5, 0.25, 0.25])

    addColumn(table, 0)

    expect(widthsOf(table)).toHaveLength(4)
    expect(asNode(table).attrs?.widths).toHaveLength(columnCount(table))
    // The new column took half of the one it was added beside, so nothing
    // else on the row shifted out from under what was being read.
    expect(widthsOf(table)!.slice(0, 2)).toEqual([0.25, 0.25])
  })

  it('keeps as many widths as there are columns when one is removed', () => {
    const table = grid(2, 3)
    setWidths(table, [0.5, 0.25, 0.25])

    removeColumn(table, 0)

    expect(asNode(table).attrs?.widths).toHaveLength(columnCount(table))
  })

  it('comes back out of the DOM as shares that add up', () => {
    const table = grid(2, 4)
    setWidths(table, [0.4, 0.2, 0.2, 0.2])

    const widths = asNode(table).attrs!.widths!
    const total = widths.reduce((sum, width) => sum + width, 0)

    expect(total).toBeCloseTo(1, 3)
  })
})

describe('merging cells', () => {
  const row = (...cells: string[]) =>
    tableFrom(
      `<table><tbody><tr>${cells
        .map(text => `<td>${text}</td>`)
        .join('')}</tr></tbody></table>`,
    )

  it('makes one cell covering both', () => {
    const table = row('<p>Left</p>', '<p>Right</p>')
    expect(mergeCells(cellsOf(rowsOf(table)[0]!))).toBe(true)

    expect(shape(table)).toEqual([2])
    expect(cellsOf(rowsOf(table)[0]!)).toHaveLength(1)
  })

  it('keeps what both of them said', () => {
    const table = row('<p>Left</p>', '<p>Right</p>')
    mergeCells(cellsOf(rowsOf(table)[0]!))

    const merged = cellsOf(rowsOf(table)[0]!)[0]!
    expect(merged).toHaveTextContent('Left')
    expect(merged).toHaveTextContent('Right')
  })

  it('keeps text typed straight into a cell, with no paragraph of its own', () => {
    /*
     * A cell typed into directly holds a bare text node, and the reader takes
     * a cell's paragraphs when it has any. Appended beside another cell's
     * paragraph without a block of its own, those words would be read as
     * neither - and would vanish on the way to the PDF. This is the whole
     * reason merging wraps before it appends.
     */
    const table = row('Bare words', '<p>In a paragraph</p>')
    mergeCells(cellsOf(rowsOf(table)[0]!))

    const cell = asNode(table).content[0]!.content[0]!
    const text = (cell.content ?? [])
      .flatMap(paragraph => paragraph.content ?? [])
      .map(node => node.text)
      .join(' ')

    expect(text).toContain('Bare words')
    expect(text).toContain('In a paragraph')
  })

  it('leaves an empty cell empty rather than filling it with blank lines', () => {
    const table = row('<p>Only this</p>', '<p><br></p>')
    mergeCells(cellsOf(rowsOf(table)[0]!))

    const cell = asNode(table).content[0]!.content[0]!
    expect(cell.content ?? []).toHaveLength(1)
  })

  it('refuses to merge a cell with nothing', () => {
    const table = row('<p>Alone</p>')
    expect(mergeCells(cellsOf(rowsOf(table)[0]!))).toBe(false)
  })

  it('splits a merged cell back into the columns it covered', () => {
    const table = tableFrom(
      '<table><tbody><tr><td colspan="3"><p>Across</p></td></tr></tbody></table>',
    )

    expect(splitCell(cellsOf(rowsOf(table)[0]!)[0]!)).toBe(true)
    expect(cellsOf(rowsOf(table)[0]!)).toHaveLength(3)
    expect(shape(table)).toEqual([3])
    // The text stays where it was rather than being shared out.
    expect(cellsOf(rowsOf(table)[0]!)[0]!).toHaveTextContent('Across')
  })

  it('declines to split a cell that was never merged', () => {
    const table = row('<p>One</p>', '<p>Two</p>')
    expect(splitCell(cellsOf(rowsOf(table)[0]!)[0]!)).toBe(false)
  })
})

describe('what a merge press acts on', () => {
  const table = () =>
    tableFrom(
      '<table><tbody><tr><td>A</td><td>B</td><td>C</td></tr></tbody></table>',
    )

  const selectionOver = (from: Node, to: Node): Selection => {
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(from, 0)
    range.setEnd(to, to.childNodes.length)
    selection.removeAllRanges()
    selection.addRange(range)
    return selection
  }

  it('takes the cells a selection runs across', () => {
    const built = table()
    const cells = cellsOf(rowsOf(built)[0]!)
    document.body.appendChild(built.closest('div') ?? built)

    const chosen = mergeTarget(selectionOver(cells[0]!, cells[2]!))
    expect(chosen).toHaveLength(3)
  })

  it('takes the cell beside it when only one is selected', () => {
    // So a table can be built up one press at a time, which is how anybody
    // who has not thought about it first will do it.
    const built = table()
    const cells = cellsOf(rowsOf(built)[0]!)
    document.body.appendChild(built.closest('div') ?? built)

    const chosen = mergeTarget(selectionOver(cells[0]!, cells[0]!))
    expect(chosen).toEqual([cells[0], cells[1]])
  })

  it('takes nothing at the end of a row', () => {
    const built = table()
    const cells = cellsOf(rowsOf(built)[0]!)
    document.body.appendChild(built.closest('div') ?? built)

    expect(mergeTarget(selectionOver(cells[2]!, cells[2]!))).toEqual([])
  })
})

describe('row heights', () => {
  it('reports what was asked for, in the memo\\u2019s own points', () => {
    const table = grid(2, 2)
    const row = rowsOf(table)[1]!

    setRowHeight(row, 48)

    expect(heightOf(row)).toBe(48)
    expect(asNode(table).content[1]!.attrs?.height).toBe(48)
  })

  it('refuses a height no page has room for', () => {
    const table = grid(2, 2)
    const row = rowsOf(table)[1]!

    setRowHeight(row, 5_000)

    expect(heightOf(row)).toBe(MAX_ROW_HEIGHT)
  })

  it('leaves a row nobody has sized carrying no height at all', () => {
    // Which is what keeps a table filed before any of this drawn exactly as
    // it was, and most tables sized from their content as they always were.
    const table = grid(2, 2)
    expect(heightOf(rowsOf(table)[0]!)).toBeNull()
    expect(asNode(table).content[0]!.attrs).toBeUndefined()
  })
})

describe('finding one\\u2019s way around', () => {
  it('counts the columns before a cell, not the cells', () => {
    const table = tableFrom(
      '<table><tbody><tr>' +
        '<td colspan="2">A</td><td>B</td>' +
        '</tr></tbody></table>',
    )

    const cells = cellsOf(rowsOf(table)[0]!)
    expect(columnOf(cells[0]!)).toBe(0)
    expect(columnOf(cells[1]!)).toBe(2)
    expect(columnCount(table)).toBe(3)
  })
})

describe('filling a table from one cell, as pasting into a spreadsheet does', () => {
  const twoByTwo =
    '<table><tbody>' +
    '<tr><th>A</th><th>B</th></tr>' +
    '<tr><td>1</td><td>2</td></tr>' +
    '</tbody></table>'

  const grid = (table: HTMLTableElement): string[][] =>
    rowsOf(table).map((row) => cellsOf(row).map((cell) => cell.textContent ?? ''))

  const write = (cell: HTMLTableCellElement, row: number, column: number) => {
    cell.textContent = `${row}${column}`
  }

  it('lands with its corner in that cell and grows the table to take the rest', () => {
    const table = tableFrom(twoByTwo)
    const corner = cellsOf(rowsOf(table)[1]!)[1]! // the "2"

    fillTableFrom(table, corner, { rows: 2, columns: 2 }, write)

    expect(grid(table)).toEqual([
      ['A', 'B', ''],
      ['1', '00', '01'],
      ['', '10', '11'],
    ])
  })

  it('keeps the header row a header row where it grows', () => {
    const table = tableFrom(twoByTwo)

    fillTableFrom(table, cellsOf(rowsOf(table)[1]!)[1]!, { rows: 1, columns: 2 }, write)

    expect(cellsOf(rowsOf(table)[0]!).map((cell) => cell.tagName)).toEqual(['TH', 'TH', 'TH'])
  })

  it('keeps the widths numbering the columns', () => {
    const table = tableFrom(twoByTwo)
    setWidths(table, [0.5, 0.5])

    fillTableFrom(table, cellsOf(rowsOf(table)[1]!)[0]!, { rows: 1, columns: 4 }, write)

    expect(columnCount(table)).toBe(4)
    expect(widthsOf(table)).toHaveLength(4)
  })

  it('writes into a merged cell once and skips the columns it covers', () => {
    const table = tableFrom(
      '<table><tbody><tr><td colspan="2">AB</td><td>C</td></tr></tbody></table>',
    )
    const writes: [number, number][] = []

    fillTableFrom(table, cellsOf(rowsOf(table)[0]!)[0]!, { rows: 1, columns: 3 }, (_, row, column) => {
      writes.push([row, column])
    })

    expect(writes).toEqual([
      [0, 0],
      [0, 2],
    ])
    expect(columnCount(table)).toBe(3)
  })

  it('does nothing for an empty grid', () => {
    const table = tableFrom(twoByTwo)

    fillTableFrom(table, cellsOf(rowsOf(table)[0]!)[0]!, { rows: 0, columns: 0 }, write)

    expect(grid(table)).toEqual([
      ['A', 'B'],
      ['1', '2'],
    ])
  })

  it('finds the cell covering a column', () => {
    const table = tableFrom(
      '<table><tbody><tr><td colspan="2">AB</td><td>C</td></tr></tbody></table>',
    )
    const row = rowsOf(table)[0]!

    expect(cellAt(row, 1)?.textContent).toBe('AB')
    expect(cellAt(row, 2)?.textContent).toBe('C')
    expect(cellAt(row, 3)).toBeNull()
  })
})
