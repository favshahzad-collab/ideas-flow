/**
 * Naming a colleague in a memo by typing `@`.
 *
 * An allowance memo names people, and a mistyped name or job title on a
 * document four people sign is not a typo - it is the wrong person paid, or
 * the right person described as somebody else. So the editor offers the
 * directory: type `@` and the first letters of a name, pick, and the person's
 * line is written from their record.
 *
 * Written, not linked. What lands in the memo is plain text, fixed at the
 * moment it is inserted. A live reference would make a filed memo change
 * when somebody's designation changed, and a memo that says something
 * different from what it said when it was signed is the one thing this
 * system exists to prevent.
 */

/** What is being looked up: the `@name` before the caret, and where it is. */
export type MentionAtCaret = {
  node: Text
  /** Offset of the `@` in the text node. */
  start: number
  /** Offset of the caret. */
  end: number
  /** What follows the `@`. */
  query: string
}

/**
 * `@` at the start of the text or after a space (a non-breaking one
 * included, which is what a browser leaves at the end of a line) or an
 * opening bracket, then up to forty characters that are neither space nor
 * another `@`, running right up to the caret. An `@` in the middle of a
 * word - an email address being typed - is not an invitation to look
 * anybody up.
 */
const MENTION = /(?:^|[\s\xa0(])@([^\s\xa0@]{0,40})$/

/** The mention being typed before the caret, if there is one. */
export function mentionAtCaret(region: HTMLElement): MentionAtCaret | null {
  const selection = region.ownerDocument.getSelection()
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null

  const node = selection.anchorNode
  if (!node || node.nodeType !== Node.TEXT_NODE || !region.contains(node)) return null

  const text = node.textContent ?? ''
  const end = selection.anchorOffset
  const match = MENTION.exec(text.slice(0, end))
  if (!match) return null

  const query = match[1] ?? ''
  return { node: node as Text, start: end - query.length - 1, end, query }
}

/** How many people to offer. A name narrows the list faster than a scroll would. */
export const MENTION_LIMIT = 8

/**
 * The people whose name starts with what was typed first, then those whose
 * name contains it, then the rest - and no more than the limit.
 *
 * The directory search matches a term anywhere, department included, and
 * answers alphabetically; after an `@` the letters are the start of a name,
 * and "ina" has to find Inayat before it finds everybody in Finance. Ties
 * keep the directory's own order.
 */
export function rankByName<T extends { firstName: string; lastName: string }>(
  query: string,
  people: T[],
  limit = MENTION_LIMIT,
): T[] {
  const term = query.trim().toLowerCase()
  if (!term) return people.slice(0, limit)

  const score = (person: T): number => {
    const first = person.firstName.toLowerCase()
    const last = person.lastName.toLowerCase()
    const full = `${first} ${last}`
    if (first.startsWith(term) || last.startsWith(term) || full.startsWith(term)) return 0
    if (full.includes(term)) return 1
    return 2
  }

  return people
    .map((person, index) => ({ person, index, score: score(person) }))
    .sort((one, other) => one.score - other.score || one.index - other.index)
    .map(entry => entry.person)
    .slice(0, limit)
}

/** Somebody as the directory describes them. */
export type MentionablePerson = {
  firstName: string
  lastName: string
  designation?: string | null
  department?: { name: string } | null
}

/**
 * The line written into the memo for a person: name, designation and
 * department, each left out when the record does not have it.
 */
export function personLine(person: MentionablePerson): string {
  const name = `${person.firstName} ${person.lastName}`.trim()
  return [name, person.designation?.trim(), person.department?.name?.trim()]
    .filter((part): part is string => Boolean(part))
    .join(', ')
}
