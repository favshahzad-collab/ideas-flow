import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  makeUser,
  signature,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { approvalService } from "./approval.service";
import { documentsService } from "./documents.service";

/**
 * The Control room's figures, against a real database.
 *
 * This is the only screen that shows an administrator every workflow in the
 * organisation, and it exists to answer one question: which memos have
 * stopped. Two of its numbers are decisions rather than descriptions - the
 * "stalled" count and the tint on a row both come from `heldSince`, and an
 * administrator reads them to decide whether to chase somebody or move the
 * step off them.
 *
 * It had no test of any kind. The route guard was proved; what the route
 * ANSWERS was not, so every figure on the board rested on nothing.
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

const board = () => documentsService.getApprovalOversight();

const rowFor = async (id: string) => {
  const { items } = await board();
  return items.find((item) => item.id === id);
};

const approveAs = (actorId: string) => {
  const { useSavedSignature: _saved, ...placement } = signature();
  return approvalService.approve(documentId, actorId, {
    ...placement,
    useSavedSignature: false,
  });
};

const DAY = 24 * 60 * 60 * 1000;

/** Age the run, as though the memo had been sitting there for `days`. */
async function sittingFor(days: number) {
  const when = new Date(Date.now() - days * DAY);

  await prisma.workflowRun.updateMany({
    where: { documentId },
    data: { startedAt: when, currentStepStartedAt: when },
  });
}

/** Within a minute of now, which on a test run means "just happened". */
const justNow = (moment: Date | string) =>
  Date.now() - new Date(moment).getTime() < 60_000;

describe("what is on the board", () => {
  it("shows a memo that is waiting on somebody", async () => {
    const row = await rowFor(documentId);

    expect(row).toBeDefined();
    expect(row?.title).toBe("Warehouse lease extension");
    expect(row?.holder?.id).toBe(cast.reviewer.id);
    expect(row?.currentStepOrder).toBe(1);
    expect(row?.totalSteps).toBe(3);
  });

  it("names the memo by its reference, which is what somebody quotes", async () => {
    const row = await rowFor(documentId);

    expect(row?.referenceNumber).toMatch(/^MEMO-/);
  });

  it.each(["APPROVED", "REJECTED", "REVISION_REQUESTED", "DRAFT"] as const)(
    "leaves out a %s memo, which is waiting on nobody",
    async (status) => {
      await prisma.document.update({ where: { id: documentId }, data: { status } });

      expect(await rowFor(documentId)).toBeUndefined();
    },
  );

  it("is the whole organisation, not one person's slice", async () => {
    // The point of the screen. An administrator's own document list is
    // narrower than an ordinary approver's, so without this they could not
    // find a stalled memo they were not party to.
    const other = await makeCast();
    const theirs = await submitDocument({
      preparerId: other.preparer.id,
      approvalChain: chainOf(other.reviewer, other.finalApprover),
    });

    const { items } = await board();

    expect(items.map((item) => item.id)).toEqual(
      expect.arrayContaining([documentId, theirs.id]),
    );
  });
});

describe("how long it has been sitting", () => {
  /*
   * `heldSince` is not "how old is this memo". It is how long it has sat with
   * the person holding it NOW, which is the only version of the question an
   * administrator can act on - the memo may have moved through four people
   * quite briskly and stopped dead at the fifth.
   */

  it("starts at the submission for a memo still on its first step", async () => {
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { documentId } });
    const row = await rowFor(documentId);

    expect(new Date(row!.heldSince).getTime()).toBe(run.startedAt.getTime());
  });

  it("restarts when an approval moves it on to the next person", async () => {
    await sittingFor(7);

    await approveAs(cast.reviewer.id);
    const row = await rowFor(documentId);

    expect(row?.holder?.id).toBe(cast.approver.id);
    expect(justNow(row!.heldSince)).toBe(true);
  });

  it("restarts when the step is moved to a different approver", async () => {
    /*
     * The case this was wrong for, and the worst one to be wrong for: an
     * administrator looks at the board, sees a memo stuck for a week, moves
     * the step to somebody who can act - and the board still says a week,
     * still tinted red, now against a person who received it a moment ago.
     * The obvious next thing to do about a row like that is move it again.
     *
     * A reassignment writes no approval action, because nobody approved
     * anything; the run's own `currentStepStartedAt` is what moved. Rebuilding
     * the answer from the action history could not see it.
     */
    await sittingFor(7);

    await approvalService.reassignStep(documentId, admin.id, {
      userId: cast.bystander.id,
      reason: "Reviewer has left the company.",
    });
    const row = await rowFor(documentId);

    expect(row?.holder?.id).toBe(cast.bystander.id);
    expect(justNow(row!.heldSince)).toBe(true);
  });

  it("agrees with the deadline, which is measured from the same moment", async () => {
    // Two answers to "since when" is one answer too many: `dueAt` reads the
    // run's own column, and `heldSince` used to reconstruct it from elsewhere.
    // They agreed until something moved a step without approving it.
    await sittingFor(7);
    await approvalService.reassignStep(documentId, admin.id, {
      userId: cast.bystander.id,
      reason: "Reviewer has left the company.",
    });

    const run = await prisma.workflowRun.findFirstOrThrow({ where: { documentId } });
    const row = await rowFor(documentId);

    expect(new Date(row!.heldSince).getTime()).toBe(
      run.currentStepStartedAt.getTime(),
    );
  });
});

describe("the deadline", () => {
  it("is null where the deployment has set none, rather than invented", async () => {
    // What keeps the Control room's breach card off rather than showing a
    // green zero, which would be a claim that nothing is late on a
    // deployment where nothing could be.
    const row = await rowFor(documentId);

    expect(row?.dueAt).toBeNull();
    expect(row?.chasedAt).toBeNull();
  });

  it("is set from the step's own working days where it names them", async () => {
    await prisma.approvalChainStep.updateMany({
      where: { chain: { documentId }, stepOrder: 1 },
      data: { slaDays: 3 },
    });

    const row = await rowFor(documentId);

    expect(row?.dueAt).not.toBeNull();
  });
});
