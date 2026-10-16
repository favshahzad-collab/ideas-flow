import { prisma } from "../prisma";
import { logger } from "../lib/logger";
import { Prisma, type NotificationType } from "../generated/prisma/client";
import { renderNotice } from "../lib/emailTemplates";
import { errors } from "../lib/errors";
import { appUrl, isMailConfigured, mailSettings, sendMail } from "../lib/mailer";
import { auditService } from "./audit.service";

/**
 * The outbox.
 *
 * A memo that reaches somebody's queue and a notice that never left the
 * building must not be able to disagree, so the row is written in the same
 * transaction as the notification it carries. Delivery happens afterwards, in
 * a sweep, which is what makes an unreachable mail server a delayed notice
 * rather than a failed approval.
 *
 * With no mail server configured the rows are still written. They are the
 * record of what the system meant to tell people, they cost a row each, and
 * they expire rather than being delivered a fortnight late when somebody
 * finally sets SMTP_HOST.
 */

/**
 * How many times a transient failure is retried before the row is left alone.
 *
 * The sweep is the backoff: at one minute apart, ten attempts ride out a ten
 * minute outage. Past that the row is FAILED with its last error on it, which
 * is a thing somebody can look at - unlike a retry loop that never stops and
 * never says anything.
 */
const MAX_ATTEMPTS = 10;

/** A notice older than this is confusion, not news. */
const MAX_AGE_HOURS = 24;

/** A claim held longer than this belongs to a process that is gone. */
const STALE_CLAIM_MINUTES = 5;

/** How many to take in one sweep. */
const BATCH = 25;

type EnqueueInput = {
  recipientId: string;
  recipientEmail: string;
  recipientFirstName: string;
  type: NotificationType;
  message: string;
  /** Set where the type alone would name the event wrongly. */
  subjectVerb?: string | null;
  documentId?: string | null;
  documentTitle?: string | null;
  documentReference?: string | null;
  notificationId?: string | null;
};

type ClaimedRow = {
  id: string;
  recipient_email: string;
  subject: string;
  body: string;
  attempts: number;
};

/** A mail server refusing permanently, as against being unavailable. */
function isPermanent(error: unknown): boolean {
  const code = (error as { responseCode?: number } | null)?.responseCode;

  return typeof code === "number" && code >= 500 && code < 600;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

class EmailService {
  /**
   * Queue one notice. Takes a transaction client so it commits with the state
   * change that caused it.
   */
  async enqueue(input: EnqueueInput, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    const { subject, body } = renderNotice({
      type: input.type,
      recipientFirstName: input.recipientFirstName,
      message: input.message,
      subjectVerb: input.subjectVerb,
      documentId: input.documentId,
      documentTitle: input.documentTitle,
      documentReference: input.documentReference,
      appUrl: appUrl(),
    });

    return client.emailMessage.create({
      data: {
        recipientId: input.recipientId,
        recipientEmail: input.recipientEmail,
        subject,
        body,
        documentId: input.documentId ?? null,
        notificationId: input.notificationId ?? null,
      },
    });
  }

  /**
   * Take a batch of due notices and try to deliver them.
   *
   * The claim is a status change, not a row lock: two API processes sweeping
   * the same queue must not both send the same notice, and a lock would be
   * released the moment the claiming statement committed - while the first
   * process was still talking to the mail server. `SKIP LOCKED` keeps the two
   * claims from colliding inside the statement itself.
   */
  async dispatchPending(now: Date = new Date()): Promise<{
    sent: number;
    failed: number;
    expired: number;
  }> {
    const expired = await this.expireStale(now);

    if (!isMailConfigured()) {
      return { sent: 0, failed: 0, expired };
    }

    const oldest = new Date(now.getTime() - MAX_AGE_HOURS * 60 * 60 * 1000);
    const staleClaim = new Date(now.getTime() - STALE_CLAIM_MINUTES * 60 * 1000);

    const claimed = await prisma.$queryRaw<ClaimedRow[]>`
      WITH due AS (
        SELECT id
        FROM email_messages
        WHERE (
                status = 'PENDING'
                OR (status = 'SENDING' AND claimed_at < ${staleClaim})
              )
          AND attempts < ${MAX_ATTEMPTS}
          AND created_at >= ${oldest}
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${BATCH}
      )
      UPDATE email_messages m
      SET status = 'SENDING', attempts = m.attempts + 1, claimed_at = ${now}
      FROM due
      WHERE m.id = due.id
      RETURNING m.id, m.recipient_email, m.subject, m.body, m.attempts
    `;

    let sent = 0;
    let failed = 0;

    for (const row of claimed) {
      try {
        await sendMail({
          to: row.recipient_email,
          subject: row.subject,
          text: row.body,
        });

        await prisma.emailMessage.update({
          where: { id: row.id },
          data: { status: "SENT", sentAt: new Date(), lastError: null },
        });
        sent += 1;

        // In the ledger, because "was Bilal told?" is asked after the fact and
        // an inbox row does not answer it.
        await auditService.createAuditLog({
          action: "EMAIL_SENT",
          entityType: "EmailMessage",
          entityId: row.id,
          newValue: { to: row.recipient_email, subject: row.subject },
        });
      } catch (error) {
        // Out of attempts, or refused outright: leave it alone and keep the
        // reason. Anything else goes back on the queue for the next sweep.
        const done = isPermanent(error) || row.attempts >= MAX_ATTEMPTS;

        await prisma.emailMessage.update({
          where: { id: row.id },
          data: {
            status: done ? "FAILED" : "PENDING",
            lastError: errorText(error),
            claimedAt: null,
          },
        });

        if (done) {
          failed += 1;
          /*
           * The recipient is passed as a field rather than interpolated into
           * a sentence, so redaction can reach it: an address is a person,
           * and a log file travels to places the database does not. The mail
           * row's id is what you search on; the row itself says who it was
           * for.
           */
          logger.error("mail.gave_up", {
            mailId: row.id,
            recipientEmail: row.recipient_email,
            attempts: row.attempts,
            reason: errorText(error),
          });
        }
      }
    }

    return { sent, failed, expired };
  }

  /** Mark anything too old to be worth delivering. */
  private async expireStale(now: Date): Promise<number> {
    const oldest = new Date(now.getTime() - MAX_AGE_HOURS * 60 * 60 * 1000);

    const { count } = await prisma.emailMessage.updateMany({
      where: {
        status: { in: ["PENDING", "SENDING"] },
        createdAt: { lt: oldest },
      },
      data: { status: "EXPIRED", claimedAt: null },
    });

    return count;
  }

  /** What the queue looks like right now, for whoever is asked why nobody was told. */
  async queueSummary() {
    const [grouped, recentFailures] = await Promise.all([
      prisma.emailMessage.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      prisma.emailMessage.findMany({
        where: { status: "FAILED" },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          recipientEmail: true,
          subject: true,
          attempts: true,
          lastError: true,
          createdAt: true,
        },
      }),
    ]);

    const counts = { PENDING: 0, SENDING: 0, SENT: 0, FAILED: 0, EXPIRED: 0 };
    for (const row of grouped) {
      counts[row.status] = row._count._all;
    }

    return {
      configured: isMailConfigured(),
      /*
       * What the deployment will actually do, not just whether two variables
       * are set. `appUrlIsDefault` is the one worth reading twice: mail can be
       * configured perfectly and still send every approver a link to
       * localhost, and nothing else in the product would say so.
       */
      settings: mailSettings(),
      counts,
      recentFailures,
    };
  }

  /**
   * Prove the mail path works, without involving a memo.
   *
   * Until this existed, "configured" meant SMTP_HOST and MAIL_FROM were set -
   * not that the host answers, that the credentials are accepted, that the
   * relay allows this sender, or that anything arrives. The first real test
   * was a live approval notice, and its failure mode is the worst one the
   * product has: the approver is simply never told, and the memo sits.
   *
   * Sent directly rather than queued, deliberately. The queue exists so an
   * approval never waits on a mail server; a test has no such constraint and
   * an operator needs the server's actual refusal in front of them rather than
   * "queued, look again shortly".
   *
   * TO THE ADMINISTRATOR'S OWN ADDRESS, always, read from the database and
   * never from the request. An endpoint that sends chosen text to a chosen
   * address is an open relay wearing a company logo.
   */
  async sendTestNotice(userId: string): Promise<{ sentTo: string }> {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, firstName: true },
    });

    if (!isMailConfigured()) {
      throw errors.badRequest(
        "No mail server is configured. Set one under Administration -> Mail."
      );
    }

    const settings = mailSettings();
    const subject = "Ideas Flow: test notice";
    const body = [
      `${user.firstName},`,
      "",
      "This is a test notice from Ideas Flow, sent because somebody pressed",
      "\"Send a test\" on the administration screen. Nothing has been approved,",
      "rejected or assigned.",
      "",
      "If you are reading this, approval notices will reach this mailbox.",
      "",
      `Links in real notices will point at: ${settings.appUrl}`,
      settings.appUrlIsDefault
        ? "That is the development default. Set APP_URL, or every approver gets a link that only works on the server itself."
        : null,
      "",
      "—",
      "This notice was sent by Ideas Flow. Replies to it are not read.",
    ]
      .filter((line) => line !== null)
      .join("\n");

    // Recorded in the outbox like any other message, so "was a test ever sent,
    // and did it work?" has one place to look rather than none.
    const row = await prisma.emailMessage.create({
      data: {
        recipientId: user.id,
        recipientEmail: user.email,
        subject,
        body,
        status: "SENDING",
        attempts: 1,
        claimedAt: new Date(),
      },
      select: { id: true },
    });

    try {
      await sendMail({ to: user.email, subject, text: body });
    } catch (error) {
      await prisma.emailMessage.update({
        where: { id: row.id },
        data: { status: "FAILED", lastError: errorText(error) },
      });
      logger.warn("mail.test.failed", { mailId: row.id, reason: errorText(error) });
      throw errors.badRequest(`The mail server refused it: ${errorText(error)}`);
    }

    await prisma.emailMessage.update({
      where: { id: row.id },
      data: { status: "SENT", sentAt: new Date() },
    });

    await auditService.createAuditLog({
      actorId: user.id,
      action: "EMAIL_SENT",
      entityType: "EmailMessage",
      entityId: row.id,
      newValue: { to: user.email, subject, test: true },
    });

    logger.info("mail.test.sent", { mailId: row.id, actorId: user.id });

    return { sentTo: user.email };
  }
}

export const emailService = new EmailService();
