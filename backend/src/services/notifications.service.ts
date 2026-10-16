import { prisma } from "../prisma";
import { errors } from "../lib/errors";
import { delegationsService } from "./delegations.service";
import { emailService } from "./email.service";
import { actingForMemo } from "../lib/delegation";
import { NotificationType, Prisma } from "../generated/prisma/client";

export type NotificationData = {
  recipientId: string;
  type: NotificationType;
  title: string;
  message: string;
  /**
   * The subject-line verb, where the type alone would get it wrong. Carried
   * to the mail and nowhere else: the inbox row says it in `title`.
   */
  subjectVerb?: string;
  documentId?: string;
  /**
   * The memo this notice is about, for the mail, where the notice carries no
   * `documentId` to look one up from.
   *
   * There is one such notice and it is deliberate: the approver a step has
   * just been moved away from is off the chain, so a link would lead them to
   * "Access denied". Without these the subject line degraded to the bare verb
   * - a mail reading "Reassigned" and nothing else, in an inbox of forty
   * others, about a memo the reader now has to guess at.
   */
  documentTitle?: string | null;
  documentReference?: string | null;
  workflowRunId?: string;
};

type CreateNotificationInput = NotificationData & {
  tx?: Prisma.TransactionClient;
};

/** The notices that ask their reader to act on a memo, rather than tell them something. */
const APPROVAL_WORK: ReadonlySet<NotificationType> = new Set([
  "APPROVAL_NEEDED",
  "APPROVAL_REMINDER",
  "APPROVAL_OVERDUE",
]);

class NotificationsService {
  /**
   * One "your approval is needed" notice, addressed to everybody it concerns.
   *
   * Normally that is one person. Where the approver has handed their
   * approvals over, it is two: the person whose step it is still hears about
   * it - being away is a diary entry, not a lock, and they may well sign it
   * themselves - and the person covering hears about it too, told plainly
   * whose approval they are being asked for.
   *
   * Returns rows rather than writing them, so a caller inside a transaction
   * can commit the inbox with the state change that caused it.
   */
  async approvalNeeded(data: NotificationData): Promise<NotificationData[]> {
    return this.andTheirDelegate(data);
  }

  /**
   * The notice, plus the same notice to whoever is covering for the recipient.
   *
   * Named for what it does rather than for one caller, because it is not only
   * approval requests that a delegate needs. Anything that changes the state
   * of a memo sitting on somebody's desk applies to the person actually
   * holding it - and while a delegation is running, that is the delegate.
   *
   * Withdrawal is the case that proved it: the delegate was told a memo needed
   * them, the preparer withdrew it, and nothing told the delegate. They were
   * left with a row in "Needs you" for a document that no longer existed.
   */
  async andTheirDelegate(data: NotificationData): Promise<NotificationData[]> {
    // A cover limited to some kinds of memo hears only about those.
    const memo = data.documentId
      ? await prisma.document.findUnique({
          where: { id: data.documentId },
          select: { memoType: true },
        })
      : null;
    const delegation = await delegationsService.activeDelegationFor(
      data.recipientId,
      new Date(),
      memo ? memo.memoType : undefined
    );

    if (!delegation || delegation.delegateId === data.recipientId) {
      return [data];
    }

    const away = `${delegation.delegator.firstName} ${delegation.delegator.lastName}`.trim();

    return [
      data,
      {
        ...data,
        recipientId: delegation.delegateId,
        title: `${data.title} — for ${delegation.delegator.firstName}`,
        message: `${data.message} You are covering for ${away}.`,
      },
    ];
  }

  /**
   * The people and the memo a batch of notices is about, in two reads.
   *
   * Queued mail needs a name to open with and an address to go to, and the
   * memo's reference and title for the subject line. Fetching them per notice
   * would be four queries for a four-person notification inside the
   * transaction that is advancing a workflow.
   */
  private async addressesFor(
    notifications: NotificationData[],
    client: Prisma.TransactionClient | typeof prisma
  ) {
    const recipientIds = [
      ...new Set(notifications.map((notification) => notification.recipientId)),
    ];
    const documentIds = [
      ...new Set(
        notifications
          .map((notification) => notification.documentId)
          .filter((id): id is string => Boolean(id))
      ),
    ];

    const [people, documents] = await Promise.all([
      client.user.findMany({
        where: { id: { in: recipientIds } },
        select: { id: true, firstName: true, email: true },
      }),
      documentIds.length > 0
        ? client.document.findMany({
            where: { id: { in: documentIds } },
            select: { id: true, title: true, referenceNumber: true },
          })
        : Promise.resolve([]),
    ]);

    return {
      people: new Map(people.map((person) => [person.id, person])),
      documents: new Map(documents.map((document) => [document.id, document])),
    };
  }

  /**
   * Queue the mail for a set of notices.
   *
   * Written with the same client as the inbox rows, so a memo that reached
   * somebody's queue and a notice that never left the building cannot
   * disagree: either both are committed or neither is.
   *
   * A person with no address on file simply gets no mail - the inbox row is
   * the notice either way, and refusing to advance a workflow because
   * somebody's account has no email would be the wrong end of the stick.
   */
  private async queueMail(
    notifications: NotificationData[],
    client: Prisma.TransactionClient | typeof prisma
  ) {
    const { people, documents } = await this.addressesFor(notifications, client);

    for (const notification of notifications) {
      const person = people.get(notification.recipientId);

      if (!person?.email) continue;

      const document = notification.documentId
        ? documents.get(notification.documentId)
        : undefined;

      await emailService.enqueue(
        {
          recipientId: person.id,
          recipientEmail: person.email,
          recipientFirstName: person.firstName,
          type: notification.type,
          message: notification.message,
          subjectVerb: notification.subjectVerb ?? null,
          documentId: notification.documentId ?? null,
          // The lookup first, then what the caller named. The lookup is the
          // truth wherever there is a document to look up.
          documentTitle: document?.title ?? notification.documentTitle ?? null,
          documentReference:
            document?.referenceNumber ?? notification.documentReference ?? null,
        },
        client
      );
    }
  }

  async createNotification(input: CreateNotificationInput) {
    const client = input.tx ?? prisma;

    const notification = await client.notification.create({
      data: {
        recipientId: input.recipientId,
        type: input.type,
        title: input.title,
        message: input.message,
        documentId: input.documentId ?? null,
        workflowRunId: input.workflowRunId ?? null,
      },
    });

    await this.queueMail([input], client);

    return notification;
  }

  /**
   * Bulk insert for the workflow actions that notify several people at once.
   * Takes a transaction client so the inbox rows commit with the state change
   * they describe, rather than being dispatched afterwards where a failure is
   * invisible.
   */
  async createNotifications(
    notifications: NotificationData[],
    tx?: Prisma.TransactionClient
  ) {
    if (notifications.length === 0) {
      return;
    }

    const client = tx ?? prisma;

    await client.notification.createMany({
      data: notifications.map((notification) => ({
        recipientId: notification.recipientId,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        documentId: notification.documentId ?? null,
        workflowRunId: notification.workflowRunId ?? null,
      })),
    });

    await this.queueMail(notifications, client);
  }

  async getNotifications(userId: string, isRead?: boolean) {
    const notifications = await prisma.notification.findMany({
      where: {
        recipientId: userId,
        ...(isRead !== undefined && { isRead }),
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const stillWaiting = await this.stillWaitingOn(userId, notifications);

    return notifications.map((notification) => ({
      ...notification,
      needsAction: stillWaiting(notification),
    }));
  }

  /**
   * Whether a notice that asked its reader to do something still does.
   *
   * An approval notice was only ever created: nothing took it back when the
   * reader signed, rejected or returned the memo, when the step moved to
   * somebody else, or when the memo was deleted. So the inbox kept saying
   * "Needs you" about work that was finished - on 2026-09-28 every approval
   * notice in the live inbox pointed at a memo already approved or deleted.
   *
   * This is worked out when the inbox is read, from the memo as it stands,
   * rather than stored on the notice and cleared at each of the dozen places
   * a workflow moves. A stored flag would have to be right at every one of
   * those places and in every future one; the memo's own state already is.
   * It also covers what no workflow action touches - a delegation ending
   * takes the delegate's notices with it.
   *
   * - Approval work is still waiting while the memo is out for approval, on
   *   the same run the notice was sent for, and its current step is the
   *   reader's own or belongs to somebody the reader is covering for now.
   * - A revision request is still waiting while the memo sits returned and the
   *   reader is the one who prepared it.
   * - Anything else is news, and never needs action. A security alert is the
   *   exception the inbox keeps in "Needs you" itself; it is not about a memo.
   */
  private async stillWaitingOn(
    userId: string,
    notifications: { type: NotificationType; documentId: string | null }[],
  ): Promise<
    (notification: {
      type: NotificationType;
      documentId: string | null;
      workflowRunId: string | null;
    }) => boolean
  > {
    const documentIds = [
      ...new Set(
        notifications
          .filter(
            (notification) =>
              (APPROVAL_WORK.has(notification.type) ||
                notification.type === "REVISION_REQUESTED" ||
                notification.type === "REJECTED") &&
              notification.documentId !== null,
          )
          .map((notification) => notification.documentId as string),
      ),
    ];

    if (documentIds.length === 0) {
      return () => false;
    }

    const [documents, cover] = await Promise.all([
      prisma.document.findMany({
        where: { id: { in: documentIds } },
        select: {
          id: true,
          status: true,
          preparerId: true,
          rejectionClosedAt: true,
          memoType: true,
          currentWorkflowRunId: true,
          currentWorkflowRun: {
            select: {
              status: true,
              currentStepOrder: true,
              chain: { select: { steps: { select: { stepOrder: true, assignedUserId: true } } } },
            },
          },
        },
      }),
      delegationsService.coverHeldBy(userId),
    ]);

    const byId = new Map(documents.map((document) => [document.id, document]));

    return (notification) => {
      if (!notification.documentId) return false;
      const document = byId.get(notification.documentId);
      if (!document) return false;

      if (notification.type === "REVISION_REQUESTED") {
        return document.status === "REVISION_REQUESTED" && document.preparerId === userId;
      }

      /*
       * A rejection asks its preparer for a decision: resubmit it, or leave
       * it as rejected. Until they make one it is theirs to do, the way a
       * revision request is - it used to be news, and a memo nobody decided
       * about was simply forgotten. Only the preparer is asked, and only for
       * the rejection that ended the current cycle.
       */
      if (notification.type === "REJECTED") {
        return (
          document.status === "REJECTED" &&
          document.preparerId === userId &&
          document.rejectionClosedAt === null &&
          (!notification.workflowRunId ||
            notification.workflowRunId === document.currentWorkflowRunId)
        );
      }

      if (!APPROVAL_WORK.has(notification.type)) return false;

      const run = document.currentWorkflowRun;
      if (document.status !== "PENDING_REVIEW" || !run || run.status !== "IN_PROGRESS") {
        return false;
      }

      // Sent for a run the memo has since left - returned and resubmitted - so
      // any work on the new run has a notice of its own.
      if (notification.workflowRunId && notification.workflowRunId !== document.currentWorkflowRunId) {
        return false;
      }

      const holder = run.chain.steps.find((step) => step.stepOrder === run.currentStepOrder)
        ?.assignedUserId;

      // Their own step, or one they cover for - and a cover limited to some
      // kinds of memo only for those.
      return (
        holder !== undefined &&
        (holder === userId || actingForMemo(cover, document.memoType).includes(holder))
      );
    };
  }

  /**
   * How many the badge should show.
   *
   * The badge renders one number, and the unread list it used to count has no
   * upper bound - nothing removes a notification but the user deleting it. So
   * counting in the database is what stops every page load, and every inbox
   * action anywhere in the app, from downloading a whole inbox to draw a digit.
   */
  async getUnreadCount(userId: string) {
    const count = await prisma.notification.count({
      where: { recipientId: userId, isRead: false },
    });

    return { count };
  }

  async markAsRead(notificationId: string, userId: string) {
    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
    });

    if (!notification) {
      throw errors.notFound("Notification not found.");
    }

    if (notification.recipientId !== userId) {
      throw errors.forbidden("You cannot access this notification.");
    }

    if (notification.isRead) {
      return notification;
    }

    return prisma.notification.update({
      where: { id: notificationId },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });
  }

  /**
   * Mark everything still unread in the caller's inbox, in one statement.
   *
   * The button used to be one PATCH per unread row, which meant a failure
   * part-way through left some rows read and some not while the page rolled
   * the whole list back to unread - a disagreement between screen and server
   * that no further pressing of the button could clear. One statement either
   * happens or does not.
   *
   * `recipientId` is not a convenience here: the per-row route can compare an
   * owner after loading the row, and this one has nothing to compare, so the
   * where clause is the only thing keeping one person's button out of another
   * person's inbox.
   */
  async markAllAsRead(userId: string) {
    const result = await prisma.notification.updateMany({
      where: { recipientId: userId, isRead: false },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    return {
      message: "All notifications marked as read.",
      updatedCount: result.count,
    };
  }

  async deleteNotification(notificationId: string, userId: string) {
    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
    });

    if (!notification) {
      throw errors.notFound("Notification not found.");
    }

    if (notification.recipientId !== userId) {
      throw errors.forbidden("You cannot delete this notification.");
    }

    await prisma.notification.delete({
      where: { id: notificationId },
    });

    return { message: "Notification deleted successfully." };
  }

  async deleteAllNotifications(userId: string) {
    const result = await prisma.notification.deleteMany({
      where: { recipientId: userId },
    });

    return {
      message: "All notifications deleted successfully.",
      deletedCount: result.count,
    };
  }
}

export const notificationsService = new NotificationsService();
