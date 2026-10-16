import { sealApprovedMemos, stepSkipAllowed } from "./env";
import { defaultSlaDays } from "./sla";

/**
 * The workflow policy an approval cycle runs under.
 *
 * A memo keeps the rules it started with. Changing the default deadline,
 * allowing a step to be skipped, or switching the seal off midway would
 * otherwise reach every memo already in flight: a deadline change could make
 * dozens of them overdue in one save, and two memos approved a day apart
 * could be sealed and unsealed for no reason anyone recorded on them. So the
 * policy in force is written onto the run when the cycle starts - submission,
 * and every resubmission, which starts a new cycle - and read back from there.
 *
 * An administrator can still move cycles in flight onto a new policy, but as
 * a deliberate, recorded act (`workflowSettingsService.save` with
 * `applyToInProgress`), not as a side effect of saving.
 *
 * A run started before this existed has no snapshot (`policyFrozenAt` null)
 * and follows the current policy, as it always did.
 */
export type RunPolicy = {
  /** Working days for a step that names no deadline; null is "no deadline". */
  slaDefaultDays: number | null;
  allowStepSkip: boolean;
  sealApprovedMemos: boolean;
};

/** The columns a run carries its snapshot in. */
export type RunPolicyColumns = {
  policyFrozenAt: Date | null;
  policySlaDefaultDays: number | null;
  policyAllowStepSkip: boolean | null;
  policySealApprovedMemos: boolean | null;
};

/** The policy as it stands right now. */
export function currentPolicy(): RunPolicy {
  return {
    slaDefaultDays: defaultSlaDays(),
    allowStepSkip: stepSkipAllowed(),
    sealApprovedMemos: sealApprovedMemos(),
  };
}

/** What to write onto a run as its cycle starts. */
export function policySnapshot(at: Date = new Date()): RunPolicyColumns {
  const policy = currentPolicy();
  return {
    policyFrozenAt: at,
    policySlaDefaultDays: policy.slaDefaultDays,
    policyAllowStepSkip: policy.allowStepSkip,
    policySealApprovedMemos: policy.sealApprovedMemos,
  };
}

/** The policy a run is under: its own snapshot, or the current one if it has none. */
export function policyOf(run: RunPolicyColumns): RunPolicy {
  if (!run.policyFrozenAt) return currentPolicy();

  const now = currentPolicy();
  return {
    slaDefaultDays: run.policySlaDefaultDays,
    // Never null on a frozen run; the fallback only keeps a hand-edited row
    // from throwing.
    allowStepSkip: run.policyAllowStepSkip ?? now.allowStepSkip,
    sealApprovedMemos: run.policySealApprovedMemos ?? now.sealApprovedMemos,
  };
}

/**
 * The default deadline to hand `dueAtFor` for a run: its own, or undefined
 * so the current default answers for a run with no snapshot.
 */
export function runDeadlineDefault(run: {
  policyFrozenAt: Date | null;
  policySlaDefaultDays: number | null;
}): number | null | undefined {
  return run.policyFrozenAt ? run.policySlaDefaultDays : undefined;
}
