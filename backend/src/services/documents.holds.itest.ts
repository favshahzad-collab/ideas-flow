import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  makeUser,
  missingId,
  signature,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { approvalService } from "./approval.service";
import { documentsService } from "./documents.service";

/**
 * What stops if this person does.
 *
 * The question an administrator has when somebody resigns or goes on long
 * leave, and the one the product could not answer: every screen was organised
 * by memo, so "Kazim leaves on Friday - what breaks?" could only be answered
 * by opening every memo in flight and reading its chain. In practice it was
 * answered by waiting for the memo to stop.
 *
 * What these hold is that the answer is complete - nothing that stops is
 * missing from it - and that it is not padded with memos that would move
 * perfectly well without them. A list that over-reports is as useless as one
 * that under-reports: an administrator who is told forty memos depend on
 * somebody stops reading it.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;

beforeEach(async () => {
  cast = await makeCast();
});

const heldBy = (user: { id: string }) => documentsService.getMemosHeldBy(user.id);

const approveAs = (documentId: string, actorId: string) => {
  const { useSavedSignature: _saved, ...placement } = signature();
  return approvalService.approve(documentId, actorId, {
    ...placement,
    useSavedSignature: false,
  });
};

const submit = (title = "Warehouse lease extension") =>
  submitDocument({
    preparerId: cast.preparer.id,
    approvalChain: chainOf(cast.reviewer, cast.approver, cast.finalApprover),
    title,
  });

describe("the memo sitting with them now", () => {
  it("is reported, with how long it has been there", async () => {
    await submit();

    const held = await heldBy(cast.reviewer);

    expect(held.holdingNow).toHaveLength(1);
    expect(held.holdingNow[0]?.stepOrder).toBe(1);
    expect(held.holdingNow[0]?.heldSince).toBeInstanceOf(Date);
    expect(held.holdingNow[0]?.stepsAway).toBe(0);
  });

  it("names it the way somebody would quote it back", async () => {
    const document = await submit();

    const [entry] = (await heldBy(cast.reviewer)).holdingNow;

    expect(entry?.documentId).toBe(document.id);
    expect(entry?.title).toBe("Warehouse lease extension");
    expect(entry?.preparer.id).toBe(cast.preparer.id);
  });
});

describe("the memo that will reach them", () => {
  it("is reported before it stops, which is the whole point of asking", async () => {
    /*
     * The reason this exists. A memo stops just as completely at an approver
     * three places down; the difference is that this one can be seen coming,
     * and seeing it coming was worth nothing while the only way to find out
     * was to open every memo in flight.
     */
    await submit();

    const held = await heldBy(cast.finalApprover);

    expect(held.holdingNow).toHaveLength(0);
    expect(held.ahead).toHaveLength(1);
    expect(held.ahead[0]?.stepOrder).toBe(3);
  });

  it("says how many approvals away it is, not just that it is coming", async () => {
    // The difference between "look at this today" and "before month end".
    await submit();

    expect((await heldBy(cast.approver)).ahead[0]?.stepsAway).toBe(1);
    expect((await heldBy(cast.finalApprover)).ahead[0]?.stepsAway).toBe(2);
  });

  it("carries no deadline, because a step that has not started has none", async () => {
    // A due date on a step nobody has reached would be a commitment nobody
    // made, counted down from a clock that is not running.
    await submit();

    const [entry] = (await heldBy(cast.finalApprover)).ahead;

    expect(entry?.heldSince).toBeNull();
    expect(entry?.dueAt).toBeNull();
  });

  it("moves into 'with them now' as the memo arrives", async () => {
    const document = await submit();

    await approveAs(document.id, cast.reviewer.id);
    const held = await heldBy(cast.approver);

    expect(held.ahead).toHaveLength(0);
    expect(held.holdingNow).toHaveLength(1);
  });
});

describe("the memo sent back to them", () => {
  it("is reported, because only its preparer can resubmit it", async () => {
    /*
     * The third way one person stops a memo, and the one with no cure in
     * reassignment: `updateDocument` refuses anybody but the preparer in so
     * many words, so moving an approver changes nothing about who may correct
     * the document. A screen that offered a reassign button here would be
     * offering something that cannot help.
     */
    const document = await submit();
    await approvalService.requestRevision(document.id, cast.reviewer.id, {
      comment: "The dates in clause 4 do not match the annexure.",
    });

    const held = await heldBy(cast.preparer);

    expect(held.returned).toHaveLength(1);
    expect(held.returned[0]?.documentId).toBe(document.id);
    // No step, because the preparer has none: they are not on the chain.
    expect(held.returned[0]?.stepOrder).toBeNull();
    expect(held.returned[0]?.totalSteps).toBeNull();
  });

  /*
   * The other side of the same memo, which used to answer zero for everybody
   * but the preparer.
   *
   * This file said so in a test of its own - "is not reported against the
   * approver who sent it back: they did their part, the memo is not waiting
   * on them" - and that reading is wrong about what a resubmission does.
   * `updateDocument` supersedes the returned run and starts a NEW one over
   * the same chain at step one, so every approver on it is asked again,
   * including the one who signed before it was sent back and the one who
   * sent it back. Driven, on a chain of three with step one already signed:
   * after the resubmission the memo sits on step 1, assigned to the reviewer,
   * run IN_PROGRESS.
   *
   * So an administrator could switch an approver off while a memo that will
   * stop dead at their step sat with its preparer, having been told in so
   * many words that nothing waits on them. And it is precisely the case the
   * warning exists for: a returned memo can sit for days, which is time to
   * act in, and reassignment cannot be used until it comes back.
   */
  it("is reported against every approver it will travel to again", async () => {
    const document = await submit();
    await approveAs(document.id, cast.reviewer.id);
    await approvalService.requestRevision(document.id, cast.approver.id, {
      comment: "The dates in clause 4 do not match the annexure.",
    });

    for (const [person, step] of [
      [cast.reviewer, 1],
      [cast.approver, 2],
      [cast.finalApprover, 3],
    ] as const) {
      const held = await heldBy(person);

      expect(held.comingBack.map((entry) => entry.documentId)).toEqual([
        document.id,
      ]);
      expect(held.comingBack[0]?.stepOrder).toBe(step);
      expect(held.comingBack[0]?.totalSteps).toBe(3);
      // Counted, or the dialog that reads one number still says nothing stops.
      expect(held.total).toBe(1);
    }
  });

  it("is reported against the approver who sent it back, who will see it again", async () => {
    // The step they signed runs again from the top, so "they did their part"
    // is true of the run that was returned and of nothing after it.
    const document = await submit();
    await approveAs(document.id, cast.reviewer.id);
    await approvalService.requestRevision(document.id, cast.approver.id, {
      comment: "The dates in clause 4 do not match the annexure.",
    });

    expect((await heldBy(cast.reviewer)).comingBack).toHaveLength(1);
  });

  it("says how far down the chain they are when it comes round again", async () => {
    // Counted from step one, which is where a resubmission restarts - not
    // from wherever the memo had got to when it was sent back.
    const document = await submit();
    await approveAs(document.id, cast.reviewer.id);
    await approvalService.requestRevision(document.id, cast.approver.id, {
      comment: "Clause 4 again.",
    });

    expect((await heldBy(cast.finalApprover)).comingBack[0]?.stepsAway).toBe(2);
  });

  it("carries no wait and no deadline, because nothing is running against it", async () => {
    // The memo is with its preparer. A "waiting 3d" against an approver who
    // is not being waited on is the list over-reporting in the other
    // direction.
    const document = await submit();
    await approveAs(document.id, cast.reviewer.id);
    await approvalService.requestRevision(document.id, cast.approver.id, {
      comment: "Clause 4 again.",
    });

    const [entry] = (await heldBy(cast.finalApprover)).comingBack;

    expect(entry?.heldSince).toBeNull();
    expect(entry?.dueAt).toBeNull();
  });

  it("is not reported twice to a preparer who is also on the chain", async () => {
    /*
     * Not reachable through the form - the wizard and the service both refuse
     * a chain naming the preparer - but the two queries overlap by
     * construction and one memo counted twice against one person is the sort
     * of thing that turns a warning into noise. Built directly, because the
     * front door refuses it.
     */
    const document = await submit();
    await approveAs(document.id, cast.reviewer.id);
    await approvalService.requestRevision(document.id, cast.approver.id, {
      comment: "Clause 4 again.",
    });
    const chain = await prisma.approvalChain.findFirstOrThrow({
      where: { documentId: document.id },
    });
    await prisma.approvalChainStep.updateMany({
      where: { chainId: chain.id, stepOrder: 3 },
      data: { assignedUserId: cast.preparer.id },
    });

    const held = await heldBy(cast.preparer);

    expect(held.returned).toHaveLength(1);
    expect(held.comingBack).toEqual([]);
    expect(held.total).toBe(1);
  });
});

describe("what it must not report", () => {
  it("nothing for a step they have already signed", async () => {
    /*
     * Otherwise somebody who approved forty memos last month tops the list of
     * people holding things up, and the list stops being read.
     */
    const document = await submit();

    await approveAs(document.id, cast.reviewer.id);

    const held = await heldBy(cast.reviewer);
    expect(held.total).toBe(0);
  });

  it("nothing for a memo that has finished", async () => {
    const document = await submit();
    await approveAs(document.id, cast.reviewer.id);
    await approveAs(document.id, cast.approver.id);
    await approveAs(document.id, cast.finalApprover.id);

    expect((await heldBy(cast.finalApprover)).total).toBe(0);
  });

  it("nothing for a memo that was rejected", async () => {
    const document = await submit();
    await approvalService.reject(document.id, cast.reviewer.id, {
      comment: "The lease is not ours to extend.",
    });

    expect((await heldBy(cast.approver)).total).toBe(0);
  });

  it("nothing for a memo still in draft, which is waiting on nobody", async () => {
    /*
     * A draft has a chain on it and has not been sent, so nothing is stopped
     * and nobody is waiting. Counting it would report work that does not
     * exist - and would do it against every approver a preparer had merely
     * typed into a form.
     *
     * Set directly, because `createDocument` submits: DRAFT is a state the
     * column allows and no service path currently leaves a document in. The
     * filter still has to hold, or the day one does it reports nonsense.
     */
    const document = await submit("Not sent yet");
    await prisma.document.update({
      where: { id: document.id },
      data: { status: "DRAFT" },
    });

    expect((await heldBy(cast.reviewer)).total).toBe(0);
  });

  it("nothing for somebody with a clear desk", async () => {
    await submit();

    const held = await heldBy(cast.bystander);

    expect(held.total).toBe(0);
    expect(held.holdingNow).toEqual([]);
    expect(held.ahead).toEqual([]);
    expect(held.returned).toEqual([]);
  });
});

describe("the answer as a whole", () => {
  it("counts all four ways a memo stops at them", async () => {
    // One number, because that is what a confirmation dialog has room for.
    const first = await submit("One");
    await submit("Two");
    await approvalService.requestRevision(first.id, cast.reviewer.id, {
      comment: "Needs the annexure.",
    });

    const reviewer = await heldBy(cast.reviewer);
    const preparer = await heldBy(cast.preparer);
    const finalApprover = await heldBy(cast.finalApprover);

    // The reviewer holds "Two" now and will be asked for "One" again when it
    // is resubmitted. Counting only the first is what this used to do, and it
    // is the half of the answer that was never in doubt.
    expect(reviewer.holdingNow).toHaveLength(1);
    expect(reviewer.comingBack).toHaveLength(1);
    expect(reviewer.total).toBe(2);

    // The final approver is ahead on "Two" and on the chain "One" will travel
    // again.
    expect(finalApprover.ahead).toHaveLength(1);
    expect(finalApprover.comingBack).toHaveLength(1);
    expect(finalApprover.total).toBe(2);

    // The preparer has the one correction to make, and no step anywhere.
    expect(preparer.returned).toHaveLength(1);
    expect(preparer.total).toBe(1);
  });

  it("names the person, so a screen can say whose list this is", async () => {
    const held = await heldBy(cast.reviewer);

    expect(held.person.id).toBe(cast.reviewer.id);
    expect(held.person.email).toBe(cast.reviewer.email);
  });

  it("refuses somebody who is not there, rather than answering empty", async () => {
    // An empty answer for a missing id reads as "nothing depends on them",
    // which is the most dangerous wrong answer this can give.
    await expect(
      documentsService.getMemosHeldBy(missingId()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("crosses the whole organisation, not one department", async () => {
    const elsewhere = await makeUser({ firstName: "Outsider" });
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(elsewhere, cast.finalApprover),
      title: "Cross-department",
    });

    expect((await heldBy(elsewhere)).holdingNow[0]?.documentId).toBe(document.id);
  });

  it("reports both steps when one person holds two on a chain", async () => {
    /*
     * Nothing on offer creates this - the chain builder refuses a duplicate
     * approver and so does reassignment - but the shape of the data allows
     * it, and a list that silently dropped the second would under-report the
     * very thing it exists to report.
     */
    const document = await submit();
    const run = await prisma.workflowRun.findFirstOrThrow({
      where: { documentId: document.id },
      include: { chain: { include: { steps: true } } },
    });
    const third = run.chain.steps.find((step) => step.stepOrder === 3)!;
    await prisma.approvalChainStep.update({
      where: { id: third.id },
      data: { assignedUserId: cast.reviewer.id },
    });

    const held = await heldBy(cast.reviewer);

    expect(held.holdingNow).toHaveLength(1);
    expect(held.ahead).toHaveLength(1);
    expect(held.total).toBe(2);
  });
});
