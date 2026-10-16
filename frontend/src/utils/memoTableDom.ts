/**
 * Editing a table in the memo, as operations on the DOM.
 *
 * The editor is a `contenteditable` region, so the DOM is the model: a table
 * in a memo is a real `<table>` the browser lays out and the caret moves
 * around inside, not a picture of one. These are the operations somebody
 * expects from a table - add and remove rows and columns, merge cells, drag a
 * boundary to resize - written against that element directly.
 *
 * They live here rather than in the component because they are the part worth
 * testing. Whether removing a column leaves the table rectangular is a
 * question about a table, and a test that has to mount an editor to ask it is
 * testing the wrong thing.
 *
 * Two invariants hold across every operation, because the server enforces
 * both and refuses a body that breaks either:
 *
 *  - every row covers the same number of columns, counting merged cells as
 *    the columns they cover;
 *  - the column widths, when there are any, number exactly as many as there
 *    are columns.
 */

/** Written beside the CSS width so the value can be read back exactly. */
export const WIDTH_ATTRIBUTE = 'data-memo-width'
export const HEIGHT_ATTRIBUTE = 'data-memo-height'

/**
 * The narrowest a column may be dragged, as a fraction of the table.
 *
 * Comfortably above the renderer's own floor of 26 points in a 508.88 point
 * text column, so a column dragged to the stop here is drawn at the width it
 * was dragged to rather than quietly widened on the way to the PDF.
 */
export const MIN_COLUMN_FRACTION = 0.06

/** And for a row, in points. Below this the renderer draws nothing legible. */
export const MIN_ROW_HEIGHT = 16
/** A row taller than the page has room for could never be drawn whole. */
export const MAX_ROW_HEIGHT = 600

/** How much one press of a resize control moves a boundary. */
export const COLUMN_STEP = 0.02
export const ROW_STEP = 6

/**
 * The memo's text column, in points.
 *
 * A table spans exactly this, so the width of a table on screen is the scale
 * between the two: points per pixel, without anything having to be told how
 * large the sheet is being drawn.
 */
export const TEXT_WIDTH = 508.88

const round = (value: number, places: number): number =>
  Number(value.toFixed(places))

// ── Finding one's way around ────────────────────────────────────────────────

function elementOf(node: Node | null | undefined): HTMLElement | null {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as HTMLElement)
    : node.parentElement
}

export function tableOf(node: Node | null | undefined): HTMLTableElement | null {
  return elementOf(node)?.closest('table') ?? null
}

export function cellOf(
  node: Node | null | undefined,
): HTMLTableCellElement | null {
  return elementOf(node)?.closest('td, th') ?? null
}

export function rowsOf(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.querySelectorAll('tr'))
}

export function cellsOf(row: HTMLTableRowElement): HTMLTableCellElement[] {
  return Array.from(row.children).filter(
    (child): child is HTMLTableCellElement =>
      child.tagName === 'TD' || child.tagName === 'TH',
  )
}

/** How many columns a cell covers. */
export function spanOf(cell: HTMLTableCellElement): number {
  const span = Number(cell.getAttribute('colspan'))
  return Number.isFinite(span) && span > 1 ? Math.floor(span) : 1
}

/** How many columns a row covers, which is not how many cells it holds. */
function rowSpan(row: HTMLTableRowElement): number {
  return cellsOf(row).reduce((total, cell) => total + spanOf(cell), 0)
}

export function columnCount(table: HTMLTableElement): number {
  return Math.max(0, ...rowsOf(table).map(rowSpan))
}

/** The first column a cell covers, counting the spans before it. */
export function columnOf(cell: HTMLTableCellElement): number {
  const row = cell.closest('tr')
  if (!row) return 0

  let column = 0
  for (const other of cellsOf(row)) {
    if (other === cell) break
    column += spanOf(other)
  }
  return column
}

/** The cell covering a column in this row, and where its span begins. */
function cellCovering(
  row: HTMLTableRowElement,
  column: number,
): { cell: HTMLTableCellElement; from: number } | null {
  let at = 0
  for (const cell of cellsOf(row)) {
    const span = spanOf(cell)
    if (column < at + span) return { cell, from: at }
    at += span
  }
  return null
}

function setSpan(cell: HTMLTableCellElement, span: number): void {
  if (span > 1) cell.setAttribute('colspan', String(Math.floor(span)))
  else cell.removeAttribute('colspan')
}

function blankCell(
  row: HTMLTableRowElement,
  tag: 'td' | 'th' = 'td',
): HTMLTableCellElement {
  const cell = row.ownerDocument.createElement(tag)
  cell.appendChild(row.ownerDocument.createElement('br'))
  return cell as HTMLTableCellElement
}

// ── Column widths ───────────────────────────────────────────────────────────

/**
 * Widths brought back into range: none below the floor, and summing to one.
 *
 * The sum matters because the renderer reads these as shares of the text
 * column. A set summing to 1.3 would draw every column narrower than it looks
 * on screen, which is the one thing a resize must never do.
 */
function normalise(widths: number[]): number[] {
  const count = widths.length
  if (count === 0) return []

  const floor = count * MIN_COLUMN_FRACTION > 1 ? 1 / count : MIN_COLUMN_FRACTION
  const clamped = widths.map((width) =>
    Number.isFinite(width) && width > floor ? width : floor,
  )
  const total = clamped.reduce((sum, width) => sum + width, 0)

  return clamped.map((width) => round(width / total, 4))
}

/** The widths this table carries, or null where it has never been sized. */
export function widthsOf(table: HTMLTableElement): number[] | null {
  const columns = Array.from(table.querySelectorAll('col'))
  if (columns.length === 0) return null

  const widths = columns.map((column) =>
    Number(column.getAttribute(WIDTH_ATTRIBUTE)),
  )
  if (widths.some((width) => !Number.isFinite(width) || width <= 0)) return null

  return normalise(widths)
}

export function setWidths(table: HTMLTableElement, widths: number[]): void {
  const shares = normalise(widths)
  const doc = table.ownerDocument

  let group = table.querySelector('colgroup')
  if (!group) {
    group = doc.createElement('colgroup')
    table.insertBefore(group, table.firstChild)
  }

  group.replaceChildren(
    ...shares.map((share) => {
      const column = doc.createElement('col')
      column.setAttribute(WIDTH_ATTRIBUTE, String(share))
      column.style.width = `${round(share * 100, 3)}%`
      return column
    }),
  )

  // Without this the browser sizes the columns from their content and the
  // widths somebody dragged have no effect on screen, however faithfully the
  // PDF then draws them.
  table.style.tableLayout = 'fixed'
}

/** Even columns, for a table being sized for the first time. */
export function evenWidths(count: number): number[] {
  return new Array<number>(Math.max(1, count)).fill(1 / Math.max(1, count))
}

/**
 * Move one boundary, leaving the rest of the table where it is.
 *
 * `boundary` is the line between column `boundary` and the one after it, and
 * only those two change: what one gains the other gives up. Scaling every
 * column instead would mean dragging one edge quietly resized the whole
 * table, which is not what dragging an edge means anywhere else.
 */
export function resizeColumn(
  table: HTMLTableElement,
  boundary: number,
  share: number,
): void {
  const count = columnCount(table)
  const widths = widthsOf(table) ?? evenWidths(count)
  if (boundary < 0 || boundary >= widths.length - 1) return

  const left = widths[boundary]!
  const right = widths[boundary + 1]!
  const pair = left + right

  const next = Math.min(
    Math.max(share, MIN_COLUMN_FRACTION),
    pair - MIN_COLUMN_FRACTION,
  )
  if (!(next > 0)) return

  widths[boundary] = next
  widths[boundary + 1] = pair - next
  setWidths(table, widths)
}

/** Nudge a boundary by a step, which is how this is done without a mouse. */
export function stepColumn(
  table: HTMLTableElement,
  boundary: number,
  by: number,
): void {
  const widths = widthsOf(table) ?? evenWidths(columnCount(table))
  resizeColumn(table, boundary, (widths[boundary] ?? 0) + by)
}

// ── Row heights ─────────────────────────────────────────────────────────────

export function heightOf(row: HTMLTableRowElement): number | null {
  const height = Number(row.getAttribute(HEIGHT_ATTRIBUTE))
  return Number.isFinite(height) && height > 0 ? height : null
}

/**
 * Ask a row to be a given height, in points.
 *
 * A minimum, not a measurement: the renderer gives a row whose content needs
 * more room more room, because a clipped cell loses a figure off a document
 * somebody signs. So the screen shows `min-height` too - a row that grew to
 * fit what was typed into it looks the way it will print.
 */
export function setRowHeight(row: HTMLTableRowElement, points: number): void {
  const height = round(
    Math.min(Math.max(points, MIN_ROW_HEIGHT), MAX_ROW_HEIGHT),
    2,
  )

  row.setAttribute(HEIGHT_ATTRIBUTE, String(height))
  // In the sheet's own points rather than the browser's, so a row is the same
  // fraction of the page here as it is in the PDF.
  row.style.height = `calc(${height} * var(--memo-pt))`
}

export function clearRowHeight(row: HTMLTableRowElement): void {
  row.removeAttribute(HEIGHT_ATTRIBUTE)
  row.style.removeProperty('height')
}

// ── Rows and columns ────────────────────────────────────────────────────────

/** A new row of plain cells, below the one the caret is in. */
export function addRow(table: HTMLTableElement, below: HTMLTableRowElement): void {
  const fresh = table.ownerDocument.createElement('tr')
  for (let at = 0; at < columnCount(table); at += 1) {
    fresh.appendChild(blankCell(fresh))
  }
  below.parentElement?.insertBefore(fresh, below.nextSibling)
}

/**
 * Take a row out. False when it was the last one, which the caller answers by
 * removing the table: a table with no rows is not a table, and the server
 * refuses one.
 */
export function removeRow(
  table: HTMLTableElement,
  row: HTMLTableRowElement,
): boolean {
  if (rowsOf(table).length <= 1) return false
  row.remove()
  return true
}

/**
 * A new column after the one given.
 *
 * Where the new column falls inside a merged cell, that cell grows by one
 * instead of being split - the merge is what somebody asked for, and a new
 * column is not a reason to undo it. Every other row gets a cell, so the
 * table stays rectangular.
 */
export function addColumn(table: HTMLTableElement, after: number): void {
  for (const row of rowsOf(table)) {
    const covering = cellCovering(row, after)
    if (!covering) {
      row.appendChild(blankCell(row, cellsOf(row)[0]?.tagName === 'TH' ? 'th' : 'td'))
      continue
    }

    const { cell } = covering
    const span = spanOf(cell)

    if (span > 1) {
      setSpan(cell, span + 1)
      continue
    }

    const fresh = blankCell(row, cell.tagName === 'TH' ? 'th' : 'td')
    cell.parentElement?.insertBefore(fresh, cell.nextSibling)
  }

  const widths = widthsOf(table)
  if (!widths) return

  // The new column takes half of the one it was added beside, so the rest of
  // the table does not shift out from under what somebody was reading.
  const taken = (widths[after] ?? 1 / widths.length) / 2
  widths[after] = taken
  widths.splice(after + 1, 0, taken)
  setWidths(table, widths)
}

/**
 * Take a column out of every row. False when it was the last one.
 *
 * A merged cell covering it narrows by one rather than disappearing: it still
 * covers the columns either side, and removing it would take somebody else's
 * text away as well.
 */
export function removeColumn(table: HTMLTableElement, at: number): boolean {
  if (columnCount(table) <= 1) return false

  for (const row of rowsOf(table)) {
    const covering = cellCovering(row, at)
    if (!covering) continue

    const { cell } = covering
    const span = spanOf(cell)

    if (span > 1) setSpan(cell, span - 1)
    else cell.remove()
  }

  const widths = widthsOf(table)
  if (widths && at < widths.length) {
    widths.splice(at, 1)
    setWidths(table, widths)
  }

  return true
}

/** The cell covering a column of this row, if the row reaches that far. */
export function cellAt(
  row: HTMLTableRowElement,
  column: number,
): HTMLTableCellElement | null {
  return cellCovering(row, column)?.cell ?? null
}

/**
 * Write a grid of values into the table, starting at one cell.
 *
 * What pasting a block of cells from a spreadsheet does: the block lands with
 * its top-left corner in the cell the caret is in and spreads right and down
 * from there, and the table grows to take it - rows below, columns to the
 * right - rather than the block being cut to fit. Growing goes through
 * `addRow` and `addColumn`, so the table stays rectangular and its widths, if
 * it has any, still number as many as its columns.
 *
 * `write` is handed each target cell with the grid position it takes. It
 * writes nothing into the middle of a merged cell: the value for the column a
 * merge begins in goes into the merged cell, and the values for the columns
 * it covers have nowhere of their own to go. A spreadsheet refuses the whole
 * paste in that case; here the rest of the block still lands.
 */
export function fillTableFrom(
  table: HTMLTableElement,
  from: HTMLTableCellElement,
  size: { rows: number; columns: number },
  write: (cell: HTMLTableCellElement, row: number, column: number) => void,
): void {
  const startRow = rowsOf(table).indexOf(from.closest('tr') as HTMLTableRowElement)
  if (startRow < 0 || size.rows < 1 || size.columns < 1) return

  const startColumn = columnOf(from)

  while (columnCount(table) < startColumn + size.columns) {
    addColumn(table, columnCount(table) - 1)
  }
  while (rowsOf(table).length < startRow + size.rows) {
    addRow(table, rowsOf(table)[rowsOf(table).length - 1]!)
  }

  const rows = rowsOf(table)
  for (let r = 0; r < size.rows; r += 1) {
    const row = rows[startRow + r]!
    for (let c = 0; c < size.columns; c += 1) {
      const column = startColumn + c
      const covering = cellCovering(row, column)
      if (!covering || covering.from !== column) continue
      write(covering.cell, r, c)
    }
  }
}

// ── Merging ─────────────────────────────────────────────────────────────────

/**
 * A cell's content as blocks, giving raw text a block of its own.
 *
 * A cell typed straight into holds a bare text node. Appended beside another
 * cell's paragraph it would be read as neither - the reader takes a cell's
 * paragraphs when it has any, and a loose text node is not one - so the words
 * would vanish on the way to the PDF. Wrapping first is the difference
 * between merging two cells and losing half of what they said.
 */
function blocksOf(cell: HTMLTableCellElement): HTMLElement[] {
  const blocks = Array.from(cell.children).filter((child) =>
    ['P', 'DIV'].includes(child.tagName),
  ) as HTMLElement[]

  if (blocks.length > 0) return blocks

  const wrapper = cell.ownerDocument.createElement('p')
  while (cell.firstChild) wrapper.appendChild(cell.firstChild)
  return [wrapper]
}

/**
 * Merge cells across one row into the first of them.
 *
 * Horizontal only, deliberately. A cell merged down the page has no honest
 * drawing when the rows it spans fall either side of a page break, and this
 * table repeats its header row precisely because it is expected to cross
 * pages - so a vertical merge would be a control that works until the memo
 * gets long, on a document nobody can redraw.
 */
export function mergeCells(cells: HTMLTableCellElement[]): boolean {
  if (cells.length < 2) return false

  const [first, ...rest] = cells as [HTMLTableCellElement, ...HTMLTableCellElement[]]
  const span = cells.reduce((total, cell) => total + spanOf(cell), 0)

  const blocks = cells.flatMap(blocksOf)
  const written = blocks.filter((block) => (block.textContent ?? '').trim())

  first.replaceChildren(
    ...(written.length > 0
      ? written
      : [first.ownerDocument.createElement('br')]),
  )
  setSpan(first, span)

  for (const cell of rest) cell.remove()
  return true
}

/** The cells one selection touches, in one row and in order. */
export function selectedCells(
  selection: Selection | null,
): HTMLTableCellElement[] {
  const from = cellOf(selection?.anchorNode)
  const to = cellOf(selection?.focusNode)
  if (!from) return []
  if (!to || to === from || to.parentElement !== from.parentElement) return [from]

  const row = from.closest('tr')
  if (!row) return [from]

  const cells = cellsOf(row)
  const one = cells.indexOf(from)
  const other = cells.indexOf(to)

  return cells.slice(Math.min(one, other), Math.max(one, other) + 1)
}

/** Undo a merge: the cell keeps its content, the columns come back empty. */
export function splitCell(cell: HTMLTableCellElement): boolean {
  const span = spanOf(cell)
  if (span < 2) return false

  const row = cell.closest('tr')
  if (!row) return false

  setSpan(cell, 1)
  let after: Node = cell
  for (let at = 1; at < span; at += 1) {
    const fresh = blankCell(row, cell.tagName === 'TH' ? 'th' : 'td')
    cell.parentElement?.insertBefore(fresh, after.nextSibling)
    after = fresh
  }

  return true
}

/**
 * The cells a merge press should act on.
 *
 * Two gestures mean the same thing. Dragging across several cells and
 * pressing merge is the obvious one; pressing it with the caret in a single
 * cell means "merge this with the one beside it", which is how a table gets
 * built up one press at a time.
 */
export function mergeTarget(
  selection: Selection | null,
): HTMLTableCellElement[] {
  const chosen = selectedCells(selection)
  if (chosen.length > 1) return chosen

  const only = chosen[0]
  if (!only) return []

  const next = only.nextElementSibling
  return next && ['TD', 'TH'].includes(next.tagName)
    ? [only, next as HTMLTableCellElement]
    : []
}
