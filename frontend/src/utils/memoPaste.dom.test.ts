import { describe, expect, it } from 'vitest'

import type {
  MemoBlockNode,
  MemoParagraphNode,
  MemoTableNode,
} from '../types/memo'
import { MEMO_BODY_LIMITS } from '../types/memo'
import { memoBodyToHtml } from './memoDom'
import { shareFor } from './memoImage'
import {
  cellGrid,
  paragraphsOnly,
  readClipboard,
  tooLargeTable,
} from './memoPaste'

/**
 * The clipboard, as three programs actually fill it.
 *
 * These fixtures are cut down from what Excel, Google Sheets and Word put on
 * the clipboard - the wrappers, the stylesheets in the body, the classes and
 * the `<o:p>` tags are theirs, not invented. The point of reading markup at
 * all is the table, so most of what is asked here is: did the table survive,
 * and did nothing else come with it?
 */

const EXCEL = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
<head><meta http-equiv=Content-Type content="text/html; charset=utf-8">
<style>
<!--table {mso-displayed-decimal-separator:".";}
.xl65 {font-weight:700; color:black;}
-->
</style></head>
<body link="#0563C1" vlink="#954F72">
<!--StartFragment-->
<table border=0 cellpadding=0 cellspacing=0 width=320 style='border-collapse:collapse;width:240pt'>
<col width=64 span=5 style='width:48pt'>
<tr height=20 style='height:15.0pt'>
  <td height=20 class=xl65 width=64 style='height:15.0pt;width:48pt'>AX ID</td>
  <td class=xl65 width=64 style='width:48pt'>Employee</td>
  <td class=xl65 width=64 style='width:48pt'>Designation</td>
  <td class=xl65 width=64 style='width:48pt'>Department</td>
  <td class=xl65 width=64 style='width:48pt'>Allowance</td>
</tr>
<tr height=20 style='height:15.0pt'>
  <td height=20 align=right style='height:15.0pt'>1644</td>
  <td>Mr. Inayat Hussain</td>
  <td>Security Executive</td>
  <td>Security &amp; Loss Prevention</td>
  <td align=right>12,000</td>
</tr>
</table>
<!--EndFragment-->
</body></html>`

const SHEETS = `<meta charset='utf-8'><google-sheets-html-origin><style type="text/css"><!--td {border: 1px solid #cccccc;}br {mso-data-placement:same-cell;}--></style><table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" border="1" style="table-layout:fixed;font-size:10pt;font-family:Arial;width:0px;border-collapse:collapse;border:none" data-sheets-root="1"><colgroup><col width="100"/><col width="100"/></colgroup><tbody><tr style="height:21px;"><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;Item&quot;}">Item</td><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;">Amount</td></tr><tr style="height:21px;"><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;">Fuel</td><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;text-align:right;">50</td></tr></tbody></table></google-sheets-html-origin>`

const WORD = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta name=Generator content="Microsoft Word 15"><style>p.MsoNormal {margin:0cm; font-size:11.0pt;}</style></head>
<body lang=EN-GB style='tab-interval:36.0pt'>
<!--StartFragment-->
<div class=WordSection1>
<p class=MsoNormal>Approval is sought for the allowance below.<o:p></o:p></p>
<table class=MsoTableGrid border=1 cellspacing=0 cellpadding=0 style='border-collapse:collapse;border:none'>
 <tr>
  <td width=301 valign=top style='width:225.4pt;border:solid windowtext 1.0pt;padding:0cm 5.4pt 0cm 5.4pt'>
  <p class=MsoNormal><b>Item<o:p></o:p></b></p>
  </td>
  <td width=301 valign=top style='width:225.4pt;border:solid windowtext 1.0pt;padding:0cm 5.4pt 0cm 5.4pt'>
  <p class=MsoNormal><b>Amount</b></p>
  </td>
 </tr>
 <tr>
  <td width=301 valign=top style='width:225.4pt;border:solid windowtext 1.0pt;padding:0cm 5.4pt 0cm 5.4pt'>
  <p class=MsoNormal>Fuel</p>
  </td>
  <td width=301 valign=top style='width:225.4pt;border:solid windowtext 1.0pt;padding:0cm 5.4pt 0cm 5.4pt'>
  <p class=MsoNormal>50</p>
  </td>
 </tr>
</table>
<p class=MsoNormal><o:p>&nbsp;</o:p></p>
</div>
<!--EndFragment-->
</body></html>`

const read = (html: string, text = ''): MemoBlockNode[] =>
  readClipboard(html, text).blocks

const table = (blocks: MemoBlockNode[], at = 0): MemoTableNode =>
  blocks[at] as MemoTableNode

/** The text of one cell, runs joined. */
const cellText = (node: MemoTableNode, row: number, column: number): string =>
  (node.content[row]!.content[column]!.content ?? [])
    .flatMap(paragraph => paragraph.content ?? [])
    .map(run => run.text)
    .join('')

describe('a spreadsheet selection', () => {
  it('comes in as a table, not as lines of text', () => {
    const blocks = read(EXCEL)

    expect(blocks).toHaveLength(1)
    expect(table(blocks).content).toHaveLength(2)
    expect(table(blocks).content[0]!.content).toHaveLength(5)
    expect(cellText(table(blocks), 0, 0)).toBe('AX ID')
    expect(cellText(table(blocks), 1, 1)).toBe('Mr. Inayat Hussain')
    expect(cellText(table(blocks), 1, 3)).toBe('Security & Loss Prevention')
  })

  it('takes the first row as the header, since no spreadsheet marks one', () => {
    /*
     * Left as they come, a pasted table could never have a header: every
     * cell arrives plain and the editor has no control that makes one. The
     * header is what the template shades and repeats across a page break,
     * which a long list of employees needs.
     */
    const rows = table(read(EXCEL)).content

    expect(rows[0]!.content.every(cell => cell.type === 'tableHeader')).toBe(true)
    expect(rows[1]!.content.every(cell => cell.type === 'tableCell')).toBe(true)
  })

  it('does not make a header out of a single row', () => {
    const blocks = read('<table><tr><td>1644</td><td>12,000</td></tr></table>')

    expect(table(blocks).content[0]!.content.map(cell => cell.type)).toEqual([
      'tableCell',
      'tableCell',
    ])
  })

  it('leaves a table that marks its own header exactly as marked', () => {
    const blocks = read(
      '<table><tr><td>a</td><td>b</td></tr><tr><th>Total</th><td>1</td></tr></table>',
    )

    expect(table(blocks).content[0]!.content.map(cell => cell.type)).toEqual([
      'tableCell',
      'tableCell',
    ])
    expect(table(blocks).content[1]!.content[0]!.type).toBe('tableHeader')
  })

  it('does not read the stylesheet Google Sheets puts beside the table', () => {
    const blocks = read(SHEETS)

    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe('table')
    expect(JSON.stringify(blocks)).not.toContain('border')
    expect(cellText(table(blocks), 1, 0)).toBe('Fuel')
  })

  it('finds the table inside the section Word wraps everything in', () => {
    const blocks = read(WORD)

    expect(blocks.map(block => block.type)).toEqual(['paragraph', 'table'])
    expect(cellText(table(blocks, 1), 1, 1)).toBe('50')
  })

  it('keeps the emphasis a Word table carried', () => {
    const header = table(read(WORD), 1).content[0]!.content[0]!

    expect(header.content![0]!.content![0]).toMatchObject({
      text: 'Item',
      marks: [{ type: 'bold' }],
    })
  })

  it('keeps a merged cell merged', () => {
    const blocks = read(
      '<table><tr><td colspan=2>Both</td></tr><tr><td>a</td><td>b</td></tr></table>',
    )

    expect(table(blocks).content[0]!.content[0]!.attrs).toEqual({ colspan: 2 })
  })
})

describe('the plain-text form of the same selection', () => {
  it('reads tab-separated lines as a table', () => {
    const blocks = read('', 'AX ID\tEmployee\n1644\tMr. Inayat Hussain\n')

    expect(blocks).toHaveLength(1)
    expect(table(blocks).content).toHaveLength(2)
    expect(cellText(table(blocks), 1, 1)).toBe('Mr. Inayat Hussain')
    expect(table(blocks).content[0]!.content[0]!.type).toBe('tableHeader')
  })

  it('handles the line endings a Windows clipboard produces', () => {
    expect(table(read('', 'a\tb\r\nc\td\r\n')).content).toHaveLength(2)
  })

  it('pads a short line rather than producing a ragged table', () => {
    const rows = table(read('', 'a\tb\tc\nd\te')).content

    expect(rows.map(row => row.content.length)).toEqual([3, 3])
    expect(rows[1]!.content[2]).toEqual({ type: 'tableCell' })
  })

  it('unquotes a cell the spreadsheet quoted', () => {
    const node = table(read('', 'Item\tNote\nFuel\t"Monthly, ""capped"""'))

    expect(cellText(node, 1, 1)).toBe('Monthly, "capped"')
  })

  it('leaves one indented line as text, since one line is not a grid', () => {
    const blocks = read('', 'Name\tvalue')

    expect(blocks).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Name\tvalue' }] },
    ])
  })

  it('still reads prose as one paragraph per line', () => {
    expect(read('', 'One.\nTwo.').map(block => block.type)).toEqual([
      'paragraph',
      'paragraph',
    ])
  })

  it('inserts nothing for an empty clipboard', () => {
    expect(read('', '')).toEqual([])
    expect(read('', '  \n')).toEqual([])
  })
})

describe('what never gets in', () => {
  it("a script's source", () => {
    const blocks = read('<p>Hello</p><script>alert(1)</script>')

    expect(JSON.stringify(blocks)).not.toContain('alert')
    expect(blocks).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
    ])
  })

  it('an element, however it is written', () => {
    /*
     * The reading is into nodes, and the editor inserts markup built from
     * the nodes. So an image with a handler on it can only ever come out as
     * the text beside it - there is no path by which the element itself
     * reaches the region.
     */
    const blocks = read(
      '<table><tr><td><img src=x onerror="alert(1)">Name</td><td>1</td></tr><tr><td>a</td><td>b</td></tr></table>',
    )

    expect(cellText(table(blocks), 0, 0)).toBe('Name')
    expect(JSON.stringify(blocks)).not.toContain('<img')
    expect(memoBodyToHtml({ type: 'doc', content: blocks })).not.toContain('<img')
  })

  it('markup written as text stays text', () => {
    const blocks = read('<p>&lt;b&gt;not bold&lt;/b&gt;</p>')

    expect(blocks[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: '<b>not bold</b>' }],
    })
    expect(memoBodyToHtml({ type: 'doc', content: blocks })).toContain('&lt;b&gt;')
  })

  it('the whitespace a document is indented with', () => {
    const blocks = read(
      '<table>\n  <tr>\n    <td>\n\t\tAX ID\n\t</td>\n    <td>  Employee </td>\n  </tr>\n  <tr><td>1</td><td>2</td></tr>\n</table>',
    )

    expect(cellText(table(blocks), 0, 0)).toBe('AX ID')
    expect(cellText(table(blocks), 0, 1)).toBe('Employee')
  })

  it('the blank paragraphs a fragment is wrapped in', () => {
    const blocks = read('<p>&nbsp;</p><p>Kept.</p><p><o:p>&nbsp;</o:p></p>')

    expect(blocks).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Kept.' }] },
    ])
  })

  it('an image alone, which falls back to the text beside it', () => {
    expect(read('<img src=x>', 'Caption')).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Caption' }] },
    ])
  })
})

describe('a table the server would refuse', () => {
  const grid = (rows: number, columns: number): string =>
    Array.from({ length: rows }, () =>
      Array.from({ length: columns }, () => 'x').join('\t'),
    ).join('\n')

  it('is refused at the paste, and says how large it was', () => {
    const { refusal } = readClipboard('', grid(MEMO_BODY_LIMITS.tableRows + 1, 2))

    expect(refusal).toMatch(/401 rows/)
    expect(refusal).toMatch(/400/)
  })

  it('is refused for its width too', () => {
    const { refusal } = readClipboard('', grid(2, MEMO_BODY_LIMITS.tableColumns + 1))

    expect(refusal).toMatch(/21 columns/)
  })

  it('counts a merged cell as the columns it covers', () => {
    expect(tooLargeTable(2, MEMO_BODY_LIMITS.tableColumns)).toBeNull()
    expect(tooLargeTable(2, MEMO_BODY_LIMITS.tableColumns + 1)).not.toBeNull()
  })

  it('is not refused at exactly the limit', () => {
    const { refusal } = readClipboard(
      '',
      grid(MEMO_BODY_LIMITS.tableRows, MEMO_BODY_LIMITS.tableColumns),
    )

    expect(refusal).toBeNull()
  })
})

describe('landing inside a table cell', () => {
  const text = (value: string): MemoParagraphNode => ({
    type: 'paragraph',
    content: [{ type: 'text', text: value }],
  })

  it('flattens everything to paragraphs, which is all a cell can hold', () => {
    const paragraphs = paragraphsOnly([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'H' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [text('a'), text('b')] }] },
      { type: 'pageBreak' },
      {
        type: 'table',
        content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [text('c')] }] }],
      },
      text('d'),
    ])

    expect(paragraphs.map(paragraph => paragraph.content![0]!.text)).toEqual([
      'H',
      'a',
      'b',
      'c',
      'd',
    ])
  })

  it('lays a pasted table out as a rectangular grid', () => {
    const grid = cellGrid({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [{ type: 'tableCell', attrs: { colspan: 2 }, content: [text('wide')] }],
        },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [text('a')] }] },
      ],
    })

    // The merged cell's content lands in its first column; the column it
    // covered, and the short row's missing cell, are empty.
    expect(grid.map(row => row.length)).toEqual([2, 2])
    expect(grid[0]![0]![0]!.content![0]!.text).toBe('wide')
    expect(grid[0]![1]).toEqual([])
    expect(grid[1]![1]).toEqual([])
  })
})

describe('pasting a picture', () => {
  /** A PNG with a real header and nothing after it; only the header is read. */
  const pngUri = (width: number, height: number): string => {
    const bytes = new Uint8Array(33)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])
    const view = new DataView(bytes.buffer)
    view.setUint32(16, width)
    view.setUint32(20, height)
    bytes[24] = 8
    bytes[25] = 2
    return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`
  }

  it('lifts a picture out of the paragraph it sat in, sized as the page would draw it', () => {
    const src = pngUri(400, 300)

    expect(read(`<p>See <img src="${src}" alt="the tray"> here</p>`)).toEqual([
      { type: 'image', attrs: { src, alt: 'the tray', share: shareFor(400, 508.88) } },
      { type: 'paragraph', content: [{ type: 'text', text: 'See here' }] },
    ])
  })

  it('leaves out a picture fetched from a web page, and keeps the text', () => {
    expect(read('<p>See <img src="https://example.com/a.png"> here</p>')).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'See here' }] },
    ])
  })

  it('leaves out a picture inside a table, which cannot hold one', () => {
    const blocks = read(
      `<table><tr><td>a</td><td><img src="${pngUri(10, 10)}"></td></tr><tr><td>b</td><td>c</td></tr></table>`,
    )

    expect(blocks.map(block => block.type)).toEqual(['table'])
  })

  it('refuses more pictures than a memo can carry', () => {
    const html = Array.from(
      { length: MEMO_BODY_LIMITS.images + 1 },
      () => `<p><img src="${pngUri(10, 10)}"></p>`,
    ).join('')

    expect(readClipboard(html, '').refusal).toContain(
      `That paste has ${MEMO_BODY_LIMITS.images + 1} pictures; a memo can carry ${MEMO_BODY_LIMITS.images}.`,
    )
  })

  it('refuses a picture over the limit, with its size', () => {
    const heavy = `data:image/png;base64,${'A'.repeat(540_000)}`

    expect(readClipboard(`<p><img src="${heavy}"></p>`, '').refusal).toContain(
      'KB; a memo picture can be 391 KB. Attach it as a supporting document instead.',
    )
  })

  it('drops a picture pasted into a cell, which holds paragraphs only', () => {
    expect(paragraphsOnly([{ type: 'image', attrs: { src: pngUri(10, 10) } }])).toEqual([])
  })
})
