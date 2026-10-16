import { ApprovalType } from "../generated/prisma/browser";

export type ChainStepShape = {
  userId: string;
  approvalType: ApprovalType;
};

/**
 * The structural rules every approval chain must satisfy, whatever produced
 * it. These used to live only inside the zod refinement for the inline
 * `approvalChain` field, which left template-compiled chains unchecked — and
 * a compiled chain without a FINAL_APPROVER can never complete, because the
 * run ends on the step's *type*, not its position.
 */
export function findApprovalChainIssues(steps: ChainStepShape[]): string[] {
  const issues: string[] = [];

  if (steps.length === 0) {
    issues.push("At least one approval step is required");
    return issues;
  }

  const finalApprovers = steps.filter(
    (step) => step.approvalType === ApprovalType.FINAL_APPROVER
  );
  if (finalApprovers.length !== 1) {
    issues.push("Exactly one Final Approver is required");
  }

  const ids = steps.map((step) => step.userId);
  if (new Set(ids).size !== ids.length) {
    issues.push("Duplicate users are not allowed in the approval chain");
  }

  const lastStep = steps[steps.length - 1];
  if (lastStep && lastStep.approvalType !== ApprovalType.FINAL_APPROVER) {
    issues.push("Final Approver must be the last step");
  }

  return issues;
}

/**
 * The preparer signs before the document enters the chain and is barred from
 * approving, rejecting or requesting revision on it. A step assigned to them
 * can therefore never be acted on, and since the final step cannot be
 * skipped, a self-assigned chain stalls the run for good.
 */
export function preparerIsInChain(
  steps: ChainStepShape[],
  preparerId: string
): boolean {
  return steps.some((step) => step.userId === preparerId);
}

export const PREPARER_IN_CHAIN_MESSAGE =
  "The document preparer cannot be an approver on their own document.";
