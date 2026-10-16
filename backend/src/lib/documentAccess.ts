import { Prisma, WorkflowRunStatus } from "../generated/prisma/client";
import { actingAs } from "./delegation";

/**
 * The ids whose steps count as this person's.
 *
 * `actingFor` is the people who have delegated their approvals to them, and it
 * is empty for almost every request. It never includes authorship: a delegate
 * covers somebody's approvals, not their drafts, so a document is still only
 * visible to the person who prepared it and to the chain.
 */
type ActingFor = { actingFor?: readonly string[] };

type ChainWithSteps =
  | {
      steps: { assignedUserId: string; stepOrder: number }[];
    }
  | null
  | undefined;

type WorkflowRunWithChain =
  | {
      status: WorkflowRunStatus;
      currentStepOrder: number;
      chain: ChainWithSteps;
    }
  | null
  | undefined;

type WorkflowRunProgress = {
  currentStepOrder: number;
  actions?: { id: string }[];
};

export function prismaDocumentAccessFilter(
  userId: string,
  actingFor: readonly string[] = [],
  isAdministrator = false
): Prisma.DocumentWhereInput {
  /*
   * An administrator reads every memo. The empty filter is the whole of it:
   * this goes inside an `AND`, where it narrows nothing.
   *
   * See `Viewer.isAdministrator` for why this rule exists. In short: everyone
   * else sees a memo because they wrote it or because the workflow reached
   * them, and an approved memo has left the oversight screen, so without this
   * the person answerable for the process is the only one who cannot look at
   * a finished one.
   */
  if (isAdministrator) {
    /*
     * Everything except somebody else's draft.
     *
     * `memos.view.own` promises a draft is seen by nobody else, and an
     * administrator reading every submitted memo does not need that promise
     * broken to do it. A draft is not yet a record of anything.
     */
    return {
      OR: [{ preparerId: userId }, { status: { not: "DRAFT" } }],
    };
  }

  return {
    OR: [
      { preparerId: userId },
      {
        approvalChain: {
          steps: {
            some: { assignedUserId: { in: actingAs(userId, actingFor) } },
          },
        },
      },
    ],
  };
}

export function isUserInApprovalChain(
  chain: ChainWithSteps,
  userId: string,
  actingFor: readonly string[] = []
): boolean {
  const ids = actingAs(userId, actingFor);

  return chain?.steps.some((step) => ids.includes(step.assignedUserId)) ?? false;
}

export function hasWorkflowReachedUser(params: {
  userId: string;
  approvalChain?: ChainWithSteps;
  currentWorkflowRun?: WorkflowRunWithChain | null;
  workflowRunHistory?: WorkflowRunProgress[];
  hasUserActed?: boolean;
} & ActingFor): boolean {
  const {
    userId,
    actingFor = [],
    approvalChain,
    currentWorkflowRun,
    workflowRunHistory,
    hasUserActed,
  } = params;

  if (hasUserActed) {
    return true;
  }

  const ids = actingAs(userId, actingFor);
  const chain = approvalChain ?? currentWorkflowRun?.chain;

  // The earliest step that is theirs to act on, explicitly - somebody can sit
  // on a chain twice, and covering for two people puts two steps in reach.
  // Whichever comes first is the one that decides when they can see it.
  const userStep = chain?.steps
    .filter((step) => ids.includes(step.assignedUserId))
    .reduce<{ stepOrder: number } | undefined>(
      (earliest, step) =>
        !earliest || step.stepOrder < earliest.stepOrder ? step : earliest,
      undefined
    );

  if (!userStep) {
    return false;
  }

  const runs =
    workflowRunHistory ??
    (currentWorkflowRun ? [{ currentStepOrder: currentWorkflowRun.currentStepOrder }] : []);

  if (runs.length === 0) {
    return false;
  }

  const maxReachedStep = runs.reduce(
    (max, run) => Math.max(max, run.currentStepOrder),
    0
  );

  return userStep.stepOrder <= maxReachedStep;
}

export function canUserViewDocument(params: {
  preparerId: string;
  userId: string;
  approvalChain?: ChainWithSteps;
  currentWorkflowRun?: WorkflowRunWithChain | null;
  workflowRunHistory?: WorkflowRunProgress[];
  hasUserActed?: boolean;
  /** Reading only; it confers nothing else. See `Viewer.isAdministrator`. */
  isAdministrator?: boolean;
  /**
   * The document's own status, which only the administrator rule reads.
   *
   * Absent means the caller did not select it, and an administrator is then
   * allowed through: this is a read the participant rule would have refused,
   * and every caller that can reach a draft does pass it.
   */
  status?: string | null;
} & ActingFor): boolean {
  if (params.isAdministrator) {
    // Somebody else's draft stays theirs. See the filter above.
    return params.preparerId === params.userId || params.status !== "DRAFT";
  }

  if (params.preparerId === params.userId) {
    return true;
  }

  const chain = params.approvalChain ?? params.currentWorkflowRun?.chain;
  if (!isUserInApprovalChain(chain, params.userId, params.actingFor)) {
    return false;
  }

  return hasWorkflowReachedUser({
    userId: params.userId,
    actingFor: params.actingFor,
    approvalChain: params.approvalChain,
    currentWorkflowRun: params.currentWorkflowRun,
    workflowRunHistory: params.workflowRunHistory,
    hasUserActed: params.hasUserActed,
  });
}

/**
 * Is this memo sitting at a step that is this person's to act on now - their
 * own, or one they are covering?
 *
 * One rule for the badge and the queue. They used to be decided in two
 * places, and the browser's copy knew nothing of delegations, so a delegate's
 * badge counted a memo their queue did not show. Never the preparer's own
 * memo, whatever delegation they hold.
 */
export function isAwaitingActionBy(
  document: {
    status: string;
    preparerId: string;
    currentWorkflowRun: WorkflowRunWithChain;
  },
  userId: string,
  actingFor: readonly string[]
): boolean {
  const run = document.currentWorkflowRun;
  if (
    document.status !== "PENDING_REVIEW" ||
    document.preparerId === userId ||
    run?.status !== "IN_PROGRESS" ||
    !run.chain
  ) {
    return false;
  }

  const holders = actingAs(userId, actingFor);
  return run.chain.steps.some(
    (step) =>
      step.stepOrder === run.currentStepOrder &&
      holders.includes(step.assignedUserId)
  );
}

export function documentHasUserActed(
  workflowRuns: WorkflowRunProgress[] | undefined
): boolean {
  return (
    workflowRuns?.some((run) => (run.actions?.length ?? 0) > 0) ?? false
  );
}
