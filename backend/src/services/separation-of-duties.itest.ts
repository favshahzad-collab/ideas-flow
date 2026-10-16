import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import {
  chainOf,
  currentPosition,
  makeCast,
  makeUser,
  resubmitDocument,
  signature,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { adminService } from "./admin.service";
import { approvalService } from "./approval.service";
import { delegationsService } from "./delegations.service";

/**
 * The separations a memo's signatures depend on, against a real database.
 *
 * A chain of three approvers is worth three people's judgement only if three
 * people give it. Each test here is a way one person could have given two -
 * or given the one nobody chose them to give - through a control that exists
 * for a different reason: moving a stuck step, arranging cover for somebody
 * away, or keeping the administration screens reachable.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;
let admin: Awaited<ReturnType<typeof makeUser>>;
let documentId: string;

beforeEach(async () => {
  cast = await makeCast();
  admin = await makeUser({
    firstName: "Admin",
    departmentId: cast.department.id,
    loginRole: "ADMINISTRATOR",
  });

  const document = await submitDocument({
    preparerId: cast.preparer.id,
    approvalChain: chainOf(cast.reviewer, cast.approver, cast.finalApprover),
    title: "Warehouse lease extension",
  });
  documentId = document.id;
});

const asUser = (user: { id: string }) => ({ id: user.id, isAdministrator: false });
const asAdmin = (user: { id: string }) => ({ id: user.id, isAdministrator: true });

const approveAs = (actorId: string) => {
  const { useSavedSignature: _saved, ...placement } = signature();
  return approvalService.approve(documentId, actorId, {
    ...placement,
    useSavedSignature: false,
  });
};

/** Every decision on the memo, in order, as who signed and for whom. */
const decisions = async () =>
  (
    await prisma.approvalAction.findMany({
      where: { workflowRun: { documentId } },
      orderBy: { createdAt: "asc" },
      select: { actorId: true, onBehalfOfId: true, action: true },
    })
  ).map((row) => [row.action, row.actorId, row.onBehalfOfId]);

const chainHolders = async () => {
  const run = await prisma.workflowRun.findFirstOrThrow({
    where: { documentId },
    orderBy: { startedAt: "desc" },
    include: { chain: { include: { steps: { orderBy: { stepOrder: "asc" } } } } },
  });
  return run.chain.steps.map((step) => step.assignedUserId);
};

describe("moving a step", () => {
  it("is refused when the administrator names themselves for the step the memo is on", async () => {
    await expect(
      approvalService.reassignStep(documentId, admin.id, {
        userId: admin.id,
        reason: "I will sign it myself.",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message:
        "You cannot move a step to yourself. Choose the person who should approve it.",
    });

    // Nothing moved, and nothing was recorded as having moved.
    expect(await chainHolders()).toEqual([
      cast.reviewer.id,
      cast.approver.id,
      cast.finalApprover.id,
    ]);
    expect(
      await prisma.auditLog.count({
        where: { entityId: documentId, action: "WORKFLOW_STEP_REASSIGNED" },
      }),
    ).toBe(0);
  });

  it("is refused for a step still ahead of the memo too", async () => {
    await expect(
      approvalService.reassignStep(documentId, admin.id, {
        userId: admin.id,
        reason: "I will sign the last one.",
        stepOrder: 3,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(await chainHolders()).toEqual([
      cast.reviewer.id,
      cast.approver.id,
      cast.finalApprover.id,
    ]);
  });
});

describe("arranging cover", () => {
  it("does not let an administrator hand somebody's approvals to themselves", async () => {
    await expect(
      delegationsService.create(
        { delegatorId: cast.reviewer.id, delegateId: admin.id },
        asAdmin(admin),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(await prisma.delegation.count()).toBe(0);
  });

  it("still lets the approver hand their own approvals to an administrator", async () => {
    // The refusal is about who chose it, not about who is chosen: the approver
    // deciding that an administrator should cover them is theirs to decide.
    const delegation = await delegationsService.create(
      { delegateId: admin.id },
      asUser(cast.reviewer),
    );

    expect([delegation.delegatorId, delegation.delegateId]).toEqual([
      cast.reviewer.id,
      admin.id,
    ]);
  });
});

describe("one decision per person on a memo", () => {
  it("refuses a delegate who holds a later step of their own", async () => {
    // The reviewer is away and has handed their approvals to the approver -
    // who already holds step 2. Signing step 1 for the reviewer would make the
    // approver both of the first two signatures.
    await delegationsService.create({ delegateId: cast.approver.id }, asUser(cast.reviewer));

    await expect(approveAs(cast.approver.id)).rejects.toMatchObject({
      statusCode: 403,
      message:
        "You have your own step on this memo, so you cannot also act for somebody else on it. Ask them, or the administrator, to arrange different cover.",
    });

    expect(await decisions()).toEqual([]);
    expect((await currentPosition(documentId)).assignedTo).toBe(cast.reviewer.id);
  });

  it("refuses the same delegate's rejection as well as their approval", async () => {
    await delegationsService.create({ delegateId: cast.approver.id }, asUser(cast.reviewer));

    await expect(
      approvalService.reject(documentId, cast.approver.id, {
        comment: "Not in this form.",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(await decisions()).toEqual([]);
    expect((await currentPosition(documentId)).status).toBe("PENDING_REVIEW");
  });

  it("refuses somebody who has already signed a step and is now covering the next", async () => {
    // The reviewer signs step 1 as themselves. The approver is then away and
    // hands step 2 to the reviewer. The same person signing twice is exactly
    // what the chain exists to prevent.
    await approveAs(cast.reviewer.id);
    await delegationsService.create({ delegateId: cast.reviewer.id }, asUser(cast.approver));

    await expect(approveAs(cast.reviewer.id)).rejects.toMatchObject({
      statusCode: 403,
      message:
        "You have already decided a step on this memo. Somebody else has to decide this one.",
    });

    expect(await decisions()).toEqual([["APPROVE",cast.reviewer.id, null]]);
    expect((await currentPosition(documentId)).assignedTo).toBe(cast.approver.id);
  });

  it("still lets a delegate with no step on the memo sign for the person away", async () => {
    await delegationsService.create({ delegateId: cast.bystander.id }, asUser(cast.reviewer));

    await approveAs(cast.bystander.id);

    expect(await decisions()).toEqual([
      ["APPROVE",cast.bystander.id, cast.reviewer.id],
    ]);
  });

  it("counts decisions per run, so a returned memo is decided afresh", async () => {
    // Returned from step 1 and resubmitted: a new run, and the same reviewer
    // is asked again. Their earlier decision belongs to the run that ended.
    await approvalService.requestRevision(documentId, cast.reviewer.id, {
      comment: "Please attach the lease schedule.",
    });
    await resubmitDocument({ documentId, preparerId: cast.preparer.id });

    await approveAs(cast.reviewer.id);

    expect(await decisions()).toEqual([
      ["REQUEST_REVISION",cast.reviewer.id, null],
      ["APPROVE",cast.reviewer.id, null],
    ]);
  });
});

describe("keeping an administrator who can sign in", () => {
  /** A second administrator, already switched off. */
  const switchedOffAdmin = async () => {
    const other = await makeUser({
      firstName: "Former",
      departmentId: cast.department.id,
      loginRole: "ADMINISTRATOR",
    });
    await prisma.user.update({
      where: { id: other.id },
      data: { deactivatedAt: new Date() },
    });
    return other;
  };

  it("refuses to demote the only administrator in use, though a switched-off one exists", async () => {
    await switchedOffAdmin();

    // Refused twice over now: nobody changes their own role, and the only
    // Super Administrator in use cannot be removed.
    await expect(
      adminService.updateUser(admin.id, { loginRole: "USER" }, admin.id),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "You cannot change your own role. Ask another Super Administrator.",
    });

    const roles = await prisma.user.findMany({
      where: { loginRole: "ADMINISTRATOR" },
      select: { id: true, deactivatedAt: true },
    });
    expect(roles.filter((row) => row.deactivatedAt === null).map((row) => row.id)).toEqual([
      admin.id,
    ]);
  });

  it("still lets the administrator in use demote the one already switched off", async () => {
    const former = await switchedOffAdmin();

    await adminService.updateUser(former.id, { loginRole: "USER" }, admin.id);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: former.id },
      select: { loginRole: true },
    });
    expect(after.loginRole).toBe("USER");
  });

  it("still refuses to switch off the only administrator in use", async () => {
    const former = await switchedOffAdmin();

    await expect(adminService.setUserActive(admin.id, false, former.id)).rejects.toMatchObject({
      statusCode: 400,
      message: "Cannot switch off the last Super Administrator. Make somebody else one first.",
    });
  });
});
