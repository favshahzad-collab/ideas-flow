import { beforeEach, describe, expect, it } from "vitest";
import { ApprovalType } from "../generated/prisma/client";
import type {
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from "../schemas/workflow-templates.schema";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  makeUser,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { workflowTemplatesService } from "./workflow-templates.service";

/**
 * Keeping the templates, against a real database.
 *
 * The compiler that turns a drawn graph into an approval chain has its own
 * tests and they are thorough. What had none was everything around it: making
 * a template, rewriting one, retiring one, and what happens to a memo that was
 * submitted against one somebody then retires.
 *
 * Templates used to be deletable, and `documents.template_id` is
 * ON DELETE SET NULL - so a delete that got past the guard did not fail
 * loudly, it emptied a column. They are archived now instead, and nothing
 * removes one.
 */

useCleanDatabase();

const node = (
  id: string,
  type: WorkflowNode["type"],
  data: WorkflowNode["data"] = {},
): WorkflowNode => ({ id, type, position: { x: 0, y: 0 }, data });

const edge = (source: string, target: string): WorkflowEdge => ({
  id: `${source}->${target}`,
  source,
  target,
});

let cast: Awaited<ReturnType<typeof makeCast>>;
let admin: Awaited<ReturnType<typeof makeUser>>;

const graphFor = (...approvers: { id: string }[]): WorkflowGraph => ({
  nodes: [
    node("start", "start"),
    ...approvers.map((person, index) =>
      node(`a${index}`, "approval", {
        approverId: person.id,
        approvalType:
          index === approvers.length - 1
            ? ApprovalType.FINAL_APPROVER
            : ApprovalType.REVIEWER,
      }),
    ),
    node("end", "end"),
  ],
  edges: [
    edge("start", "a0"),
    ...approvers.slice(1).map((_, index) => edge(`a${index}`, `a${index + 1}`)),
    edge(`a${approvers.length - 1}`, "end"),
  ],
});

beforeEach(async () => {
  cast = await makeCast();
  admin = await makeUser({
    firstName: "Admin",
    departmentId: cast.department.id,
    loginRole: "ADMINISTRATOR",
  });
});

/*
 * `isActive` is passed explicitly because the type requires it: the zod schema
 * gives it a default, so by the time a route has parsed a body it is always
 * present, and the service's own `?? true` is the belt to that braces.
 */
const make = (name = "Leave request", isActive = true) =>
  workflowTemplatesService.createTemplate(
    { name, isActive, graph: graphFor(cast.reviewer, cast.finalApprover) },
    admin.id,
  );

const trailFor = (entityId: string) =>
  prisma.auditLog.findMany({
    where: { entityType: "WorkflowTemplate", entityId },
    orderBy: { writeSeq: "asc" },
    select: { action: true, actorId: true, oldValue: true, newValue: true },
  });

describe("making one", () => {
  it("keeps the graph as drawn, so the designer reopens what was saved", async () => {
    const template = await make();

    const stored = await workflowTemplatesService.getTemplate(template.id);
    expect((stored.graph as WorkflowGraph).nodes).toHaveLength(4);
  });

  it("can be drafted inactive, so a half-built route is not offered", async () => {
    expect((await make("Not ready", false)).isActive).toBe(false);
    expect((await make()).isActive).toBe(true);
  });

  it("records who made it, as making it", async () => {
    const template = await make();

    expect(await trailFor(template.id)).toEqual([
      expect.objectContaining({
        action: "WORKFLOW_TEMPLATE_CREATED",
        actorId: admin.id,
      }),
    ]);
  });
});

describe("rewriting one", () => {
  it("records it as a rewrite, not as another creation", async () => {
    /*
     * Both used to write APPROVAL_CHAIN_CREATED - an action that means a
     * chain was built on a document. The history of a template therefore read
     * as though it had been created three times, and "who changed the route
     * every memo of this kind travels" had no answer anywhere.
     */
    const template = await make();

    await workflowTemplatesService.updateTemplate(
      template.id,
      { name: "Leave request (2026)" },
      admin.id,
    );

    expect((await trailFor(template.id)).map((row) => row.action)).toEqual([
      "WORKFLOW_TEMPLATE_CREATED",
      "WORKFLOW_TEMPLATE_UPDATED",
    ]);
  });

  it("keeps both names in the row, so the change is readable from it", async () => {
    const template = await make();

    await workflowTemplatesService.updateTemplate(
      template.id,
      { name: "Leave request (2026)" },
      admin.id,
    );
    const [, rewrite] = await trailFor(template.id);

    expect(rewrite?.oldValue).toMatchObject({ name: "Leave request" });
    expect(rewrite?.newValue).toMatchObject({ name: "Leave request (2026)" });
  });

  it("leaves out what the request did not mention", async () => {
    const template = await make();

    await workflowTemplatesService.updateTemplate(
      template.id,
      { name: "Renamed" },
      admin.id,
    );

    const stored = await workflowTemplatesService.getTemplate(template.id);
    expect(stored.isActive).toBe(true);
    expect((stored.graph as WorkflowGraph).nodes).toHaveLength(4);
  });

  it("refuses one that does not exist", async () => {
    await expect(
      workflowTemplatesService.updateTemplate(
        "00000000-0000-4000-8000-000000000000",
        { name: "Nothing" },
        admin.id,
      ),
    ).rejects.toThrow(/not found/i);
  });
});

describe("archiving one", () => {
  /*
   * What replaced deleting. Deleting lost the design for good, and was only
   * refused while a memo pointed at the template; archiving keeps it, hides it,
   * and can be undone.
   */
  it("keeps the template, graph and all, and stops it being offered", async () => {
    const template = await make();

    const archived = await workflowTemplatesService.archiveTemplate(template.id, admin.id);

    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(archived.isActive).toBe(false);
    const kept = await workflowTemplatesService.getTemplate(template.id);
    expect(kept.graph).toEqual(template.graph);
    expect(await workflowTemplatesService.listTemplates({ isActive: true })).toEqual([]);
  });

  it("works while memos are routed by it, and leaves them exactly as they were", async () => {
    const template = await make();
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      templateId: template.id,
    });

    await workflowTemplatesService.archiveTemplate(template.id, admin.id);

    const after = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(after.templateId).toBe(template.id);
  });

  it("cannot be chosen for a new memo", async () => {
    const template = await make();
    await workflowTemplatesService.archiveTemplate(template.id, admin.id);

    await expect(
      submitDocument({ preparerId: cast.preparer.id, templateId: template.id }),
    ).rejects.toThrow("Selected workflow template is not available");
  });

  it("cannot be edited, and says to restore it first", async () => {
    const template = await make();
    await workflowTemplatesService.archiveTemplate(template.id, admin.id);

    const rename = workflowTemplatesService.updateTemplate(template.id, { name: "Renamed" }, admin.id);
    await expect(rename).rejects.toMatchObject({ statusCode: 409 });
    await expect(rename).rejects.toThrow("Restore it first");
    await expect(
      workflowTemplatesService.updateTemplate(template.id, { isActive: true }, admin.id),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("is refused a second time, rather than moving the date it was archived", async () => {
    const template = await make();
    const first = await workflowTemplatesService.archiveTemplate(template.id, admin.id);

    await expect(
      workflowTemplatesService.archiveTemplate(template.id, admin.id),
    ).rejects.toMatchObject({ statusCode: 409 });
    const kept = await workflowTemplatesService.getTemplate(template.id);
    expect(kept.archivedAt).toEqual(first.archivedAt);
  });

  it("comes back switched off, to be switched on deliberately", async () => {
    const template = await make();
    await workflowTemplatesService.archiveTemplate(template.id, admin.id);

    const restored = await workflowTemplatesService.restoreTemplate(template.id, admin.id);

    expect(restored.archivedAt).toBeNull();
    expect(restored.isActive).toBe(false);
    await expect(
      workflowTemplatesService.updateTemplate(template.id, { isActive: true }, admin.id),
    ).resolves.toMatchObject({ isActive: true });
  });

  it("refuses to restore one that is not archived", async () => {
    const template = await make();

    await expect(
      workflowTemplatesService.restoreTemplate(template.id, admin.id),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("records each step, and whether it had been offered", async () => {
    const template = await make();
    await workflowTemplatesService.archiveTemplate(template.id, admin.id);
    await workflowTemplatesService.restoreTemplate(template.id, admin.id);

    expect(await trailFor(template.id)).toEqual([
      {
        action: "WORKFLOW_TEMPLATE_CREATED",
        actorId: admin.id,
        oldValue: null,
        newValue: { name: "Leave request", isActive: true, nodeCount: 4, edgeCount: 3 },
      },
      {
        action: "WORKFLOW_TEMPLATE_ARCHIVED",
        actorId: admin.id,
        oldValue: { name: "Leave request", isActive: true },
        newValue: { name: "Leave request", isActive: false, archived: true },
      },
      {
        action: "WORKFLOW_TEMPLATE_RESTORED",
        actorId: admin.id,
        oldValue: { name: "Leave request", isActive: false, archived: true },
        newValue: { name: "Leave request", isActive: false, archived: false },
      },
    ]);
  });

  it("refuses one that does not exist", async () => {
    await expect(
      workflowTemplatesService.archiveTemplate("00000000-0000-4000-8000-000000000000", admin.id),
    ).rejects.toThrow(/not found/i);
    await expect(
      workflowTemplatesService.restoreTemplate("00000000-0000-4000-8000-000000000000", admin.id),
    ).rejects.toThrow(/not found/i);
  });

  it("offers no way to delete one any more", () => {
    expect("deleteTemplate" in workflowTemplatesService).toBe(false);
  });
});

describe("listing them", () => {
  it("gives back what was made, without the graph weighing the list down", async () => {
    await make("Leave request");
    await make("Expense claim");

    const templates = await workflowTemplatesService.listTemplates();

    expect(templates.map((t) => t.name).sort()).toEqual([
      "Expense claim",
      "Leave request",
    ]);
    expect(templates[0]).not.toHaveProperty("graph");
  });

  it("leaves archived ones out unless they are asked for, and then gives only those", async () => {
    await make("Leave request");
    const retired = await make("Old expense claim");
    await workflowTemplatesService.archiveTemplate(retired.id, admin.id);

    expect((await workflowTemplatesService.listTemplates()).map((t) => t.name)).toEqual([
      "Leave request",
    ]);
    const archived = await workflowTemplatesService.listTemplates({ archived: true });
    expect(archived.map((t) => [t.name, t.archivedAt instanceof Date])).toEqual([
      ["Old expense claim", true],
    ]);
  });
});

describe("a memo submitted against one", () => {
  it("is routed by the chain the template compiles to", async () => {
    // The join between the two halves: the compiler's output becomes real
    // approval steps, which is what the compiler's own unit tests cannot see.
    const template = await make();

    const document = await submitDocument({
      preparerId: cast.preparer.id,
      templateId: template.id,
    });

    const steps = await prisma.approvalChainStep.findMany({
      where: { chain: { documentId: document.id } },
      orderBy: { stepOrder: "asc" },
    });
    expect(steps.map((step) => step.assignedUserId)).toEqual([
      cast.reviewer.id,
      cast.finalApprover.id,
    ]);
  });

  it("remembers which template it was, for as long as the memo exists", async () => {
    const template = await make();

    const document = await submitDocument({
      preparerId: cast.preparer.id,
      templateId: template.id,
    });

    const stored = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    expect(stored.templateId).toBe(template.id);
  });
});

describe("an inline chain", () => {
  it("still works, because not every memo comes from a template", async () => {
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });

    const stored = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    expect(stored.templateId).toBeNull();
  });
});
