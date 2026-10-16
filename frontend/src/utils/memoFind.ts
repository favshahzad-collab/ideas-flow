/**
 * Finding words in the memo, and replacing them.
 *
 * The editor's DOM is its model, so the one thing a find must not do is
 * write into it: a `<mark>` wrapped round each match would be read by
 * `memoDom` as part of the memo, recorded by the history as an edit, and
 * carried into every snapshot. Matches are found as DOM Ranges over the
 * text that is already there, and shown through the CSS highlight registry,
 * which paints a range without adding a node. Only a replacement writes,
 * and it writes the way typing over a selection does.
 *
 * Matching is over the text of the region read as one string, so a phrase
 * is found across a bold word in the middle of it, and not found across the
 * end of a paragraph or the edge of a table cell.
 */

export interface FindOptions {
  matchCase: boolean
  wholeWord: boolean
}

/** One text node's place in the region's text. */
interface Piece {
  node: Text
  /** Where this node's first character falls in the joined text. */
  start: number
}

export interface TextIndex {
  text: string
  pieces: Piece[]
}

/** The elements a match may not cross. */
const BLOCKS = 'p, h1, h2, li, td, th'

/** Between two blocks: a character no query can contain. */
const SEPARATOR = '\n'

/**
 * The region's text as one string, with a map back to the nodes it came
 * from. Anything inside a `contenteditable="false"` marker - the page
 * break's own label - is not memo text and is left out.
 */
export function indexText(region: HTMLElement): TextIndex {
  const walker = region.ownerDocument.createTreeWalker(region, NodeFilter.SHOW_TEXT, {
    acceptNode: node => {
      const frozen = node.parentElement?.closest('[contenteditable="false"]')
      return frozen && frozen !== region && region.contains(frozen)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
    },
  })

  let text = ''
  const pieces: Piece[] = []
  let lastBlock: Element | null = null

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const piece = node as Text
    if (!piece.data) continue

    const block = piece.parentElement?.closest(BLOCKS) ?? region
    if (lastBlock && block !== lastBlock) text += SEPARATOR
    lastBlock = block

    pieces.push({ node: piece, start: text.length })
    text += piece.data
  }

  return { text, pieces }
}

/** The characters that must be escaped for a query to be matched as written. */
const SPECIAL = /[.*+?^${}()|[\]\\]/g

/** Letters, digits and the underscore: what a whole word is made of. */
const WORD = /[\p{L}\p{N}_]/u

/**
 * The query as a pattern. Plain text, never a regular expression: a preparer
 * looking for `Rs.` means the dot.
 */
export function findPattern(query: string, options: FindOptions): RegExp | null {
  // A query holding the separator could only match across blocks.
  if (!query || query.includes(SEPARATOR)) return null
  return new RegExp(query.replace(SPECIAL, '\\$&'), options.matchCase ? 'g' : 'gi')
}

const isWholeWord = (text: string, start: number, end: number): boolean =>
  !WORD.test(text.charAt(start - 1)) && !WORD.test(text.charAt(end))

/** The piece holding an offset - for an end offset, the piece it closes. */
function pieceAt(index: TextIndex, offset: number, closing: boolean): Piece | null {
  let found: Piece | null = null
  for (const piece of index.pieces) {
    if (closing ? piece.start < offset : piece.start <= offset) found = piece
    else break
  }
  if (!found || offset - found.start > found.node.data.length) return null
  return found
}

export function rangeFromOffsets(index: TextIndex, start: number, end: number): Range | null {
  const from = pieceAt(index, start, false)
  const to = pieceAt(index, end, true)
  if (!from || !to) return null

  const range = from.node.ownerDocument.createRange()
  range.setStart(from.node, start - from.start)
  range.setEnd(to.node, end - to.start)
  return range
}

/** Every match in the region, in document order. */
export function findAll(region: HTMLElement, query: string, options: FindOptions): Range[] {
  const pattern = findPattern(query, options)
  if (!pattern) return []

  const index = indexText(region)
  const ranges: Range[] = []

  for (const match of index.text.matchAll(pattern)) {
    const start = match.index
    const end = start + match[0].length
    if (options.wholeWord && !isWholeWord(index.text, start, end)) continue

    const range = rangeFromOffsets(index, start, end)
    if (range) ranges.push(range)
  }

  return ranges
}

/**
 * Write over one match.
 *
 * The replacement goes into the text node the match began in, at the place
 * it began, so it takes the formatting the match had there - bold stays
 * bold - exactly as typing over the selection would. What the match spanned
 * beyond that node is deleted; `tidy` clears away what that leaves.
 */
export function replaceRange(range: Range, replacement: string): void {
  const startNode = range.startContainer
  const startOffset = range.startOffset

  range.deleteContents()

  if (startNode.nodeType === Node.TEXT_NODE) {
    const text = startNode as Text
    text.insertData(Math.min(startOffset, text.length), replacement)
    return
  }
  range.insertNode(startNode.ownerDocument!.createTextNode(replacement))
}

/**
 * After replacements: no empty emphasis left where a bold word was
 * replaced away, adjacent text joined back into one node, and a block
 * emptied entirely given the filler the browser needs to put a caret in it.
 */
export function tidy(region: HTMLElement): void {
  for (const element of Array.from(region.querySelectorAll('strong, b, em, i, u, span'))) {
    if (!element.textContent && !element.querySelector('br')) element.remove()
  }
  region.normalize()
  for (const block of Array.from(region.querySelectorAll(BLOCKS))) {
    if (block.childNodes.length === 0) block.appendChild(region.ownerDocument.createElement('br'))
  }
}

/**
 * Replace every match, last to first so that each edit lands beyond the
 * matches still to be done and moves none of them. One pass over the
 * matches as they stood, so a replacement that contains the query is not
 * found again.
 */
export function replaceAll(
  region: HTMLElement,
  query: string,
  replacement: string,
  options: FindOptions,
): number {
  const ranges = findAll(region, query, options)
  for (const range of [...ranges].reverse()) replaceRange(range, replacement)
  if (ranges.length > 0) tidy(region)
  return ranges.length
}

// ── Showing the matches ─────────────────────────────────────────────────────

export const FIND_HIGHLIGHT = 'memo-find'
export const CURRENT_HIGHLIGHT = 'memo-find-current'

/** The registry, where the browser has one. A test DOM does not. */
function registry(): HighlightRegistry | null {
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined') {
    return null
  }
  return CSS.highlights
}

/** Paint every match, and the current one in its own colour. */
export function paintMatches(ranges: Range[], current: number): void {
  const highlights = registry()
  if (!highlights) return

  highlights.set(FIND_HIGHLIGHT, new Highlight(...ranges.filter((_, at) => at !== current)))
  const at = ranges[current]
  if (at) highlights.set(CURRENT_HIGHLIGHT, new Highlight(at))
  else highlights.delete(CURRENT_HIGHLIGHT)
}

export function clearMatches(): void {
  const highlights = registry()
  if (!highlights) return
  highlights.delete(FIND_HIGHLIGHT)
  highlights.delete(CURRENT_HIGHLIGHT)
}
