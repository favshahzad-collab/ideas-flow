/**
 * What the signed-in person may do, as the server describes it.
 *
 * The client used to work this out for itself by comparing `role` to the
 * string 'ADMINISTRATOR' - in the shell, on the route guards, and in a
 * handful of screens. Four copies of a rule that lives on the server is four
 * chances to show somebody a link to a page that will turn them away.
 *
 * These are still only for *rendering*. Nothing here is a permission check:
 * every one of them is enforced again by the route the screen calls, and would
 * be enforced there even if this file said the opposite.
 */
export type Capability =
  | 'memos.prepare'
  | 'memos.view.own'
  | 'memos.view.assigned'
  | 'memos.view.all'
  | 'memos.comment'
  | 'approvals.act'
  | 'approvals.delegate'
  | 'audit.view'
  | 'audit.verify'
  | 'audit.export'
  | 'approvals.oversee'
  | 'approvals.reassign'
  | 'audit.administration'
  | 'users.manage'
  | 'departments.manage'
  | 'workflows.manage'
  | 'workflows.policy'
  | 'documents.pageSetup'
  | 'documents.clauses'
  | 'documents.dictionary'
  | 'mail.configure'
  | 'sso.configure'
  | 'sessions.view'
  | 'approvals.holders'
  | 'admins.manage'
  | 'memos.cancel'

/**
 * Whether somebody holds a capability, for deciding what to *render*.
 *
 * The empty list is the interesting case. Every real signed-in person holds at
 * least the everyday capabilities, so an empty list cannot mean "this person
 * may do nothing" - it means the server did not say. That happens in exactly
 * one situation: a browser running this build against a server old enough not
 * to report capabilities at all.
 *
 * Without this, that situation would lock an administrator out of every
 * administration screen and hide the whole navigation group, because the
 * absence of an answer would read as a refusal. Falling back to the role is
 * precisely the rule this replaced, so an old server keeps behaving the way it
 * did before any of this existed.
 *
 * Never a permission check either way: the route refuses the request itself.
 */
export function holdsCapability(
  user: { role: string; capabilities: Capability[] } | null | undefined,
  capability: Capability
): boolean {
  if (!user) return false
  if (user.capabilities.length > 0) return user.capabilities.includes(capability)
  return user.role === 'ADMINISTRATOR'
}

/**
 * Whether somebody may at least *see* an area: they hold it, or a Super
 * Administrator gave them the seeing half of it alone. For deciding which
 * screens to offer; `holdsCapability` still says whether they may change
 * what is on them.
 */
export function seesCapability(
  user: { role: string; capabilities: Capability[]; viewOnly?: Capability[] } | null | undefined,
  capability: Capability
): boolean {
  return holdsCapability(user, capability) || Boolean(user?.viewOnly?.includes(capability))
}
