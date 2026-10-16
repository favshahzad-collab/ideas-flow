import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  resubmitDocument,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { approvalService } from "./approval.service";
import { slaService } from "./sla.service";
import { workflowService } from "./workflow.service";
import { workflowSettingsService } from "./workflowSettings.service";

/**
 * A memo keeps the workflow policy its approval cycle started with.
 *
 * Agreed after the fit-gap review: changing the default deadline, skipping or
 * sealing midway made memos already in flight inconsistent - a deadline
 * change could make dozens overdue in one save. The policy is recorded on the
 * run when a cycle starts and read from there; an administrator moves memos
 * in progress onto a new policy only by asking to.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;

beforeEach(async () => {
  cast = await makeCast();
});

const policy = (overrides: {
  slaDefaultDays?: number | null;
  allowStepSkip?: boolean;
  sealApprovedMemos?: boolean;
  applyToInProgress?: boolean;
} = {}) =>
  workflowSettingsService.save(
    {
      slaDefaultDays: null,
      allowStepSkip: false,
      preparerSignsOnSubmit: true,
      sealApprovedMemos: true,
      ...overrides,
    },
    cast.preparer.id
  );

const submit = () =>
  submitDocument({
    preparerId: cast.preparer.id,
    approvalChain: chainOf(cast.reviewer, cast.approver, cast.finalApprover),
  });

const currentRun = (documentId: string) =>
  prisma.workflowRun.findFirstOrThrow({
    where: { documentId, status: "IN_PROGRESS" },
  });

/** Wind the current step's clock back, as though it arrived days ago. */
const heldFor = (documentId: string, days: number) =>
  prisma.$executeRaw`
    UPDATE workflow_runs
    SET current_step_started_at = ${new Date(Date.now() - days * 86_400_000)}
    WHERE document_id = ${documentId}::uuid AND status = 'IN_PROGRESS'`;

const skip = (documentId: string) =>
  approvalService.skipWorkflowStep(documentId, cast.preparer.id, {
    reason: "On leave this week.",
  });

describe("recording the policy when a cycle starts", () => {
  it("writes the policy in force onto the run at submission", async () => {
    await policy({ slaDefaultDays: 3, allowStepSkip: true, sealApprovedMemos: false });
    const { id } = await submit();

    expect(await currentRun(id)).toMatchObject({
      policySlaDefaultDays: 3,
      policyAllowStepSkip: true,
      policySealApprovedMemos: false,
    });
    expect((await currentRun(id)).policyFrozenAt).not.toBeNull();
  });

  it("takes the policy in force at the time for a resubmission, which is a new cycle", async () => {
    await policy({ slaDefaultDays: 3 });
    const { id } = await submit();
    await approvalService.reject(id, cast.reviewer.id, { comment: "Wrong vendor." });

    await policy({ slaDefaultDays: 8 });
    await resubmitDocument({ documentId: id, preparerId: cast.preparer.id });

    expect((await currentRun(id)).policySlaDefaultDays).toBe(8);
  });
});

describe("a later policy change does not reach memos in flight", () => {
  it("keeps the deadline the memo started with", async () => {
    await policy({ slaDefaultDays: 2 });
    const { id } = await submit();
    await heldFor(id, 10);

    // The deadline is switched off for everyone, after the memo started.
    await policy({ slaDefaultDays: null });

    expect(await slaService.chaseOverdue()).toEqual({ chased: 1 });
  });

  it("does not make a memo overdue by adding a deadline after it started", async () => {
    const { id } = await submit();
    await heldFor(id, 10);

    await policy({ slaDefaultDays: 2 });

    expect(await slaService.chaseOverdue()).toEqual({ chased: 0 });
    expect(await slaService.overdueCount()).toBe(0);
  });

  it("refuses a skip turned on after the memo started", async () => {
    const { id } = await submit();
    await policy({ allowStepSkip: true });

    await expect(skip(id)).rejects.toThrow(/switched off for this memo/);
    expect(await workflowService.getWorkflow(id, cast.preparer.id)).toMatchObject({
      policy: { allowStepSkip: false },
    });
  });

  it("still allows a skip the memo started with, after it is turned off", async () => {
    await policy({ allowStepSkip: true });
    const { id } = await submit();
    await policy({ allowStepSkip: false });

    await expect(skip(id)).resolves.toBeTruthy();
  });

  it("keeps the sealing rule the memo started with", async () => {
    await policy({ sealApprovedMemos: true });
    const { id } = await submit();
    await policy({ sealApprovedMemos: false });

    expect((await currentRun(id)).policySealApprovedMemos).toBe(true);
  });
});

describe("applying a policy change to memos in progress, on purpose", () => {
  it("moves every open cycle onto the new policy and records how many", async () => {
    const first = await submit();
    const second = await submit();
    await heldFor(first.id, 10);

    await policy({ slaDefaultDays: 2, allowStepSkip: true, applyToInProgress: true });

    expect(await currentRun(first.id)).toMatchObject({
      policySlaDefaultDays: 2,
      policyAllowStepSkip: true,
    });
    expect((await currentRun(second.id)).policySlaDefaultDays).toBe(2);
    expect(await slaService.chaseOverdue()).toEqual({ chased: 1 });

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: "WORKFLOW_SETTINGS_UPDATED" },
      orderBy: { createdAt: "desc" },
    });
    expect(row.newValue).toMatchObject({ appliedToInProgress: 2 });
  });

  it("says how many memos are in progress, so the screen can ask", async () => {
    await submit();
    await submit();

    expect(await workflowSettingsService.get()).toMatchObject({ memosInProgress: 2 });
  });
});

describe("a cycle started before policies were recorded", () => {
  it("follows the current policy, as it always did", async () => {
    const { id } = await submit();
    await prisma.workflowRun.updateMany({
      where: { documentId: id },
      data: {
        policyFrozenAt: null,
        policySlaDefaultDays: null,
        policyAllowStepSkip: null,
        policySealApprovedMemos: null,
      },
    });

    await policy({ allowStepSkip: true });

    await expect(skip(id)).resolves.toBeTruthy();
  });
});
