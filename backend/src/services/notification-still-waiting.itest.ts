import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  makeUser,
  resubmitDocument,
  signature,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { approvalService } from "./approval.service";
import { delegationsService } from "./delegations.service";
import { documentsService } from "./documents.service";
import { notificationsService } from "./notifications.service";

/**
 * Whether a notice that asked somebody to act still does.
 *
 * An approval notice used to be permanent: once sent it said "Needs you" for
 * ever, whether the reader had signed, returned the memo, had the step moved
 * away from them, or the memo had been deleted. On 2026-09-28 every approval
 * notice in the live inbox pointed at a memo that was already approved or
 * deleted. Each test here walks a memo through one of those endings, through
 * the real services, and reads each person's inbox the way the screen does.
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

/** One person's notices about this memo, newest first, as type and whether they still need action. */
const inboxOf = async (userId: string) =>
  (await notificationsService.getNotifications(userId))
    // The preparer's receipt for submitting is news, not work, and not
    // what this file is about.
    .filter((notice) => notice.documentId === documentId && notice.type !== "SUBMITTED")
    .map((notice) => [notice.type, notice.needsAction]);

const approveAs = (actorId: string) => {
  const { useSavedSignature: _saved, ...placement } = signature();
  return approvalService.approve(documentId, actorId, {
    ...placement,
    useSavedSignature: false,
  });
};

describe("while the memo is waiting on the reader", () => {
  it("needs action from the approver it is sitting with, and nobody else yet", async () => {
    expect(await inboxOf(cast.reviewer.id)).toEqual([["APPROVAL_NEEDED", true]]);
    expect(await inboxOf(cast.approver.id)).toEqual([]);
  });
});

describe("once the reader has decided", () => {
  it("stops needing action when they approve, and starts for the next approver", async () => {
    await approveAs(cast.reviewer.id);

    expect(await inboxOf(cast.reviewer.id)).toEqual([["APPROVAL_NEEDED", false]]);
    expect(await inboxOf(cast.approver.id)).toEqual([["APPROVAL_NEEDED", true]]);
  });

  it("stops needing action when they reject", async () => {
    await approvalService.reject(documentId, cast.reviewer.id, {
      comment: "Not in this form.",
    });

    // No outcome notice for the person who rejected it - they know
    // (fit-gap decision 2) - and the request stops needing them.
    expect(await inboxOf(cast.reviewer.id)).toEqual([["APPROVAL_NEEDED", false]]);
  });

  it("stops for everybody once the last approver signs", async () => {
    await approveAs(cast.reviewer.id);
    await approveAs(cast.approver.id);
    await approveAs(cast.finalApprover.id);

    for (const person of [cast.reviewer, cast.approver, cast.finalApprover]) {
      const inbox = await inboxOf(person.id);
      expect(inbox).toContainEqual(["APPROVAL_NEEDED", false]);
      expect(inbox.filter(([, needsAction]) => needsAction)).toEqual([]);
    }
  });
});

describe("a memo returned for revision", () => {
  it("hands the work to the preparer, and back again once they resubmit", async () => {
    await approvalService.requestRevision(documentId, cast.reviewer.id, {
      comment: "Please attach the lease schedule.",
    });

    expect(await inboxOf(cast.reviewer.id)).toEqual([["APPROVAL_NEEDED", false]]);
    expect(await inboxOf(cast.preparer.id)).toEqual([["REVISION_REQUESTED", true]]);

    await resubmitDocument({ documentId, preparerId: cast.preparer.id });

    // The revision is done, and the reviewer is asked again on the new run.
    // The notice from the run that ended stays finished.
    expect(await inboxOf(cast.preparer.id)).toEqual([["REVISION_REQUESTED", false]]);
    expect(await inboxOf(cast.reviewer.id)).toEqual([
      ["APPROVAL_NEEDED", true],
      ["APPROVAL_NEEDED", false],
    ]);
  });
});

describe("a step moved to somebody else", () => {
  it("stops needing action from the approver it was taken from", async () => {
    const admin = await makeUser({
      firstName: "Admin",
      departmentId: cast.department.id,
      loginRole: "ADMINISTRATOR",
    });

    await approvalService.reassignStep(documentId, admin.id, {
      userId: cast.bystander.id,
      reason: "Ayesha has left the company.",
    });

    const reviewer = await inboxOf(cast.reviewer.id);
    expect(reviewer).toContainEqual(["APPROVAL_NEEDED", false]);
    expect(reviewer.filter(([, needsAction]) => needsAction)).toEqual([]);
    expect(await inboxOf(cast.bystander.id)).toEqual([["APPROVAL_NEEDED", true]]);
  });
});

describe("a memo that was deleted", () => {
  it("needs nothing from anybody", async () => {
    await documentsService.withdrawDocument(documentId, cast.preparer.id, "No longer needed");

    expect(
      (await inboxOf(cast.reviewer.id)).filter(([, needsAction]) => needsAction),
    ).toEqual([]);
  });
});

describe("cover for somebody away", () => {
  it("needs action from the delegate only while the delegation lasts", async () => {
    // Cover arranged before the memo arrives, so the delegate is told too.
    const delegation = await delegationsService.create(
      { delegateId: cast.bystander.id },
      { id: cast.approver.id, isAdministrator: false },
    );
    await approveAs(cast.reviewer.id);

    expect(await inboxOf(cast.bystander.id)).toContainEqual(["APPROVAL_NEEDED", true]);

    await delegationsService.revoke(delegation.id, {
      id: cast.approver.id,
      isAdministrator: false,
    });

    expect(
      (await inboxOf(cast.bystander.id)).filter(([, needsAction]) => needsAction),
    ).toEqual([]);
    // The approver's own authority is untouched by their cover ending.
    expect(await inboxOf(cast.approver.id)).toContainEqual(["APPROVAL_NEEDED", true]);
  });
});

describe("notices that were never work", () => {
  it("never need action, whether or not they are about a memo", async () => {
    await approveAs(cast.reviewer.id);
    await prisma.notification.create({
      data: {
        recipientId: cast.preparer.id,
        type: "SECURITY_ALERT",
        title: "Two-step sign-in was turned off",
        message: "Tell an administrator if this was not you.",
      },
    });

    const preparer = await notificationsService.getNotifications(cast.preparer.id);
    expect(preparer.map((notice) => [notice.type, notice.needsAction])).toEqual(
      preparer.map((notice) => [notice.type, false]),
    );
    expect(preparer.map((notice) => notice.type)).toContain("SECURITY_ALERT");
  });
});
