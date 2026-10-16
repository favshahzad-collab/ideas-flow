import { z } from "zod";
import { ApprovalType } from "../generated/prisma/browser";

/**
 * Single node in a workflow template graph.
 * `type` mirrors the React Flow node types in the designer UI.
 */
export const workflowNodeTypeSchema = z.enum([
  "start",
  "approval",
  "decision",
  "end",
]);

export const workflowNodeSchema = z.object({
  id: z.string().min(1, "Node id is required"),
  type: workflowNodeTypeSchema,
  position: z
    .object({
      x: z.number(),
      y: z.number(),
    })
    .default({ x: 0, y: 0 }),
  data: z
    .object({
      label: z.string().trim().min(1).max(255).optional(),
      approverId: z.uuid("Approver must be a valid user id").optional(),
      approvalType: z.nativeEnum(ApprovalType).optional(),
      /** Working days this step is given. See lib/sla.ts for what null means. */
      slaDays: z.coerce.number().int().min(1).max(365).optional(),
      // Decision condition: when `field` matches `operator` against `value`
      // Supported fields: title, description
      condition: z
        .object({
          field: z.enum(["title", "description"]),
          operator: z.enum(["contains", "equals", "startsWith"]),
          value: z.string().min(1),
        })
        .optional(),
    })
    .default({}),
});

export const workflowEdgeSchema = z.object({
  id: z.string().min(1, "Edge id is required"),
  source: z.string().min(1, "Edge source node is required"),
  target: z.string().min(1, "Edge target node is required"),
  label: z.string().trim().max(50).optional(),
  // Branch hint: which decision branch this edge represents.
  branch: z.enum(["yes", "no", "default"]).optional(),
});

export const workflowGraphSchema = z.object({
  nodes: z.array(workflowNodeSchema).min(1, "At least one node is required"),
  edges: z.array(workflowEdgeSchema).default([]),
});

const graphRefine = (
  graph: z.infer<typeof workflowGraphSchema>,
  ctx: z.RefinementCtx
) => {
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate node id: ${node.id}`,
        path: ["nodes"],
      });
    }
    nodeIds.add(node.id);
  }

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Edge references unknown source node: ${edge.source}`,
        path: ["edges"],
      });
    }
    if (!nodeIds.has(edge.target)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Edge references unknown target node: ${edge.target}`,
        path: ["edges"],
      });
    }
  }

  const startNodes = graph.nodes.filter((n) => n.type === "start");
  if (startNodes.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Workflow must contain exactly one Start node",
      path: ["nodes"],
    });
  }
  if (startNodes.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Workflow can only contain one Start node",
      path: ["nodes"],
    });
  }

  const endNodes = graph.nodes.filter((n) => n.type === "end");
  if (endNodes.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Workflow must contain at least one End node",
      path: ["nodes"],
    });
  }

  const approvalNodes = graph.nodes.filter((n) => n.type === "approval");
  if (approvalNodes.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Workflow must contain at least one Approval step",
      path: ["nodes"],
    });
  }

  for (const node of approvalNodes) {
    if (!node.data.approverId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Approval node "${node.id}" is missing an assigned user`,
        path: ["nodes"],
      });
    }
    if (!node.data.approvalType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Approval node "${node.id}" is missing an approval type`,
        path: ["nodes"],
      });
    }
  }

  const finalApprovers = approvalNodes.filter(
    (n) => n.data.approvalType === ApprovalType.FINAL_APPROVER
  );
  if (finalApprovers.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Workflow must contain exactly one Final Approver step",
      path: ["nodes"],
    });
  }
};

export const createWorkflowTemplateSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1, "Name is required").max(255),
    description: z.string().trim().max(2000).optional().or(z.literal("")),
    isActive: z.boolean().optional().default(true),
    graph: workflowGraphSchema.superRefine(graphRefine),
  }),
});

export const updateWorkflowTemplateSchema = z.object({
  params: z.object({
    id: z.uuid("Invalid template id"),
  }),
  body: z
    .object({
      name: z.string().trim().min(1).max(255).optional(),
      description: z.string().trim().max(2000).optional().or(z.literal("")),
      isActive: z.boolean().optional(),
      graph: workflowGraphSchema.optional().superRefine((g, ctx) => {
        if (g) graphRefine(g, ctx);
      }),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: "At least one field is required",
    }),
});

export const getWorkflowTemplateSchema = z.object({
  params: z.object({
    id: z.uuid("Invalid template id"),
  }),
});

/** Archive and restore: the template's id, nothing else. */
export const workflowTemplateIdSchema = z.object({
  params: z.object({
    id: z.uuid("Invalid template id"),
  }),
});

export const listWorkflowTemplatesSchema = z.object({
  query: z.object({
    isActive: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
    /** `true` lists only archived templates; otherwise they are left out. */
    archived: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => v === "true"),
  }),
});

export type CreateWorkflowTemplateInput = z.infer<
  typeof createWorkflowTemplateSchema
>["body"];
export type UpdateWorkflowTemplateInput = z.infer<
  typeof updateWorkflowTemplateSchema
>["body"];
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

/**
 * The memo a template's route is previewed for. The same two fields its
 * conditions can test, as the submit form has them so far.
 */
export const templateRouteSchema = z.object({
  params: z.object({ id: z.uuid("That template does not exist") }),
  body: z.object({
    title: z.string().max(500).default(""),
    description: z.string().max(10_000).optional(),
  }),
});
