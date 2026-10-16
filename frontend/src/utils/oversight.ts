import type { OversightItem } from '../types/document'
import { getDueSeverity, getWaitingSeverity } from './format'

/**
 * Derivations for the Control room.
 *
 * Everything here is computed from the oversight payload, which is the
 * ORGANISATION-WIDE set of in-flight workflows — not the signed-in user's
 * slice. That is what makes a per-approver load figure honest here when the
 * same figure on the people table would not be: the denominator is the whole
 * board, so nobody is under-counted by a permission boundary.
 */

const DAY = 86_400_000

export interface OversightStats {
  /** Everything currently awaiting an approval action. */
  inFlight: number
  /** Waiting longer than a week where it now sits. Real; not an SLA breach. */
  stalled: number
  /** Distinct people holding at least one document. */
  holders: number
  /** Whole days the oldest item has waited. */
  longestWaitDays: number
  /**
   * Past a deadline that was actually set. Null - not zero - when no item on
   * the board has one, so the Control room can leave the card out rather than
   * show a green zero that would read as "nothing is late" on a deployment
   * where nothing could be.
   */
  breaching: number | null
  /** Holders told about an overdue step today. Null on the same terms. */
  chasedToday: number | null
}

export function computeOversightStats(
  items: OversightItem[],
  now: number = Date.now(),
): OversightStats {
  let stalled = 0
  let longestMs = 0
  let breaching = 0
  let chasedToday = 0
  let anyDeadlines = false
  const holders = new Set<string>()
  const startOfToday = new Date(now)
  startOfToday.setUTCHours(0, 0, 0, 0)

  for (const item of items) {
    const severity = getWaitingSeverity(item.heldSince, now)
    if (severity === 'overdue' || severity === 'critical') stalled += 1

    if (item.holder) holders.add(item.holder.id)

    const waited = now - new Date(item.heldSince).getTime()
    if (Number.isFinite(waited) && waited > longestMs) longestMs = waited

    if (item.dueAt) {
      anyDeadlines = true
      if (getDueSeverity(item.dueAt, now) === 'overdue') breaching += 1
    }

    if (item.chasedAt && new Date(item.chasedAt).getTime() >= startOfToday.getTime()) {
      chasedToday += 1
    }
  }

  return {
    inFlight: items.length,
    stalled,
    holders: holders.size,
    longestWaitDays: Math.floor(longestMs / DAY),
    // Null rather than zero where nothing has a deadline: "0 breaching" is a
    // claim about compliance, and a board with no deadlines on it is making
    // no such claim.
    breaching: anyDeadlines ? breaching : null,
    chasedToday: anyDeadlines ? chasedToday : null,
  }
}

export interface ApproverLoad {
  id: string
  name: string
  department: string | null
  /** How many in-flight documents this person is holding. */
  count: number
  /** Of those, how many have waited longer than a week. */
  stalled: number
  /** `count` as a share of the busiest person's, 0-100. */
  percent: number
  tone: 'accent' | 'warning' | 'danger'
}

/**
 * Load per approver, busiest first.
 *
 * The share is relative to the busiest person rather than to an absolute
 * capacity, because no capacity is recorded anywhere — five documents might
 * be a light week or an impossible one. Relative load still answers the
 * question the card is for: who is the bottleneck right now.
 */
export function computeApproverLoad(
  items: OversightItem[],
  now: number = Date.now(),
): ApproverLoad[] {
  const byPerson = new Map<string, ApproverLoad>()

  for (const item of items) {
    const holder = item.holder
    if (!holder) continue

    const existing = byPerson.get(holder.id) ?? {
      id: holder.id,
      name: `${holder.firstName} ${holder.lastName}`,
      department: holder.department ?? null,
      count: 0,
      stalled: 0,
      percent: 0,
      tone: 'accent' as const,
    }

    existing.count += 1
    const severity = getWaitingSeverity(item.heldSince, now)
    if (severity === 'overdue' || severity === 'critical') existing.stalled += 1

    byPerson.set(holder.id, existing)
  }

  const rows = [...byPerson.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  )

  const busiest = rows[0]?.count ?? 0

  return rows.map(row => {
    const percent = busiest ? Math.round((row.count / busiest) * 100) : 0
    return {
      ...row,
      percent,
      tone: percent >= 80 ? 'danger' : percent >= 50 ? 'warning' : 'accent',
    }
  })
}

/** Longest-waiting first — the only order this screen is read in. */
export function sortByWait(items: OversightItem[]): OversightItem[] {
  return [...items].sort(
    (a, b) => new Date(a.heldSince).getTime() - new Date(b.heldSince).getTime(),
  )
}
