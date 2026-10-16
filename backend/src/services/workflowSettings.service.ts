import { auditService } from "./audit.service";
import { environmentSlaDays } from "../lib/sla";
import {
  environmentPreparerSignsOnSubmit,
  environmentSealApprovedMemos,
  environmentStepSkipAllowed,
} from "../lib/env";
import { configuredSeal } from "../lib/pdfSeal";
import { policySnapshot } from "../lib/runPolicy";
import { prisma } from "../prisma";
import { useStoredWorkflowPolicy } from "../lib/workflowPolicy";
import type { UpdateWorkflowSettingsInput } from "../schemas/admin.schema";

/**
 * Workflow policy an administrator can change without a shell.
 *
 * The same argument mail settings made, for two decisions that had never left
 * the environment. A deadline is the one that matters: with none set nothing
 * chases anybody, the sweep runs every cycle and finds nothing to do, and the
 * first anyone hears of it is a memo three weeks late. That is not a fact a
 * deployment should have to learn by reading `.env.example`.
 *
 * The row wins over the environment, and the environment stays supported for
 * deployments that already manage it that way. See `lib/workflowPolicy` for
 * why the answer is held in a module variable rather than read per call.
 */

const SINGLETON = "singleton";

/*
 * The same row, named again for the audit trail - `audit_logs.entity_id` is a
 * UUID column and this row's key is a word. A constant, never generated, so
 * every policy change in the history groups under one entity. Mail settings
 * took `...0001`.
 */
const WORKFLOW_SETTINGS_AUDIT_ID = "00000000-0000-4000-8000-000000000002";

/** What the environment would answer if the row were taken away. */
function environmentPolicy() {
  return {
    slaDefaultDays: environmentSlaDays(),
    allowStepSkip: environmentStepSkipAllowed(),
    preparerSignsOnSubmit: environmentPreparerSignsOnSubmit(),
    sealApprovedMemos: environmentSealApprovedMemos(),
  };
}

/**
 * The seal certificate the server holds, if any.
 *
 * The switch only matters where there is one: without it nothing is sealed
 * whatever the switch says, and the screen has to say so rather than offer a
 * switch that turns nothing on. A certificate that will not open has already
 * stopped the server at start-up, so a failure here is reported as none.
 */
function sealCertificate(): { configured: boolean; signer: string | null } {
  try {
    const seal = configuredSeal();
    return { configured: Boolean(seal), signer: seal?.signerName ?? null };
  } catch {
    return { configured: false, signer: null };
  }
}

/**
 * Push whatever is stored into the policy holder.
 *
 * Called at boot and after every save. Everything that asks about a deadline
 * or a skip reads the holder, so this is the only place the two can get out
 * of step.
 */
export async function applyStoredWorkflowPolicy(): Promise<void> {
  const row = await prisma.workflowSetting.findUnique({
    where: { id: SINGLETON },
  });

  useStoredWorkflowPolicy(
    row
      ? {
          slaDefaultDays: row.slaDefaultDays,
          allowStepSkip: row.allowStepSkip,
          preparerSignsOnSubmit: row.preparerSignsOnSubmit,
          sealApprovedMemos: row.sealApprovedMemos,
        }
      : null
  );
}

export type WorkflowSettingsView = {
  /** The answer in force, whichever it came from. */
  slaDefaultDays: number | null;
  allowStepSkip: boolean;
  /**
   * Does submitting a document also mean signing it?
   *
   * The answer for an uploaded document, and the fallback for a memo type
   * that states no preference of its own.
   */
  preparerSignsOnSubmit: boolean;
  /** Does the final approval seal the approved PDF? */
  sealApprovedMemos: boolean;
  /**
   * Whether the server holds a seal certificate, and whose name it carries.
   * Not part of the policy: it is set up on the server, not here.
   */
  sealCertificate: { configured: boolean; signer: string | null };
  /**
   * Memos in an approval cycle right now. They keep the policy their cycle
   * started with unless a save applies the new one to them as well.
   */
  memosInProgress: number;
  /** Where that answer came from, so the screen can say so rather than imply. */
  source: "stored" | "environment";
  /**
   * What the environment alone would say. Shown beside the form so somebody
   * about to hand the policy back can see what they would get, instead of
   * finding out by doing it.
   */
  environment: {
    slaDefaultDays: number | null;
    allowStepSkip: boolean;
    preparerSignsOnSubmit: boolean;
    sealApprovedMemos: boolean;
  };
};

export const workflowSettingsService = {
  applyStoredWorkflowPolicy,

  async get(): Promise<WorkflowSettingsView> {
    const row = await prisma.workflowSetting.findUnique({
      where: { id: SINGLETON },
    });

    return {
      slaDefaultDays: row ? row.slaDefaultDays : environmentSlaDays(),
      allowStepSkip: row ? row.allowStepSkip : environmentStepSkipAllowed(),
      preparerSignsOnSubmit: row
        ? row.preparerSignsOnSubmit
        : environmentPreparerSignsOnSubmit(),
      sealApprovedMemos: row
        ? row.sealApprovedMemos
        : environmentSealApprovedMemos(),
      sealCertificate: sealCertificate(),
      memosInProgress: await prisma.workflowRun.count({
        where: { status: "IN_PROGRESS" },
      }),
      source: row ? "stored" : "environment",
      environment: environmentPolicy(),
    };
  },

  /**
   * Write the policy, then make it live.
   *
   * A null deadline is a value, not an omission: it means "no deadline", and
   * it is the answer an organisation gives by clearing the field. Nothing
   * here treats it as "unset, fall back" - that is what `clear` is for.
   */
  async save(
    input: UpdateWorkflowSettingsInput,
    actorId: string,
    ipAddress?: string
  ) {
    const existing = await prisma.workflowSetting.findUnique({
      where: { id: SINGLETON },
    });

    const data = {
      slaDefaultDays: input.slaDefaultDays ?? null,
      allowStepSkip: input.allowStepSkip,
      preparerSignsOnSubmit: input.preparerSignsOnSubmit,
      sealApprovedMemos: input.sealApprovedMemos,
      updatedById: actorId,
    };

    const row = await prisma.workflowSetting.upsert({
      where: { id: SINGLETON },
      create: { id: SINGLETON, ...data },
      update: data,
    });

    const shape = (value: {
      slaDefaultDays: number | null;
      allowStepSkip: boolean;
      preparerSignsOnSubmit: boolean;
      sealApprovedMemos: boolean;
    }) => ({
      slaDefaultDays: value.slaDefaultDays,
      allowStepSkip: value.allowStepSkip,
      preparerSignsOnSubmit: value.preparerSignsOnSubmit,
      sealApprovedMemos: value.sealApprovedMemos,
    });

    // Live before anything reads it, including the snapshot below.
    await applyStoredWorkflowPolicy();

    /*
     * Memos already in progress keep the policy their cycle started with,
     * unless the administrator asked for this change to reach them too. Then
     * every open cycle takes the new policy now, and the audit row says how
     * many - so "why did my memo become overdue on Tuesday" has an answer.
     */
    let appliedToInProgress = 0;
    if (input.applyToInProgress) {
      const moved = await prisma.workflowRun.updateMany({
        where: { status: "IN_PROGRESS" },
        data: policySnapshot(),
      });
      appliedToInProgress = moved.count;
    }

    await auditService.createAuditLog({
      actorId,
      action: "WORKFLOW_SETTINGS_UPDATED",
      entityType: "WorkflowSetting",
      entityId: WORKFLOW_SETTINGS_AUDIT_ID,
      // Where it came from as well as where it went. Switching a deadline on
      // changes who gets chased for every memo in the building, and "it was
      // off until Tuesday" is the question that gets asked afterwards.
      oldValue: existing ? shape(existing) : { source: "environment" },
      newValue: {
        ...shape(row),
        // Present only when it happened, so a plain save reads as one.
        ...(input.applyToInProgress ? { appliedToInProgress } : {}),
      },
      ipAddress,
    });

    return row;
  },

  /**
   * Hand the policy back to the environment.
   *
   * Deliberately not the same as clearing the deadline field, which stores
   * "no deadline". This removes the row, so whatever the environment says
   * answers again - including an `SLA_DEFAULT_DAYS` somebody set long ago.
   */
  async clear(actorId: string, ipAddress?: string) {
    const existing = await prisma.workflowSetting.findUnique({
      where: { id: SINGLETON },
    });

    if (!existing) return;

    await prisma.workflowSetting.delete({ where: { id: SINGLETON } });

    await auditService.createAuditLog({
      actorId,
      action: "WORKFLOW_SETTINGS_CLEARED",
      entityType: "WorkflowSetting",
      entityId: WORKFLOW_SETTINGS_AUDIT_ID,
      oldValue: {
        slaDefaultDays: existing.slaDefaultDays,
        allowStepSkip: existing.allowStepSkip,
        preparerSignsOnSubmit: existing.preparerSignsOnSubmit,
        sealApprovedMemos: existing.sealApprovedMemos,
      },
      // What the deployment is left with, which is the part somebody reading
      // this afterwards actually needs.
      newValue: { cleared: true, ...environmentPolicy() },
      ipAddress,
    });

    await applyStoredWorkflowPolicy();
  },
};
