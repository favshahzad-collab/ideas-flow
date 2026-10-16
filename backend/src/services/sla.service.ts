import { Prisma } from "../generated/prisma/client";
import { prisma } from "../prisma";
import { logger } from "../lib/logger";
import { dueAtFor, escalateAtFor, ESCALATE_AFTER_WORKING_DAYS, slaDaysFor } from "../lib/sla";
import { ACCESS_SELECT, capabilitiesOf } from "../lib/capabilities";
import { delegationsService } from "./delegations.service";
import { runDeadlineDefault } from "../lib/runPolicy";
import { auditService } from "./audit.service";
import { notificationsService } from "./notifications.service";

/**
 * Chasing a memo that has stopped moving.
 *
 * A deadline nobody is told about is a column, not a deadline. This is the
 * half that makes the SLA worth having: when a step runs past the days it was
 * given, the approver holding it and the person who prepared it are both told,
 * once, through the same inbox and outbox as every other notice.
 *
 * Once, and only once, is the whole design. `breachNotifiedAt` is set when the
 * chase goes out and cleared when the step advances, so each approver is
 * chased for their own step and never inherits the last one's. A sweep that
 * re-sent every fifteen minutes would be read as noise within a day and
 * filtered within a week, which is worse than not sending it.
 *
 * Nothing happens at all unless a deadline exists: with no `slaDays` on the
 * step and no `SLA_DEFAULT_DAYS` on the deployment, every query here comes
 * back empty.
 */

/** How many overdue steps one pass handles. */
const BATCH = 100;

/** How many steps in flight are read at a time while looking for them. */
const PAGE = 200;

/**
 * A ceiling on one pass: 200 pages of 200 is forty thousand memos in flight,
 * far beyond any organisation this serves, and the next pass goes on.
 */
const MAX_PAGES = 200;

/**
 * The coarse prefilter. The shortest deadline anyone can set is one working
 * day, so nothing younger than a day can be overdue - and the exact answer,
 * which counts working days and ends at the end of a day, is worked out in
 * `dueAtFor` rather than reimplemented in SQL where the two could drift.
 */
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

type OverdueRow = {
  runId: string;
  documentId: string;
  documentTitle: string;
  documentReference: string | null;
  /** The memo's type, null for an uploaded one: a scoped cover must cover it. */
  memoType: string | null;
  currentStepStartedAt: Date;
  slaDays: number | null;
  /** The cycle's own policy snapshot, for its default deadline. */
  policyFrozenAt: Date | null;
  policySlaDefaultDays: number | null;
  assignedUserId: string;
  assignedFirstName: string;
  preparerId: string;
  preparerFirstName: string;
};

/**
 * An overdue step together with the deadline it actually ran over.
 *
 * `days` rather than `slaDays` because the number the notice quotes is the
 * resolved one - the step's own deadline, or the deployment default standing
 * in for it. Carried on the row so the notice cannot be written without it:
 * it used to be re-derived at the point of writing and fall back to `0`,
 * which nothing could reach but which, the day something did, would have put
 * "longer than the 0 working days allowed" in mail to real people.
 */
type OverdueStep = OverdueRow & { days: number };

class SlaService {
  /**
   * Steps whose deadline has passed and whose holder has not been told.
   *
   * The join is to the *current* step specifically: a chain of four steps has
   * one deadline at a time, held by whoever the memo is with.
   */
  private async findOverdue(
    now: Date,
    limit = BATCH,
    pageSize = PAGE
  ): Promise<OverdueStep[]> {
    const oldest = new Date(now.getTime() - MIN_AGE_MS);
    const found: OverdueStep[] = [];

    /*
     * Paged, oldest first, until a batch of overdue steps is found or the
     * list runs out.
     *
     * One page used to be the whole search. Steps that are not due yet - a
     * long deadline, or no deadline at all - are never marked as chased, so
     * they stay at the front of the queue forever. A hundred of them filled
     * the only page, every sweep threw them all away, and a memo genuinely
     * overdue behind them was never chased. Whether a step is due is worked
     * out in `dueAtFor`, not in SQL, so the paging has to happen here.
     *
     * The cursor is (started at, run id): the id breaks ties, so no row is
     * read twice or skipped when two steps started in the same instant.
     */
    let after: { startedAt: Date; runId: string } | null = null;

    for (let page = 0; page < MAX_PAGES && found.length < limit; page++) {
      const cursor: Prisma.Sql = after
        ? Prisma.sql`AND (r.current_step_started_at, r.id) > (${after.startedAt}, ${after.runId}::uuid)`
        : Prisma.empty;

      const rows = await prisma.$queryRaw<OverdueRow[]>`
        SELECT
          r.id                     AS "runId",
          d.id                     AS "documentId",
          d.title                  AS "documentTitle",
          d.reference_number       AS "documentReference",
          d.memo_type              AS "memoType",
          r.current_step_started_at AS "currentStepStartedAt",
          s.sla_days               AS "slaDays",
          r.policy_frozen_at       AS "policyFrozenAt",
          r.policy_sla_default_days AS "policySlaDefaultDays",
          s.assigned_user_id       AS "assignedUserId",
          holder.first_name        AS "assignedFirstName",
          d.preparer_id            AS "preparerId",
          preparer.first_name      AS "preparerFirstName"
        FROM workflow_runs r
        JOIN documents d ON d.id = r.document_id
        JOIN approval_chain_steps s
          ON s.chain_id = r.chain_id AND s.step_order = r.current_step_order
        JOIN users holder ON holder.id = s.assigned_user_id
        JOIN users preparer ON preparer.id = d.preparer_id
        WHERE r.status = 'IN_PROGRESS'
          AND d.status = 'PENDING_REVIEW'
          AND r.breach_notified_at IS NULL
          AND r.current_step_started_at <= ${oldest}
          ${cursor}
        ORDER BY r.current_step_started_at ASC, r.id ASC
        LIMIT ${pageSize}`;

      for (const row of rows) {
        const runDefault = runDeadlineDefault(row);
        const dueAt = dueAtFor(row.currentStepStartedAt, row.slaDays, runDefault);
        const days = slaDaysFor(row.slaDays, runDefault);

        // Both, and not because either is redundant: `dueAt` decides whether
        // the deadline has passed, `days` is the number the notice quotes, and
        // a step with no deadline at all has neither.
        if (dueAt === null || days === null || dueAt.getTime() >= now.getTime()) {
          continue;
        }

        found.push({ ...row, days });
        if (found.length === limit) break;
      }

      if (rows.length < pageSize) break;
      const last = rows[rows.length - 1];
      after = { startedAt: last.currentStepStartedAt, runId: last.runId };
    }

    return found;
  }

  /**
   * Tell the holder, and tell the preparer.
   *
   * Both, because they need different things from it: the approver needs to
   * know it is with them, and the preparer - who is the one being asked why
   * the memo has not come back - needs to know where it stopped.
   */
  async chaseOverdue(
    now: Date = new Date(),
    /** Smaller pages, so a test can show the paging without a thousand memos. */
    options: { pageSize?: number } = {}
  ): Promise<{ chased: number }> {
    const overdue = await this.findOverdue(now, BATCH, options.pageSize);
    let chased = 0;

    for (const row of overdue) {
      const { days } = row;
      const reference = row.documentReference ?? "This memo";

      // Whoever is covering for the approver can act on it too, so they are
      // told as well - otherwise a memo held by somebody on leave is chased
      // into an inbox nobody is reading.
      const cover = await delegationsService.activeDelegationFor(
        row.assignedUserId,
        now,
        row.memoType
      );
      const delegateId =
        cover && cover.delegateId !== row.preparerId ? cover.delegateId : null;

      try {
        await prisma.$transaction(async (tx) => {
          // The claim and the notice in one transaction: a crash between them
          // would either chase nobody or chase somebody twice, and the second
          // is the one people remember.
          const claimed = await tx.workflowRun.updateMany({
            where: { id: row.runId, breachNotifiedAt: null },
            data: { breachNotifiedAt: now },
          });

          // Another process got there first.
          if (claimed.count === 0) return;

          await notificationsService.createNotifications(
            [
              {
                recipientId: row.assignedUserId,
                type: "APPROVAL_OVERDUE",
                title: `Overdue: ${row.documentTitle}`,
                message: `${reference} has been waiting for your approval longer than the ${days} working ${days === 1 ? "day" : "days"} allowed. It cannot move until you act on it.`,
                documentId: row.documentId,
                workflowRunId: row.runId,
              },
              {
                recipientId: row.preparerId,
                type: "APPROVAL_OVERDUE",
                title: `Overdue: ${row.documentTitle}`,
                message: `${reference} has been with ${row.assignedFirstName} longer than the ${days} working ${days === 1 ? "day" : "days"} allowed. They have been told.`,
                documentId: row.documentId,
                workflowRunId: row.runId,
              },
              ...(delegateId
                ? [
                    {
                      recipientId: delegateId,
                      type: "APPROVAL_OVERDUE" as const,
                      title: `Overdue: ${row.documentTitle}`,
                      message: `${reference} is waiting on ${row.assignedFirstName}, whom you are covering for, longer than the ${days} working ${days === 1 ? "day" : "days"} allowed. You can sign it in their place.`,
                      documentId: row.documentId,
                      workflowRunId: row.runId,
                    },
                  ]
                : []),
            ],
            tx
          );

          await auditService.createAuditLog({
            action: "WORKFLOW_STEP_OVERDUE",
            entityType: "Document",
            entityId: row.documentId,
            newValue: {
              runId: row.runId,
              assignedUserId: row.assignedUserId,
              slaDays: days,
              stepStartedAt: row.currentStepStartedAt.toISOString(),
            },
            tx,
          });

          chased += 1;
        });
      } catch (error) {
        // One memo failing to chase must not stop the rest of the sweep: the
        // others are just as overdue.
        logger.error("deadlines.chase.failed", { documentId: row.documentId, err: error });
      }
    }

    return { chased };
  }

  /**
   * Escalate what is still sitting two working days after its deadline.
   *
   * Agreed after the fit-gap review: the approver's line manager and the
   * administrators who watch the control room are told, once. Neither can
   * sign it; they can ask, or move the step. `escalatedAt` is cleared with
   * the chase marker when the step moves, so the next approver starts clean.
   *
   * Only a step already chased is a candidate: escalation is the second
   * notice, never the first.
   */
  async escalateOverdue(now: Date = new Date()): Promise<{ escalated: number }> {
    const rows = await prisma.$queryRaw<
      (OverdueRow & { lineManagerId: string | null })[]
    >`
      SELECT
        r.id                     AS "runId",
        d.id                     AS "documentId",
        d.title                  AS "documentTitle",
        d.reference_number       AS "documentReference",
        d.memo_type              AS "memoType",
        r.current_step_started_at AS "currentStepStartedAt",
        s.sla_days               AS "slaDays",
        r.policy_frozen_at       AS "policyFrozenAt",
        r.policy_sla_default_days AS "policySlaDefaultDays",
        s.assigned_user_id       AS "assignedUserId",
        holder.first_name        AS "assignedFirstName",
        holder.line_manager_id   AS "lineManagerId",
        d.preparer_id            AS "preparerId",
        preparer.first_name      AS "preparerFirstName"
      FROM workflow_runs r
      JOIN documents d ON d.id = r.document_id
      JOIN approval_chain_steps s
        ON s.chain_id = r.chain_id AND s.step_order = r.current_step_order
      JOIN users holder ON holder.id = s.assigned_user_id
      JOIN users preparer ON preparer.id = d.preparer_id
      WHERE r.status = 'IN_PROGRESS'
        AND d.status = 'PENDING_REVIEW'
        AND r.breach_notified_at IS NOT NULL
        AND r.escalated_at IS NULL
      ORDER BY r.current_step_started_at ASC
      LIMIT ${BATCH}`;

    const due = rows.filter((row) => {
      const at = escalateAtFor(row.currentStepStartedAt, row.slaDays, runDeadlineDefault(row));
      return at !== null && at.getTime() < now.getTime();
    });
    if (due.length === 0) return { escalated: 0 };

    // The administrators who watch the control room, read once per sweep.
    const administrators = (
      await prisma.user.findMany({
        where: { loginRole: "ADMINISTRATOR", deactivatedAt: null },
        select: { id: true, ...ACCESS_SELECT },
      })
    )
      .filter((admin) => capabilitiesOf(admin).includes("approvals.oversee"))
      .map((admin) => admin.id);

    let escalated = 0;

    for (const row of due) {
      const reference = row.documentReference ?? "A memo";
      const manager = row.lineManagerId
        ? await prisma.user.findFirst({
            where: { id: row.lineManagerId, deactivatedAt: null },
            select: { id: true },
          })
        : null;

      const recipients = [
        ...new Set([...(manager ? [manager.id] : []), ...administrators]),
      ].filter((id) => id !== row.assignedUserId);

      try {
        await prisma.$transaction(async (tx) => {
          const claimed = await tx.workflowRun.updateMany({
            where: { id: row.runId, escalatedAt: null },
            data: { escalatedAt: now },
          });
          if (claimed.count === 0) return;

          await notificationsService.createNotifications(
            recipients.map((recipientId) => ({
              recipientId,
              type: "ESCALATED" as const,
              title: `Escalated: ${row.documentTitle}`,
              message:
                recipientId === manager?.id
                  ? `${reference} has waited on ${row.assignedFirstName}, who reports to you, more than ${ESCALATE_AFTER_WORKING_DAYS} working days past its deadline. Please ask them to act on it, or arrange cover.`
                  : `${reference} has waited on ${row.assignedFirstName} more than ${ESCALATE_AFTER_WORKING_DAYS} working days past its deadline. It can be moved to another approver from the control room.`,
              documentId: row.documentId,
              workflowRunId: row.runId,
            })),
            tx
          );

          await auditService.createAuditLog({
            action: "WORKFLOW_STEP_ESCALATED",
            entityType: "Document",
            entityId: row.documentId,
            newValue: {
              runId: row.runId,
              assignedUserId: row.assignedUserId,
              lineManagerId: manager?.id ?? null,
              notified: recipients,
            },
            tx,
          });

          escalated += 1;
        });
      } catch (error) {
        logger.error("deadlines.escalate.failed", { documentId: row.documentId, err: error });
      }
    }

    return { escalated };
  }

  /**
   * How many in-flight steps are past their deadline right now.
   *
   * Counted live rather than read from `breachNotifiedAt`, because that column
   * records whether anybody was *told*, which is a different question from
   * whether the memo is late.
   */
  async overdueCount(now: Date = new Date()): Promise<number> {
    const oldest = new Date(now.getTime() - MIN_AGE_MS);

    const rows = await prisma.$queryRaw<
      {
        currentStepStartedAt: Date;
        slaDays: number | null;
        policyFrozenAt: Date | null;
        policySlaDefaultDays: number | null;
      }[]
    >`
      SELECT r.current_step_started_at AS "currentStepStartedAt", s.sla_days AS "slaDays",
             r.policy_frozen_at AS "policyFrozenAt",
             r.policy_sla_default_days AS "policySlaDefaultDays"
      FROM workflow_runs r
      JOIN documents d ON d.id = r.document_id
      JOIN approval_chain_steps s
        ON s.chain_id = r.chain_id AND s.step_order = r.current_step_order
      WHERE r.status = 'IN_PROGRESS'
        AND d.status = 'PENDING_REVIEW'
        AND r.current_step_started_at <= ${oldest}`;

    return rows.filter((row) => {
      const dueAt = dueAtFor(row.currentStepStartedAt, row.slaDays, runDeadlineDefault(row));
      return dueAt !== null && dueAt.getTime() < now.getTime();
    }).length;
  }

  /** Chases sent today, for the oversight board's escalations card. */
  async chasedToday(now: Date = new Date()): Promise<number> {
    const since = new Date(now.getTime());
    since.setUTCHours(0, 0, 0, 0);

    return prisma.workflowRun.count({
      where: { breachNotifiedAt: { gte: since } },
    });
  }
}

export const slaService = new SlaService();
