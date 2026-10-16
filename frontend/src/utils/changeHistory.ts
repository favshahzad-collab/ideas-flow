import type { AdministrationEntry } from '../services/auditApi'

/**
 * How a row of the administration trail reads.
 *
 * Here rather than beside the table because both are pure string work with
 * their own tests, and a component file that also exports helpers loses fast
 * refresh for the whole module.
 */

/** `USER_UPDATED` reads as "User updated". Sentence case, not shouting. */
export function readableAction(action: string): string {
  const words = action.toLowerCase().split('_').join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * What changed, in as few words as carry the meaning.
 *
 * A field whose values the server withheld is named without them: "changed"
 * is the honest word for a credential that was replaced, and printing the old
 * and new would be the one thing this screen must not do.
 */
export function describeChanges(entry: AdministrationEntry): string {
  if (entry.changes.length === 0) return '—'

  return entry.changes
    .map(change => {
      if (change.to !== null && change.from !== null) {
        return `${change.field}: ${change.from} → ${change.to}`
      }
      if (change.to !== null) return `${change.field}: ${change.to}`
      if (change.from !== null) return `${change.field} was ${change.from}`
      return `${change.field} changed`
    })
    .join(' · ')
}
