/**
 * The two workflow policies, held where a synchronous caller can read them.
 *
 * `slaDaysFor` is called on every document list and every queue row, and
 * `stepSkipAllowed` before a state change. Neither can afford a database read,
 * and neither can be frozen at import either - an administrator changes a
 * policy and it has to take effect without a restart.
 *
 * So the same arrangement mail uses: the row is pushed in here at boot and
 * after every save, and the pure functions in `sla.ts` and `env.ts` read it
 * from this module variable. This file deliberately imports nothing - `env.ts`
 * imports it, so anything it imported back would be a cycle.
 */

export type WorkflowPolicy = {
  /**
   * Working days before an approver is chased, for steps naming no deadline.
   *
   * `null` is a real answer, not a missing one: an organisation that has set
   * no deadline has not missed one, so nothing is chased and no due date is
   * invented on a queue.
   */
  slaDefaultDays: number | null;
  /** May a preparer pass over an approver who has not acted yet? */
  allowStepSkip: boolean;
  /**
   * Does submitting a document also mean signing it?
   *
   * The answer for a document with no memo type - which is every uploaded
   * one - and the fallback for a memo type that expresses no preference.
   */
  preparerSignsOnSubmit: boolean;
  /**
   * Does the final approval seal the approved PDF?
   *
   * Only meaningful where a seal certificate is configured; without one,
   * nothing is sealed whatever this says.
   */
  sealApprovedMemos: boolean;
};

let stored: WorkflowPolicy | null = null;

/**
 * Put the stored policy in front of the environment, or take it away again.
 *
 * `null` means there is no row, and the environment answers - which is what
 * a deployment that has always managed these as variables keeps getting.
 */
export function useStoredWorkflowPolicy(policy: WorkflowPolicy | null): void {
  stored = policy;
}

/**
 * What was stored, if anything.
 *
 * A row wins over the environment *entirely*, including when its deadline is
 * null. An administrator who clears the deadline has said "no deadline", and
 * an `SLA_DEFAULT_DAYS` left behind in a file from last year must not quietly
 * undo them. Handing the policy back to the environment is a separate,
 * audited act: it deletes the row.
 */
export function storedWorkflowPolicy(): WorkflowPolicy | null {
  return stored;
}
