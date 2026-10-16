import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  missingId,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { approvalService } from "./approval.service";
import { auditService } from "./audit.service";
import { commentsService } from "./comments.service";
import { documentsService } from "./documents.service";

/**
 * The comment thread on a document.
 *
 * It is not a side channel: rejections, revision requests and skipped steps
 * are all written into it by the approval service, naming who was skipped and
 * why. Reading the thread is reading the document's history, so it follows the
 * document's own rule - and until these tests were written it followed no rule
 * at all.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;
let documentId: string;

beforeEach(async () => {
  cast = await makeCast();
  const document = await submitDocument({
    preparerId: cast.preparer.id,
    approvalChain: chainOf(cast.reviewer, cast.approver, cast.finalApprover),
    title: "Warehouse lease extension",
  });
  documentId = document.id;
});

describe("telling people about a comment", () => {
  /*
   * Found by driving the path and reading what it produced, not by a failing
   * assertion - every test in this file passed while a comment told nobody.
   *
   * The thread renders as a conversation: avatars, names, timestamps, a box
   * that says "Add comment". A reviewer with a question before they sign
   * would write it, watch it appear, and the memo would sit there with
   * nobody aware. The worst version of silent, because everyone involved
   * believes a message was sent.
   *
   * It hid because the rejection reason and the revision request are written
   * into this same thread by `approval.service`, and those notify through
   * their own path. Only a free-standing comment was quiet.
   */

  const noticesFor = (userId: string) =>
    prisma.notification.findMany({
      where: { recipientId: userId, type: "COMMENT_ADDED" },
      select: { message: true },
    });

  it("tells the preparer when an approver comments", async () => {
    await commentsService.createComment(documentId, cast.reviewer.id, {
      comment: "The grade on page 2 does not match the scale.",
    });

    const [notice] = await noticesFor(cast.preparer.id);

    expect(notice).toBeDefined();
    // The words themselves, not just that there are some. The point of the
    // notice is answering it without opening anything.
    expect(notice.message).toContain("does not match the scale");
  });

  it("tells the approver holding it when the preparer answers", async () => {
    // The other direction, which is the half that unsticks the memo.
    await commentsService.createComment(documentId, cast.preparer.id, {
      comment: "Corrected - the scale is the 2026 one.",
    });

    expect(await noticesFor(cast.reviewer.id)).toHaveLength(1);
  });

  it("does not tell the person who wrote it", async () => {
    await commentsService.createComment(documentId, cast.preparer.id, {
      comment: "Survey attached.",
    });

    expect(await noticesFor(cast.preparer.id)).toHaveLength(0);
  });

  it("does not tell approvers the memo has not reached", async () => {
    /*
     * The final approver is two steps down and has never seen this memo. A
     * notice about a question on it would be the first they hear of its
     * existence, which is not a notification - it is a leak of somebody
     * else's work in progress.
     */
    await commentsService.createComment(documentId, cast.reviewer.id, {
      comment: "Checking the grade.",
    });

    expect(await noticesFor(cast.finalApprover.id)).toHaveLength(0);
    expect(await noticesFor(cast.approver.id)).toHaveLength(0);
  });

  it("queues a notice that names the memo in the subject", async () => {
    // It goes out as mail as well as to the bell. "New comment" rather than
    // "Comment", because an inbox list reads the verb first.
    await commentsService.createComment(documentId, cast.reviewer.id, {
      comment: "One question before I sign.",
    });

    const mail = await prisma.emailMessage.findFirst({
      // By recipient and the verb in the subject: EmailMessage carries no
      // type of its own, it is linked to the notification that raised it.
      // Not the preparer's receipt for submitting it.
      where: {
        recipientId: cast.preparer.id,
        NOT: { subject: { startsWith: "Submitted:" } },
      },
      select: { subject: true },
    });

    expect(mail?.subject).toContain("New comment");
    expect(mail?.subject).toContain("Warehouse lease extension");
  });
});

describe("reading a thread", () => {
  it("gives the preparer their own thread", async () => {
    await commentsService.createComment(documentId, cast.preparer.id, {
      comment: "Survey attached.",
    });

    const comments = await commentsService.getComments(
      documentId,
      cast.preparer.id
    );

    expect(comments.map((row) => row.comment)).toEqual(["Survey attached."]);
    expect(comments[0].author.id).toBe(cast.preparer.id);
  });

  it("gives it to the approver the document is sitting with", async () => {
    await commentsService.createComment(documentId, cast.preparer.id, {
      comment: "Survey attached.",
    });

    await expect(
      commentsService.getComments(documentId, cast.reviewer.id)
    ).resolves.toHaveLength(1);
  });

  it("newest first", async () => {
    await commentsService.createComment(documentId, cast.preparer.id, {
      comment: "First.",
    });
    await commentsService.createComment(documentId, cast.reviewer.id, {
      comment: "Second.",
    });

    const comments = await commentsService.getComments(
      documentId,
      cast.preparer.id
    );

    expect(comments.map((row) => row.comment)).toEqual(["Second.", "First."]);
  });

  it("reports a document that does not exist as not found", async () => {
    await expect(
      commentsService.getComments(missingId(), cast.preparer.id)
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("who may read a thread", () => {
  it("refuses someone who is not on the document at all", async () => {
    // The thread carries the rejection reasons and the skip reasons. Reading
    // it is reading the document's history, and audit.service already treats
    // it that way.
    await approvalService.reject(documentId, cast.reviewer.id, {
      comment: "The lease term is wrong and the guarantor has not signed.",
    });

    await expect(
      commentsService.getComments(documentId, cast.bystander.id)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses an approver the workflow has not reached", async () => {
    // Same rule the document itself follows: being named later in the chain
    // is not permission to read it now.
    await expect(
      commentsService.getComments(documentId, cast.finalApprover.id)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("agrees with the audit trail about a complete stranger", async () => {
    await expect(
      auditService.getDocumentAuditHistory(documentId, cast.bystander.id)
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      commentsService.getComments(documentId, cast.bystander.id)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("agrees with the audit trail about an approver not yet reached", async () => {
    /*
     * This is where the two used to part company. The thread followed the
     * document - in the chain AND the run has reached you - while the audit
     * trail asked only whether you were on the chain at all, so an approver
     * at step 3 who could not open the memo could read its entire history:
     * who signed it, what they wrote, and when.
     *
     * The audit trail applies the same rule now. Two rules over one document
     * means the stricter one is decoration, and the looser one is the real
     * policy whether or not anybody meant it to be.
     */
    await expect(
      commentsService.getComments(documentId, cast.finalApprover.id)
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(
      auditService.getDocumentAuditHistory(documentId, cast.finalApprover.id)
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("adding to a thread", () => {
  it("records the author and the document", async () => {
    const comment = await commentsService.createComment(
      documentId,
      cast.reviewer.id,
      { comment: "Please attach the survey." }
    );

    expect(comment.author.id).toBe(cast.reviewer.id);
    expect(
      await prisma.documentComment.count({ where: { documentId } })
    ).toBe(1);
  });

  it("refuses someone who cannot read the document", async () => {
    await expect(
      commentsService.createComment(documentId, cast.bystander.id, {
        comment: "Approve this please.",
      })
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(await prisma.documentComment.count()).toBe(0);
  });

  it("refuses a deleted document", async () => {
    await documentsService.withdrawDocument(documentId, cast.preparer.id, "No longer needed");

    await expect(
      commentsService.createComment(documentId, cast.preparer.id, {
        comment: "Still here?",
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("reports a document that does not exist as not found", async () => {
    await expect(
      commentsService.createComment(missingId(), cast.preparer.id, {
        comment: "Hello?",
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("keeps the thread the approval service writes into", async () => {
    // reject, requestRevision and skipWorkflowStep all write here, and those
    // entries have to be readable by the same people as the rest.
    await approvalService.requestRevision(documentId, cast.reviewer.id, {
      comment: "Page 2 is unsigned.",
    });

    const comments = await commentsService.getComments(
      documentId,
      cast.preparer.id
    );

    expect(comments[0].comment).toContain("Page 2 is unsigned.");
    expect(comments[0].author.id).toBe(cast.reviewer.id);
  });
});
