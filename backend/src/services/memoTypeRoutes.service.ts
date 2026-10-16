import { UPLOADED_MEMO } from "../lib/delegation";
import { errors } from "../lib/errors";
import { listMemoTypes } from "../lib/memoTypes";
import { prisma } from "../prisma";
import { auditService } from "./audit.service";

/**
 * The approval route each kind of memo starts from - fit-gap decision 7.
 *
 * An administrator who designs workflows names, for each memo type and for
 * a memo uploaded as a PDF, the workflow template the submit screen picks
 * first. The preparer can still choose another where the screen allows it;
 * this is the consistent starting point, so the same kind of memo goes the
 * same way and fewer go to the wrong people.
 */

/** The routes' fixed id in the trail, like the other singleton settings. */
const MEMO_TYPE_ROUTES_AUDIT_ID = "00000000-0000-4000-8000-000000000006";

/** Every kind of memo a route can be set for, in the order the screen lists them. */
function kinds(): { key: string; label: string }[] {
  return [
    ...listMemoTypes().map((type) => ({ key: type.key, label: type.label })),
    { key: UPLOADED_MEMO, label: "Uploaded PDF" },
  ];
}

export type MemoTypeRouteView = {
  key: string;
  label: string;
  templateId: string | null;
  templateName: string | null;
  /** False where the template was archived since: no route is offered then. */
  templateActive: boolean;
};

export const memoTypeRoutesService = {
  /** For the administration screen: every kind of memo and its route. */
  async list(): Promise<MemoTypeRouteView[]> {
    const rows = await prisma.memoTypeRoute.findMany({
      include: { template: { select: { id: true, name: true, isActive: true, archivedAt: true } } },
    });
    const byKey = new Map(rows.map((row) => [row.memoType, row]));

    return kinds().map(({ key, label }) => {
      const template = byKey.get(key)?.template ?? null;
      return {
        key,
        label,
        templateId: template?.id ?? null,
        templateName: template?.name ?? null,
        templateActive: Boolean(template && template.isActive && !template.archivedAt),
      };
    });
  },

  /**
   * For the submit screen: the template to pick first for each kind of memo,
   * leaving out any since archived or switched off.
   */
  async resolved(): Promise<Record<string, string>> {
    const rows = await prisma.memoTypeRoute.findMany({
      where: { template: { isActive: true, archivedAt: null } },
      select: { memoType: true, templateId: true },
    });
    return Object.fromEntries(
      rows
        .filter((row): row is { memoType: string; templateId: string } => row.templateId !== null)
        .map((row) => [row.memoType, row.templateId])
    );
  },

  async set(key: string, templateId: string | null, actorId: string, ipAddress?: string) {
    const kind = kinds().find((candidate) => candidate.key === key);
    if (!kind) {
      throw errors.notFound("That is not a kind of memo here.");
    }

    if (templateId) {
      const template = await prisma.workflowTemplate.findUnique({
        where: { id: templateId },
        select: { isActive: true, archivedAt: true },
      });
      if (!template || !template.isActive || template.archivedAt) {
        throw errors.badRequest("Choose a workflow that is in use. That one is archived or switched off.");
      }
    }

    const before = await prisma.memoTypeRoute.findUnique({ where: { memoType: key } });

    await prisma.$transaction(async (tx) => {
      await tx.memoTypeRoute.upsert({
        where: { memoType: key },
        create: { memoType: key, templateId, updatedById: actorId },
        update: { templateId, updatedById: actorId },
      });
      await auditService.createAuditLog({
        actorId,
        action: "MEMO_TYPE_ROUTE_CHANGED",
        entityType: "MemoTypeRoute",
        entityId: MEMO_TYPE_ROUTES_AUDIT_ID,
        oldValue: { memoType: key, templateId: before?.templateId ?? null },
        newValue: { memoType: key, templateId },
        ipAddress,
        tx,
      });
    });

    return this.list();
  },
};
