import { beforeEach, describe, expect, it } from "vitest";
import {
  chainOf,
  makeCast,
  makeUser,
  signature,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { approvalService } from "./approval.service";
import { delegationsService } from "./delegations.service";
import { documentsService } from "./documents.service";
import { workflowService } from "./workflow.service";

/**
 * What somebody covering another person's approvals is actually shown.
 *
 * The delegation feature was write-enabled and invisible. `approve` consulted
 * `authorityOver` and accepted a delegate's signature; nothing else did.
 * The queue counted a memo against the person who was away, and the workflow
 * response named them as the assignee - which is the only thing the screen had
 * to decide whether to offer a Sign button. So the delegate was emailed that a
 * memo needed them, opened it, and was offered nothing to press.
 *
 * These tests are about the two answers that were missing rather than about
 * the approval itself, which always worked.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;
let deputy: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  cast = await makeCast();
  deputy = await makeUser({ firstName: "Deputy", departmentId: cast.department.id });
});

/** Hand the reviewer's approvals to the deputy, from now on. */
const handOver = () =>
  delegationsService.create(
    { delegateId: deputy.id },
    { id: cast.reviewer.id, isAdministrator: false }
  );

const submit = () =>
  submitDocument({
    preparerId: cast.preparer.id,
    approvalChain: chainOf(cast.reviewer, cast.finalApprover),
  });

describe("the queue", () => {
  it("counts a memo waiting on somebody whose approvals you are covering", async () => {
    await handOver();
    await submit();

    expect(await documentsService.getPendingApprovalCount(deputy.id)).toEqual({
      count: 1,
    });
  });

  it("counts nothing before the delegation exists", async () => {
    await submit();

    expect(await documentsService.getPendingApprovalCount(deputy.id)).toEqual({
      count: 0,
    });
  });

  it("stops counting it once the delegation is revoked", async () => {
    const delegation = await handOver();
    await submit();

    await delegationsService.revoke(delegation.id, {
      id: cast.reviewer.id,
      isAdministrator: false,
    });

    expect(await documentsService.getPendingApprovalCount(deputy.id)).toEqual({
      count: 0,
    });
  });

  it("still counts your own steps, which is the ordinary case", async () => {
    await handOver();
    await submit();

    expect(await documentsService.getPendingApprovalCount(cast.reviewer.id)).toEqual({
      count: 1,
    });
  });

  it("never counts a memo you prepared yourself, delegation or not", async () => {
    // Arranging cover for somebody does not make you an approver of your own
    // memo, and the queue must not offer you one.
    await delegationsService.create(
      { delegateId: cast.preparer.id },
      { id: cast.reviewer.id, isAdministrator: false }
    );
    await submit();

    expect(await documentsService.getPendingApprovalCount(cast.preparer.id)).toEqual({
      count: 0,
    });
  });

  it("does not count a step that is not the one the memo is sitting at", async () => {
    // Covering the final approver while the memo is still with the reviewer is
    // work that is coming, not work that is waiting.
    await delegationsService.create(
      { delegateId: deputy.id },
      { id: cast.finalApprover.id, isAdministrator: false }
    );
    await submit();

    expect(await documentsService.getPendingApprovalCount(deputy.id)).toEqual({
      count: 0,
    });
  });
});

describe("the queue list agrees with the badge", () => {
  /*
   * The sidebar badge is `getPendingApprovalCount`; My queue is the document
   * list, filtered on `awaitingMyAction`. The list used to leave that
   * decision to the browser, which compared the step's assignee with the
   * signed-in user and knew nothing of delegations - so a delegate's badge
   * said 1 and their queue was empty. Every case here asks both, for
   * everybody in the cast, and requires the same answer.
   */
  const everybody = () => [
    cast.preparer,
    cast.reviewer,
    cast.finalApprover,
    deputy,
  ];

  async function awaitingIn(userId: string) {
    const { documents } = await documentsService.getDocuments(userId);
    return documents
      .filter((document) => document.awaitingMyAction)
      .map((document) => document.id);
  }

  async function expectAgreement(expected: Record<string, string[]>) {
    for (const person of everybody()) {
      const listed = await awaitingIn(person.id);
      const { count } = await documentsService.getPendingApprovalCount(person.id);
      expect({ person: person.firstName, listed, count }).toEqual({
        person: person.firstName,
        listed: expected[person.id] ?? [],
        count: (expected[person.id] ?? []).length,
      });
    }
  }

  it("puts a covered memo in the delegate's queue, and still in the holder's", async () => {
    await handOver();
    const document = await submit();

    await expectAgreement({
      [deputy.id]: [document.id],
      [cast.reviewer.id]: [document.id],
    });
  });

  it("puts nothing in the delegate's queue before the delegation exists", async () => {
    const document = await submit();

    await expectAgreement({ [cast.reviewer.id]: [document.id] });
  });

  it("takes it out of the delegate's queue once the delegation is revoked", async () => {
    const delegation = await handOver();
    const document = await submit();
    await delegationsService.revoke(delegation.id, {
      id: cast.reviewer.id,
      isAdministrator: false,
    });

    await expectAgreement({ [cast.reviewer.id]: [document.id] });
  });

  it("never queues a memo for the person who prepared it", async () => {
    await delegationsService.create(
      { delegateId: cast.preparer.id },
      { id: cast.reviewer.id, isAdministrator: false }
    );
    const document = await submit();

    await expectAgreement({ [cast.reviewer.id]: [document.id] });
  });

  it("does not queue a covered step the memo has not reached", async () => {
    await delegationsService.create(
      { delegateId: deputy.id },
      { id: cast.finalApprover.id, isAdministrator: false }
    );
    const document = await submit();

    await expectAgreement({ [cast.reviewer.id]: [document.id] });
  });

  it("moves it on with the step", async () => {
    await delegationsService.create(
      { delegateId: deputy.id },
      { id: cast.finalApprover.id, isAdministrator: false }
    );
    const document = await submit();
    await approvalService.approve(document.id, cast.reviewer.id, signature());

    await expectAgreement({
      [cast.finalApprover.id]: [document.id],
      [deputy.id]: [document.id],
    });
  });
});

describe("what the screen is told it may do", () => {
  it("says a delegate may act, and whose step it is", async () => {
    await handOver();
    const document = await submit();

    const workflow = await workflowService.getWorkflow(document.id, deputy.id);

    expect(workflow.viewer.canAct).toBe(true);
    expect(workflow.viewer.onBehalfOf).toMatchObject({ id: cast.reviewer.id });
  });

  it("says the assignee may act, on nobody's behalf", async () => {
    await handOver();
    const document = await submit();

    const workflow = await workflowService.getWorkflow(document.id, cast.reviewer.id);

    expect(workflow.viewer.canAct).toBe(true);
    expect(workflow.viewer.onBehalfOf).toBeNull();
  });

  it("refuses somebody with no part in it the workflow at all", async () => {
    // Not a `canAct: false` - they never reach the question. Worth pinning
    // here so the new field cannot become a way to learn who is on a chain
    // you are not entitled to see.
    const document = await submit();

    await expect(
      workflowService.getWorkflow(document.id, cast.bystander.id)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses an approver whose turn has not come", async () => {
    await handOver();
    const document = await submit();

    // The reviewer's delegate may act; the delegate of a later step may not,
    // and neither may the later approver once they can see it.
    const workflow = await workflowService.getWorkflow(document.id, deputy.id);
    expect(workflow.viewer.onBehalfOf).toMatchObject({ id: cast.reviewer.id });
    expect(workflow.viewer.onBehalfOf).not.toMatchObject({
      id: cast.finalApprover.id,
    });
  });

  it("refuses the preparer, who never approves their own memo", async () => {
    const document = await submit();

    const workflow = await workflowService.getWorkflow(document.id, cast.preparer.id);

    expect(workflow.viewer.canAct).toBe(false);
  });

  it("agrees with what approving actually allows", async () => {
    /*
     * The point of asking the server rather than reading the chain: what is
     * offered and what is honoured come from one rule, so they cannot drift
     * apart. A button that is offered and then refused is the same defect in
     * the other direction.
     */
    await handOver();
    const document = await submit();

    const workflow = await workflowService.getWorkflow(document.id, deputy.id);
    const { useSavedSignature: _saved, ...placement } = signature();

    await expect(
      approvalService.approve(document.id, deputy.id, {
        ...placement,
        useSavedSignature: false,
      })
    ).resolves.toBeDefined();
    expect(workflow.viewer.canAct).toBe(true);
  });

  it("stops saying so once the step has moved on", async () => {
    await handOver();
    const document = await submit();
    const { useSavedSignature: _saved, ...placement } = signature();
    await approvalService.approve(document.id, deputy.id, {
      ...placement,
      useSavedSignature: false,
    });

    const workflow = await workflowService.getWorkflow(document.id, deputy.id);

    expect(workflow.viewer.canAct).toBe(false);
  });
});
