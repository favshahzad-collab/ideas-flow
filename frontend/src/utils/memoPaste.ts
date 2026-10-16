/**
 * What the clipboard holds, as memo blocks.
 *
 * Paste is the one route by which a whole styled document - a spreadsheet, a
 * Word file with its own fonts and classes, a web page - reaches the editor.
 * None of it enters the editor's DOM. The markup is parsed into a document of
 * its own that has no window, runs no script and loads nothing, read from
 * there into the handful of nodes the template can draw, and the editor then
 * inserts markup it built itself from those nodes. So there is still no
 * sanitising step to get wrong: the only thing that can reach the body is the
 * node set, and text.
 *
 * The reason to read markup at all is the table. A memo's details are very
 * often kept in a spreadsheet first - names, IDs, amounts - and every
 * spreadsheet puts its cells on the clipboard as an HTML table. Reading it
 * as one means the most common real task, moving those rows into the memo,
 * is a single paste rather than a table rebuilt cell by cell.
 */
import type {
  MemoBlockNode,
  MemoParagraphNode,
  MemoTableNode,
  MemoTableRowNode,
  MemoTextNode,
} from '../types/memo'
import { MEMO_BODY_LIMITS } from '../types/memo'
import {
  IMAGE_ATTRIBUTE,
  IMAGE_SHARE_ATTRIBUTE,
  IMAGE_SRC,
  htmlToMemoBlocks,
  plainTextToBlocks,
} from './memoDom'
import { dataUriBytes, imageSize, shareFor, tooLargePicture } from './memoImage'
import { TEXT_WIDTH } from './memoTableDom'

export type ClipboardReading = {
  blocks: MemoBlockNode[]
  /**
   * Why nothing should be inserted, in the preparer's terms - or null.
   *
   * A table larger than the server allows is refused here rather than
   * inserted and refused at the moment of submitting. Cutting it to fit would
   * lose rows without saying so, on a document somebody signs.
   */
  refusal: string | null
}

/**
 * Elements whose text is not content.
 *
 * Google Sheets puts a stylesheet in the body of what it copies; a web page
 * can carry a script anywhere. Reading either would paste its source into the
 * memo as a paragraph. The parsed document runs none of it regardless; this
 * is about not reading it.
 */
const NOT_CONTENT =
  'script, style, template, noscript, iframe, object, embed, svg, math, link, meta, title, head'

/** Read the clipboard, preferring its markup for the table it may carry. */
export function readClipboard(html: string, text: string): ClipboardReading {
  const blocks =
    blocksFromHtml(html) ??
    blocksFromGrid(text) ??
    // An image alone, or an empty clipboard, is not a blank line to insert.
    (text.trim() ? plainTextToBlocks(text) : [])

  return { blocks, refusal: tooLarge(blocks) }
}

function blocksFromHtml(html: string): MemoBlockNode[] | null {
  if (!html.trim()) return null

  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const element of Array.from(doc.querySelectorAll(NOT_CONTENT))) {
    element.remove()
  }
  hoistPictures(doc)

  const blocks = trimEnds(
    htmlToMemoBlocks(doc.body).map(block =>
      block.type === 'table' ? withHeaderRow(block) : block,
    ),
  )

  // Markup that read as nothing - an image alone, say - is not a reason to
  // paste nothing; the text beside it may still say something.
  return blocks.length > 0 ? blocks : null
}

/**
 * Tab-separated lines as a table.
 *
 * The plain-text form of a spreadsheet selection, and what arrives where the
 * markup has been dropped on the way - a remote desktop, a stripped-down
 * clipboard. Two lines or more, every one of them holding a tab: one line is
 * as likely to be a sentence somebody indented.
 */
function blocksFromGrid(text: string): MemoBlockNode[] | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length > 0 && !lines[lines.length - 1]!.trim()) lines.pop()

  if (lines.length < 2) return null
  if (!lines.every(line => line.includes('\t'))) return null

  const rows = lines.map(line => line.split('\t').map(unquote))
  const width = Math.max(...rows.map(row => row.length))

  const table: MemoTableNode = {
    type: 'table',
    content: rows.map(
      (cells): MemoTableRowNode => ({
        type: 'tableRow',
        content: Array.from({ length: width }, (_, at) => {
          const value = cells[at] ?? ''
          return {
            type: 'tableCell',
            ...(value ? { content: [paragraph(value)] } : {}),
          }
        }),
      }),
    ),
  }

  return [withHeaderRow(table)]
}

/** A cell a spreadsheet quoted because it held a tab or a line break. */
function unquote(cell: string): string {
  const trimmed = cell.trim()
  const quoted =
    trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')

  return quoted
    ? trimmed.slice(1, -1).replace(/""/g, '"').replace(/\s+/g, ' ').trim()
    : trimmed
}

const paragraph = (text: string): MemoParagraphNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
})

/**
 * A table with no header row given one: its first row.
 *
 * No spreadsheet marks a header. Every cell comes as a plain cell, and a
 * memo's table has no control for turning a row into a heading afterwards -
 * so left as they come, a pasted table could never have one. The template
 * draws the header row shaded and repeats it when the table crosses a page,
 * which is what a long list of employees needs and what the paper form does.
 *
 * One row alone is not promoted: a single row copied out of a sheet is a
 * line of figures, not a heading with nothing under it. A table that already
 * marks a header is left exactly as it marks it.
 */
function withHeaderRow(table: MemoTableNode): MemoTableNode {
  const [first, ...rest] = table.content
  if (!first || rest.length === 0) return table

  const marked = table.content.some(row =>
    row.content.some(cell => cell.type === 'tableHeader'),
  )
  if (marked) return table

  return {
    ...table,
    content: [
      {
        ...first,
        content: first.content.map(cell => ({ ...cell, type: 'tableHeader' })),
      },
      ...rest,
    ],
  }
}

/**
 * Pasted text with its layout whitespace taken out.
 *
 * A document's markup is indented for the people who wrote it, and a cell or
 * a paragraph in it can begin with a newline and three tabs that nobody ever
 * saw. The browser collapses that to nothing on screen; so does this, so
 * that what is pasted is what was seen. Runs are collapsed to single spaces,
 * each block's first and last run are trimmed at its edges, and a run left
 * empty goes.
 */
function tidyRuns(runs: MemoTextNode[] | undefined): MemoTextNode[] | undefined {
  if (!runs?.length) return undefined

  const collapsed = runs.map(run => ({ ...run, text: run.text.replace(/\s+/g, ' ') }))
  const first = collapsed[0]!
  first.text = first.text.replace(/^\s+/, '')
  const last = collapsed[collapsed.length - 1]!
  last.text = last.text.replace(/\s+$/, '')

  const kept = collapsed.filter(run => run.text.length > 0)
  return kept.length > 0 ? kept : undefined
}

function tidyParagraph(node: MemoParagraphNode): MemoParagraphNode {
  const content = tidyRuns(node.content)
  return { type: 'paragraph', ...(content ? { content } : {}) }
}

function tidyBlock(block: MemoBlockNode): MemoBlockNode {
  switch (block.type) {
    case 'paragraph':
      return tidyParagraph(block)
    case 'heading': {
      const content = tidyRuns(block.content)
      return { ...block, ...(content ? { content } : { content: [] }) }
    }
    case 'bulletList':
    case 'orderedList':
      return {
        ...block,
        content: block.content.map(item => ({
          ...item,
          content: item.content.map(tidyParagraph),
        })),
      }
    case 'table':
      return {
        ...block,
        content: block.content.map(row => ({
          ...row,
          content: row.content.map(cell => {
            const paragraphs = (cell.content ?? []).map(tidyParagraph)
            const { content: _dropped, ...rest } = cell
            return paragraphs.some(p => p.content)
              ? { ...rest, content: paragraphs }
              : rest
          }),
        })),
      }
    case 'pageBreak':
    case 'image':
      return block
  }
}

const isEmptyParagraph = (block: MemoBlockNode): boolean =>
  block.type === 'paragraph' && !block.content?.length

/** Tidied, and without the blank lines a fragment is wrapped in. */
function trimEnds(blocks: MemoBlockNode[]): MemoBlockNode[] {
  const tidied = blocks.map(tidyBlock)

  let from = 0
  let to = tidied.length
  while (from < to && isEmptyParagraph(tidied[from]!)) from += 1
  while (to > from && isEmptyParagraph(tidied[to - 1]!)) to -= 1

  return tidied.slice(from, to)
}

/** The columns a row covers, counting a merged cell as the columns it spans. */
function spanOfRow(row: MemoTableRowNode): number {
  return row.content.reduce(
    (total, cell) => total + (cell.attrs?.colspan ?? 1),
    0,
  )
}

/**
 * Why a table of this size cannot go in a memo - or null, when it can.
 *
 * The same numbers the server refuses at, said before the paste rather than
 * at the moment of submitting.
 */
export function tooLargeTable(rows: number, columns: number): string | null {
  if (rows > MEMO_BODY_LIMITS.tableRows) {
    return `That table has ${rows.toLocaleString()} rows; a memo table can hold ${MEMO_BODY_LIMITS.tableRows}. Attach the sheet as a supporting document instead.`
  }
  if (columns > MEMO_BODY_LIMITS.tableColumns) {
    return `That table has ${columns} columns; a memo table can hold ${MEMO_BODY_LIMITS.tableColumns}. Attach the sheet as a supporting document instead.`
  }
  return null
}

function tooLarge(blocks: MemoBlockNode[]): string | null {
  let pictures = 0
  let pictureBytes = 0

  for (const block of blocks) {
    if (block.type === 'image') {
      const bytes = dataUriBytes(block.attrs.src)
      if (bytes > MEMO_BODY_LIMITS.imageBytes) return tooLargePicture(bytes)
      pictures += 1
      pictureBytes += bytes
      continue
    }
    if (block.type !== 'table') continue
    const refusal = tooLargeTable(
      block.content.length,
      Math.max(0, ...block.content.map(spanOfRow)),
    )
    if (refusal) return refusal
  }

  if (pictures > MEMO_BODY_LIMITS.images) {
    return `That paste has ${pictures} pictures; a memo can carry ${MEMO_BODY_LIMITS.images}. Attach them as supporting documents instead.`
  }
  if (pictureBytes > MEMO_BODY_LIMITS.imageTotalBytes) {
    return `The pictures in that paste come to ${Math.round(pictureBytes / 1024)} KB together; a memo can carry ${Math.round(MEMO_BODY_LIMITS.imageTotalBytes / 1024)} KB of pictures. Attach them as supporting documents instead.`
  }
  return null
}

/**
 * Pictures in pasted markup, made blocks of their own.
 *
 * A picture arrives inline - inside the paragraph it sat in, or wrapped in
 * a link - and a memo holds one as a block. Each that the memo can carry
 * (a PNG or a JPEG carried in the markup itself) is lifted out to stand
 * before the paragraph it was in, sized as the renderer would size it; any
 * other - one fetched from a web page, one inside a table or a list, which
 * cannot hold a picture - is dropped. The text beside it is still pasted.
 */
function hoistPictures(doc: Document): void {
  for (const img of Array.from(doc.body.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? ''
    if (!IMAGE_SRC.test(src) || img.closest('table, ul, ol')) {
      img.remove()
      continue
    }

    const figure = doc.createElement('figure')
    figure.setAttribute(IMAGE_ATTRIBUTE, 'true')
    const size = imageSize(src)
    if (size) figure.setAttribute(IMAGE_SHARE_ATTRIBUTE, String(shareFor(size.width, TEXT_WIDTH)))
    const copy = doc.createElement('img')
    copy.setAttribute('src', src)
    copy.setAttribute('alt', img.getAttribute('alt') ?? '')
    figure.appendChild(copy)

    const line = img.closest('p, h1, h2, h3, h4, h5, h6, pre')
    if (line) {
      line.before(figure)
      img.remove()
    } else {
      img.replaceWith(figure)
    }
  }
}

/**
 * Everything as paragraphs, for a paste that lands inside a table cell.
 *
 * A cell holds paragraphs and nothing else - the template draws no heading,
 * list or table inside one, and the server refuses a cell that carries one.
 * So a heading pasted into a cell becomes its text, a list its items, and a
 * table its cells one after another; a page break has no meaning in a cell
 * and goes.
 */
export function paragraphsOnly(blocks: MemoBlockNode[]): MemoParagraphNode[] {
  return blocks.flatMap((block): MemoParagraphNode[] => {
    switch (block.type) {
      case 'paragraph':
        return [block]
      case 'heading':
        return [
          {
            type: 'paragraph',
            ...(block.content?.length ? { content: block.content } : {}),
          },
        ]
      case 'bulletList':
      case 'orderedList':
        return block.content.flatMap(item => item.content)
      case 'table':
        return block.content.flatMap(row =>
          row.content.flatMap(cell => cell.content ?? []),
        )
      case 'pageBreak':
      case 'image':
        // Neither has a place in a cell.
        return []
    }
  })
}

/**
 * A table as a rectangular grid of cell contents.
 *
 * For pasting into an existing table, where the pasted cells land one per
 * target cell. A merged cell in the paste covers several columns; its content
 * lands in the first of them and the rest are left empty, because the target
 * table's cells are not going to be merged to match.
 */
export function cellGrid(table: MemoTableNode): MemoParagraphNode[][][] {
  const rows = table.content.map(row =>
    row.content.flatMap(cell => {
      const span = Math.max(1, Math.floor(cell.attrs?.colspan ?? 1))
      return [
        cell.content ?? [],
        ...Array.from({ length: span - 1 }, (): MemoParagraphNode[] => []),
      ]
    }),
  )

  const width = Math.max(0, ...rows.map(row => row.length))
  return rows.map(row => [
    ...row,
    ...Array.from({ length: width - row.length }, (): MemoParagraphNode[] => []),
  ])
}
