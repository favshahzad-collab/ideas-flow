import { prisma } from "../prisma";
import { errors } from "../lib/errors";
import { notificationsService } from "./notifications.service";
import {
  canUserViewDocument,
  documentHasUserActed,
} from "../lib/documentAccess";
import { CreateCommentInput } from "../schemas/comments.schema";
import { viewerFor } from "./viewer.service";

/**
 * The comment thread on a document.
 *
 * Neither method checked who was asking. Any authenticated user could read
 * the whole thread of any document by id, and post into it - and the thread
 * is where approval.service writes rejection reasons, revision requests and
 * the note naming whoever was skipped and why. The document itself, and its
 * audit trail, were both closed; this was the way round them.
 *
 * The rule is the document's own: you may read the conversation about a
 * document exactly when you may read the document.
 */

/** Everything canUserViewDocument needs, plus what a notice has to name. */
const accessShape = (userId: string) =>
  ({
    preparerId: true,
    status: true,
    // For the notice, not for the permission check: a message that does not
    // name the memo is one somebody has to go and look up.
    title: true,
    approvalChain: {
      select: { steps: { select: { assignedUserId: true, stepOrder: true } } },
    },
    currentWorkflowRun: {
      select: {
        status: true,
        currentStepOrder: true,
        chain: {
          select: {
            steps: { select: { assignedUserId: true, stepOrder: true } },
          },
        },
      },
    },
    workflowRuns: {
      select: {
        currentStepOrder: true,
        // The caller's own actions only: "has anybody acted" is a different
        // question and would let one approver's action open the document to
        // everybody in the chain.
        actions: { where: { actorId: userId }, select: { id: true }, take: 1 },
      },
    },
  }) as const;

class CommentsService {
  /**
   * Load the document and refuse anyone who may not see it.
   *
   * The two failures are told apart deliberately: a document that does not
   * exist is a 404, one that exists and is not yours is a 403. Answering 404
   * for both would hide that the id is real - which matters less here than
   * being able to tell a broken link from a permission problem, and the
   * document and audit services already draw the line in the same place.
   */
  private async loadVisibleDocument(documentId: string, userId: string) {
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: accessShape(userId),
    });

    if (!document) {
      throw errors.notFound("Document not found");
    }

    if (
      !canUserViewDocument({
        preparerId: document.preparerId,
        status: document.status,
        ...(await viewerFor(userId)),
        approvalChain: document.approvalChain,
        currentWorkflowRun: document.currentWorkflowRun,
        workflowRunHistory: document.workflowRuns,
        hasUserActed: documentHasUserActed(document.workflowRuns),
      })
    ) {
      throw errors.forbidden("Access denied");
    }

    return document;
  }

  async getComments(documentId: string, userId: string) {
    await this.loadVisibleDocument(documentId, userId);

    return prisma.documentComment.findMany({
      where: {
        documentId,
      },
      orderBy: {
        createdAt: "desc",
      },
      include: {
        author: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });
  }

  /**
   * Who should hear about a comment on this memo.
   *
   * The preparer, plus everyone the memo has actually reached - the approvers
   * at or before the current step. Not the whole chain: somebody three steps
   * down has never seen this memo and telling them about a question on it
   * would be the first they hear of its existence.
   *
   * The same set `approval.service` calls the upline, and deliberately so: a
   * comment and a revision request are the same conversation, and it would be
   * strange for one to reach people the other does not.
   */
  private recipientsFor(document: {
    preparerId: string;
    currentWorkflowRun: {
      currentStepOrder: number;
      chain: { steps: { assignedUserId: string; stepOrder: number }[] } | null;
    } | null;
  }): Set<string> {
    const recipients = new Set<string>([document.preparerId]);
    const run = document.currentWorkflowRun;

    for (const step of run?.chain?.steps ?? []) {
      if (step.stepOrder <= run!.currentStepOrder) {
        recipients.add(step.assignedUserId);
      }
    }

    return recipients;
  }

  async createComment(
    documentId: string,
    userId: string,
    input: CreateCommentInput
  ) {
    const document = await this.loadVisibleDocument(documentId, userId);

    if (document.status === "DELETED") {
      throw errors.badRequest("Cannot comment on a deleted document.");
    }

    const comment = await prisma.documentComment.create({
      data: {
        documentId,
        authorId: userId,
        comment: input.comment,
      },
      include: {
        author: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    /*
     * Tell the people party to the memo.
     *
     * This did not happen, and the thread rendered as a conversation anyway.
     * A reviewer asking a question before they sign would write it, see it
     * appear, and the memo would sit there with nobody aware - which is the
     * worst version, because everybody involved believes a message was sent.
     *
     * Outside the create, not in a transaction with it: a comment that was
     * saved is saved, and a mail queue that is unreachable must not roll back
     * somebody's words. The notice is the follow-up, not the point.
     */
    const recipients = this.recipientsFor(document);
    recipients.delete(userId);

    const author = `${comment.author.firstName} ${comment.author.lastName}`.trim();

    await notificationsService.createNotifications(
      [...recipients].map((recipientId) => ({
        recipientId,
        type: "COMMENT_ADDED" as const,
        title: "New comment",
        // The comment itself, not just that there is one. The whole value of
        // the notice is answering it without opening anything, and a question
        // about a grade on page 2 fits in a line.
        message: `${author} commented on "${document.title}": ${input.comment}`,
        documentId,
      }))
    );

    return comment;
  }
}

export const commentsService = new CommentsService();
