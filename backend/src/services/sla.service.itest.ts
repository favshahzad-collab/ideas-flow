import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  signature,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { defaultSlaDaysInThisSuite } from "../test/sla";
import { approvalService } from "./approval.service";
import { documentsService } from "./documents.service";
import { slaService } from "./sla.service";

/**
 * Deadlines, against a real database.
 *
 * Two properties carry the whole feature. Nothing is chased unless somebody
 * set a deadline - that is what makes the countdown honest rather than
 * invented - and nobody is chased twice, because a notice that repeats every
 * quarter of an hour is filtered within a week and then the real one is
 * filtered with it.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;

beforeEach(async () => {
  cast = await makeCast();
});

const submit = () =>
  submitDocument({
    preparerId: cast.preparer.id,
    approvalChain: chainOf(cast.reviewer, cast.approver),
  });

/** Wind the current step's clock back, as though it arrived days ago. */
async function heldFor(documentId: string, days: number) {
  const started = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  await prisma.$executeRaw`
    UPDATE workflow_runs SET current_step_started_at = ${started}
    WHERE document_id = ${documentId}::uuid AND status = 'IN_PROGRESS'`;

  return started;
}

const approveAs = (documentId: string, actorId: string) => {
  const { useSavedSignature: _saved, ...placement } = signature();
  return approvalService.approve(documentId, actorId, {
    ...placement,
    useSavedSignature: false,
  });
};

const noticesFor = (recipientId: string) =>
  prisma.notification.findMany({
    where: { recipientId, type: "APPROVAL_OVERDUE" },
  });

describe("with no deadline set anywhere", () => {
  it("chases nobody, however long a memo has sat", async () => {
    // The delivered behaviour, and the reason the countdown was off for so
    // long: an organisation that has not set a deadline has not missed one.
    const { id } = await submit();
    await heldFor(id, 60);

    expect(await slaService.chaseOverdue()).toEqual({ chased: 0 });
    expect(await slaService.overdueCount()).toBe(0);
  });

  it("shows no due date on the queue", async () => {
    const { id } = await submit();
    const page = await documentsService.getDocuments(cast.preparer.id, {});
    const row = page.documents.find((d) => d.id === id);

    expect(row?.dueAt).toBeNull();
  });
});

describe("with a deployment-wide deadline", () => {
  defaultSlaDaysInThisSuite(2);

  it("puts a real due date on the queue", async () => {
    const { id } = await submit();
    const page = await documentsService.getDocuments(cast.preparer.id, {});
    const row = page.documents.find((d) => d.id === id);

    expect(row?.dueAt).toBeInstanceOf(Date);
    expect(row!.dueAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("leaves a memo alone while it still has time", async () => {
    const { id } = await submit();
    await heldFor(id, 1);

    expect(await slaService.chaseOverdue()).toEqual({ chased: 0 });
  });

  it("chases one that has run over", async () => {
    const { id } = await submit();
    await heldFor(id, 10);

    expect(await slaService.chaseOverdue()).toEqual({ chased: 1 });
    expect(await slaService.overdueCount()).toBe(1);
  });

  it("still finds an overdue memo behind older ones that are not due yet", async () => {
    // Older memos on a long deadline are not overdue, so they are never
    // marked as chased and stay first in line. They used to fill the only
    // page the sweep read, and the overdue memo behind them was never chased.
    for (let i = 0; i < 3; i++) {
      const { id } = await submit();
      await heldFor(id, 40);
      await prisma.$executeRaw`
        UPDATE approval_chain_steps SET sla_days = 120
        WHERE chain_id = (SELECT chain_id FROM workflow_runs
                          WHERE document_id = ${id}::uuid AND status = 'IN_PROGRESS')`;
    }
    const { id: late } = await submit();
    await heldFor(late, 10);

    expect(await slaService.chaseOverdue(new Date(), { pageSize: 2 })).toEqual({ chased: 1 });
    const run = await prisma.workflowRun.findFirstOrThrow({
      where: { documentId: late, status: "IN_PROGRESS" },
    });
    expect(run.breachNotifiedAt).not.toBeNull();
  });

  it("tells the approver holding it and the person who prepared it", async () => {
    // Different needs: the approver has to act, and the preparer is the one
    // being asked why the memo has not come back.
    const { id } = await submit();
    await heldFor(id, 10);
    await slaService.chaseOverdue();

    expect(await noticesFor(cast.reviewer.id)).toHaveLength(1);
    expect(await noticesFor(cast.preparer.id)).toHaveLength(1);
    expect(await noticesFor(cast.approver.id)).toHaveLength(0);
  });

  it("names the memo and the days it was given", async () => {
    const { id } = await submit();
    await heldFor(id, 10);
    await slaService.chaseOverdue();

    const [notice] = await noticesFor(cast.reviewer.id);
    expect(notice?.message).toContain("2 working days");
    expect(notice?.documentId).toBe(id);
  });

  it("writes it to the audit trail", async () => {
    const { id } = await submit();
    await heldFor(id, 10);
    await slaService.chaseOverdue();

    const rows = await prisma.auditLog.findMany({
      where: { action: "WORKFLOW_STEP_OVERDUE", entityId: id },
    });

    expect(rows).toHaveLength(1);
  });

  it("chases once, not once every sweep", async () => {
    const { id } = await submit();
    await heldFor(id, 10);

    await slaService.chaseOverdue();
    const second = await slaService.chaseOverdue();
    const third = await slaService.chaseOverdue();

    expect([second, third]).toEqual([{ chased: 0 }, { chased: 0 }]);
    expect(await noticesFor(cast.reviewer.id)).toHaveLength(1);
  });

  it("does not let two sweeps at once chase the same memo twice", async () => {
    const { id } = await submit();
    await heldFor(id, 10);

    const [a, b] = await Promise.all([
      slaService.chaseOverdue(),
      slaService.chaseOverdue(),
    ]);

    expect(a.chased + b.chased).toBe(1);
    expect(await noticesFor(cast.reviewer.id)).toHaveLength(1);
  });

  it("still counts it as overdue after it has been chased", async () => {
    // Being told is not the same as being done. The board has to go on
    // showing it until somebody actually acts.
    const { id } = await submit();
    await heldFor(id, 10);
    await slaService.chaseOverdue();

    expect(await slaService.overdueCount()).toBe(1);
  });
});

describe("when the memo moves on", () => {
  defaultSlaDaysInThisSuite(2);

  it("starts the next approver's clock from when they got it", async () => {
    const { id } = await submit();
    const wasStarted = await heldFor(id, 10);

    await approveAs(id, cast.reviewer.id);

    const run = await prisma.workflowRun.findFirstOrThrow({
      where: { documentId: id, status: "IN_PROGRESS" },
    });

    expect(run.currentStepStartedAt.getTime()).toBeGreaterThan(
      wasStarted.getTime()
    );
  });

  it("does not hand the next approver the last one's overdue notice", async () => {
    const { id } = await submit();
    await heldFor(id, 10);
    await slaService.chaseOverdue();

    await approveAs(id, cast.reviewer.id);

    const run = await prisma.workflowRun.findFirstOrThrow({
      where: { documentId: id, status: "IN_PROGRESS" },
    });

    expect(run.breachNotifiedAt).toBeNull();
    expect(await slaService.overdueCount()).toBe(0);
  });

  it("chases the new holder once they have run over too", async () => {
    const { id } = await submit();
    await approveAs(id, cast.reviewer.id);
    await heldFor(id, 10);

    expect(await slaService.chaseOverdue()).toEqual({ chased: 1 });
    expect(await noticesFor(cast.approver.id)).toHaveLength(1);
  });
});

describe("a step that names its own deadline", () => {
  it("uses it in place of the deployment's", async () => {
    const { id } = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.approver).map((step) => ({
        ...step,
        slaDays: 30,
      })),
    });
    await heldFor(id, 10);

    // Ten days into a thirty-day allowance, with no deployment default in
    // play at all.
    expect(await slaService.chaseOverdue()).toEqual({ chased: 0 });
  });

  it("gives a step a deadline even when the deployment sets none", async () => {
    const { id } = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.approver).map((step) => ({
        ...step,
        slaDays: 1,
      })),
    });
    await heldFor(id, 10);

    expect(await slaService.chaseOverdue()).toEqual({ chased: 1 });
  });

  it("quotes that deadline, and counts one day as a day", async () => {
    /*
     * The number in the sentence is the deadline the step actually ran over,
     * carried on the row rather than re-derived where the notice is written.
     * It used to be re-derived there with a `?? 0` behind it - unreachable,
     * but the day anything reached it the sentence sent to real people would
     * have read "longer than the 0 working days allowed".
     */
    const { id } = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.approver).map((step) => ({
        ...step,
        slaDays: 1,
      })),
    });
    await heldFor(id, 10);
    await slaService.chaseOverdue();

    const [held] = await noticesFor(cast.reviewer.id);
    const [waiting] = await noticesFor(cast.preparer.id);

    expect(held?.message).toContain("longer than the 1 working day allowed");
    expect(waiting?.message).toContain("longer than the 1 working day allowed");
    expect(held?.message).not.toContain("0 working");
  });
});

describe("memos that are not waiting on anybody", () => {
  defaultSlaDaysInThisSuite(1);

  it("never chases one that has been approved", async () => {
    const { id } = await submit();
    await approveAs(id, cast.reviewer.id);
    await approveAs(id, cast.approver.id);
    await heldFor(id, 30);

    expect(await slaService.chaseOverdue()).toEqual({ chased: 0 });
  });

  it("never chases one that was sent back for revision", async () => {
    const { id } = await submit();
    await approvalService.requestRevision(id, cast.reviewer.id, {
      comment: "Attach the sanction letter.",
    });
    await heldFor(id, 30);

    expect(await slaService.chaseOverdue()).toEqual({ chased: 0 });
  });
});
