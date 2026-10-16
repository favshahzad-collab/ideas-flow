import type { NotificationType } from "../generated/prisma/client";

/**
 * What a notice looks like when it arrives in somebody's inbox.
 *
 * Plain text, deliberately. A memo notice is four facts and a link — who wants
 * something, which memo, why, and where to go — and every one of those
 * survives a corporate mail client, a phone, a screen reader and a printout.
 * An HTML template would add a stylesheet to maintain and nothing a reader
 * needs.
 *
 * These are pure functions on purpose: the subject line of an approval request
 * is the thing an approver decides whether to open, and it is worth being able
 * to test it without a mail server.
 */

/** Subject lines are read in a list, so the verb comes first. */
const SUBJECT_VERB: Record<NotificationType, string> = {
  APPROVAL_NEEDED: "Approval needed",
  // Not "Comment": the inbox list shows the verb before the reference, and
  // "New comment: MEMO-2026-0001" reads as an event where "Comment:" reads
  // as a label on the memo.
  COMMENT_ADDED: "New comment",
  APPROVAL_OVERDUE: "Overdue",
  // "Reminder", not "Overdue" and not "Approval needed". Overdue would assert
  // a deadline that may never have been set, and the approver has already had
  // one "Approval needed" for this memo - a second identical subject line is
  // how a person concludes the system sends the same mail twice.
  APPROVAL_REMINDER: "Reminder",
  REVISION_REQUESTED: "Revision requested",
  REJECTED: "Rejected",
  APPROVED: "Approved",
  RESUBMITTED: "Resubmitted",
  // The preparer's receipt. "Submitted", the fact, rather than anything that
  // reads as a request: there is nothing for them to do.
  SUBMITTED: "Submitted",
  // For a line manager or an administrator: it is late, and somebody should ask.
  ESCALATED: "Escalated",
  DOCUMENT_DELETED: "Withdrawn",
  DELEGATION_STARTED: "Approvals handed over",
  DELEGATION_ENDED: "Delegation ended",
  // Not "Approval needed", which is what this used to send to somebody whose
  // approval had just been bypassed.
  STEP_SKIPPED: "Skipped",
  // Not "Skipped": the step still has to be signed, by somebody else. The
  // memo is named inside the sentence rather than after the verb for the
  // approver's copy, which deliberately carries no document to reference.
  STEP_REASSIGNED: "Reassigned",
  // No memo reference follows this one, so the verb IS the whole subject. It
  // has to read as something to open now rather than a receipt to file, and
  // it must not name the account or what changed: a subject line is the part
  // of a mail visible on a lock screen, over a shoulder, in a preview pane.
  SECURITY_ALERT: "Security alert",
};

/**
 * How much of a memo title a subject line carries.
 *
 * Mail clients cut a subject at somewhere around 70 characters in a list view,
 * and the reference in front of the title is the part that must survive.
 */
const TITLE_LIMIT = 72;

export type NoticeInput = {
  type: NotificationType;
  /** The person being written to, so it opens with their name. */
  recipientFirstName: string;
  /** The inbox line already written for a human. Reused, never re-worded. */
  message: string;
  /**
   * Overrides the verb the type alone would put at the front of the subject.
   *
   * `APPROVED` is two different events. A step was signed and the memo moved
   * on, or the memo is finished — and only the caller advancing the workflow
   * knows which. The inbox row has always told them apart ("Approval
   * Progress" against "Document Approved"); the subject line could not, so a
   * preparer's three notices arrived under three identical subjects, which a
   * mail client threads into one. The first of them said "Approved:" while
   * two approvers had yet to see the memo at all.
   */
  subjectVerb?: string | null;
  documentId?: string | null;
  documentTitle?: string | null;
  /** `MEMO-2026-0007`, where the memo has one. */
  documentReference?: string | null;
  /** Base URL of the application, without a trailing slash. */
  appUrl: string;
};

function shorten(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();

  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

export function noticeSubject(input: NoticeInput): string {
  const verb = input.subjectVerb?.trim() || SUBJECT_VERB[input.type] || "Update";
  const name = [input.documentReference, input.documentTitle]
    .filter(Boolean)
    .join(" — ");

  return name ? `${verb}: ${shorten(name, TITLE_LIMIT)}` : verb;
}

export function noticeBody(input: NoticeInput): string {
  const lines: string[] = [`${input.recipientFirstName},`, "", input.message];

  const facts = [
    input.documentReference ? `Reference: ${input.documentReference}` : null,
    input.documentTitle ? `Memo: ${input.documentTitle}` : null,
  ].filter(Boolean) as string[];

  if (facts.length > 0) {
    lines.push("", ...facts);
  }

  if (input.documentId) {
    // The whole point of the mail: one click back to the thing itself.
    lines.push("", `Open it here: ${input.appUrl}/documents/${input.documentId}`);
  }

  lines.push("", "—");

  if (input.documentId) {
    lines.push(
      "This notice was sent by Ideas Flow. Replies to it are not read;",
      "use the comment thread on the memo instead."
    );
  } else if (input.type === "SECURITY_ALERT") {
    /*
     * There is no memo and so no thread to point at. A security notice that
     * ended "use the comment thread on the memo instead" would be telling
     * somebody whose account may have just been taken over to go and do
     * something impossible.
     */
    lines.push(
      "This notice was sent by Ideas Flow. Replies to it are not read.",
      "If you did not do this, tell your administrator now."
    );
  } else {
    /*
     * A notice about a memo the reader can no longer open - which today is
     * the approver a step has just been moved away from. Chosen on the type
     * rather than on the missing link, because the alternative was every
     * linkless notice inheriting the security wording: "if you did not do
     * this, tell your administrator now", sent to somebody who did nothing
     * and to whom nothing has happened except that a job left their desk.
     */
    lines.push(
      "This notice was sent by Ideas Flow. Replies to it are not read."
    );
  }

  return lines.join("\n");
}

export function renderNotice(input: NoticeInput): {
  subject: string;
  body: string;
} {
  return { subject: noticeSubject(input), body: noticeBody(input) };
}
