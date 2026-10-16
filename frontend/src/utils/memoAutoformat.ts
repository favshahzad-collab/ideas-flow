/**
 * What the editor does with a few things as they are typed, the way every
 * word processor does: a line begun with a dash becomes a bullet, straight
 * quotes become the curly ones the page is set in, two hyphens become a
 * dash. Each is a single undo away, and each is decided here, on text, so
 * it can be tested without an editor.
 */

/** A block format asked for by what was typed at the start of a line. */
export type BlockMarker =
  | { kind: 'bulletList' }
  | { kind: 'orderedList' }
  | { kind: 'heading'; level: 1 | 2 }

/**
 * The block a line's text asks for, once the space after the marker lands.
 * Exact: "- " and nothing else, so a dash somebody meant is left alone the
 * moment they type past it.
 */
export function blockMarker(text: string): BlockMarker | null {
  switch (text.replace(/\xa0/g, ' ')) {
    case '- ':
    case '* ':
      return { kind: 'bulletList' }
    case '1. ':
      return { kind: 'orderedList' }
    case '# ':
      return { kind: 'heading', level: 1 }
    case '## ':
      return { kind: 'heading', level: 2 }
    default:
      return null
  }
}

/** What opens a quotation: the start of the text, a space, or an opening bracket or dash. */
const OPENS = /(?:^|[\s([{—–“‘])$/

/**
 * The curly form of a straight quote typed after `before`. A single quote
 * inside a word - don't, the organisation's - is the closing form, which is
 * also the apostrophe.
 */
export function smartQuote(before: string, quote: '"' | "'"): string {
  const opening = OPENS.test(before)
  if (quote === '"') return opening ? '“' : '”'
  return opening ? '‘' : '’'
}

/**
 * The text as it stands after a character typed at `offset - 1`, with the
 * conversion applied, or null when there is none to apply. Two hyphens
 * become an en dash; a third hyphen after a dash is left alone, so that
 * a rule of hyphens can still be typed.
 */
export function convertTyped(
  text: string,
  offset: number,
): { text: string; offset: number } | null {
  const typed = text.charAt(offset - 1)
  const before = text.slice(0, offset - 1)

  if (typed === '"' || typed === "'") {
    return { text: before + smartQuote(before, typed) + text.slice(offset), offset }
  }

  if (typed === '-' && before.endsWith('-') && !before.endsWith('--')) {
    return { text: before.slice(0, -1) + '–' + text.slice(offset), offset: offset - 1 }
  }

  return null
}
