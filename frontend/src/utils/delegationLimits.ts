/** The longest a delegation may run; the server refuses anything longer. */
export const MAX_DELEGATION_DAYS = 90

/** The last day a delegation starting today may run to, as YYYY-MM-DD. */
export function latestDelegationEnd(from: Date = new Date()): string {
  return new Date(from.getTime() + MAX_DELEGATION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
}
