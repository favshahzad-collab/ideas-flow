import { prisma } from "../prisma";
import { errors } from "../lib/errors";
import { auditService } from "./audit.service";
import type {
  CreateWorkflowTemplateInput,
  UpdateWorkflowTemplateInput,
  WorkflowGraph,
  WorkflowNode,
  WorkflowEdge,
} from "../schemas/workflow-templates.schema";
import { ApprovalType } from "../generated/prisma/browser";

/**
 * Compiled step produced from a workflow template.
 * Used by the documents service to seed an ApprovalChain at submission time.
 */
export type CompiledStep = {
  assignedUserId: string;
  approvalType: ApprovalType;
  order: number;
  /** Working days this step is given, when the template says. See lib/sla.ts. */
  slaDays: number | null;
};

/** The document a template is being compiled against. */
type CompileTarget = { title: string; description: string | null };

/**
 * The graph once every decision has been resolved against one document: the
 * nodes still on the route, in the order they were first reached, and the
 * edges actually taken. Ordering happens in a second pass over this.
 */
type ResolvedRoute = {
  discovered: string[];
  taken: Array<{ source: string; target: string }>;
};

const MAX_DEPTH = 200;

/** What to call a node in a message a person has to act on. */
function describe(node: WorkflowNode): string {
  return node.data.label?.trim() || node.id;
}

class WorkflowTemplatesService {
  /**
   * Archived templates are left out unless `archived: true` asks for them, and
   * then only they come back: the studio's main list is the templates in use,
   * and the archive is somewhere you go to look.
   */
  async listTemplates(filter: { isActive?: boolean; archived?: boolean } = {}) {
    const where: { isActive?: boolean; archivedAt: null | { not: null } } = {
      archivedAt: filter.archived ? { not: null } : null,
    };
    if (typeof filter.isActive === "boolean") where.isActive = filter.isActive;

    const templates = await prisma.workflowTemplate.findMany({
      where,
      orderBy: { updatedAt: "desc" },
    });

    return templates.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      isActive: t.isActive,
      archivedAt: t.archivedAt,
      createdById: t.createdById,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));
  }

  async getTemplate(id: string) {
    const template = await prisma.workflowTemplate.findUnique({
      where: { id },
    });
    if (!template) {
      throw errors.notFound("Workflow template not found");
    }
    return template;
  }

  async createTemplate(input: CreateWorkflowTemplateInput, actorId: string) {
    const template = await prisma.workflowTemplate.create({
      data: {
        name: input.name,
        description: input.description || null,
        isActive: input.isActive ?? true,
        graph: input.graph,
        createdById: actorId,
      },
    });

    await auditService.createAuditLog({
      actorId,
      action: "WORKFLOW_TEMPLATE_CREATED",
      entityType: "WorkflowTemplate",
      entityId: template.id,
      newValue: {
        name: template.name,
        isActive: template.isActive,
        nodeCount: input.graph.nodes.length,
        edgeCount: input.graph.edges.length,
      },
    });

    return template;
  }

  async updateTemplate(
    id: string,
    input: UpdateWorkflowTemplateInput,
    actorId: string
  ) {
    const existing = await prisma.workflowTemplate.findUnique({ where: { id } });
    if (!existing) {
      throw errors.notFound("Workflow template not found");
    }
    // Switching one on would offer a retired route to preparers without anybody
    // having decided to bring it back; restoring is that decision.
    if (existing.archivedAt) {
      throw errors.conflict(
        "This template is archived, so it cannot be changed. Restore it first."
      );
    }

    const data: {
      name?: string;
      description?: string | null;
      isActive?: boolean;
      graph?: object;
    } = {};

    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined)
      data.description = input.description || null;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.graph !== undefined) data.graph = input.graph;

    const updated = await prisma.workflowTemplate.update({
      where: { id },
      data,
    });

    await auditService.createAuditLog({
      actorId,
      // Not the action the create writes. A template is the route every memo
      // of its kind travels, and a rewrite filed as a creation leaves the
      // trail unable to say the route ever changed.
      action: "WORKFLOW_TEMPLATE_UPDATED",
      entityType: "WorkflowTemplate",
      entityId: updated.id,
      oldValue: { name: existing.name, isActive: existing.isActive },
      newValue: { name: updated.name, isActive: updated.isActive },
    });

    return updated;
  }

  /**
   * Retire a template: hide it from choosing and from the studio's main list,
   * and keep it. What replaced deleting.
   *
   * Deleting was refused while any memo pointed at the template - a withdrawn
   * one included, because `documents.template_id` is ON DELETE SET NULL and a
   * delete that got past the check emptied the record of which route a memo
   * had travelled. Even when it was allowed, it threw the design away. An
   * archived template leaves every memo exactly as it was, keeps its graph and
   * its audit rows, and can be brought back.
   *
   * It is also switched off, so every place that offers only active templates
   * - the picker, the public read, submission - refuses it without being told
   * about archiving.
   */
  async archiveTemplate(id: string, actorId: string) {
    const existing = await prisma.workflowTemplate.findUnique({ where: { id } });
    if (!existing) {
      throw errors.notFound("Workflow template not found");
    }
    if (existing.archivedAt) {
      throw errors.conflict("This template is already archived.");
    }

    const archived = await prisma.workflowTemplate.update({
      where: { id },
      data: { archivedAt: new Date(), isActive: false },
    });

    await auditService.createAuditLog({
      actorId,
      action: "WORKFLOW_TEMPLATE_ARCHIVED",
      entityType: "WorkflowTemplate",
      entityId: id,
      oldValue: { name: existing.name, isActive: existing.isActive },
      newValue: { name: archived.name, isActive: false, archived: true },
    });

    return archived;
  }

  /**
   * Bring an archived template back to the studio, switched off. Offering it
   * to preparers again is a separate, deliberate step: a route retired for a
   * reason should not reappear in everybody's picker because somebody wanted
   * to look at it.
   */
  async restoreTemplate(id: string, actorId: string) {
    const existing = await prisma.workflowTemplate.findUnique({ where: { id } });
    if (!existing) {
      throw errors.notFound("Workflow template not found");
    }
    if (!existing.archivedAt) {
      throw errors.conflict("This template is not archived.");
    }

    const restored = await prisma.workflowTemplate.update({
      where: { id },
      data: { archivedAt: null },
    });

    await auditService.createAuditLog({
      actorId,
      action: "WORKFLOW_TEMPLATE_RESTORED",
      entityType: "WorkflowTemplate",
      entityId: id,
      oldValue: { name: existing.name, isActive: existing.isActive, archived: true },
      newValue: { name: restored.name, isActive: restored.isActive, archived: false },
    });

    return restored;
  }

  /**
   * Compiles a workflow template graph into an ordered list of approval steps.
   *
   * Two passes, and the second pass is the whole point. Resolving the
   * decisions is a walk; deciding what order the survivors run in is a
   * topological sort, because a join must come after EVERY branch that
   * reaches it. One depth-first walk compiles the join the moment the first
   * branch arrives — which puts the Final Approver in the middle of the chain
   * and gets the submission refused for a reason that talks about the chain
   * to somebody who drew a graph.
   */
  compileGraphToSteps(
    graph: WorkflowGraph,
    document: CompileTarget
  ): CompiledStep[] {
    const nodeMap = new Map<string, WorkflowNode>();
    for (const node of graph.nodes) nodeMap.set(node.id, node);

    const edgeMap = new Map<string, WorkflowEdge[]>();
    for (const edge of graph.edges) {
      const list = edgeMap.get(edge.source) ?? [];
      list.push(edge);
      edgeMap.set(edge.source, list);
    }

    const startNode = graph.nodes.find((n) => n.type === "start");
    if (!startNode) {
      throw errors.badRequest("Workflow template is missing a Start node");
    }

    const route = this.resolveRoute(startNode.id, nodeMap, edgeMap, document);
    return this.orderRoute(route, nodeMap);
  }

  /**
   * Pass one: follow the graph from Start, choosing one branch at each
   * decision, and record both the nodes reached and the edges taken. An edge
   * arriving at a node that has already been reached is still recorded — that
   * is exactly what makes a join a join, and pass two needs to count it.
   */
  private resolveRoute(
    startId: string,
    nodeMap: Map<string, WorkflowNode>,
    edgeMap: Map<string, WorkflowEdge[]>,
    document: CompileTarget
  ): ResolvedRoute {
    const discovered: string[] = [];
    const reached = new Set<string>();
    const taken: Array<{ source: string; target: string }> = [];

    const walk = (nodeId: string, depth: number): void => {
      if (depth > MAX_DEPTH) {
        throw errors.badRequest("Workflow template has a cycle or is too deep");
      }

      const alreadyReached = reached.has(nodeId);
      if (!alreadyReached) {
        reached.add(nodeId);
        discovered.push(nodeId);
      }

      const node = nodeMap.get(nodeId);
      if (!node || node.type === "end") return;
      // A node reached a second time is a join. Its edges were followed the
      // first time; following them again would only re-tread the same graph.
      if (alreadyReached) return;

      const outgoing = edgeMap.get(nodeId) ?? [];
      const next =
        node.type === "decision"
          ? this.chooseBranch(node, outgoing, document)
          : outgoing;

      for (const edge of next) {
        taken.push({ source: nodeId, target: edge.target });
        walk(edge.target, depth + 1);
      }
    };

    walk(startId, 0);
    return { discovered, taken };
  }

  /**
   * Pass two: emit the approval steps in an order that respects every edge
   * taken (Kahn's algorithm). Ties are broken by the order nodes were first
   * reached, so a plain chain keeps the order it was drawn in and "left, then
   * right, then the join" comes out in that order rather than by node id.
   */
  private orderRoute(
    route: ResolvedRoute,
    nodeMap: Map<string, WorkflowNode>
  ): CompiledStep[] {
    const { discovered, taken } = route;
    const rank = new Map(discovered.map((id, index) => [id, index]));

    const incoming = new Map<string, number>(discovered.map((id) => [id, 0]));
    const outgoing = new Map<string, string[]>();
    for (const edge of taken) {
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
      const list = outgoing.get(edge.source) ?? [];
      list.push(edge.target);
      outgoing.set(edge.source, list);
    }

    const ready = discovered.filter((id) => incoming.get(id) === 0);
    const ordered: string[] = [];

    while (ready.length > 0) {
      ready.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
      const nodeId = ready.shift() as string;
      ordered.push(nodeId);

      for (const target of outgoing.get(nodeId) ?? []) {
        const remaining = (incoming.get(target) ?? 0) - 1;
        incoming.set(target, remaining);
        if (remaining === 0) ready.push(target);
      }
    }

    if (ordered.length !== discovered.length) {
      // Some node's incoming count never reached zero, which can only happen
      // if it sits on a loop. The walk's `reached` set hides the loop from
      // pass one, so this is where a cycle actually surfaces.
      throw errors.badRequest("Workflow template has a cycle or is too deep");
    }

    const steps: CompiledStep[] = [];
    for (const nodeId of ordered) {
      const node = nodeMap.get(nodeId);
      if (!node || node.type !== "approval") continue;

      // Refused rather than skipped. Dropping the step routes the document
      // past somebody the person who drew the graph put there, with nothing
      // anywhere recording it; refusing happens at submission, where there is
      // a human present who can go and finish the template. The save-time
      // schema already refuses this shape — a graph stored before it did, or
      // written straight to the database, is what reaches here.
      if (!node.data.approverId) {
        throw errors.badRequest(
          `Approval step "${describe(node)}" has nobody assigned. Open the workflow template and choose an approver.`
        );
      }
      if (!node.data.approvalType) {
        throw errors.badRequest(
          `Approval step "${describe(node)}" has no approval type. Open the workflow template and set one.`
        );
      }

      steps.push({
        slaDays: node.data.slaDays ?? null,
        assignedUserId: node.data.approverId,
        approvalType: node.data.approvalType,
        order: steps.length + 1,
      });
    }

    return steps;
  }

  /**
   * Which way out of a decision, for this document. Returns the one edge to
   * follow, or nothing at all.
   *
   * Nothing at all is the important case. A decision drawn with only a Yes
   * branch — "if the title says CAPITAL, add the CFO" — has nowhere to send a
   * document that does not match, and the honest answer is that this route
   * simply ends here. The previous answer was `outgoing[0]`, which is the Yes
   * edge: a document that FAILED the condition was routed exactly as though
   * it had passed.
   *
   * An edge with no branch label carries no yes/no meaning, so a decision
   * drawn without handles still follows its single edge as before.
   */
  private chooseBranch(
    node: WorkflowNode,
    outgoing: WorkflowEdge[],
    document: CompileTarget
  ): WorkflowEdge[] {
    const labelled = outgoing.some(
      (e) => e.branch === "yes" || e.branch === "no"
    );
    const fallback = (): WorkflowEdge | undefined =>
      outgoing.find((e) => e.branch === "default") ??
      (labelled ? undefined : outgoing[0]);

    const condition = node.data.condition;
    if (!condition) {
      const edge = fallback();
      if (!edge && outgoing.length > 0) {
        // Labelled branches and no condition to choose between them. Picking
        // one would be a coin toss over which approvers see the document.
        throw errors.badRequest(
          `Decision "${describe(node)}" has no condition, so it cannot choose a branch.`
        );
      }
      return edge ? [edge] : [];
    }

    const fieldValue =
      condition.field === "title"
        ? document.title
        : (document.description ?? "");
    const matches = this.evaluateCondition(
      fieldValue,
      condition.operator,
      condition.value
    );

    const edge =
      outgoing.find((e) => e.branch === (matches ? "yes" : "no")) ?? fallback();
    return edge ? [edge] : [];
  }

  private evaluateCondition(
    fieldValue: string,
    operator: "contains" | "equals" | "startsWith",
    value: string
  ): boolean {
    const haystack = fieldValue.toLowerCase();
    const needle = value.toLowerCase();
    switch (operator) {
      case "contains":
        return haystack.includes(needle);
      case "equals":
        return haystack === needle;
      case "startsWith":
        return haystack.startsWith(needle);
    }
  }
}

export const workflowTemplatesService = new WorkflowTemplatesService();
