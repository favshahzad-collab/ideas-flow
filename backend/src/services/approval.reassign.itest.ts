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
import { approvalService } from "./approval.service";
import { auditService } from "./audit.service";
import { delegationsService } from "./delegations.service";

/**
 * Moving a step to a different approver, against a real database.
 *
 * This is the one action in the system that changes who is entitled to sign a
 * memo after it was submitted, so most of what is worth holding shut is about
 * refusal - who may move a step, onto whom, and on which memos - and about
 * what is left behind afterwards. The chain itself cannot remember: the
 * assignment is one column and moving it overwrites it. If the trail, the
 * thread and the notices are not written, the change happened and nothing
 * anywhere says so.
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

const move = (
  actorId: string,
  userId: string,
  reason = "Ayesha has left the company.",
  ipAddress?: string,
) => approvalService.reassignStep(documentId, actorId, { userId, reason }, ipAddress);

/** The same, naming a step rather than taking the one the memo is sitting on. */
const moveStep = (
  stepOrder: number,
  actorId: string,
  userId: string,
  reason = "Ayesha has left the company.",
) => approvalService.reassignStep(documentId, actorId, { userId, reason, stepOrder });

/** Who holds each step, in order, however far the memo has got. */
const chainHolders = async () => {
  const run = await prisma.workflowRun.findFirstOrThrow({
    where: { documentId },
    include: { chain: { include: { steps: { orderBy: { stepOrder: "asc" } } } } },
  });

  return run.chain.steps.map((step) => step.assignedUserId);
};

const noticesFor = (recipientId: string, type: "STEP_REASSIGNED" | "APPROVAL_NEEDED") =>
  prisma.notification.findMany({
    where: { recipientId, type },
    orderBy: { createdAt: "asc" },
  });

const trail = () =>
  prisma.auditLog.findMany({
    where: { entityId: documentId, action: "WORKFLOW_STEP_REASSIGNED" },
    orderBy: { createdAt: "asc" },
  });

const thread = () =>
  prisma.documentComment.findMany({
    where: { documentId },
    orderBy: { createdAt: "asc" },
  });

/** Sign as whoever the memo is currently with, through the real service. */
const approveAs = (actorId: string) => {
  const { useSavedSignature: _saved, ...placement } = signature();
  return approvalService.approve(documentId, actorId, {
    ...placement,
    useSavedSignature: false,
  });
};

describe("who may move a step", () => {
  it("an administrator, who is the one watching memos that have stopped", async () => {
    const result = await move(admin.id, cast.bystander.id);

    expect(result.movedTo.id).toBe(cast.bystander.id);
    expect((await currentPosition(documentId)).assignedTo).toBe(cast.bystander.id);
  });

  it("not the preparer, who would otherwise be shopping for a signature", async () => {
    /*
     * They chose the chain at submission, in the open, before anybody had
     * seen the memo. Swapping an approver out after watching that approver
     * sit on it is a different act, and the preparer's remedy for "it is
     * simply slow" is the reminder.
     */
    await expect(move(cast.preparer.id, cast.bystander.id)).rejects.toThrow(
      /Only an administrator can move a step/,
    );
    expect((await currentPosition(documentId)).assignedTo).toBe(cast.reviewer.id);
  });

  it("not a later approver on the same chain", async () => {
    await expect(move(cast.approver.id, cast.bystander.id)).rejects.toThrow(
      /Only an administrator/,
    );
  });

  it("not the person holding it, who cannot hand their own step on", async () => {
    // What they have is a delegation, which says something true: that they
    // arranged cover. This says the organisation moved the work.
    await expect(move(cast.reviewer.id, cast.bystander.id)).rejects.toThrow(
      /Only an administrator/,
    );
  });
});

describe("who it may be moved to", () => {
  it("not the approver already on the step", async () => {
    await expect(move(admin.id, cast.reviewer.id)).rejects.toThrow(
      /already with Reviewer\. Choose somebody else/,
    );
  });

  it("not the preparer, who cannot approve their own memo", async () => {
    // The rule that refuses such a chain at submission. Reaching the same
    // state by editing the chain afterwards would stall the run for good:
    // the preparer cannot act, and the final step cannot be skipped.
    await expect(move(admin.id, cast.preparer.id)).rejects.toThrow(
      /preparer cannot be an approver on their own document/,
    );
  });

  it("not somebody who already holds another step on the memo", async () => {
    await expect(move(admin.id, cast.finalApprover.id)).rejects.toThrow(
      /already has a step on this memo/,
    );
  });

  it("not an account that does not exist", async () => {
    await expect(
      move(admin.id, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toThrow(/does not have an account here/);
  });
});

describe("which memos", () => {
  it("refuses one that is not waiting on anybody", async () => {
    await prisma.document.update({
      where: { id: documentId },
      data: { status: "APPROVED" },
    });

    await expect(move(admin.id, cast.bystander.id)).rejects.toThrow(
      /not waiting on anybody/,
    );
  });

  it("refuses one that does not exist", async () => {
    await expect(
      approvalService.reassignStep(
        "00000000-0000-4000-8000-000000000000",
        admin.id,
        { userId: cast.bystander.id, reason: "x" },
      ),
    ).rejects.toThrow(/not found/i);
  });
});

describe("a memo back with its preparer", () => {
  /*
   * Sent back, or rejected, the memo is between cycles: the next starts at
   * step 1 over this chain. A step held by somebody who has since left must
   * be movable, or the resubmission - which refuses a chain naming a
   * switched-off account - can never go through.
   */
  const leaves = (userId: string) =>
    prisma.user.update({ where: { id: userId }, data: { deactivatedAt: new Date() } });

  it("lets an administrator move a leaver's step, after which the memo can be resubmitted", async () => {
    await approvalService.requestRevision(documentId, cast.reviewer.id, { comment: "Fix the dates." });
    await leaves(cast.finalApprover.id);

    await expect(
      resubmitDocument({ documentId, preparerId: cast.preparer.id })
    ).rejects.toThrow(/no longer has an account/);

    const result = await moveStep(3, admin.id, cast.bystander.id);
    expect(result.message).toMatch(/can be resubmitted now/);
    expect(result.documentStatus).toBe("REVISION_REQUESTED");
    expect(await chainHolders()).toEqual([cast.reviewer.id, cast.approver.id, cast.bystander.id]);

    await resubmitDocument({ documentId, preparerId: cast.preparer.id });
    expect(await currentPosition(documentId)).toMatchObject({
      runStatus: "IN_PROGRESS",
      stepOrder: 1,
      assignedTo: cast.reviewer.id,
    });
  });

  it("works the same after a rejection, including the step that rejected it", async () => {
    await approvalService.reject(documentId, cast.reviewer.id, { comment: "Wrong lease term." });
    await leaves(cast.reviewer.id);

    await moveStep(1, admin.id, cast.bystander.id);

    expect((await chainHolders())[0]).toBe(cast.bystander.id);
    // The rejection on record still names who made it.
    const rejection = await prisma.approvalAction.findFirstOrThrow({
      where: { action: "REJECT", workflowRun: { documentId } },
    });
    expect(rejection.actorId).toBe(cast.reviewer.id);
  });

  it("needs the step to be named, since none is current", async () => {
    await approvalService.requestRevision(documentId, cast.reviewer.id, { comment: "Fix the dates." });

    await expect(move(admin.id, cast.bystander.id)).rejects.toThrow(/say which step to move/);
  });

  it("is still an administrator's alone", async () => {
    await approvalService.requestRevision(documentId, cast.reviewer.id, { comment: "Fix the dates." });

    await expect(moveStep(2, cast.preparer.id, cast.bystander.id)).rejects.toThrow(
      /Only an administrator/,
    );
  });
});

describe("what it actually moves", () => {
  it("hands the step over without advancing the run", async () => {
    // The approval is still required. Skipping is the action that drops one,
    // and this is deliberately not that.
    await move(admin.id, cast.bystander.id);

    const position = await currentPosition(documentId);
    expect(position.stepOrder).toBe(1);
    expect(position.status).toBe("PENDING_REVIEW");
    expect(position.runStatus).toBe("IN_PROGRESS");
    expect(position.assignedTo).toBe(cast.bystander.id);
  });

  it("lets the new approver sign it, and refuses the old one", async () => {
    await move(admin.id, cast.bystander.id);

    await expect(approveAs(cast.reviewer.id)).rejects.toThrow();

    await approveAs(cast.bystander.id);
    expect((await currentPosition(documentId)).stepOrder).toBe(2);
  });

  it("restarts the deadline clock, so the new approver is not chased for somebody else's time", async () => {
    const before = await prisma.workflowRun.findFirstOrThrow({
      where: { documentId },
    });
    await prisma.workflowRun.update({
      where: { id: before.id },
      data: {
        currentStepStartedAt: new Date("2026-01-01T00:00:00.000Z"),
        breachNotifiedAt: new Date("2026-01-08T00:00:00.000Z"),
      },
    });

    await move(admin.id, cast.bystander.id);

    const after = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(after.currentStepStartedAt.getTime()).toBeGreaterThan(
      new Date("2026-01-01T00:00:00.000Z").getTime(),
    );
    expect(after.breachNotifiedAt).toBeNull();
  });

  it("can be done again, because the second choice can be wrong too", async () => {
    await move(admin.id, cast.bystander.id);
    const second = await makeUser({
      firstName: "Second",
      departmentId: cast.department.id,
    });

    await move(admin.id, second.id, "Bystander is on leave as well.");

    expect((await currentPosition(documentId)).assignedTo).toBe(second.id);
    expect(await trail()).toHaveLength(2);
  });
});

/**
 * A memo stops at an approver who cannot act. It stops just as completely
 * whether that approver is holding it now or is third in the chain - the only
 * difference is that the second can be seen coming, and until now nothing
 * could be done with the warning: an administrator had to wait for the memo
 * to reach the person who had left, and unstick it once it was already stuck.
 */
describe("a step still ahead of the memo", () => {
  it("moves without disturbing where the memo is or who is holding it", async () => {
    await moveStep(3, admin.id, cast.bystander.id);

    const position = await currentPosition(documentId);
    expect(position.stepOrder).toBe(1);
    expect(position.assignedTo).toBe(cast.reviewer.id);
    expect(await chainHolders()).toEqual([
      cast.reviewer.id,
      cast.approver.id,
      cast.bystander.id,
    ]);
  });

  it("holds when the memo arrives, so the person who replaced them signs it", async () => {
    // The whole point. Without this the memo travels to a name that cannot
    // act and stops there, which is the state this feature exists to prevent.
    await moveStep(3, admin.id, cast.bystander.id);

    await approveAs(cast.reviewer.id);
    await approveAs(cast.approver.id);

    expect((await currentPosition(documentId)).assignedTo).toBe(cast.bystander.id);
    await expect(approveAs(cast.bystander.id)).resolves.toMatchObject({
      documentStatus: "APPROVED",
    });
  });

  it("leaves the deadline alone, because a step ahead has no clock running", async () => {
    /*
     * The step the memo is on restarts its clock when it is moved - the new
     * approver must not be chased for time somebody else used. A step ahead
     * has not started, so restarting anything here would reset the CURRENT
     * approver's deadline: moving step 3 would quietly give the person
     * holding step 1 a fresh week.
     */
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { documentId } });
    const started = new Date("2026-01-01T00:00:00.000Z");
    const chased = new Date("2026-01-08T00:00:00.000Z");
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { currentStepStartedAt: started, breachNotifiedAt: chased },
    });

    await moveStep(3, admin.id, cast.bystander.id);

    const after = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.currentStepStartedAt.getTime()).toBe(started.getTime());
    expect(after.breachNotifiedAt?.getTime()).toBe(chased.getTime());
  });

  it("refuses a step the memo has already passed", async () => {
    // It carries a signature. Rewriting whose name stands against it would
    // make the chain disagree with the action recorded on it.
    await approveAs(cast.reviewer.id);

    const refused = await moveStep(1, admin.id, cast.bystander.id).catch((e) => e as Error);

    expect(refused).toMatchObject({ statusCode: 400 });
    expect((await chainHolders())[0]).toBe(cast.reviewer.id);
  });

  it("refuses a step that is not on this memo", async () => {
    await expect(moveStep(9, admin.id, cast.bystander.id)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("still refuses somebody who already holds another step", async () => {
    // The chain rules do not relax because the step is further off.
    await expect(moveStep(3, admin.id, cast.approver.id)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("still refuses the preparer", async () => {
    await expect(moveStep(3, admin.id, cast.preparer.id)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("still refuses anybody but an administrator", async () => {
    await expect(
      moveStep(3, cast.preparer.id, cast.bystander.id),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("says the memo has not reached them yet, rather than that they were asked", async () => {
    const result = await moveStep(3, admin.id, cast.bystander.id);

    expect(result.message).toMatch(/when the memo reaches them/);
    expect(result.stepOrder).toBe(3);
    // Where the memo is, which moving a step ahead of it does not change.
    expect(result.currentStepOrder).toBe(1);
  });
});

describe("who is told about a step still ahead", () => {
  it("the person taken off it, and not that a memo 'moved' that was never theirs", async () => {
    await moveStep(3, admin.id, cast.bystander.id);

    const [notice] = await noticesFor(cast.finalApprover.id, "STEP_REASSIGNED");

    expect(notice?.title).toBe("You were taken off a memo's approval chain");
    expect(notice?.message).toMatch(/you were going to be asked to approve/);
    // Off the chain now, so the link every other notice carries would lead
    // them to "Access denied".
    expect(notice?.documentId).toBeNull();
  });

  it("the person put on it as news, not as work waiting on them", async () => {
    /*
     * APPROVAL_NEEDED would put the memo in their queue, which is a queue of
     * things to sign - and there is nothing for them to sign until the memo
     * gets there. That is the same mistake STEP_SKIPPED exists to avoid at
     * the other end of the chain.
     */
    await moveStep(3, admin.id, cast.bystander.id);

    expect(await noticesFor(cast.bystander.id, "APPROVAL_NEEDED")).toHaveLength(0);

    const [notice] = await noticesFor(cast.bystander.id, "STEP_REASSIGNED");
    expect(notice?.title).toBe("You were added to a memo's approval chain");
    expect(notice?.message).toMatch(/when the memo reaches you/);
    // They ARE on the chain, so this one can be opened - and reading it is
    // most of what somebody newly added to a chain wants to do.
    expect(notice?.documentId).toBe(documentId);
  });

  it("and asks them for the approval when the memo does reach them", async () => {
    await moveStep(3, admin.id, cast.bystander.id);
    await approveAs(cast.reviewer.id);
    await approveAs(cast.approver.id);

    expect(
      (await noticesFor(cast.bystander.id, "APPROVAL_NEEDED")).length,
    ).toBeGreaterThan(0);
  });

  it("not the colleague covering today, who is covering for work that is not due", async () => {
    /*
     * A delegation is an arrangement about who signs while somebody is away.
     * A step three places down is not being signed by anybody today, and
     * whoever is covering today may well be back before the memo arrives - so
     * copying them in is telling a person about work that is neither theirs
     * nor due.
     */
    await delegationsService.create(
      { delegateId: cast.bystander.id },
      { id: cast.finalApprover.id, isAdministrator: false },
    );
    const deputy = await makeUser({
      firstName: "Deputy",
      departmentId: cast.department.id,
    });

    await moveStep(3, admin.id, deputy.id);

    expect(await noticesFor(cast.bystander.id, "STEP_REASSIGNED")).toHaveLength(0);
  });

  it("the preparer, whose chain changed ahead of where the memo has got to", async () => {
    await moveStep(3, admin.id, cast.bystander.id);

    const [notice] = await noticesFor(cast.preparer.id, "STEP_REASSIGNED");

    expect(notice?.title).toBe("An approver ahead on your memo changed");
    expect(notice?.documentId).toBe(documentId);
  });
});

describe("what a step still ahead leaves behind", () => {
  it("a trail row saying the memo was not waiting on it", async () => {
    // Otherwise the trail cannot tell a memo that was unstuck from one that
    // was rerouted before it ever got there, and those read as the same event.
    await moveStep(3, admin.id, cast.bystander.id);

    const [row] = await trail();

    expect(row?.oldValue).toMatchObject({
      stepOrder: 3,
      assignedUserId: cast.finalApprover.id,
    });
    expect(row?.newValue).toMatchObject({
      stepOrder: 3,
      assignedUserId: cast.bystander.id,
      wasWaitingOnIt: false,
    });
  });

  it("and says it WAS waiting on the step the memo is sitting on", async () => {
    await move(admin.id, cast.bystander.id);

    const [row] = await trail();

    expect(row?.newValue).toMatchObject({ stepOrder: 1, wasWaitingOnIt: true });
  });

  it("a ledger row that names the step, so two moves do not read as one event", async () => {
    /*
     * Before a step ahead could be moved there was only ever one movable
     * step, so "which step" never needed saying. Now a memo can carry two of
     * these on the same day and the ledger is where somebody reads back who
     * it was with and how that changed - two rows with the same reason and no
     * step number are two accounts of one event.
     */
    await moveStep(3, admin.id, cast.bystander.id, "Kazim retires next month.");
    const standIn = await makeUser({
      firstName: "Standin",
      departmentId: cast.department.id,
    });
    await move(admin.id, standIn.id, "Ayesha has left the company.");

    const history = await auditService.getDocumentAuditHistory(documentId, admin.id);
    const rows = history
      .filter((entry) => entry.action === "WORKFLOW_STEP_REASSIGNED")
      .map((entry) => entry.comments);

    expect(rows).toContain("Step 3 — Kazim retires next month.");
    expect(rows).toContain("Step 1 — Ayesha has left the company.");
  });

  it("a line on the thread naming the step, so the chain can be read back", async () => {
    await moveStep(3, admin.id, cast.bystander.id, "Kazim retires next month.");

    const lines = (await thread()).map((comment) => comment.comment);

    expect(lines.some((line) => line.startsWith("Step 3 moved from"))).toBe(true);
    expect(lines.some((line) => line.includes("Kazim retires next month."))).toBe(true);
  });
});

describe("who is told", () => {
  it("the approver it was taken from, with no link, because it is no longer theirs to open", async () => {
    /*
     * A memo is visible to its preparer and to the people on its chain. The
     * moment the step moves they are on neither, so the link every other
     * notice carries would, for this one, lead to "Access denied". The memo
     * is named in the sentence instead.
     */
    await move(admin.id, cast.bystander.id);
    const [notice] = await noticesFor(cast.reviewer.id, "STEP_REASSIGNED");

    expect(notice.documentId).toBeNull();
    expect(notice.message).toContain("Warehouse lease extension");
    expect(notice.message).toContain("no longer assigned to you");
    expect(notice.message).toContain("Ayesha has left the company.");
  });

  it("and their mail still names the memo, even with no link in it", async () => {
    /*
     * The subject is built from the memo the notice points at, and this one
     * points at nothing on purpose. Without the memo named alongside, the
     * subject degrades to the bare verb: a mail reading "Reassigned", in an
     * inbox of forty others, about a memo the reader has to guess at.
     */
    await move(admin.id, cast.bystander.id);

    const mail = await prisma.emailMessage.findFirstOrThrow({
      where: { recipientId: cast.reviewer.id, subject: { startsWith: "Reassigned" } },
    });

    expect(mail.subject).toContain("Warehouse lease extension");
    expect(mail.body).not.toContain("/documents/");
  });

  it("and the colleague covering for them, who would have been asked to sign it", async () => {
    const cover = await makeUser({
      firstName: "Cover",
      departmentId: cast.department.id,
    });
    await delegationsService.create(
      { delegateId: cover.id },
      { id: cast.reviewer.id, isAdministrator: false },
    );

    await move(admin.id, cast.bystander.id);

    expect(await noticesFor(cover.id, "STEP_REASSIGNED")).toHaveLength(1);
  });

  it("the new approver, as work rather than news", async () => {
    await move(admin.id, cast.bystander.id);
    const [notice] = await noticesFor(cast.bystander.id, "APPROVAL_NEEDED");

    expect(notice.documentId).toBe(documentId);
    expect(notice.message).toContain("requires your review and approval");
    // Why it landed on them, which is the question they are about to ask.
    expect(notice.message).toContain("Ayesha has left the company.");
  });

  it("the preparer, who is waiting on it and did not do this", async () => {
    await move(admin.id, cast.bystander.id);
    const [notice] = await noticesFor(cast.preparer.id, "STEP_REASSIGNED");

    expect(notice.documentId).toBe(documentId);
    expect(notice.message).toContain("moved from Reviewer User to Bystander User");
  });

  it("but never the person who did it", async () => {
    // An administrator prepares memos like anybody else. Telling somebody
    // what they have just done is how a notification list becomes noise.
    const own = await submitDocument({
      preparerId: admin.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });

    await approvalService.reassignStep(own.id, admin.id, {
      userId: cast.bystander.id,
      reason: "Reviewer is away.",
    });

    expect(await noticesFor(admin.id, "STEP_REASSIGNED")).toHaveLength(0);
  });
});

describe("what it leaves behind", () => {
  it("a trail row naming who moved it, off whom, onto whom and why", async () => {
    await move(admin.id, cast.bystander.id, "Ayesha has left the company.", "203.0.113.7");
    const [entry] = await trail();

    expect(entry.actorId).toBe(admin.id);
    expect(entry.ipAddress).toBe("203.0.113.7");
    expect(entry.oldValue).toMatchObject({
      stepOrder: 1,
      assignedUserId: cast.reviewer.id,
    });
    expect(entry.newValue).toMatchObject({
      stepOrder: 1,
      assignedUserId: cast.bystander.id,
      reason: "Ayesha has left the company.",
    });
  });

  it("a row on the memo's own ledger, which is where the process is read", async () => {
    /*
     * The thread is a conversation and the trail is a record, and this
     * belongs in both. The ledger tab is where somebody answers "who was
     * this memo with, and how did that change" - and a reassignment arriving
     * with no row there leaves the chain showing a name that nothing on the
     * page accounts for.
     *
     * It reaches the ledger from the audit log rather than from the approval
     * actions, because no approval happened: the two halves of a memo's
     * history are separate tables, and this one writes only to the first.
     */
    await move(admin.id, cast.bystander.id);

    const history = await auditService.getDocumentAuditHistory(
      documentId,
      admin.id,
    );
    const row = history.find((entry) => entry.action === "WORKFLOW_STEP_REASSIGNED");

    expect(row).toBeDefined();
    expect(row?.user.id).toBe(admin.id);
    // The capacity it was done in, which only an administrator has.
    expect(row?.role).toBe("Administrator");
    // And why, without opening the thread.
    expect(row?.comments).toContain("Ayesha has left the company.");
  });

  it("a line on the memo's own thread, where the people party to it can read it", async () => {
    // The trail is an administrator's screen. The approvers waiting behind
    // this step never see it, and they are the ones who will wonder why the
    // name at the top of the memo changed.
    await move(admin.id, cast.bystander.id);
    const comments = await thread();
    const line = comments[comments.length - 1];

    expect(line?.authorId).toBe(admin.id);
    expect(line?.comment).toBe(
      "Step 1 moved from Reviewer User to Bystander User: Ayesha has left the company.",
    );
  });

  it("nothing at all when it is refused", async () => {
    await expect(move(admin.id, cast.preparer.id)).rejects.toThrow();

    expect(await trail()).toHaveLength(0);
    expect((await currentPosition(documentId)).assignedTo).toBe(cast.reviewer.id);
  });
});
