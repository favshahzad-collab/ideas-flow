import type { Delegation } from '../types/delegation'

/**
 * The cover somebody holds that stops their own approvals being handed on.
 *
 * `POST /api/delegations` refuses onward delegation in both directions: a
 * person whose approvals are already routed away cannot take anybody else's
 * on, and a person covering for a colleague cannot route their own onward.
 * The second is the half that strands a memo - the colleague's steps stay
 * addressed to the person covering, so whoever took their approvals could
 * neither sign those steps nor know they were waiting.
 *
 * Wider than the server's `isActive`, deliberately. Both screens that offer a
 * handover start it now and run it until somebody ends it, so cover beginning
 * next week shares days with it and the server refuses on exactly that
 * overlap. Filtering on `isActive` would offer a form whose only outcome is a
 * rejection.
 */
export function coverStillRunning(
  held: readonly Delegation[],
  now: number = Date.now(),
): Delegation[] {
  return held.filter(
    one => one.revokedAt === null && (one.endsAt === null || Date.parse(one.endsAt) >= now),
  )
}
