import { indexText, rangeFromOffsets, type TextIndex } from './memoFind'

/**
 * Spelling, checked in the editor against a dictionary the app carries.
 *
 * The browser has a spell check of its own, and it is the reason this one
 * exists: it cannot be told the organisation's words. Every colleague's
 * name, every department, every product and every term of the trade comes
 * up underlined in red, on every memo, for everybody - and a warning that
 * is wrong that often is a warning nobody reads. So the region's own check
 * is switched off once this one is ready, and this one is given the
 * directory and the organisation's dictionary before it looks at a word.
 *
 * The English is the en-GB dictionary from SCOWL (see
 * `public/dictionaries/en-GB.LICENSE`), read through `nspell`, both loaded
 * only when an editor opens. Misspellings are painted through the highlight
 * registry, like find matches: nothing is written into the memo.
 *
 * What is checked is deliberately narrow. A word of letters, in the Latin
 * script; not an acronym, not something against a figure, not part of an
 * address. The dictionary is English and says nothing about a word in Urdu.
 */

export interface Speller {
  correct(word: string): boolean
  suggest(word: string): string[]
}

/** Letters, with apostrophes inside; a hyphen ends a word. */
const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu

export interface Token {
  word: string
  start: number
  end: number
}

export function tokensOf(text: string): Token[] {
  return [...text.matchAll(WORD)].map(match => ({
    word: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }))
}

/** Whether a word is the checker's business at all. */
export function checkable(text: string, token: Token): boolean {
  const { word, start, end } = token
  if (word.length < 2) return false
  // Not an English word if there is no Latin letter in it.
  if (!/[A-Za-z]/.test(word)) return false
  // An acronym, or a word shouted: no dictionary lists them.
  if (/^[\p{Lu}]+$/u.test(word)) return false
  // Against a figure: the "th" of 19th, the "pm" of 5pm, the "x" of 4x.
  if (/\p{N}/u.test(text.charAt(start - 1)) || /\p{N}/u.test(text.charAt(end))) return false
  // Part of an address.
  const run = text.slice(text.lastIndexOf(' ', start) + 1, (text.indexOf(' ', end) + 1 || text.length + 1) - 1)
  if (/@|:\/\/|^www\./i.test(run)) return false
  return true
}

const key = (word: string): string => word.replace(/’/g, "'").toLowerCase()

/** How many suggestions to offer. More than this is a list nobody reads. */
export const SUGGESTION_LIMIT = 5

/**
 * The dictionary with the organisation's words on top, and a memory of what
 * it has already been asked: a memo is re-read on every keystroke, and the
 * same word is the same answer.
 */
export class SpellChecker {
  private readonly speller: Speller
  private readonly extra = new Set<string>()
  private readonly ignored = new Set<string>()
  private readonly answers = new Map<string, boolean>()

  constructor(speller: Speller, words: Iterable<string> = []) {
    this.speller = speller
    this.learn(words)
  }

  /** Words the organisation writes: never flagged, in any case. */
  learn(words: Iterable<string>): void {
    for (const word of words) this.extra.add(key(word))
    this.answers.clear()
  }

  /** "Ignore" - for this editor, this session. */
  ignore(word: string): void {
    this.ignored.add(key(word))
  }

  isKnown(word: string): boolean {
    const lower = key(word)
    if (this.extra.has(lower) || this.ignored.has(lower)) return true

    const cached = this.answers.get(word)
    if (cached !== undefined) return cached

    let known = this.speller.correct(word)
    // A sentence starts with a capital; "Approval" is "approval".
    if (!known && word !== lower && /^\p{Lu}\p{Ll}/u.test(word)) known = this.speller.correct(lower)
    // A possessive of a name the directory knows: "Somrow's".
    if (!known && /['’]s$/.test(word)) known = this.isKnown(word.slice(0, -2))

    this.answers.set(word, known)
    return known
  }

  /** What it might have been, in the case it was written. */
  suggestions(word: string): string[] {
    const found = this.speller.suggest(word).slice(0, SUGGESTION_LIMIT)
    const capital = /^\p{Lu}/u.test(word) && !/^\p{Lu}+$/u.test(word)
    return found.map(suggestion =>
      capital ? suggestion.charAt(0).toUpperCase() + suggestion.slice(1) : suggestion,
    )
  }
}

export interface Misspelling extends Token {
  range: Range
}

/**
 * Every word in the region the checker does not know, in order. A word the
 * caret is inside while it is being typed is left out - it is not finished.
 */
export function misspellings(
  index: TextIndex,
  checker: SpellChecker,
  typingAt: number | null = null,
): Misspelling[] {
  const found: Misspelling[] = []

  for (const token of tokensOf(index.text)) {
    if (!checkable(index.text, token)) continue
    if (typingAt !== null && token.start < typingAt && typingAt <= token.end) continue
    if (checker.isKnown(token.word)) continue

    const range = rangeFromOffsets(index, token.start, token.end)
    if (range) found.push({ ...token, range })
  }

  return found
}

/** Where a caret stands in the region's text, or null when it is not in a text node of it. */
export function caretOffset(index: TextIndex, node: Node | null, offset: number): number | null {
  if (!node || node.nodeType !== Node.TEXT_NODE) return null
  const piece = index.pieces.find(entry => entry.node === node)
  return piece ? piece.start + offset : null
}

/** The misspelling the caret stands in, if any. */
export const misspellingAt = (list: Misspelling[], offset: number | null): Misspelling | null =>
  offset === null
    ? null
    : (list.find(entry => entry.start <= offset && offset <= entry.end) ?? null)

export { indexText }

// ── Loading ─────────────────────────────────────────────────────────────────

let loading: Promise<Speller> | null = null

/**
 * The English dictionary, read once per page and only when asked for. The
 * files are served as static assets rather than bundled: half a megabyte
 * the browser caches and the memo's own code never has to carry.
 */
export function loadSpeller(): Promise<Speller> {
  loading ??= (async () => {
    const [{ default: nspell }, aff, dic] = await Promise.all([
      import('nspell'),
      fetch('/dictionaries/en-GB.aff').then(response => response.text()),
      fetch('/dictionaries/en-GB.dic').then(response => response.text()),
    ])
    return nspell(aff, dic)
  })()
  return loading
}

// ── Showing the misspellings ────────────────────────────────────────────────

export const SPELLING_HIGHLIGHT = 'memo-spelling'

function registry(): HighlightRegistry | null {
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined') {
    return null
  }
  return CSS.highlights
}

export function paintMisspellings(ranges: Range[]): void {
  const highlights = registry()
  if (!highlights) return
  if (ranges.length === 0) highlights.delete(SPELLING_HIGHLIGHT)
  else highlights.set(SPELLING_HIGHLIGHT, new Highlight(...ranges))
}

export function clearMisspellings(): void {
  registry()?.delete(SPELLING_HIGHLIGHT)
}
