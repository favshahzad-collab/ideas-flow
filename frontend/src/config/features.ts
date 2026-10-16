/// <reference types="vite/client" />

/**
 * Feature gates for the parts of the redesign that depend on API fields the
 * backend does not return yet — SLA due dates, escalation, delegation,
 * ledger hashes, saved views, per-document value.
 *
 * The rule: a surface that would show INVENTED data is on in development,
 * where it is being built and reviewed, and off in a production build unless
 * somebody explicitly turns it on. That way the redesign is visible while it
 * is being made, and a guessed SLA never reaches a real approver.
 *
 * Set `VITE_FEATURE_<NAME>=true|false` to override either way.
 */
function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

export const FEATURES = {
  /*
   * Off by default everywhere, not just in production.
   *
   * The list, its names and its counts are invented - the endpoint does not
   * exist - and `whileBuilding` put them on screen beside a real queue for
   * anybody being shown the app before release. "Breaching SLA 3" next to a
   * true figure is worse than no feature at all, because there is nothing on
   * screen that says which of the two is real. Set VITE_FEATURE_SAVED_VIEWS
   * to see the design.
   */
  savedViews: flag(import.meta.env.VITE_FEATURE_SAVED_VIEWS, false),

  /**
   * SLA countdowns and breach figures. Shipped: a step carries `slaDays`, the
   * API returns a real `dueAt`, and a sweep chases whoever is holding a memo
   * that has run over.
   *
   * On — but nothing appears unless a deadline has actually been set, either
   * on the step or as `SLA_DEFAULT_DAYS` on the server. With none set every
   * `dueAt` is null, the documents table goes on showing age, and the breach
   * figures stay hidden rather than reading zero. A deadline is a commitment
   * an organisation makes; the product does not make one on its behalf.
   */
  sla: flag(import.meta.env.VITE_FEATURE_SLA, true),

  /**
   * Multi-select and the bulk action bar. The three actions the design puts
   * in that bar — Approve all, Reassign, Nudge holder — have no endpoints,
   * and "Approve all" cannot have one as the product stands: `approveDocument`
   * requires a signature placed on the rendered PDF, which is the whole point
   * of the product.
   *
   * Off by default, for the same reason as the saved views above. The actions
   * inside the bar are disabled, which is honest, but a row of controls that
   * can never be pressed is still something a person has to work out and
   * dismiss - and the first thing they ask is why the product is broken. Set
   * VITE_FEATURE_BULK_ACTIONS to review the design.
   */
  bulkActions: flag(import.meta.env.VITE_FEATURE_BULK_ACTIONS, false),

  /**
   * Out-of-office and delegated approvals. Shipped: `/api/delegations` stores
   * them, the approval service honours them while they are in force, and every
   * approval given under one records both names.
   */
  delegation: flag(import.meta.env.VITE_FEATURE_DELEGATION, true),

  /**
   * The QUEUE column on the people table — how many approvals each person is
   * currently holding, as a bar. It was off while the only way to count was
   * `fetchDocuments`, which returns what the SIGNED-IN user can see: counting
   * holders from it under-reports everybody else, and a load bar that reads
   * low because of a permission boundary is the kind of number a manager
   * reassigns work on. `listUsers` now counts it server-side, over every
   * document, for a screen only administrators can open.
   */
  approverLoad: flag(import.meta.env.VITE_FEATURE_APPROVER_LOAD, true),

  /**
   * The seal on the audit trail. Shipped: every audit record carries a digest
   * over its own contents and the one before it, `GET /api/audit/ledger` says
   * how far the seal has reached, and an administrator can have the whole
   * chain read back and recomputed.
   *
   * What it deliberately does NOT turn on is a per-row digest column on the
   * ledger table. Those rows are approval actions and file uploads; the chain
   * is over audit records, which are a different table with no per-action
   * link. A column headed "Digest" showing a dash on every row would assert a
   * per-row seal that does not exist.
   */
  ledgerIntegrity: flag(import.meta.env.VITE_FEATURE_LEDGER_INTEGRITY, true),

  /*
   * `stepSkip` was here, and is now `user.workflowPolicy.allowStepSkip` from
   * `GET /api/auth/me`.
   *
   * It was a build-time flag because the server's answer was a build-time
   * decision too - `ALLOW_STEP_SKIP` in the environment - so the two agreed by
   * being set together. That stopped being true when the setting became a row
   * an administrator changes from the Workflow policy screen: the switch
   * turned the endpoint on and the button stayed hidden, because nothing in a
   * compiled bundle can follow a database row.
   *
   * A flag that could still force it ON would be the same fault mirrored - a
   * button whose answer is 403. So there is no flag: the client asks.
   */

  /**
   * The topbar "Live" pill. Off even in development, deliberately: a pulsing
   * dot labelled "Live" asserts a push connection, and this app polls on
   * navigation. Turn it on when there is a real subscription behind it —
   * shipping the badge first would be a claim the product does not meet.
   */
  liveIndicator: flag(import.meta.env.VITE_FEATURE_LIVE, false),
} as const
