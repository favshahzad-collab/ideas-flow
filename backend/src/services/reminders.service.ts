import { prisma } from "../prisma";
import { errors } from "../lib/errors";
import { ACCESS_SELECT, capabilitiesOf } from "../lib/capabilities";
import { auditService } from "./audit.service";
import { delegationsService } from "./delegations.service";
import { notificationsService } from "./notifications.service";

/**
 * Asking the person holding a memo to look at it.
 *
 * The only thing that chased a memo before this was the deadline sweep, and it
 * chases exactly one case: a step that has run past the working days it was
 * given. This deployment has no `SLA_DEFAULT_DAYS` and no step-level deadlines,
 * so nothing was ever chased and a memo could sit for a week with nobody told
 * anything at all. What the preparer had instead was walking down the corridor.
 *
 * Three rules make this a reminder rather than a way to pester somebody:
 *
 * - only the person waiting may send it - the preparer, or an administrator
 *   watching the whole organisation from the control room;
 * - one per memo per COOLDOWN_HOURS, counted by the server from its own audit
 *   trail rather than trusted to a client not to ask twice;
 * - it goes to whoever can actually act, which is the assigned approver and,
 *   while a delegation is in force, the colleague covering for them.
 *
 * It says only that somebody is waiting. It must never read as "overdue":
 * overdue is a statement about a deadline that has passed, and a memo with no
 * deadline on it cannot be late.
 */

/** How long before the same memo may be chased again. */
export const COOLDOWN_HOURS = 12;

const COOLDOWN_MS = COOLDOWN_HOURS * 60 * 60 * 1000;

function nameOf(person: { firstName: string; lastName: string }): string {
  return `${person.firstName} ${person.lastName}`.trim();
}

/** "in 3 hours", "in 40 minutes" — what somebody actually wants to be told. */
function waitOf(readyAt: Date, now: Date): string {
  const minutes = Math.max(1, Math.ceil((readyAt.getTime() - now.getTime()) / 60000));

  if (minutes < 60) {
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }

  const hours = Math.ceil(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export const remindersService = {
  /**
   * Send one reminder about `documentId`, or explain why not.
   *
   * Everything it needs is read inside one transaction with the write, so two
   * people pressing the button at the same moment cannot both pass the
   * cooldown check and send two notices about the same memo.
   */
  async remind(
    documentId: string,
    actorId: string,
    ipAddress?: string,
    now: Date = new Date()
  ) {
    const [document, actor] = await Promise.all([
      prisma.document.findUnique({
        where: { id: documentId },
        select: {
          id: true,
          title: true,
          referenceNumber: true,
          status: true,
          preparerId: true,
          memoType: true,
          currentWorkflowRun: {
            select: { id: true, status: true, chainId: true, currentStepOrder: true },
          },
        },
      }),
      prisma.user.findUnique({
        where: { id: actorId },
        select: { id: true, firstName: true, lastName: true, ...ACCESS_SELECT },
      }),
    ]);

    if (!document) throw errors.notFound("Document not found.");
    if (!actor) throw errors.unauthorized("Sign in again.");

    /*
     * Whoever is waiting for it: the person who prepared it, or somebody
     * holding `approvals.oversee` - which is the control room, the screen
     * where an administrator can see a memo that has stopped moving and has
     * until now had nothing to do about it.
     *
     * Deliberately not "anybody who can see the memo". Every later approver
     * on the chain can see it, and a reminder from somebody with no stake in
     * it is the thing that turns a useful notice into noise.
     */
    const oversees = capabilitiesOf(actor).includes("approvals.oversee");

    if (actor.id !== document.preparerId && !oversees) {
      throw errors.forbidden(
        "Only the person who prepared this memo, or an administrator, can send a reminder about it."
      );
    }

    const run = document.currentWorkflowRun;

    if (document.status !== "PENDING_REVIEW" || !run || run.status !== "IN_PROGRESS") {
      throw errors.badRequest(
        "This memo is not waiting on anybody, so there is nobody to remind."
      );
    }

    const currentStep = await prisma.approvalChainStep.findUnique({
      where: {
        chainId_stepOrder: { chainId: run.chainId, stepOrder: run.currentStepOrder },
      },
      select: {
        id: true,
        stepOrder: true,
        assignedUserId: true,
        assignedUser: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    if (!currentStep) throw errors.internal("Current workflow step not found.");

    if (currentStep.assignedUserId === actorId) {
      throw errors.badRequest("This memo is waiting on you, so there is nobody to remind.");
    }

    /*
     * The delegate as well, when one is covering: they are the person who can
     * actually sign it right now. Both are told, because the approver whose
     * step it is has not stopped being responsible for it - being covered is
     * a diary entry, not a transfer.
     */
    const delegation = await delegationsService.activeDelegationFor(
      currentStep.assignedUserId,
      now,
      document.memoType
    );

    const holder = currentStep.assignedUser;
    const reference = document.referenceNumber ?? document.title;
    const from = nameOf(actor);

    const sent = await prisma.$transaction(async (tx) => {
      /*
       * The cooldown, read and written inside the transaction. Outside it,
       * two people pressing the button in the same second both read "no
       * reminder yet" and both send one.
       */
      const last = await tx.auditLog.findFirst({
        where: {
          action: "APPROVAL_REMINDER_SENT",
          entityType: "Document",
          entityId: document.id,
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });

      if (last && now.getTime() - last.createdAt.getTime() < COOLDOWN_MS) {
        const readyAt = new Date(last.createdAt.getTime() + COOLDOWN_MS);

        throw errors.badRequest(
          `${holder.firstName} was reminded about this memo less than ${COOLDOWN_HOURS} hours ago. You can send another in ${waitOf(readyAt, now)}.`
        );
      }

      const recipients = [
        {
          recipientId: currentStep.assignedUserId,
          type: "APPROVAL_REMINDER" as const,
          title: `Reminder: ${document.title}`,
          message: `${from} is waiting on ${reference}. It is at your step and cannot move until you act on it.`,
          documentId: document.id,
          workflowRunId: run.id,
        },
      ];

      if (delegation && delegation.delegateId !== actorId) {
        recipients.push({
          recipientId: delegation.delegateId,
          type: "APPROVAL_REMINDER" as const,
          title: `Reminder: ${document.title}`,
          message: `${from} is waiting on ${reference}. It is at ${holder.firstName}'s step, and you are covering for them.`,
          documentId: document.id,
          workflowRunId: run.id,
        });
      }

      await notificationsService.createNotifications(recipients, tx);

      await auditService.createAuditLog({
        actorId,
        action: "APPROVAL_REMINDER_SENT",
        entityType: "Document",
        entityId: document.id,
        newValue: {
          runId: run.id,
          stepOrder: currentStep.stepOrder,
          assignedUserId: currentStep.assignedUserId,
          alsoTold: delegation?.delegateId ?? null,
          /*
           * The capacity it was sent in, written down rather than worked out
           * later. Either the preparer chased their own memo or the control
           * room did, and the two are different facts about how a memo came
           * to move - the row is the only place that difference survives,
           * because the actor's own role can change afterwards.
           */
          actedAs: actor.id === document.preparerId ? "Preparer" : "Administrator",
        },
        ipAddress,
        tx,
      });

      return recipients.length;
    });

    return {
      message:
        sent > 1
          ? `${nameOf(holder)} and the colleague covering for them have been reminded.`
          : `${nameOf(holder)} has been reminded.`,
      remindedUserId: currentStep.assignedUserId,
      recipients: sent,
    };
  },
};
