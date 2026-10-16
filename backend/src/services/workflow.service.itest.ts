import { beforeEach, describe, expect, it } from "vitest";
import {
  chainOf,
  makeCast,
  missingId,
  signature,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { allowStepSkipInThisSuite } from "../test/stepSkip";
import { approvalService } from "./approval.service";
import { workflowService } from "./workflow.service";

/**
 * The chain as the detail screen draws it: who is on it, in what order, where
 * it has got to, and what each person did. Same visibility rule as the
 * document - the progress of a document you cannot open is still information
 * about it.
 */

useCleanDatabase();

// One scenario below has the preparer skip a reviewer, which a deployment has
// to switch on before it is possible at all.
allowStepSkipInThisSuite();

let cast: Awaited<ReturnType<typeof makeCast>>;
let documentId: string;

beforeEach(async () => {
  cast = await makeCast();
  const document = await submitDocument({
    preparerId: cast.preparer.id,
    approvalChain: chainOf(cast.reviewer, cast.approver, cast.finalApprover),
  });
  documentId = document.id;
});

const approveAs = (actorId: string) => {
  const { useSavedSignature: _saved, ...placement } = signature();
  return approvalService.approve(documentId, actorId, {
    ...placement,
    useSavedSignature: false,
  });
};

/** The view, as the detail screen consumes it. */
const view = (userId: string) =>
  workflowService.getWorkflow(documentId, userId) as Promise<{
    documentStatus: string;
    workflowStatus: string | null;
    currentStepOrder: number | null;
    workflow?: {
      stepOrder: number;
      assignedUser: { id: string };
      status: string;
      comment: string | null;
    }[];
  }>;

const statuses = async (userId: string) =>
  (await view(userId)).workflow?.map((step) => step.status);

describe("getWorkflow", () => {
  it("returns the chain in order with who is on each step", async () => {
    const workflow = await view(cast.preparer.id);

    expect(workflow.workflow?.map((step) => step.stepOrder)).toEqual([1, 2, 3]);
    expect(workflow.workflow?.map((step) => step.assignedUser.id)).toEqual([
      cast.reviewer.id,
      cast.approver.id,
      cast.finalApprover.id,
    ]);
  });

  it("marks the step it is waiting on, and only that one", async () => {
    // The whole point of the view: one row is somebody's problem right now.
    expect(await statuses(cast.preparer.id)).toEqual([
      "PENDING",
      "WAITING",
      "WAITING",
    ]);
  });

  it("shows what has been done so far", async () => {
    await approveAs(cast.reviewer.id);

    const workflow = await view(cast.preparer.id);

    expect(workflow.currentStepOrder).toBe(2);
    expect(workflow.workflow?.map((step) => step.status)).toEqual([
      "APPROVE",
      "PENDING",
      "WAITING",
    ]);
  });

  it("shows every step approved once the run completes", async () => {
    await approveAs(cast.reviewer.id);
    await approveAs(cast.approver.id);
    await approveAs(cast.finalApprover.id);

    const workflow = await view(cast.preparer.id);

    expect(workflow.documentStatus).toBe("APPROVED");
    expect(workflow.workflow?.map((step) => step.status)).toEqual([
      "APPROVE",
      "APPROVE",
      "APPROVE",
    ]);
    // Not the run's last index: a completed workflow reads as being at its
    // end, not at the step it happened to stop on.
    expect(workflow.currentStepOrder).toBe(3);
  });

  it("keeps the steps before a rejection marked as approved", async () => {
    await approveAs(cast.reviewer.id);
    await approvalService.reject(documentId, cast.approver.id, {
      comment: "The figures do not add up.",
    });

    const workflow = await view(cast.preparer.id);

    expect(workflow.documentStatus).toBe("REJECTED");
    expect(workflow.workflow?.map((step) => step.status)).toEqual([
      "APPROVE",
      "REJECT",
      "WAITING",
    ]);
    expect(workflow.workflow?.[1].comment).toBe("The figures do not add up.");
  });

  it("resets the whole chain to waiting when a revision is asked for", async () => {
    // The run is superseded and the document is back with the preparer, so
    // nothing in the chain is anyone's problem until it is resubmitted.
    await approvalService.requestRevision(documentId, cast.reviewer.id, {
      comment: "Page 2 is unsigned.",
    });

    const workflow = await view(cast.preparer.id);

    expect(workflow.documentStatus).toBe("REVISION_REQUESTED");
    expect(workflow.workflowStatus).toBeNull();
    expect(workflow.currentStepOrder).toBeNull();
    expect(workflow.workflow?.map((step) => step.status)).toEqual([
      "WAITING",
      "WAITING",
      "WAITING",
    ]);
  });

  it("records a skipped step as skipped, not approved", async () => {
    await approvalService.skipWorkflowStep(documentId, cast.preparer.id, {
      reason: "On leave until next month.",
    });

    expect(await statuses(cast.preparer.id)).toEqual([
      "SKIP",
      "PENDING",
      "WAITING",
    ]);
  });

  it("is visible to the approver it is sitting with", async () => {
    await expect(
      workflowService.getWorkflow(documentId, cast.reviewer.id)
    ).resolves.toBeTruthy();
  });

  it("refuses an approver the workflow has not reached", async () => {
    await expect(
      workflowService.getWorkflow(documentId, cast.finalApprover.id)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("opens up to that approver once it reaches them", async () => {
    await approveAs(cast.reviewer.id);
    await approveAs(cast.approver.id);

    await expect(
      workflowService.getWorkflow(documentId, cast.finalApprover.id)
    ).resolves.toBeTruthy();
  });

  it("refuses someone not on the document at all", async () => {
    await expect(
      workflowService.getWorkflow(documentId, cast.bystander.id)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("reports a document that does not exist as not found", async () => {
    await expect(
      workflowService.getWorkflow(missingId(), cast.preparer.id)
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
