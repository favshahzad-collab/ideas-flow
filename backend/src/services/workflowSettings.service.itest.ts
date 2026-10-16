import { beforeEach, describe, expect, it } from "vitest";
import {
  chainOf,
  makeCast,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { defaultSlaDaysInThisSuite } from "../test/sla";
import { documentsService } from "./documents.service";
import { prisma } from "../prisma";
import { sealApprovedMemos, stepSkipAllowed } from "../lib/env";
import { workflowSettingsService } from "./workflowSettings.service";

/**
 * Workflow policy set from the administration screens.
 *
 * The point of the table is that an administrator can answer "why has nobody
 * been chased" without a shell on the server, so these tests care about two
 * things: that what is stored beats what is in the environment, and that
 * storing it actually reaches the queue - a policy that saves and changes
 * nothing is the same bug it was written to fix.
 */

useCleanDatabase();

/** `makeCast` has no exported type; every itest names it this way. */
let cast: Awaited<ReturnType<typeof makeCast>>;

beforeEach(async () => {
  cast = await makeCast();
});

const admin = () => cast.preparer.id;

const submit = () =>
  submitDocument({
    preparerId: cast.preparer.id,
    approvalChain: chainOf(cast.reviewer, cast.approver),
  });

const dueDateOn = async (documentId: string) => {
  const page = await documentsService.getDocuments(cast.preparer.id, {});
  return page.documents.find((row) => row.id === documentId)?.dueAt ?? null;
};

describe("with nothing stored", () => {
  it("answers from the environment, and says that is where it came from", async () => {
    const view = await workflowSettingsService.get();

    expect(view).toMatchObject({
      slaDefaultDays: null,
      allowStepSkip: false,
      source: "environment",
    });
  });

  describe("and an environment that sets a deadline", () => {
    defaultSlaDaysInThisSuite(3);

    it("reports the environment's answer as the one in force", async () => {
      expect(await workflowSettingsService.get()).toMatchObject({
        slaDefaultDays: 3,
        source: "environment",
      });
    });
  });
});

describe("saving a policy", () => {
  it("puts a real due date on memos submitted from then on", async () => {
    // The whole point. Before: nothing is chased, and the queue shows age.
    const before = await submit();
    expect(await dueDateOn(before.id)).toBeNull();

    await workflowSettingsService.save(
      { slaDefaultDays: 2, allowStepSkip: false, preparerSignsOnSubmit: true, sealApprovedMemos: true },
      admin()
    );

    const after = await submit();
    expect(await dueDateOn(after.id)).toBeInstanceOf(Date);
    // A memo already in flight keeps the rules it started with
    // (run-policy.itest.ts), so it is not suddenly given a deadline.
    expect(await dueDateOn(before.id)).toBeNull();
  });

  it("takes effect without anything being restarted", async () => {
    await workflowSettingsService.save(
      { slaDefaultDays: null, allowStepSkip: true, preparerSignsOnSubmit: true, sealApprovedMemos: true },
      admin()
    );

    // Read through the same function the workflow calls before it moves a
    // memo, not through the row: that is the path that actually decides.
    expect(stepSkipAllowed()).toBe(true);
  });

  it("says it is stored now, not inherited", async () => {
    await workflowSettingsService.save(
      { slaDefaultDays: 5, allowStepSkip: false, preparerSignsOnSubmit: true, sealApprovedMemos: true },
      admin()
    );

    expect(await workflowSettingsService.get()).toMatchObject({
      slaDefaultDays: 5,
      source: "stored",
    });
  });

  it("records who changed it, and what it was before", async () => {
    await workflowSettingsService.save(
      { slaDefaultDays: 2, allowStepSkip: false, preparerSignsOnSubmit: true, sealApprovedMemos: true },
      admin()
    );
    await workflowSettingsService.save(
      { slaDefaultDays: 7, allowStepSkip: true, preparerSignsOnSubmit: true, sealApprovedMemos: true },
      admin()
    );

    const rows = await prisma.auditLog.findMany({
      where: { action: "WORKFLOW_SETTINGS_UPDATED" },
      orderBy: { createdAt: "asc" },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].actorId).toBe(admin());
    // Switching a deadline on changes who gets chased for every memo in the
    // building. "It was off until Tuesday" is the question asked afterwards.
    expect(rows[0].oldValue).toMatchObject({ source: "environment" });
    expect(rows[1].oldValue).toMatchObject({ slaDefaultDays: 2 });
    expect(rows[1].newValue).toMatchObject({
      slaDefaultDays: 7,
      allowStepSkip: true,
    });
  });
});

describe("a stored deadline of none", () => {
  defaultSlaDaysInThisSuite(3);

  it("beats an environment that still sets one", async () => {
    /*
     * The distinction the whole design turns on. Somebody who cleared the
     * field has said "no deadline"; an SLA_DEFAULT_DAYS left in a file from
     * last year must not quietly reinstate one behind them.
     */
    const before = await submit();
    expect(await dueDateOn(before.id)).toBeInstanceOf(Date);

    await workflowSettingsService.save(
      { slaDefaultDays: null, allowStepSkip: false, preparerSignsOnSubmit: true, sealApprovedMemos: true },
      admin()
    );

    const after = await submit();
    expect(await dueDateOn(after.id)).toBeNull();
    // The memo already in flight keeps the deadline it started with.
    expect(await dueDateOn(before.id)).toBeInstanceOf(Date);
    expect(await workflowSettingsService.get()).toMatchObject({
      slaDefaultDays: null,
      source: "stored",
    });
  });

  it("still shows what handing it back would give", async () => {
    await workflowSettingsService.save(
      { slaDefaultDays: null, allowStepSkip: false, preparerSignsOnSubmit: true, sealApprovedMemos: true },
      admin()
    );

    // So nobody has to find out by doing it.
    expect(await workflowSettingsService.get()).toMatchObject({
      environment: { slaDefaultDays: 3, allowStepSkip: false, preparerSignsOnSubmit: true, sealApprovedMemos: true },
    });
  });
});

describe("handing the policy back to the environment", () => {
  defaultSlaDaysInThisSuite(3);

  it("removes the row and lets the environment answer again", async () => {
    await workflowSettingsService.save(
      { slaDefaultDays: null, allowStepSkip: true, preparerSignsOnSubmit: true, sealApprovedMemos: true },
      admin()
    );

    await workflowSettingsService.clear(admin());

    expect(await workflowSettingsService.get()).toMatchObject({
      slaDefaultDays: 3,
      allowStepSkip: false,
      source: "environment",
    });
    expect(stepSkipAllowed()).toBe(false);
  });

  it("writes down what the deployment was left with", async () => {
    await workflowSettingsService.save(
      { slaDefaultDays: 9, allowStepSkip: false, preparerSignsOnSubmit: true, sealApprovedMemos: true },
      admin()
    );
    await workflowSettingsService.clear(admin());

    const [row] = await prisma.auditLog.findMany({
      where: { action: "WORKFLOW_SETTINGS_CLEARED" },
    });

    expect(row.oldValue).toMatchObject({ slaDefaultDays: 9 });
    expect(row.newValue).toMatchObject({ cleared: true, slaDefaultDays: 3 });
  });

  it("does nothing, and says nothing, when there was no row", async () => {
    await workflowSettingsService.clear(admin());

    expect(
      await prisma.auditLog.count({
        where: { action: "WORKFLOW_SETTINGS_CLEARED" },
      })
    ).toBe(0);
  });
});

describe("the seal switch", () => {
  const policy = (seal: boolean) => ({
    slaDefaultDays: null,
    allowStepSkip: false,
    preparerSignsOnSubmit: true,
    sealApprovedMemos: seal,
  });

  it("is on until somebody turns it off", async () => {
    expect(await workflowSettingsService.get()).toMatchObject({ sealApprovedMemos: true });
    expect(sealApprovedMemos()).toBe(true);
  });

  it("takes effect as soon as it is saved, and is recorded in the ledger", async () => {
    await workflowSettingsService.save(policy(false), admin());

    expect(sealApprovedMemos()).toBe(false);
    expect(await workflowSettingsService.get()).toMatchObject({ sealApprovedMemos: false });

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: "WORKFLOW_SETTINGS_UPDATED" },
    });
    expect(row.newValue).toMatchObject({ sealApprovedMemos: false });

    await workflowSettingsService.save(policy(true), admin());
    expect(sealApprovedMemos()).toBe(true);
  });

  it("says whether the server holds a certificate, so the screen does not offer a switch that does nothing", async () => {
    delete process.env.SEAL_P12_PATH;
    expect(await workflowSettingsService.get()).toMatchObject({
      sealCertificate: { configured: false, signer: null },
    });
  });
});
