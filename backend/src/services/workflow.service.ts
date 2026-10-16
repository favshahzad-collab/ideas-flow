import { prisma } from "../prisma";
import { errors } from "../lib/errors";
import { canUserViewDocument, documentHasUserActed } from "../lib/documentAccess";
import { delegationsService } from "./delegations.service";
import { viewerFor } from "./viewer.service";
import { policyOf } from "../lib/runPolicy";

class WorkflowService {
  async getWorkflow(documentId: string, userId: string) {
    const document = await prisma.document.findUnique({
      where: {
        id: documentId,
      },
      include: {
        currentWorkflowRun: {
          include: {
            actions: {
              include: {
                actor: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                  },
                },
                onBehalfOf: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                  },
                },
              },
            },
          },
        },
        approvalChain: {
          include: {
            steps: {
              include: {
                assignedUser: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                  },
                },
              },
              orderBy: {
                stepOrder: "asc",
              },
            },
          },
        },
        workflowRuns: {
          select: {
            currentStepOrder: true,
            actions: {
              where: { actorId: userId },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    });

    if (!document) {
      throw errors.notFound("Document not found.");
    }

    if (
      !canUserViewDocument({
        preparerId: document.preparerId,
        status: document.status,
        // Somebody covering an approver has to be able to see where the memo
        // has got to, or they are asked to sign a document they cannot open.
        // An administrator can see it because they can see all of them.
        ...(await viewerFor(userId)),
        approvalChain: document.approvalChain,
        currentWorkflowRun: document.currentWorkflowRun
          ? {
              status: document.currentWorkflowRun.status,
              currentStepOrder: document.currentWorkflowRun.currentStepOrder,
              chain: document.approvalChain,
            }
          : null,
        workflowRunHistory: document.workflowRuns,
        hasUserActed: documentHasUserActed(document.workflowRuns),
      })
    ) {
      throw errors.forbidden("Access denied.");
    }

    if (
      document.status === "REVISION_REQUESTED" ||
      document.status === "DELETED"
    ) {
      const workflow = document.approvalChain?.steps.map((step) => ({
        stepOrder: step.stepOrder,
        approvalType: step.approvalType,
        assignedUser: step.assignedUser,
        status: "WAITING",
        actedAt: null,
        comment: null,
      }));

      return {
        documentId: document.id,
        documentStatus: document.status,
        workflowStatus: null,
        currentStepOrder: null,
        workflow,
        // Nobody approves a memo that is back with its preparer. Said in the
        // same shape as every other answer so a caller never has to check
        // whether the field is there before reading it.
        viewer: { canAct: false, onBehalfOf: null },
      };
    }

    const actions = document.currentWorkflowRun?.actions ?? [];
    const isFullyApproved =
      document.status === "APPROVED" ||
      document.currentWorkflowRun?.status === "APPROVED";
    const isRejected =
      document.status === "REJECTED" ||
      document.currentWorkflowRun?.status === "REJECTED";

    const workflow = document.approvalChain?.steps.map((step) => {
      const action = actions.find((a) => a.chainStepId === step.id);

      let status: string;
      if (action) {
        status = action.action;
      } else if (isFullyApproved) {
        // Final approval completed the run; treat every chain step as done
        // even if an older action record is missing for display purposes.
        status = "APPROVE";
      } else if (
        document.currentWorkflowRun?.status === "IN_PROGRESS" &&
        step.stepOrder === document.currentWorkflowRun.currentStepOrder
      ) {
        status = "PENDING";
      } else if (
        isRejected &&
        document.currentWorkflowRun &&
        step.stepOrder < document.currentWorkflowRun.currentStepOrder
      ) {
        status = "APPROVE";
      } else {
        status = "WAITING";
      }

      return {
        stepOrder: step.stepOrder,
        approvalType: step.approvalType,
        /*
         * Whose step it was when it was decided, read from the action rather
         * than the chain. A leaver's steps are handed to a successor, and on
         * a memo back with its preparer that includes steps decided in the
         * cycle that ended - which would otherwise show the successor's name
         * against a decision the leaver made.
         */
        assignedUser: action ? (action.onBehalfOf ?? action.actor) : step.assignedUser,
        status,
        actedAt: action?.createdAt ?? null,
        comment: action?.comment ?? null,
      };
    });

    /*
     * Whether the person reading this may act on the step it is sitting at,
     * and whose step it is if it is not their own.
     *
     * Additive, and answered here because the answer lives here. The client
     * was deciding for itself, by looking for its own id on a pending step -
     * which is the rule for everybody except the one group the rule exists
     * for. A delegate covering somebody's approvals never matches it, so the
     * memo they had been emailed about offered them nothing to press: the
     * server would have accepted their approval, and the screen never asked
     * for it. `authorityOver` is the same check `approve` itself makes, so
     * what is offered and what is honoured cannot drift apart.
     */
    const pending =
      document.currentWorkflowRun?.status === "IN_PROGRESS" &&
      document.status === "PENDING_REVIEW"
        ? document.approvalChain?.steps.find(
            (step) =>
              step.stepOrder === document.currentWorkflowRun?.currentStepOrder
          )
        : undefined;

    // A preparer never approves their own memo, whatever else they hold.
    const authority =
      pending && document.preparerId !== userId
        ? await delegationsService.authorityOver(
            pending.assignedUserId,
            userId,
            new Date(),
            document.memoType
          )
        : { allowed: false, onBehalfOfId: null };

    const onBehalfOf =
      authority.onBehalfOfId && pending
        ? {
            id: pending.assignedUser.id,
            firstName: pending.assignedUser.firstName,
            lastName: pending.assignedUser.lastName,
          }
        : null;

    return {
      documentId: document.id,
      documentStatus: document.status,
      workflowStatus: document.currentWorkflowRun?.status ?? null,
      currentStepOrder: isFullyApproved
        ? (document.approvalChain?.steps.length ??
          document.currentWorkflowRun?.currentStepOrder ??
          null)
        : (document.currentWorkflowRun?.currentStepOrder ?? null),
      workflow,
      /**
       * The rules this memo's approval cycle runs under, which are the ones
       * it started with rather than whatever the policy screen says today.
       * The memo screen asks here before offering Skip.
       */
      policy: document.currentWorkflowRun
        ? { allowStepSkip: policyOf(document.currentWorkflowRun).allowStepSkip }
        : null,
      viewer: {
        /** May this person act on the step the memo is sitting at. */
        canAct: authority.allowed,
        /** Whose step it is, when it is not their own. Null otherwise. */
        onBehalfOf,
      },
    };
  }
}

export const workflowService = new WorkflowService();