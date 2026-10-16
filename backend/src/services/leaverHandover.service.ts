import { prisma } from "../prisma";
import { errors } from "../lib/errors";
import { isCancelledByAdministrator } from "../lib/cancellation";
import { auditService } from "./audit.service";
import { approvalService } from "./approval.service";
import { delegationsService } from "./delegations.service";

/**
 * Handing a leaver's approval work to the person who takes it over.
 *
 * Agreed after the fit-gap review: somebody leaving must not leave memos
 * blocked until an administrator happens to notice. Switching an account off
 * now names a successor whenever the person still has work, and in the same
 * act every step of theirs moves to that successor:
 *
 * - on memos in progress, the step the memo is sitting on and every step
 *   still ahead of it - through the same reassignment an administrator makes
 *   by hand, so it is checked, notified and recorded exactly the same way;
 * - on memos back with their preparer (returned for revision, rejected, or
 *   withdrawn), the step on the chain the memo will travel again, so the next
 *   cycle goes to the successor rather than to an account nobody signs in to.
 *
 * Steps already decided keep their record: the actions name whoever really
 * acted, and the chain card reads names from those actions for decided steps.
 *
 * Their delegations end too, both ways. Cover given to a leaver would leave
 * the person covered without anyone; cover a leaver gave would let somebody
 * go on signing in the name of a person who has gone.
 *
 * Absence is not handled here: a delegation with dates already hands a
 * person's approvals to their cover for exactly that period.
 */

type HeldStep = {
  stepId: string;
  stepOrder: number;
  chainId: string;
  documentId: string;
  reference: string;
  preparerId: string;
};

export type OpenWork = {
  /** Steps on memos in progress: the one it is on, and those ahead. */
  inFlight: HeldStep[];
  /** Steps on memos back with their preparer, for the next cycle. */
  nextCycle: HeldStep[];
  /** Delegations not yet ended in which they are either party. */
  delegationIds: string[];
};

const fullName = (user: { firstName: string; lastName: string }) =>
  `${user.firstName} ${user.lastName}`.trim();

class LeaverHandoverService {
  /** Everything of this person's that would stop if their account went. */
  async openWork(userId: string, now: Date = new Date()): Promise<OpenWork> {
    const steps = await prisma.approvalChainStep.findMany({
      where: {
        assignedUserId: userId,
        chain: {
          document: {
            OR: [
              { status: "PENDING_REVIEW" },
              { status: { in: ["REVISION_REQUESTED", "REJECTED"] } },
              // Withdrawn but never approved: it can be sent round again (unless an
              // administrator cancelled it, which is skipped below).
              { status: "DELETED", approvedAt: null },
            ],
          },
        },
      },
      select: {
        id: true,
        stepOrder: true,
        chainId: true,
        chain: {
          select: {
            document: {
              select: {
                id: true,
                status: true,
                referenceNumber: true,
                title: true,
                preparerId: true,
                withdrawnById: true,
                rejectionClosedAt: true,
                currentWorkflowRun: {
                  select: { status: true, currentStepOrder: true },
                },
              },
            },
          },
        },
      },
    });

    const inFlight: HeldStep[] = [];
    const nextCycle: HeldStep[] = [];

    for (const step of steps) {
      const document = step.chain.document;
      const held: HeldStep = {
        stepId: step.id,
        stepOrder: step.stepOrder,
        chainId: step.chainId,
        documentId: document.id,
        reference: document.referenceNumber ?? document.title,
        preparerId: document.preparerId,
      };
      const run = document.currentWorkflowRun;

      // Cancelled by an administrator: final, so there is no next cycle to
      // hand over.
      if (document.status === "DELETED" && isCancelledByAdministrator(document)) continue;
      // Left as rejected by its preparer: closed too.
      if (document.rejectionClosedAt !== null) continue;

      if (document.status === "PENDING_REVIEW" && run?.status === "IN_PROGRESS") {
        // A step behind the memo is decided; it is history, not work.
        if (step.stepOrder >= run.currentStepOrder) inFlight.push(held);
      } else if (document.status !== "PENDING_REVIEW") {
        nextCycle.push(held);
      }
    }

    const delegations = await prisma.delegation.findMany({
      where: {
        revokedAt: null,
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
        AND: [{ OR: [{ delegatorId: userId }, { delegateId: userId }] }],
      },
      select: { id: true },
    });

    return { inFlight, nextCycle, delegationIds: delegations.map((d) => d.id) };
  }

  /**
   * Check a successor against every memo the work is on, before anything
   * moves. One refusal names every memo it would break, so the administrator
   * picks somebody else once rather than finding them one at a time.
   */
  async assertSuccessor(
    leaverId: string,
    successorId: string,
    actorId: string,
    work: OpenWork
  ) {
    if (successorId === leaverId) {
      throw errors.badRequest("Choose somebody other than the person who is leaving.");
    }

    // The same rule as moving a step by hand: unblocking a memo is never how
    // an administrator comes to sign it.
    if (successorId === actorId) {
      throw errors.badRequest(
        "You cannot take over their approvals yourself. Choose the person who should approve in their place."
      );
    }

    const successor = await prisma.user.findUnique({
      where: { id: successorId },
      select: { id: true, firstName: true, lastName: true, deactivatedAt: true },
    });

    if (!successor) {
      throw errors.badRequest("That person does not have an account here.");
    }

    if (successor.deactivatedAt) {
      throw errors.badRequest(
        `${successor.firstName}'s account has been switched off, so they cannot take over these approvals. Choose somebody else.`
      );
    }

    const all = [...work.inFlight, ...work.nextCycle];
    const chainIds = [...new Set(all.map((step) => step.chainId))];
    const alreadyOn = new Set(
      (
        await prisma.approvalChainStep.findMany({
          where: { chainId: { in: chainIds }, assignedUserId: successorId },
          select: { chainId: true },
        })
      ).map((row) => row.chainId)
    );

    const clashes = all
      .filter((step) => step.preparerId === successorId || alreadyOn.has(step.chainId))
      .map((step) => step.reference);

    if (clashes.length > 0) {
      throw errors.badRequest(
        `${fullName(successor)} prepared or is already an approver on ${clashes.length === 1 ? "this memo" : "these memos"}, so they cannot also take this step: ${[...new Set(clashes)].join(", ")}. Choose somebody else, or move ${clashes.length === 1 ? "that step" : "those steps"} by hand first.`
      );
    }

    return successor;
  }

  /** Move the work and end the delegations. Called before the account goes off. */
  async handOver(
    leaver: { id: string; firstName: string; lastName: string },
    successor: { id: string; firstName: string; lastName: string },
    actorId: string,
    work: OpenWork,
    ipAddress?: string
  ) {
    const reason = `${fullName(leaver)} has left. Their approvals were handed to ${fullName(successor)} when their account was switched off.`;

    for (const step of work.inFlight) {
      await approvalService.reassignStep(
        step.documentId,
        actorId,
        { userId: successor.id, stepOrder: step.stepOrder, reason },
        ipAddress
      );
    }

    if (work.nextCycle.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const step of work.nextCycle) {
          await tx.approvalChainStep.update({
            where: { id: step.stepId },
            data: { assignedUserId: successor.id },
          });

          await auditService.createAuditLog({
            actorId,
            action: "WORKFLOW_STEP_REASSIGNED",
            entityType: "Document",
            entityId: step.documentId,
            oldValue: { stepOrder: step.stepOrder, assignedUserId: leaver.id },
            newValue: {
              stepOrder: step.stepOrder,
              assignedUserId: successor.id,
              reason,
              wasWaitingOnIt: false,
              // The memo is back with its preparer; this is who it goes to
              // when it is sent round again.
              forNextCycle: true,
            },
            ipAddress,
            tx,
          });
        }
      });
    }

    await this.endDelegations(work.delegationIds, actorId, ipAddress);

    return {
      stepsMoved: work.inFlight.length + work.nextCycle.length,
      delegationsEnded: work.delegationIds.length,
    };
  }

  /** End cover given to or by the leaver; both parties are told, as usual. */
  async endDelegations(delegationIds: string[], actorId: string, ipAddress?: string) {
    for (const delegationId of delegationIds) {
      await delegationsService.revoke(
        delegationId,
        { id: actorId, isAdministrator: true },
        ipAddress
      );
    }
  }
}

export const leaverHandoverService = new LeaverHandoverService();
