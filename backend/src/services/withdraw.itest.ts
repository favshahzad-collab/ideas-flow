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
import { documentsService } from "./documents.service";
import { leaverHandoverService } from "./leaverHandover.service";

/**
 * Withdraw, not delete - fit-gap decision 3.
 *
 * A preparer withdraws their memo with a reason; it stays on record, its
 * file still readable, and it can be resubmitted as a new version. An
 * administrator with the power cancels an abandoned one, with a reason, and
 * the preparer is told. Neither touches an approved or rejected memo.
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
});

describe("withdrawing", () => {
  it("keeps the memo on record with who withdrew it and why", async () => {
    await documentsService.withdrawDocument(documentId, cast.preparer.id, "Raised in error");

    const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe("DELETED");
    expect(document.withdrawalReason).toBe("Raised in error");
    expect(document.withdrawnById).toBe(cast.preparer.id);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: documentId, action: "DOCUMENT_WITHDRAWN" },
    });
    expect(audit.newValue).toMatchObject({ reason: "Raised in error" });
  });

  it("keeps its file readable", async () => {
    await documentsService.withdrawDocument(documentId, cast.preparer.id, "Raised in error");

    const { buffer } = await documentsService.getDocumentFile(documentId, cast.preparer.id, "VIEW");
    expect(buffer.length).toBeGreaterThan(0);
  });

  it("refuses without a reason", async () => {
    await expect(
      documentsService.withdrawDocument(documentId, cast.preparer.id, "   ")
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("is the preparer's alone", async () => {
    await expect(
      documentsService.withdrawDocument(documentId, cast.reviewer.id, "Not mine")
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("tells the chain why", async () => {
    await documentsService.withdrawDocument(documentId, cast.preparer.id, "Raised in error");

    const notice = await prisma.notification.findFirstOrThrow({
      where: { documentId, recipientId: cast.reviewer.id, type: "DOCUMENT_DELETED" },
    });
    expect(notice.title).toBe("Memo withdrawn");
    expect(notice.message).toContain("Raised in error");
  });

  it("can be resubmitted as a new version", async () => {
    await documentsService.withdrawDocument(documentId, cast.preparer.id, "Wrong attachment");

    await resubmitDocument({ documentId, preparerId: cast.preparer.id });

    const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe("PENDING_REVIEW");
    expect(document.currentVersionNumber).toBe(2);
  });
});

describe("cancelling an abandoned memo", () => {
  it("is open to an administrator with the power, and tells the preparer", async () => {
    const admin = await makeUser({
      loginRole: LoginRole.ADMINISTRATOR,
      superAdmin: false,
      adminPowers: ["memos.cancel"],
    });

    await documentsService.cancelDocument(documentId, admin.id, "Preparer has left");

    const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect([document.status, document.withdrawnById]).toEqual(["DELETED", admin.id]);
    expect(
      await prisma.auditLog.count({ where: { entityId: documentId, action: "DOCUMENT_CANCELLED" } })
    ).toBe(1);
    const told = await prisma.notification.findFirstOrThrow({
      where: { documentId, recipientId: cast.preparer.id, type: "DOCUMENT_DELETED" },
    });
    expect(told.title).toBe("Memo cancelled");
  });

  it("is refused to an administrator without the power", async () => {
    const admin = await makeUser({
      loginRole: LoginRole.ADMINISTRATOR,
      superAdmin: false,
      adminPowers: [],
    });

    await expect(
      documentsService.cancelDocument(documentId, admin.id, "Preparer has left")
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  /*
   * Final. A cancel used to leave the memo exactly as a withdrawal does, so
   * its preparer could upload over it and send it round again - undoing an
   * administrator's decision alone.
   */
  it("is final: the preparer cannot send it round again", async () => {
    const admin = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });
    await documentsService.cancelDocument(documentId, admin.id, "Preparer has left");

    await expect(
      resubmitDocument({ documentId, preparerId: cast.preparer.id })
    ).rejects.toMatchObject({ statusCode: 409, code: "CANCELLED_BY_ADMINISTRATOR" });

    const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect([document.status, document.currentVersionNumber]).toEqual(["DELETED", 1]);
  });

  it("is not offered to a leaver's successor as a memo to send round again", async () => {
    const admin = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });
    await documentsService.cancelDocument(documentId, admin.id, "Preparer has left");

    const work = await leaverHandoverService.openWork(cast.reviewer.id);
    expect(work.nextCycle.map((held) => held.documentId)).not.toContain(documentId);
  });

  it("leaves a memo its preparer withdrew offered to a leaver's successor", async () => {
    await documentsService.withdrawDocument(documentId, cast.preparer.id, "Wrong attachment");

    const work = await leaverHandoverService.openWork(cast.reviewer.id);
    expect(work.nextCycle.map((held) => held.documentId)).toContain(documentId);
  });

  it("never touches an approved memo", async () => {
    const admin = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });
    await prisma.document.update({ where: { id: documentId }, data: { status: "APPROVED" } });

    await expect(
      documentsService.cancelDocument(documentId, admin.id, "Tidy up")
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
