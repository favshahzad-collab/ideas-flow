import { describe, expect, it } from 'vitest'

import { htmlToMemoBody } from './memoDom'
import { rowsOf } from './memoTableDom'
import { staleTotals, totalColumn, totalRowOf } from './memoTotals'
import type { MemoTableNode } from '../types/memo'

/**
 * A total written into a table, and the check that it still holds.
 *
 * On a real `<table>`, because that is the model: the total has to land as
 * a bold cell the reader in `memoDom` turns into a text node with a mark,
 * and nothing more - the whole point is that the body carries figures, not
 * formulas.
 */

function tableFrom(html: string): HTMLTableElement {
  const host = document.createElement('div')
  host.innerHTML = html
  return host.querySelector('table')!
}

const rowTexts = (table: HTMLTableElement): string[][] =>
  rowsOf(table).map(row =>
    Array.from(row.children).map(cell => (cell.textContent ?? '').trim()),
  )

const salaries = () =>
  tableFrom(`<table><tbody>
    <tr><th>Name</th><th>Current</th><th>Proposed</th></tr>
    <tr><td>A. Khan</td><td>Rs. 80,000</td><td>Rs. 92,000</td></tr>
    <tr><td>B. Raza</td><td>Rs. 65,000</td><td>Rs. 71,500</td></tr>
  </tbody></table>`)

describe('totalling a column', () => {
  it('adds a labelled totals row and writes the sum in bold', () => {
    const table = salaries()

    expect(totalColumn(table, 2)).toEqual({ ok: true })

    expect(rowTexts(table)).toEqual([
      ['Name', 'Current', 'Proposed'],
      ['A. Khan', 'Rs. 80,000', 'Rs. 92,000'],
      ['B. Raza', 'Rs. 65,000', 'Rs. 71,500'],
      ['Total', '', 'Rs. 163,500'],
    ])

    // Bold text with a mark, and nothing the server would refuse.
    const host = document.createElement('div')
    host.appendChild(table)
    const memo = htmlToMemoBody(host).content[0] as MemoTableNode
    expect(memo.content[3]!.content[2]!.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Rs. 163,500', marks: [{ type: 'bold' }] }] },
    ])
    expect(memo.content[3]!.content[0]!.content![0]!.content![0]).toMatchObject({
      text: 'Total',
      marks: [{ type: 'bold' }],
    })
  })

  it('totals a second column into the same row', () => {
    const table = salaries()
    totalColumn(table, 2)
    totalColumn(table, 1)

    expect(rowsOf(table)).toHaveLength(4)
    expect(rowTexts(table)[3]).toEqual(['Total', 'Rs. 145,000', 'Rs. 163,500'])
  })

  it('writes over a stale total rather than adding another row', () => {
    const table = salaries()
    totalColumn(table, 2)
    rowsOf(table)[1]!.children[2]!.textContent = 'Rs. 100,000'

    totalColumn(table, 2)

    expect(rowsOf(table)).toHaveLength(4)
    expect(rowTexts(table)[3]![2]).toBe('Rs. 171,500')
  })

  it('writes the total in lakhs when the column is', () => {
    const table = tableFrom(`<table><tbody>
      <tr><th>Name</th><th>Gratuity</th></tr>
      <tr><td>A</td><td>Rs. 1,20,000/-</td></tr>
      <tr><td>B</td><td>Rs. 75,000/-</td></tr>
    </tbody></table>`)

    totalColumn(table, 1)

    expect(rowTexts(table)[3]).toEqual(['Total', 'Rs. 1,95,000/-'])
  })

  it('recognises a totals row the preparer typed, however they labelled it', () => {
    const table = tableFrom(`<table><tbody>
      <tr><th>Item</th><th>Amount</th></tr>
      <tr><td>Fuel</td><td>4,000</td></tr>
      <tr><td>Grand Total:</td><td></td></tr>
    </tbody></table>`)

    expect(totalRowOf(table)).toBe(rowsOf(table)[2])
    totalColumn(table, 1)

    expect(rowTexts(table)).toEqual([
      ['Item', 'Amount'],
      ['Fuel', '4,000'],
      ['Grand Total:', '4,000'],
    ])
  })

  it('leaves the header row out of the sum', () => {
    const table = tableFrom(`<table><tbody>
      <tr><th>Days</th></tr>
      <tr><td>3</td></tr>
      <tr><td>5</td></tr>
    </tbody></table>`)

    expect(totalColumn(table, 0)).toEqual({ ok: true })
    expect(rowTexts(table)).toEqual([['Days'], ['3'], ['5'], ['Total 8']])
    // And the row it made is still the totals row, so the next press writes over it.
    expect(totalRowOf(table)).toBe(rowsOf(table)[3])
    rowsOf(table)[1]!.children[0]!.textContent = '4'
    totalColumn(table, 0)
    expect(rowTexts(table)).toEqual([['Days'], ['4'], ['5'], ['Total 9']])
  })

  it('counts every row when the table has no header', () => {
    const table = tableFrom(`<table><tbody>
      <tr><td>Fuel</td><td>4,000</td></tr>
      <tr><td>Tolls</td><td>600</td></tr>
    </tbody></table>`)

    totalColumn(table, 1)

    expect(rowTexts(table)[2]).toEqual(['Total', '4,600'])
  })

  it('says which cell stopped it, and changes nothing', () => {
    const table = tableFrom(`<table><tbody>
      <tr><td>Item</td><td>Amount</td></tr>
      <tr><td>Fuel</td><td>4,000</td></tr>
    </tbody></table>`)

    expect(totalColumn(table, 1)).toEqual({
      ok: false,
      reason: '“Amount” in row 1 is not a figure, so the column was not totalled.',
    })
    expect(rowsOf(table)).toHaveLength(2)
  })

  it('does not read a cell merged across from another column as a figure', () => {
    const table = tableFrom(`<table><tbody>
      <tr><th>Item</th><th>Qty</th><th>Amount</th></tr>
      <tr><td>Fuel</td><td>2</td><td>4,000</td></tr>
      <tr><td colspan="2">Carried forward</td><td>600</td></tr>
    </tbody></table>`)

    expect(totalColumn(table, 1)).toEqual({ ok: true })
    expect(rowTexts(table)[3]).toEqual(['Total', '2', ''])
    expect(totalColumn(table, 2)).toEqual({ ok: true })
    expect(rowTexts(table)[3]).toEqual(['Total', '2', '4,600'])
  })

  it('refuses to write into a merged totals cell', () => {
    const table = tableFrom(`<table><tbody>
      <tr><th>Item</th><th>Qty</th><th>Amount</th></tr>
      <tr><td>Fuel</td><td>2</td><td>4,000</td></tr>
      <tr><td colspan="2">Total</td><td></td></tr>
    </tbody></table>`)

    expect(totalColumn(table, 1)).toMatchObject({ ok: false })
    expect(rowTexts(table)[2]).toEqual(['Total', ''])
  })

  it('refuses a column the table does not have', () => {
    expect(totalColumn(salaries(), 3)).toMatchObject({ ok: false })
  })
})

describe('the check', () => {
  function region(html: string): HTMLElement {
    const host = document.createElement('div')
    host.innerHTML = html
    return host
  }

  it('finds nothing when the totals still hold', () => {
    const host = region(`<table><tbody>
      <tr><th>Name</th><th>Amount</th></tr>
      <tr><td>A</td><td>1,200</td></tr>
      <tr><td>B</td><td>800</td></tr>
      <tr><td><strong>Total</strong></td><td><strong>2,000</strong></td></tr>
    </tbody></table>`)

    expect(staleTotals(host)).toEqual([])
  })

  it('names the heading over a total the figures no longer add up to', () => {
    const host = region(`<table><tbody>
      <tr><th>Name</th><th>Current</th><th>Proposed</th></tr>
      <tr><td>A</td><td>1,200</td><td>1,500</td></tr>
      <tr><td>B</td><td>800</td><td>900</td></tr>
      <tr><td>Total</td><td>2,000</td><td>2,400</td></tr>
    </tbody></table>`)
    host.querySelector('tr:nth-child(2) td:nth-child(3)')!.textContent = '1,600'

    expect(staleTotals(host)).toEqual(['Proposed'])
  })

  it('names the column by number where there is no heading', () => {
    const host = region(`<table><tbody>
      <tr><td>A</td><td>1,200</td></tr>
      <tr><td>Total</td><td>1,000</td></tr>
    </tbody></table>`)

    expect(staleTotals(host)).toEqual(['column 2'])
  })

  it('compares the value, not the writing', () => {
    const host = region(`<table><tbody>
      <tr><th>Item</th><th>Amount</th></tr>
      <tr><td>A</td><td>Rs. 1,200.50</td></tr>
      <tr><td>B</td><td>800</td></tr>
      <tr><td>Total</td><td>2000.5</td></tr>
    </tbody></table>`)

    expect(staleTotals(host)).toEqual([])
  })

  it('leaves alone a totals row cell that is not a figure, and a column that cannot be summed', () => {
    const host = region(`<table><tbody>
      <tr><th>Item</th><th>Note</th><th>Amount</th></tr>
      <tr><td>A</td><td>see below</td><td>1,200</td></tr>
      <tr><td>Total</td><td>as agreed</td><td>-</td></tr>
    </tbody></table>`)

    expect(staleTotals(host)).toEqual([])
  })

  it('checks the first column when the label and the figure share its cell', () => {
    const host = region(`<table><tbody>
      <tr><th>Days</th></tr>
      <tr><td>3</td></tr>
      <tr><td>Total 5</td></tr>
    </tbody></table>`)

    expect(staleTotals(host)).toEqual(['Days'])
  })

  it('looks at every table in the memo', () => {
    const host = region(`
      <p>Two tables.</p>
      <table><tbody><tr><th>X</th></tr><tr><td>1</td></tr><tr><td>Total 1</td></tr></tbody></table>
      <table><tbody><tr><th>Y</th></tr><tr><td>1</td></tr><tr><td>Total 2</td></tr></tbody></table>`)

    expect(staleTotals(host)).toEqual(['Y'])
  })
})
