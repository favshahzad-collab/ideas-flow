import { addRow, cellAt, cellsOf, columnCount, columnOf, rowsOf } from './memoTableDom'

/**
 * Adding up a column of a memo table, and writing the answer in as text.
 *
 * A memo is not a spreadsheet, and this does not try to make it one. There
 * is no formula stored anywhere: the total is worked out at the moment the
 * control is pressed and written into the cell as words, bold, exactly as if
 * the preparer had typed it. From then on the body carries figures and
 * nothing else - the renderer, the diff, the paste and the signing all see a
 * table of text, which is the only kind of table a signed document can hold.
 *
 * What that costs is that a total can go stale: a figure above it changed,
 * and the sum did not. So the second half of this file is the check that
 * catches exactly that, run after every edit, so a memo is never signed with
 * a total its own figures contradict without somebody having been told.
 *
 * Amounts are read the way they are written in this organisation's memos:
 * `Rs. 1,25,000/-`, `PKR 45,000`, `(1,200)` for a deduction, `12.50`.
 * Grouping by lakh (`12,00,000`) is read and written back the same way.
 */

// ── Reading and writing one amount ──────────────────────────────────────────

export type Grouping = 'none' | 'thousands' | 'lakh'

/** An amount as one cell wrote it, with enough of its style to write another. */
export interface Amount {
  /** Scaled to an integer by `decimals`, so that adding up stays exact. */
  scaled: number
  decimals: number
  prefix: string
  suffix: string
  grouping: Grouping
  /** Written as `(1,200)` rather than `-1,200`. */
  parenthesised: boolean
}

export interface AmountStyle {
  decimals: number
  prefix: string
  suffix: string
  grouping: Grouping
  parenthesised: boolean
}

/**
 * A figure, with what may sit around it.
 *
 * Group 1 is a prefix: a currency (`Rs.`, `PKR`, `$`), letters and dots
 * only. Then an optional sign - a minus, or an opening bracket that must be
 * closed after the digits. The digits, with commas in threes or in lakh
 * groups of two. An optional decimal part. A suffix of `/-`, `%`, or
 * letters again (`PKR` written after).
 *
 * Letters directly against the digits are refused on purpose, in either
 * direction: `EMP1234` is an employee code and `EMP-1234` a badge number,
 * and a column of those must never be added up. A currency written first is
 * followed by a space or a dot - `Rs. 1,200`, `PKR 1,200` - and that is
 * what tells the two apart.
 */
const AMOUNT =
  /^([A-Za-z]+\.?|[$€£¥₹])?\s*(-|\()?\s*(\d+(?:,\d+)*)(?:\.(\d+))?\s*(\))?\s*(\/-|%|[A-Za-z]+\.?)?$/

/** Commas in threes, or lakh groups: two-digit groups before a final three. */
const GROUPED = /^\d{1,3}(?:,\d{3})*$|^\d{1,2}(?:,\d{2})*,\d{3}$/

export function parseAmount(text: string): Amount | null {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!trimmed) return null

  const match = AMOUNT.exec(trimmed)
  if (!match) return null

  const [, rawPrefix = '', sign = '', digits = '', fraction = '', close = '', rawSuffix = ''] =
    match

  // A prefix of letters must be set off from the figure by a space or its
  // own dot; `Rs1200` is left alone along with `EMP1234`.
  if (/[A-Za-z]$/.test(rawPrefix) && !/^[A-Za-z]+\.?\s/.test(trimmed)) return null
  if (rawSuffix && /^[A-Za-z]/.test(rawSuffix) && !/\d\s+[A-Za-z]/.test(trimmed)) return null

  const opened = sign === '('
  if (opened !== Boolean(close)) return null

  if (digits.includes(',') && !GROUPED.test(digits)) return null
  const integer = digits.replace(/,/g, '')
  if (!/^\d+$/.test(integer)) return null

  const scaled = Number(integer + fraction)
  if (!Number.isSafeInteger(scaled)) return null

  return {
    scaled: sign ? -scaled : scaled,
    decimals: fraction.length,
    prefix: rawPrefix,
    suffix: rawSuffix,
    grouping: !digits.includes(',')
      ? 'none'
      : /^\d{1,2}(?:,\d{2})+,\d{3}$/.test(digits)
        ? 'lakh'
        : 'thousands',
    parenthesised: opened,
  }
}

function groupDigits(integer: string, grouping: Grouping): string {
  if (grouping === 'none' || integer.length <= 3) return integer

  const head = integer.slice(0, -3)
  const tail = integer.slice(-3)
  const size = grouping === 'lakh' ? 2 : 3
  const groups: string[] = []
  for (let end = head.length; end > 0; end -= size) {
    groups.unshift(head.slice(Math.max(0, end - size), end))
  }
  return `${groups.join(',')},${tail}`
}

/** `scaled` written back in a style, as a cell would carry it. */
export function formatAmount(scaled: number, style: AmountStyle): string {
  const negative = scaled < 0
  const digits = String(Math.abs(scaled)).padStart(style.decimals + 1, '0')
  const integer = digits.slice(0, digits.length - style.decimals)
  const fraction = style.decimals > 0 ? `.${digits.slice(-style.decimals)}` : ''

  const figure = `${groupDigits(integer, style.grouping)}${fraction}`
  const signed = negative
    ? style.parenthesised
      ? `(${figure})`
      : `-${figure}`
    : figure

  // `Rs. 1,200` and `PKR 1,200`, but `$1,200`: a symbol sits against the figure.
  const prefix = !style.prefix
    ? ''
    : /[A-Za-z.]$/.test(style.prefix)
      ? `${style.prefix} `
      : style.prefix
  const suffix = !style.suffix
    ? ''
    : /^[A-Za-z]/.test(style.suffix)
      ? ` ${style.suffix}`
      : style.suffix

  return `${prefix}${signed}${suffix}`
}

// ── Adding up a column ──────────────────────────────────────────────────────

export type ColumnSum =
  | { ok: true; text: string; scaled: number; decimals: number }
  | { ok: false; reason: string }

/** Every cell scaled to the same number of decimals, so they can be added. */
const rescale = (amount: Amount, decimals: number): number =>
  amount.scaled * 10 ** (decimals - amount.decimals)

/**
 * The sum of a column's cells, in the style the column itself uses.
 *
 * Blank cells are skipped; every written cell must be a figure, and the
 * refusal names the first one that is not, so a heading typed into a body
 * row is found rather than guessed around. The total takes the column's
 * own currency and suffix when every figure agrees on them, the most
 * decimals any figure has, and lakh grouping if any figure used it.
 */
export function sumColumn(cells: { text: string; where: string }[]): ColumnSum {
  const amounts: Amount[] = []

  for (const cell of cells) {
    const text = cell.text.replace(/\s+/g, ' ').trim()
    if (!text) continue

    const amount = parseAmount(text)
    if (!amount) {
      return {
        ok: false,
        reason: `“${text}” in ${cell.where} is not a figure, so the column was not totalled.`,
      }
    }
    if (amount.suffix === '%') {
      return { ok: false, reason: 'Percentages are not added up.' }
    }
    amounts.push(amount)
  }

  if (amounts.length === 0) {
    return { ok: false, reason: 'There are no figures in that column to total.' }
  }

  const decimals = Math.max(...amounts.map(amount => amount.decimals))
  let scaled = 0
  for (const amount of amounts) {
    scaled += rescale(amount, decimals)
    if (!Number.isSafeInteger(scaled)) {
      return { ok: false, reason: 'Those figures are too large to add up exactly.' }
    }
  }

  const shared = (read: (amount: Amount) => string): string => {
    const first = read(amounts[0]!)
    return amounts.every(amount => read(amount) === first) ? first : ''
  }

  const style: AmountStyle = {
    decimals,
    prefix: shared(amount => amount.prefix),
    suffix: shared(amount => amount.suffix),
    grouping: amounts.some(amount => amount.grouping === 'lakh')
      ? 'lakh'
      : amounts.some(amount => amount.grouping === 'thousands')
        ? 'thousands'
        : 'none',
    parenthesised: amounts.some(amount => amount.parenthesised),
  }

  return { ok: true, text: formatAmount(scaled, style), scaled, decimals }
}

// ── The table ───────────────────────────────────────────────────────────────

/**
 * What the last row is called when it holds the totals.
 *
 * The word, on its own or in front of a figure - `Total 45,000` is what the
 * first column carries when it is the column being totalled, since the
 * label and the sum then have one cell between them.
 */
const TOTAL_LABEL = /^(?:grand\s+)?totals?\b/i

const textOf = (cell: Element | null): string =>
  (cell?.textContent ?? '').replace(/\s+/g, ' ').trim()

/** The header row, the way the renderer decides it: the first, if any cell is a heading. */
function headerRowOf(table: HTMLTableElement): HTMLTableRowElement | null {
  const first = rowsOf(table)[0]
  return first && cellsOf(first).some(cell => cell.tagName === 'TH') ? first : null
}

/** The last row, if it is the totals row. */
export function totalRowOf(table: HTMLTableElement): HTMLTableRowElement | null {
  const rows = rowsOf(table)
  const last = rows[rows.length - 1]
  if (!last || rows.length < 2) return null
  return TOTAL_LABEL.test(textOf(cellsOf(last)[0] ?? null)) ? last : null
}

/**
 * The cells of one column that hold figures to add: the body rows, leaving
 * out the header above and the totals row below.
 *
 * A cell merged across from an earlier column is not in this column - a
 * "Subtotal" written across three columns is not a figure in the third.
 */
function figureCells(
  table: HTMLTableElement,
  column: number,
  totals: HTMLTableRowElement | null,
): { cell: HTMLTableCellElement; text: string; where: string }[] {
  const header = headerRowOf(table)
  const found: { cell: HTMLTableCellElement; text: string; where: string }[] = []

  rowsOf(table).forEach((row, index) => {
    if (row === header || row === totals) return
    const cell = cellAt(row, column)
    if (!cell || columnOf(cell) !== column) return
    found.push({ cell, text: textOf(cell), where: `row ${index + 1}` })
  })

  return found
}

function writeBold(cell: HTMLTableCellElement, text: string): void {
  const doc = cell.ownerDocument
  const strong = doc.createElement('strong')
  strong.textContent = text
  cell.replaceChildren(strong)
}

export type TotalOutcome = { ok: true } | { ok: false; reason: string }

/**
 * Add up one column and write the total under it.
 *
 * The totals row is the last row when its first cell says "Total"; it is
 * added when there is none, and labelled so. When the first column is the
 * one being totalled the label and the figure share its cell - `Total
 * 45,000` - which is still a totals row to everything here. Pressed again,
 * it writes the current sum over the old one: that is how a stale total is
 * put right.
 */
export function totalColumn(table: HTMLTableElement, column: number): TotalOutcome {
  if (column < 0 || column >= columnCount(table)) {
    return { ok: false, reason: 'There is no such column.' }
  }

  const existing = totalRowOf(table)
  const sum = sumColumn(figureCells(table, column, existing))
  if (!sum.ok) return sum

  let totals = existing
  if (!totals) {
    const rows = rowsOf(table)
    addRow(table, rows[rows.length - 1]!)
    totals = rowsOf(table)[rows.length]!
    const first = cellAt(totals, 0)
    if (first && column !== 0) writeBold(first, 'Total')
  }

  const target = cellAt(totals, column)
  if (!target || columnOf(target) !== column) {
    return {
      ok: false,
      reason:
        'The totals row has no cell of its own under that column. Split the merged cell first.',
    }
  }

  writeBold(target, column === 0 ? `Total ${sum.text}` : sum.text)
  return { ok: true }
}

// ── The check ───────────────────────────────────────────────────────────────

/**
 * Every total in the region that its own column no longer adds up to.
 *
 * Named by the heading over the column, or by its number where the table
 * has no header, so the message can say where to look. A totals row cell
 * that is blank or not a figure is not a total and is left alone; a figure
 * typed there by hand that happens to be right is right.
 */
export function staleTotals(region: HTMLElement): string[] {
  const stale: string[] = []

  for (const table of Array.from(region.querySelectorAll('table'))) {
    const totals = totalRowOf(table)
    if (!totals) continue
    const header = headerRowOf(table)

    for (let column = 0; column < columnCount(table); column += 1) {
      const cell = cellAt(totals, column)
      if (!cell || columnOf(cell) !== column) continue
      const written = parseAmount(textOf(cell))
      if (!written) continue

      const sum = sumColumn(figureCells(table, column, totals))
      if (!sum.ok) continue

      const decimals = Math.max(sum.decimals, written.decimals)
      const expected = sum.scaled * 10 ** (decimals - sum.decimals)
      const actual = rescale(written, decimals)
      if (expected === actual) continue

      const heading = header ? textOf(cellAt(header, column)) : ''
      stale.push(heading || `column ${column + 1}`)
    }
  }

  return stale
}

/** The sentence under the editor, for what `staleTotals` found. */
export function staleTotalsMessage(headings: string[]): string | null {
  if (headings.length === 0) return null

  const named = headings.map(heading => `“${heading}”`)
  const list =
    named.length === 1
      ? named[0]!
      : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]!}`
  const subject = named.length === 1 ? 'The total under' : 'The totals under'
  const verb = named.length === 1 ? 'no longer matches the figures above it' : 'no longer match the figures above them'

  return `${subject} ${list} ${verb}. Put the caret in the column and press Total column again, or correct it by hand.`
}
