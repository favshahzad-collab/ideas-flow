export function formatFullName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim()
}

export function getInitials(firstName: string, lastName: string): string {
  const first = firstName?.trim().charAt(0) ?? ''
  const last = lastName?.trim().charAt(0) ?? ''
  return `${first}${last}`.toUpperCase() || '?'
}

/**
 * Split what was typed into a person search into a first and last name.
 *
 * Somebody looking for a colleague types their name, so it is already on the
 * screen - making them retype it into two more fields to add that person is
 * the kind of small insult that makes people avoid a feature. Text with an @
 * in it goes to the email field instead, because that is what was meant.
 *
 * The inverse of `formatFullName`, and deliberately not symmetrical with it:
 * everything after the first word is the surname, so "Muhammad Zaraq Mahmood"
 * keeps "Zaraq Mahmood" rather than dropping the middle name. A name printed
 * under a signature on an approved memo is the wrong place to lose a word.
 */
export function splitTypedName(query: string): {
  firstName: string
  lastName: string
  email: string
} {
  const text = query.trim()
  if (!text) return { firstName: '', lastName: '', email: '' }

  if (text.includes('@')) return { firstName: '', lastName: '', email: text }

  const parts = text.split(/\s+/)
  return {
    firstName: parts[0] ?? '',
    lastName: parts.slice(1).join(' '),
    email: '',
  }
}
