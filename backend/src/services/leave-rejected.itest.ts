import { beforeEach, describe, expect, it } from "vitest";
import { LoginRole } from "../generated/prisma/client";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  makeUser,
  resubmitDocument,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { approvalService } from "./approval.service";
import { documentsService } from "./documents.service";
import { leaverHandoverService } from "./leaverHandover.service";
import { notificationsService } from "./notifications.service";

/**
 * Leave as rejected.
 *
 * A rejection ends that cycle, not the memo, so it waits on its preparer for
 * a decision: resubmit it, or leave it as rejected. Until then the rejection
 * is in their "Needs you"; leaving it closes the memo for good, on record as
 * rejected.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;
let documentId: string;

beforeEach(async () => {
  cast = await makeCast();
  documentId = (
    await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    })
  ).id;
  await approvalService.reject(documentId, cast.reviewer.id, {
    comment: "The lease term is wrong.",
  });
});

/** Whether the rejection notice in this person's inbox still asks them for something. */
const rejectionNeedsAction = async (userId: string) =>
  (await notificationsService.getNotifications(userId))
    .filter((notice) => notice.documentId === documentId && notice.type === "REJECTED")
    .map((notice) => notice.needsAction);

describe("a rejected memo nobody has decided about", () => {
  it("is in its preparer's Needs you", async () => {
    expect(await rejectionNeedsAction(cast.preparer.id)).toEqual([true]);
  });

  it("asks nothing of anybody else who was told", async () => {
    const others = await prisma.notification.findMany({
      where: { documentId, type: "REJECTED", recipientId: { not: cast.preparer.id } },
      select: { recipientId: true },
    });
    for (const { recipientId } of others) {
      expect(await rejectionNeedsAction(recipientId)).not.toContain(true);
    }
  });

  it("leaves Needs you once it is resubmitted", async () => {
    await resubmitDocument({ documentId, preparerId: cast.preparer.id });
    expect(await rejectionNeedsAction(cast.preparer.id)).toEqual([false]);
  });
});

describe("leaving it as rejected", () => {
  it("closes it, still rejected, and records who decided", async () => {
    await documentsService.leaveRejected(documentId, cast.preparer.id);

    const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe("REJECTED");
    expect(document.rejectionClosedAt).not.toBeNull();

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: documentId, action: "REJECTION_CLOSED" },
    });
    expect(audit.actorId).toBe(cast.preparer.id);
  });

  it("takes it out of Needs you", async () => {
    await documentsService.leaveRejected(documentId, cast.preparer.id);
    expect(await rejectionNeedsAction(cast.preparer.id)).toEqual([false]);
  });

  it("is final: it cannot be resubmitted afterwards", async () => {
    await documentsService.leaveRejected(documentId, cast.preparer.id);

    await expect(
      resubmitDocument({ documentId, preparerId: cast.preparer.id })
    ).rejects.toMatchObject({ statusCode: 409, code: "REJECTION_CLOSED" });

    const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.currentVersionNumber).toBe(1);
  });

  it("leaves no step to move and nothing to hand over", async () => {
    await documentsService.leaveRejected(documentId, cast.preparer.id);

    const admin = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });
    await expect(
      approvalService.reassignStep(documentId, admin.id, {
        stepOrder: 1,
        userId: cast.approver.id,
        reason: "Reviewer has left",
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    const work = await leaverHandoverService.openWork(cast.reviewer.id);
    expect(work.nextCycle.map((held) => held.documentId)).not.toContain(documentId);
  });

  it("is the preparer's decision alone", async () => {
    await expect(
      documentsService.leaveRejected(documentId, cast.reviewer.id)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("is refused twice, and for a memo that is not rejected", async () => {
    await documentsService.leaveRejected(documentId, cast.preparer.id);
    await expect(
      documentsService.leaveRejected(documentId, cast.preparer.id)
    ).rejects.toMatchObject({ statusCode: 409 });

    const inFlight = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });
    await expect(
      documentsService.leaveRejected(inFlight.id, cast.preparer.id)
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("and a resubmission racing it never both land", async () => {
    await Promise.allSettled([
      resubmitDocument({ documentId, preparerId: cast.preparer.id }),
      documentsService.leaveRejected(documentId, cast.preparer.id),
    ]);

    const after = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    if (after.status === "REJECTED") {
      expect([after.currentVersionNumber, after.rejectionClosedAt]).toEqual([1, expect.any(Date)]);
    } else {
      expect([after.status, after.rejectionClosedAt]).toEqual(["PENDING_REVIEW", null]);
    }
  });

  it("is on the memo's page data", async () => {
    await documentsService.leaveRejected(documentId, cast.preparer.id);
    const detail = await documentsService.getDocumentById(documentId, cast.preparer.id);
    expect(detail.rejectionClosedAt).not.toBeNull();
  });
});
