/**
 * Between the editor's DOM and the memo body the server stores.
 *
 * The editor is a `contenteditable` region, so the DOM *is* the model. That
 * makes this file the whole of the contract: whatever a browser leaves behind
 * - and browsers leave a great deal behind - has to come out of here as one of
 * the handful of nodes the PDF template can draw, or not come out at all.
 *
 * The server refuses an unknown node rather than dropping it, which is the
 * right rule for an artefact somebody signs. The consequence is that anything
 * this function fails to normalise is not a cosmetic problem: it is a memo
 * that cannot be submitted, discovered at the moment of submitting it. So the
 * rule here is the opposite one - never emit a node that is not in the set,
 * whatever the DOM says.
 */
import type {
  MemoBlockNode,
  MemoBody,
  MemoImageNode,
  MemoListItemNode,
  MemoMark,
  MemoParagraphNode,
  MemoTableCellNode,
  MemoTableRowNode,
  MemoTextNode,
} from '../types/memo'
import type { MemoBodyAttrs, MemoFont, MemoSize } from '../types/memo'
import {
  DEFAULT_MEMO_FONT,
  DEFAULT_MEMO_SIZE,
  MEMO_BODY_LIMITS,
  MEMO_FONTS,
  MEMO_SIZES,
} from '../types/memo'
import { HEIGHT_ATTRIBUTE, WIDTH_ATTRIBUTE } from './memoTableDom'

/** Marked on the element the editor inserts for a page break. */
export const PAGE_BREAK_ATTRIBUTE = 'data-memo-page-break'
/** Written on the element that holds a picture; the reader looks for it. */
export const IMAGE_ATTRIBUTE = 'data-memo-image'
/** How much of the column a picture spans, beside the CSS width so it reads back exactly. */
export const IMAGE_SHARE_ATTRIBUTE = 'data-memo-share'
/** What a picture's `src` must be: a PNG or a JPEG, carried in the memo itself. */
export const IMAGE_SRC = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/

/**
 * Applied in this order, always.
 *
 * Two runs that carry the same marks in a different order are the same run,
 * and the submitted body should not depend on which button was pressed first.
 */
const MARK_ORDER: MemoMark[] = ['bold', 'italic', 'underline']

function marksFromElement(element: HTMLElement): MemoMark[] {
  const tag = element.tagName
  const found: MemoMark[] = []

  if (tag === 'B' || tag === 'STRONG') found.push('bold')
  if (tag === 'I' || tag === 'EM') found.push('italic')
  if (tag === 'U' || tag === 'INS') found.push('underline')

  /*
   * Browsers disagree about what "bold" produces.
   *
   * `styleWithCSS` is turned off in the editor, which asks for <b>/<i>/<u> -
   * but a pasted fragment, an older engine or a document.execCommand
   * implementation that ignores the flag will hand back a styled span
   * instead. Reading the style as well costs a few lines and is the
   * difference between emphasis surviving and emphasis being silently lost
   * on its way to a document somebody signs.
   */
  const style = element.style
  if (style) {
    const weight = style.fontWeight
    if (weight === 'bold' || weight === 'bolder' || Number(weight) >= 600) {
      found.push('bold')
    }
    if (style.fontStyle === 'italic' || style.fontStyle === 'oblique') {
      found.push('italic')
    }
    if (style.textDecorationLine?.includes('underline')) found.push('underline')
    if (style.textDecoration?.includes('underline')) found.push('underline')
  }

  return found
}

/**
 * The text of one block, as a list of runs.
 *
 * Adjacent runs carrying identical marks are merged: a browser will happily
 * split one word into four text nodes as it is edited, and four runs that say
 * the same thing make a larger body, a noisier diff and a draft that looks
 * changed when nothing was typed.
 */
function runsOf(node: Node): MemoTextNode[] {
  return runsOfNodes(Array.from(node.childNodes))
}

/** The same, over a run of sibling nodes that share no element of their own. */
function runsOfNodes(nodes: Node[]): MemoTextNode[] {
  const runs: MemoTextNode[] = []

  /*
   * A line break seen, waiting to find out whether it separates anything.
   *
   * Browsers put a <br> inside every empty block as a filler, so treating one
   * as a space unconditionally turned every deliberate blank line in a memo
   * into a paragraph containing a space - which is not empty, so the editor
   * stopped being able to tell an untouched body from a written one.
   *
   * Deferring it costs one flag and gets both cases right: filler at the end
   * of a block is dropped, and a break genuinely between two words still
   * keeps them apart rather than running them together.
   */
  let pendingBreak = false

  const walk = (current: Node, marks: MemoMark[]): void => {
    if (current.nodeType === Node.TEXT_NODE) {
      const text = current.textContent ?? ''
      if (!text) return
      push(text, marks)
      return
    }

    if (current.nodeType !== Node.ELEMENT_NODE) return
    const element = current as HTMLElement

    /*
     * The memo body has no hard-break node, because the PDF template has no
     * way to draw one that is not just a short paragraph. The editor turns
     * Shift+Enter into a new paragraph for that reason, so the only <br> that
     * normally reaches here is a browser's own filler - handled by the flag
     * above, which spends a space on it only if text turns up on both sides.
     */
    if (element.tagName === 'BR') {
      pendingBreak = true
      return
    }

    const next = [...marks, ...marksFromElement(element)]
    for (const child of Array.from(element.childNodes)) walk(child, next)
  }

  const push = (text: string, marks: MemoMark[]): void => {
    if (pendingBreak) {
      pendingBreak = false
      // Only between two runs. A break before anything has been written has
      // nothing to separate.
      if (runs.length > 0) push(' ', marks)
    }

    const ordered = MARK_ORDER.filter(mark => marks.includes(mark))
    const previous = runs[runs.length - 1]

    if (previous && sameMarks(previous, ordered)) {
      previous.text += text
      return
    }

    runs.push({
      type: 'text',
      text,
      ...(ordered.length ? { marks: ordered.map(mark => ({ type: mark })) } : {}),
    })
  }

  for (const node of nodes) walk(node, [])

  // A run of nothing but the empty string carries no information and is one
  // more node for the server to validate.
  return runs.filter(run => run.text.length > 0)
}

function sameMarks(run: MemoTextNode, marks: MemoMark[]): boolean {
  const existing = (run.marks ?? []).map(mark => mark.type)
  return (
    existing.length === marks.length &&
    existing.every((mark, index) => mark === marks[index])
  )
}

function paragraphOf(node: Node): MemoParagraphNode {
  const content = runsOf(node)
  return { type: 'paragraph', ...(content.length ? { content } : {}) }
}

/** The paragraphs inside a list item or a table cell. */
function paragraphsOf(element: HTMLElement): MemoParagraphNode[] {
  const blocks = Array.from(element.children).filter(
    (child): child is HTMLElement => BLOCK_TAGS.has(child.tagName),
  )

  // A cell or item typed straight into, with no block element of its own.
  if (blocks.length === 0) return [paragraphOf(element)]

  /*
   * Total: every block a cell or an item holds becomes a paragraph, or
   * several. A list item holds paragraphs in the memo, and nothing else;
   * a heading a browser put in one, or a list nested in a list, is still
   * text somebody typed, and is read as the paragraphs it would be rather
   * than dropped on the way to the PDF.
   */
  return blocks.flatMap(block => {
    switch (block.tagName) {
      case 'UL':
      case 'OL':
        return Array.from(block.children)
          .filter(item => item.tagName === 'LI')
          .flatMap(item => paragraphsOf(item as HTMLElement))
      case 'TABLE':
        return Array.from(block.querySelectorAll('td, th')).flatMap(cell =>
          paragraphsOf(cell as HTMLElement),
        )
      default:
        return [paragraphOf(block)]
    }
  })
}

/** What a browser may wrongly put inside a paragraph or a heading. */
const HOISTED = new Set(['UL', 'OL', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'DIV', 'FIGURE'])

/**
 * Lift blocks out of the paragraphs and headings a browser nested them in.
 *
 * Asked for a list with the caret in a paragraph, Chromium puts the list
 * INSIDE the paragraph - `<p><ul><li>…</li></ul></p>` - which no reader
 * of paragraphs can take for a list. So after every command the region is
 * put back into blocks side by side: the nested block goes where its
 * holder stood, and any text the holder had around it keeps a paragraph
 * (or heading) of its own. Returns whether anything moved.
 *
 * The caret is the caller's to keep: a node moved is a range lost.
 */
export function hoistNestedBlocks(region: HTMLElement): boolean {
  let moved = false

  for (const holder of Array.from(region.querySelectorAll<HTMLElement>('p, h1, h2'))) {
    const parent = holder.parentNode
    if (!parent) continue
    if (!Array.from(holder.children).some(child => HOISTED.has(child.tagName))) continue

    let inline: Node[] = []
    const keep = (): void => {
      const said = inline.some(
        node => (node.textContent ?? '').trim() !== '' || node.nodeName === 'BR',
      )
      if (said) {
        const copy = holder.cloneNode(false)
        for (const node of inline) copy.appendChild(node)
        parent.insertBefore(copy, holder)
      }
      inline = []
    }

    for (const child of Array.from(holder.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE && HOISTED.has((child as Element).tagName)) {
        keep()
        parent.insertBefore(child, holder)
      } else {
        inline.push(child)
      }
    }
    keep()
    holder.remove()
    moved = true
  }

  return moved
}

function listOf(element: HTMLElement): MemoBlockNode | null {
  const items: MemoListItemNode[] = Array.from(element.children)
    .filter(child => child.tagName === 'LI')
    .map(item => ({
      type: 'listItem' as const,
      // A list item must hold at least one paragraph, so an empty bullet -
      // which somebody halfway through typing a list always has - still
      // produces a valid node rather than failing to save.
      content: paragraphsOf(item as HTMLElement),
    }))

  if (items.length === 0) return null

  return {
    type: element.tagName === 'OL' ? 'orderedList' : 'bulletList',
    content: items,
  }
}

/** A number written into one of the editor's own attributes, or null. */
function numberAttribute(element: Element, name: string): number | null {
  const value = Number(element.getAttribute(name))
  return Number.isFinite(value) && value > 0 ? value : null
}

/** The columns a row covers, counting a merged cell as the columns it spans. */
function spanOfRow(row: MemoTableRowNode): number {
  return row.content.reduce(
    (total, cell) => total + (cell.attrs?.colspan ?? 1),
    0,
  )
}

/**
 * The widths this table carries, if they still describe it.
 *
 * A colgroup left over from before a column was added or taken away does not
 * describe the table any more, and the server refuses widths that disagree
 * with the column count. Reporting none is the honest answer: the renderer
 * then sizes the columns from what is in them, which is what it did before
 * anybody dragged anything.
 */
function columnWidthsOf(element: HTMLElement, columns: number): number[] | null {
  const cols = Array.from(element.querySelectorAll('col'))
  if (cols.length === 0 || cols.length !== columns) return null

  const widths = cols.map(col => numberAttribute(col, WIDTH_ATTRIBUTE))
  if (widths.some(width => width === null)) return null

  const total = (widths as number[]).reduce((sum, width) => sum + width, 0)
  if (!(total > 0)) return null

  // Normalised here so the body does not carry the rounding of whatever
  // sequence of drags produced it, and so the numbers read as shares.
  return (widths as number[]).map(
    width => Number((width / total).toFixed(4)) || 0.0001,
  )
}

function tableOf(element: HTMLElement): MemoBlockNode | null {
  const rowElements = Array.from(element.querySelectorAll('tr'))
  if (rowElements.length === 0) return null

  const rows: MemoTableRowNode[] = rowElements.map(row => {
    const height = numberAttribute(row, HEIGHT_ATTRIBUTE)

    return {
      type: 'tableRow',
      ...(height === null ? {} : { attrs: { height } }),
      content: Array.from(row.children)
        .filter(cell => ['TD', 'TH'].includes(cell.tagName))
        .map((cell): MemoTableCellNode => {
          const content = paragraphsOf(cell as HTMLElement)
          const colspan = numberAttribute(cell, 'colspan')

          return {
            type: cell.tagName === 'TH' ? 'tableHeader' : 'tableCell',
            ...(colspan !== null && colspan > 1
              ? { attrs: { colspan: Math.floor(colspan) } }
              : {}),
            ...(content.length ? { content } : {}),
          }
        }),
    }
  })

  /*
   * Every row padded to the widest.
   *
   * The server refuses a ragged table - the columns stop lining up with their
   * headers and the figures under them stop meaning what the header says -
   * and a browser will produce one from a single deleted cell. Padding here
   * means that mistake costs an empty cell rather than a submission refused
   * at the moment of signing.
   *
   * Counted by span, so a row holding one cell merged across the table is
   * already as wide as the headings above it and is left alone.
   */
  const widest = Math.max(...rows.map(spanOfRow))
  if (widest === 0) return null

  for (const row of rows) {
    for (let at = spanOfRow(row); at < widest; at += 1) {
      row.content.push({ type: 'tableCell' })
    }
  }

  const widths = columnWidthsOf(element, widest)

  return {
    type: 'table',
    ...(widths ? { attrs: { widths } } : {}),
    content: rows,
  }
}

/**
 * Elements that stand on a line of their own.
 *
 * Everything else - text, <b>, <span>, a stray <font> from a paste - is
 * inline, and a run of inline nodes with no block around them is read as one
 * paragraph, which is how the browser was showing them. Reading each as a
 * paragraph of its own turned "one line, two words in bold" into three lines.
 */
const LEAF_BLOCKS = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'TABLE',
  'HR',
  'PRE',
])

const CONTAINER_BLOCKS = new Set([
  'DIV',
  'SECTION',
  'ARTICLE',
  'ASIDE',
  'HEADER',
  'FOOTER',
  'MAIN',
  'NAV',
  'FIGURE',
  'BLOCKQUOTE',
  'ADDRESS',
  'FIELDSET',
  'FORM',
])

const BLOCK_TAGS = new Set([...LEAF_BLOCKS, ...CONTAINER_BLOCKS])

/**
 * An element that holds blocks rather than being one.
 *
 * A pasted document arrives wrapped: Word puts its content in a
 * `<div class=WordSection1>`, Google Sheets in a `<google-sheets-html-origin>`,
 * a web page in whatever it likes. Reading the wrapper as a paragraph would
 * flatten the table inside it into one line of text, which is exactly what
 * pasting a table must not do. So a wrapper is stepped into, and its children
 * read as if they were at the top.
 *
 * The leaf blocks are never wrappers, whatever they hold - a list holds
 * items, a table holds rows, and each reads its own children.
 */
/** The editor's own markers: a page break, a picture. Each is a block of its own. */
const isMarker = (element: Element): boolean =>
  element.hasAttribute(PAGE_BREAK_ATTRIBUTE) || element.hasAttribute(IMAGE_ATTRIBUTE)

function isWrapper(element: HTMLElement): boolean {
  if (isMarker(element)) return false
  if (LEAF_BLOCKS.has(element.tagName)) return false

  return Array.from(element.children).some(
    child =>
      BLOCK_TAGS.has(child.tagName) ||
      isMarker(child) ||
      isWrapper(child as HTMLElement),
  )
}

function isBlock(node: Node): node is HTMLElement {
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  const element = node as HTMLElement
  return BLOCK_TAGS.has(element.tagName) || isMarker(element) || isWrapper(element)
}

/**
 * A picture as a node, or nothing when what the element holds is not one a
 * memo can carry - a picture fetched from somewhere, say, which a body has
 * to be complete without.
 */
function imageOf(holder: HTMLElement): MemoImageNode | null {
  const img = holder.querySelector('img')
  const src = img?.getAttribute('src') ?? ''
  if (!img || !IMAGE_SRC.test(src)) return null

  const alt = (img.getAttribute('alt') ?? '').trim().slice(0, MEMO_BODY_LIMITS.imageAltChars)
  const share = Number(holder.getAttribute(IMAGE_SHARE_ATTRIBUTE))

  return {
    type: 'image',
    attrs: {
      src,
      ...(alt ? { alt } : {}),
      ...(Number.isFinite(share) && share >= 0.2 && share <= 1
        ? { share: Number(share.toFixed(2)) }
        : {}),
    },
  }
}

/** One block element as zero or one memo blocks. */
function blockOf(element: HTMLElement): MemoBlockNode | null {
  if (element.hasAttribute(PAGE_BREAK_ATTRIBUTE)) return { type: 'pageBreak' }
  if (element.hasAttribute(IMAGE_ATTRIBUTE)) return imageOf(element)

  switch (element.tagName) {
    case 'H1':
      return { type: 'heading', attrs: { level: 1 }, content: runsOf(element) }
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      // The template draws two levels. A deeper heading - which only arrives
      // by paste - becomes the lower of the two rather than being dropped.
      return { type: 'heading', attrs: { level: 2 }, content: runsOf(element) }
    case 'UL':
    case 'OL':
      return listOf(element)
    case 'TABLE':
      return tableOf(element)
    case 'HR':
      return { type: 'pageBreak' }
    default:
      return paragraphOf(element)
  }
}

/**
 * Read the blocks under a node.
 *
 * Total, not partial: every child produces a block the template can draw, or
 * nothing at all. Inline nodes with no block around them - what a browser
 * leaves when the last paragraph is deleted, or the loose text of a pasted
 * fragment - are gathered into one paragraph up to the next block, which is
 * the line they were being shown on.
 */
export function htmlToMemoBlocks(root: Node): MemoBlockNode[] {
  const content: MemoBlockNode[] = []
  let inline: Node[] = []

  const flush = (): void => {
    if (inline.length === 0) return
    const runs = runsOfNodes(inline)
    inline = []
    // Whitespace between two blocks is layout, not a line somebody wrote.
    if (runs.some(run => run.text.trim())) {
      content.push({ type: 'paragraph', content: runs })
    }
  }

  const visit = (node: Node): void => {
    if (!isBlock(node)) {
      if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) {
        inline.push(node)
      }
      return
    }

    flush()

    if (isWrapper(node)) {
      for (const child of Array.from(node.childNodes)) visit(child)
      flush()
      return
    }

    const block = blockOf(node)
    if (block) content.push(block)
  }

  for (const child of Array.from(root.childNodes)) visit(child)
  flush()

  return content
}

/** Written on the region: how the memo is set. The reader takes them back. */
export const MEMO_FONT_ATTRIBUTE = 'data-memo-font'
export const MEMO_SIZE_ATTRIBUTE = 'data-memo-size'

const isMemoFont = (value: string | null): value is MemoFont =>
  MEMO_FONTS.some(font => font.key === value)
const isMemoSize = (value: number): value is MemoSize =>
  (MEMO_SIZES as readonly number[]).includes(value)

/**
 * How the memo is set, as the region carries it - only what differs from
 * the default, so a memo nobody has set carries nothing and re-renders as
 * every memo before it did.
 */
export function bodyAttrsOf(root: Node): MemoBodyAttrs | undefined {
  if (!(root instanceof HTMLElement)) return undefined

  const font = root.getAttribute(MEMO_FONT_ATTRIBUTE)
  const size = Number(root.getAttribute(MEMO_SIZE_ATTRIBUTE))
  const attrs: MemoBodyAttrs = {}
  if (isMemoFont(font) && font !== DEFAULT_MEMO_FONT) attrs.font = font
  if (isMemoSize(size) && size !== DEFAULT_MEMO_SIZE) attrs.size = size

  return attrs.font || attrs.size ? attrs : undefined
}

/**
 * Write the setting onto the region: the attributes the reader takes back,
 * and the face and the scale the text is shown in, through the custom
 * properties the editor's stylesheet reads. Not part of `innerHTML`, so
 * the history does not see it: the setting is not an edit to the words.
 */
export function applyBodyAttrs(root: HTMLElement, attrs: MemoBodyAttrs | undefined): void {
  const font = attrs?.font ?? DEFAULT_MEMO_FONT
  const size = attrs?.size ?? DEFAULT_MEMO_SIZE

  if (font === DEFAULT_MEMO_FONT) root.removeAttribute(MEMO_FONT_ATTRIBUTE)
  else root.setAttribute(MEMO_FONT_ATTRIBUTE, font)
  if (size === DEFAULT_MEMO_SIZE) root.removeAttribute(MEMO_SIZE_ATTRIBUTE)
  else root.setAttribute(MEMO_SIZE_ATTRIBUTE, String(size))

  const face = MEMO_FONTS.find(entry => entry.key === font) ?? MEMO_FONTS[0]
  root.style.setProperty('--memo-font', face.css)
  root.style.setProperty('--memo-scale', String(size / DEFAULT_MEMO_SIZE))
}

/** Read the editor. */
export function htmlToMemoBody(root: HTMLElement): MemoBody {
  const attrs = bodyAttrsOf(root)
  return { type: 'doc', ...(attrs ? { attrs } : {}), content: htmlToMemoBlocks(root) }
}

/** How many characters the body holds, counted as the server counts them. */
export function memoBodyLength(body: MemoBody): number {
  let total = 0

  const walk = (nodes: { text?: string; content?: unknown[] }[]): void => {
    for (const node of nodes) {
      if (typeof node.text === 'string') total += node.text.length
      if (Array.isArray(node.content)) {
        walk(node.content as { text?: string; content?: unknown[] }[])
      }
    }
  }

  walk(body.content as unknown as { text?: string; content?: unknown[] }[])
  return total
}

export function memoBodyIsEmpty(body: MemoBody): boolean {
  return memoBodyLength(body) === 0
}

// ── The other direction: a stored body back into the editor ─────────────────

/**
 * Text, made safe to put between tags.
 *
 * This is load-bearing. The editor seeds itself by assigning the result of
 * `memoBodyToHtml` to `innerHTML`, and paste goes through the same path -
 * clipboard text becomes blocks, blocks become HTML - so anything a person
 * can paste reaches this function, and what it escapes is the whole defence.
 *
 * Quotes are not escaped here, because text between tags needs none. The
 * one place text from a memo goes inside an attribute - a picture's
 * description - goes through `escapeAttribute`, which escapes them as well.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Text made safe inside a double-quoted attribute. */
function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * A picture as the editor holds it.
 *
 * `contenteditable="false"`, like the page break: a picture is a thing you
 * place, not a thing you type inside, and the caret steps over it. The
 * share, when there is one, is written twice - as the CSS width the browser
 * lays out and as an attribute the reader takes back exactly.
 */
export function imageHtml(attrs: MemoImageNode['attrs']): string {
  const share = attrs.share
  const sized = share
    ? ` ${IMAGE_SHARE_ATTRIBUTE}="${share}" style="width:${(share * 100).toFixed(1)}%"`
    : ''
  const src = IMAGE_SRC.test(attrs.src) ? attrs.src : ''
  return (
    `<figure ${IMAGE_ATTRIBUTE}="true" contenteditable="false" class="memo-image"${sized}>` +
    `<img src="${src}" alt="${escapeAttribute(attrs.alt ?? '')}"></figure>`
  )
}

function runsToHtml(runs: MemoTextNode[] | undefined): string {
  if (!runs?.length) return '<br>'

  return runs
    .map(run => {
      const marks = (run.marks ?? []).map(mark => mark.type)
      let html = escapeHtml(run.text)
      if (marks.includes('underline')) html = `<u>${html}</u>`
      if (marks.includes('italic')) html = `<i>${html}</i>`
      if (marks.includes('bold')) html = `<b>${html}</b>`
      return html
    })
    .join('')
}

function blockToHtml(block: MemoBlockNode): string {
  switch (block.type) {
    case 'heading':
      return `<h${block.attrs.level}>${runsToHtml(block.content)}</h${block.attrs.level}>`

    case 'bulletList':
    case 'orderedList': {
      const tag = block.type === 'orderedList' ? 'ol' : 'ul'
      const items = block.content
        .map(item => `<li>${item.content.map(p => runsToHtml(p.content)).join(' ')}</li>`)
        .join('')
      return `<${tag}>${items}</${tag}>`
    }

    case 'table': {
      /*
       * Only numbers are ever written into these attributes, and every one
       * of them goes through `Number` on the way in - see the note on
       * `escapeHtml`, which does not escape quotes because nothing from the
       * memo itself is ever put inside an attribute. That remains true.
       */
      const widths = block.attrs?.widths ?? []
      const colgroup = widths.length
        ? `<colgroup>${widths
            .map(width => {
              const share = Number(width)
              return `<col ${WIDTH_ATTRIBUTE}="${share}" style="width:${(share * 100).toFixed(3)}%">`
            })
            .join('')}</colgroup>`
        : ''

      // Without a fixed layout the browser sizes the columns from their
      // content and the widths somebody dragged do nothing on screen, however
      // faithfully the PDF then draws them.
      const layout = widths.length ? ' style="table-layout:fixed"' : ''

      const rows = block.content
        .map(row => {
          const cells = row.content
            .map(cell => {
              const tag = cell.type === 'tableHeader' ? 'th' : 'td'
              const span = Number(cell.attrs?.colspan ?? 1)
              const spanned = span > 1 ? ` colspan="${Math.floor(span)}"` : ''
              const inner = (cell.content ?? [])
                .map(p => runsToHtml(p.content))
                .join(' ')
              return `<${tag}${spanned}>${inner || '<br>'}</${tag}>`
            })
            .join('')

          // The height in the sheet's own points rather than the browser's,
          // so a row is the same fraction of the page here as in the PDF.
          const height = Number(row.attrs?.height ?? 0)
          const tall =
            height > 0
              ? ` ${HEIGHT_ATTRIBUTE}="${height}" style="height:calc(${height} * var(--memo-pt))"`
              : ''

          return `<tr${tall}>${cells}</tr>`
        })
        .join('')

      return `<table${layout}>${colgroup}<tbody>${rows}</tbody></table>`
    }

    case 'pageBreak':
      return pageBreakHtml()

    case 'image':
      return imageHtml(block.attrs)

    case 'paragraph':
    default:
      return `<p>${runsToHtml(block.content)}</p>`
  }
}

export function pageBreakHtml(): string {
  // `contenteditable="false"` so the caret steps over it rather than into it:
  // a page break is a thing you place, not a thing you type inside.
  return `<div ${PAGE_BREAK_ATTRIBUTE}="true" contenteditable="false" class="memo-page-break">Page break</div>`
}

/**
 * A stored body as editor HTML.
 *
 * Only ever used to seed the region - once, on mount, or when a different
 * draft is opened. Writing to `innerHTML` while somebody is typing destroys
 * the caret and the undo stack, which is why the editor is uncontrolled.
 */
export function memoBodyToHtml(body: MemoBody): string {
  if (body.content.length === 0) return '<p><br></p>'
  return body.content.map(blockToHtml).join('')
}

/**
 * Plain text as memo blocks, for paste.
 *
 * Paste is the one route by which arbitrary markup - a whole styled web page,
 * a Word document with its own classes and fonts - reaches an editor. Taking
 * the plain text and building the blocks here means none of it ever enters
 * the DOM, so there is no sanitising to get wrong.
 */
export function plainTextToBlocks(text: string): MemoBlockNode[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line): MemoBlockNode => {
      const trimmed = line.trim()
      return trimmed
        ? { type: 'paragraph', content: [{ type: 'text', text: trimmed }] }
        : { type: 'paragraph' }
    })
}

export function emptyMemoBody(): MemoBody {
  return { type: 'doc', content: [{ type: 'paragraph' }] }
}

/** A starting point built from a memo type's outline headings. */
export function outlineBody(headings: string[]): MemoBody {
  if (headings.length === 0) return emptyMemoBody()

  return {
    type: 'doc',
    content: headings.flatMap((heading): MemoBlockNode[] => [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: heading }] },
      { type: 'paragraph' },
    ]),
  }
}

/**
 * How much of the body is the preparer's own prose.
 *
 * Headings are excluded, and that is the whole point. Choosing a memo type
 * drops that type's outline into the editor - "BACKGROUND:", "Recommendation"
 * - which is text, so every measure of "has anything been written?" answered
 * yes the moment a type was picked. The checklist ticked "Memo written" for a
 * memo containing nothing but the system's own prompts, and would have let it
 * be submitted.
 *
 * Counting only what sits outside the headings asks the question that was
 * meant: has this person written a memo, or only been handed a shape for one?
 */
export function memoBodyProseLength(body: MemoBody): number {
  let total = 0

  const runs = (nodes: MemoTextNode[] | undefined): void => {
    for (const node of nodes ?? []) total += node.text.length
  }

  for (const block of body.content) {
    switch (block.type) {
      case 'heading':
        break
      case 'paragraph':
        runs(block.content)
        break
      case 'bulletList':
      case 'orderedList':
        for (const item of block.content) {
          for (const paragraph of item.content) runs(paragraph.content)
        }
        break
      case 'table':
        for (const row of block.content) {
          for (const cell of row.content) {
            for (const paragraph of cell.content ?? []) runs(paragraph.content)
          }
        }
        break
      default:
        break
    }
  }

  return total
}

/** True when the body holds only headings, or nothing at all. */
export function memoBodyHasNoProse(body: MemoBody): boolean {
  return memoBodyProseLength(body) === 0
}
