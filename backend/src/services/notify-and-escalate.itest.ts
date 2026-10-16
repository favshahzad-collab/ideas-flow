import { beforeEach, describe, expect, it } from "vitest";
import { LoginRole } from "../generated/prisma/client";
import { dueAtFor } from "../lib/sla";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  makeUser,
  signature,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { defaultSlaDaysInThisSuite } from "../test/sla";
import { adminService } from "./admin.service";
import { approvalService } from "./approval.service";
import { calendarService } from "./calendar.service";
import { delegationsService } from "./delegations.service";
import { slaService } from "./sla.service";

/**
 * Who is told what, and the calendar deadlines count on - fit-gap decisions 2
 * and 4.
 *
 * - A return tells the preparer and the approvers who already signed.
 * - A rejection tells the preparer and earlier approvers, never the person
 *   who rejected.
 * - An overdue step tells the approver, whoever covers for them, and the
 *   preparer.
 * - The preparer gets a receipt when a memo goes in.
 * - Two working days past the deadline, the approver's line manager and the
 *   administrators who watch the control room are told, once.
 * - Public holidays are not working days; the office time zone is kept.
 */

useCleanDatabase();
defaultSlaDaysInThisSuite(2);

let cast: Awaited<ReturnType<typeof makeCast>>;

beforeEach(async () => {
  cast = await makeCast();
});

const DAY = 24 * 60 * 60 * 1000;

const approveAs = (documentId: string, actorId: string) => {
  const { useSavedSignature: _saved, ...placement } = signature();
  return approvalService.approve(documentId, actorId, {
    ...placement,
    useSavedSignature: false,
  });
};

const noticesOf = (recipientId: string, type: string) =>
  prisma.notification.findMany({
    where: { recipientId, type: type as never },
  });

async function heldFor(documentId: string, days: number) {
  const started = new Date(Date.now() - days * DAY);
  await prisma.$executeRaw`
    UPDATE workflow_runs SET current_step_started_at = ${started}
    WHERE document_id = ${documentId}::uuid AND status = 'IN_PROGRESS'`;
  return started;
}

const threeStep = () =>
  submitDocument({
    preparerId: cast.preparer.id,
    approvalChain: chainOf(cast.reviewer, cast.approver, cast.finalApprover),
  });

describe("a receipt", () => {
  it("goes to the preparer when a memo is submitted", async () => {
    const { id } = await threeStep();

    const receipts = await noticesOf(cast.preparer.id, "SUBMITTED");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].documentId).toBe(id);
  });
});

describe("a return", () => {
  it("tells the preparer and every approver who already signed, not the one returning it", async () => {
    const { id } = await threeStep();
    await approveAs(id, cast.reviewer.id);

    await approvalService.requestRevision(id, cast.approver.id, { comment: "Fix the dates" });

    expect(await noticesOf(cast.preparer.id, "REVISION_REQUESTED")).toHaveLength(1);
    expect(await noticesOf(cast.reviewer.id, "REVISION_REQUESTED")).toHaveLength(1);
    expect(await noticesOf(cast.approver.id, "REVISION_REQUESTED")).toHaveLength(0);
    expect(await noticesOf(cast.finalApprover.id, "REVISION_REQUESTED")).toHaveLength(0);
  });
});

describe("a rejection", () => {
  it("tells the preparer and earlier approvers, never the person who rejected", async () => {
    const { id } = await threeStep();
    await approveAs(id, cast.reviewer.id);

    await approvalService.reject(id, cast.approver.id, { comment: "No budget" });

    expect(await noticesOf(cast.preparer.id, "REJECTED")).toHaveLength(1);
    expect(await noticesOf(cast.reviewer.id, "REJECTED")).toHaveLength(1);
    expect(await noticesOf(cast.approver.id, "REJECTED")).toHaveLength(0);
    expect(await noticesOf(cast.finalApprover.id, "REJECTED")).toHaveLength(0);
  });
});

describe("an overdue step", () => {
  it("tells whoever is covering for the approver as well", async () => {
    const { id } = await threeStep();
    await delegationsService.create(
      { delegateId: cast.bystander.id },
      { id: cast.reviewer.id, isAdministrator: false }
    );
    await heldFor(id, 10);

    await slaService.chaseOverdue();

    expect(await noticesOf(cast.reviewer.id, "APPROVAL_OVERDUE")).toHaveLength(1);
    expect(await noticesOf(cast.bystander.id, "APPROVAL_OVERDUE")).toHaveLength(1);
    expect(await noticesOf(cast.preparer.id, "APPROVAL_OVERDUE")).toHaveLength(1);
  });
});

describe("escalation", () => {
  let manager: { id: string };
  let watcher: { id: string };
  let limitedAdmin: { id: string };

  beforeEach(async () => {
    manager = await makeUser({ firstName: "Manager", departmentId: cast.department.id });
    await prisma.user.update({
      where: { id: cast.reviewer.id },
      data: { lineManagerId: manager.id },
    });
    watcher = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });
    // An administrator not given the control room is not told.
    limitedAdmin = await makeUser({
      loginRole: LoginRole.ADMINISTRATOR,
      superAdmin: false,
      adminPowers: ["approvals.holders"],
    });
  });

  it("does nothing until the step has been chased", async () => {
    const { id } = await threeStep();
    await heldFor(id, 30);

    expect(await slaService.escalateOverdue()).toEqual({ escalated: 0 });
  });

  it("waits two working days past the deadline", async () => {
    const { id } = await threeStep();
    const started = await heldFor(id, 0);
    await prisma.workflowRun.updateMany({
      where: { documentId: id },
      data: { breachNotifiedAt: new Date() },
    });

    // The day after the deadline: not yet.
    const dueAt = dueAtFor(started, null)!;
    expect(
      await slaService.escalateOverdue(new Date(dueAt.getTime() + DAY))
    ).toEqual({ escalated: 0 });
  });

  it("tells the line manager and the administrators who watch the control room, once", async () => {
    const { id } = await threeStep();
    await heldFor(id, 20);
    await slaService.chaseOverdue();

    expect(await slaService.escalateOverdue()).toEqual({ escalated: 1 });
    expect(await slaService.escalateOverdue()).toEqual({ escalated: 0 });

    expect(await noticesOf(manager.id, "ESCALATED")).toHaveLength(1);
    expect(await noticesOf(watcher.id, "ESCALATED")).toHaveLength(1);
    expect(await noticesOf(limitedAdmin.id, "ESCALATED")).toHaveLength(0);
    expect(await noticesOf(cast.reviewer.id, "ESCALATED")).toHaveLength(0);
    expect(
      await prisma.auditLog.count({ where: { entityId: id, action: "WORKFLOW_STEP_ESCALATED" } })
    ).toBe(1);
  });

  it("starts the next approver clean", async () => {
    const { id } = await threeStep();
    await heldFor(id, 20);
    await slaService.chaseOverdue();
    await slaService.escalateOverdue();

    await approveAs(id, cast.reviewer.id);

    const run = await prisma.workflowRun.findFirstOrThrow({
      where: { documentId: id, status: "IN_PROGRESS" },
    });
    expect(run.escalatedAt).toBeNull();
    expect(run.breachNotifiedAt).toBeNull();
  });
});

describe("line managers", () => {
  it("are recorded, and cleared", async () => {
    const admin = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });

    await adminService.updateUser(cast.reviewer.id, { lineManagerId: cast.approver.id }, admin.id);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: cast.reviewer.id } })).lineManagerId
    ).toBe(cast.approver.id);

    await adminService.updateUser(cast.reviewer.id, { lineManagerId: null }, admin.id);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: cast.reviewer.id } })).lineManagerId
    ).toBeNull();
  });

  it("are never the person themselves", async () => {
    const admin = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });

    await expect(
      adminService.updateUser(cast.reviewer.id, { lineManagerId: cast.reviewer.id }, admin.id)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("are never somebody switched off", async () => {
    const admin = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });
    await prisma.user.update({
      where: { id: cast.approver.id },
      data: { deactivatedAt: new Date() },
    });

    await expect(
      adminService.updateUser(cast.reviewer.id, { lineManagerId: cast.approver.id }, admin.id)
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("the office calendar", () => {
  it("counts a public holiday as not a working day, from the moment it is added", async () => {
    const admin = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });
    // Monday 6 April 2026; two working days is the end of Wednesday.
    const monday = new Date("2026-04-06T09:00:00.000Z");
    expect(dueAtFor(monday, 2)?.toISOString()).toBe("2026-04-08T23:59:59.999Z");

    await calendarService.addHoliday({ date: "2026-04-07", name: "Holiday" }, admin.id);

    expect(dueAtFor(monday, 2)?.toISOString()).toBe("2026-04-09T23:59:59.999Z");
    expect(await prisma.auditLog.count({ where: { action: "HOLIDAY_ADDED" } })).toBe(1);
  });

  it("refuses the same date twice", async () => {
    const admin = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });
    await calendarService.addHoliday({ date: "2026-04-07", name: "One" }, admin.id);

    await expect(
      calendarService.addHoliday({ date: "2026-04-07", name: "Two" }, admin.id)
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("forgets a holiday that is removed", async () => {
    const admin = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });
    const monday = new Date("2026-04-06T09:00:00.000Z");
    const { holiday } = await calendarService.addHoliday(
      { date: "2026-04-07", name: "Holiday" },
      admin.id
    );

    await calendarService.removeHoliday(holiday.id, admin.id);

    expect(dueAtFor(monday, 2)?.toISOString()).toBe("2026-04-08T23:59:59.999Z");
  });

  it("keeps the office time zone, and refuses one it does not know", async () => {
    const admin = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });

    const saved = await calendarService.setTimeZone("Asia/Karachi", admin.id);
    expect(saved.timeZone).toBe("Asia/Karachi");
    expect(dueAtFor(new Date("2026-04-06T09:00:00.000Z"), 2)?.toISOString()).toBe(
      "2026-04-08T18:59:59.999Z"
    );

    await expect(calendarService.setTimeZone("Mars/Olympus", admin.id)).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
