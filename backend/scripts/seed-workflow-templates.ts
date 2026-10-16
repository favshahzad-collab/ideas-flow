/**
 * The starting set of workflow templates.
 *
 * A deployment with no templates can still route a memo - the preparer builds
 * a chain by hand at submission - but every memo then gets its route invented
 * by whoever happens to be submitting it, which is the thing an approval
 * system exists to stop. These are the routes themselves, drawn once.
 *
 * WHO IS ASSIGNED IS A PLACEHOLDER. Every approval step is labelled with the
 * ROLE it represents - "HR Review", "Department Head", "Final Approval" - and
 * the label is what carries the intent. The user behind it is a stand-in from
 * the five accounts that exist today, chosen so the template validates and
 * compiles; change them in Workflow Studio without touching the shape.
 *
 * The graph rules these are written against, all enforced in
 * `schemas/workflow-templates.schema.ts`:
 *
 *   - exactly one Start, at least one End, at least one Approval
 *   - every Approval step needs an assignee and an approval type
 *   - EXACTLY ONE step across the whole graph may be FINAL_APPROVER
 *
 * That last one is what shapes every branching template here: both arms of a
 * decision must CONVERGE on the one Final Approval node. Giving each arm its
 * own final approver is two, which the schema refuses; giving only one arm a
 * final approver compiles the other arm into a chain that ends without one.
 *
 * Dry run by default - validates every graph, compiles each against sample
 * documents, prints the chain it would produce, and writes nothing:
 *
 *     npx tsx scripts/seed-workflow-templates.ts
 *     npx tsx scripts/seed-workflow-templates.ts --apply
 *
 * Idempotent: a template whose name already exists is left alone.
 */
import { prisma } from "../src/prisma";
import { workflowTemplatesService } from "../src/services/workflow-templates.service";
import { createWorkflowTemplateSchema } from "../src/schemas/workflow-templates.schema";
import type { WorkflowGraph } from "../src/schemas/workflow-templates.schema";

type Role =
  | "hrReview"
  | "deptHead"
  | "finance"
  | "compliance"
  | "legal"
  | "admin"
  | "finalApproval";

/**
 * Which account stands in for which role today.
 *
 * By email rather than id so this file stays readable and survives a reseed.
 * Two of these are the same person more than once on purpose - there are five
 * accounts and more roles than that, and a template with a repeated approver
 * is a legitimate thing to fix by reassigning rather than by redrawing.
 */
const PLACEHOLDER: Record<Role, string> = {
  hrReview: "reham.nawaz@ideas.com.pk",
  deptHead: "aamir.raza@ideas.com.pk",
  finance: "adnan.mumtaz@ideas.com.pk",
  compliance: "adnan.mumtaz@ideas.com.pk",
  legal: "kazim.zaidi@ideas.com.pk",
  admin: "adnan.mumtaz@ideas.com.pk",
  finalApproval: "shahzad.ali@ideas.com.pk",
};

type StepSpec = {
  key: string;
  label: string;
  role: Role;
  type: "REVIEWER" | "APPROVER" | "FINAL_APPROVER";
  slaDays?: number;
};

/** A template as written here, before user ids are resolved into it. */
type TemplateSpec = {
  name: string;
  description: string;
  /** What this template is for, in the terms the compiler cares about. */
  covers: string;
  build: (id: (role: Role) => string) => WorkflowGraph;
  /** Titles to compile against, to show both arms of any decision. */
  samples: string[];
};

const COL = 250;
const ROW = 130;

function node(
  key: string,
  type: "start" | "approval" | "decision" | "end",
  col: number,
  row: number,
  data: Record<string, unknown> = {},
) {
  return {
    id: key,
    type,
    position: { x: col * COL, y: row * ROW },
    data,
  };
}

function edge(source: string, target: string, branch?: "yes" | "no" | "default", label?: string) {
  return {
    id: `${source}->${target}`,
    source,
    target,
    ...(branch ? { branch } : {}),
    ...(label ? { label } : {}),
  };
}

/** Start -> each step in order -> End. The shape most of these are. */
function chain(id: (role: Role) => string, steps: StepSpec[]): WorkflowGraph {
  const nodes = [
    node("start", "start", 0, 0, { label: "Submitted" }),
    ...steps.map((s, i) =>
      node(s.key, "approval", i + 1, 0, {
        label: s.label,
        approverId: id(s.role),
        approvalType: s.type,
        ...(s.slaDays ? { slaDays: s.slaDays } : {}),
      }),
    ),
    node("end", "end", steps.length + 1, 0, { label: "Approved" }),
  ];

  const order = ["start", ...steps.map((s) => s.key), "end"];
  const edges = order.slice(0, -1).map((from, i) => edge(from, order[i + 1]));

  return { nodes, edges };
}

const TEMPLATES: TemplateSpec[] = [
  {
    name: "Routine Notice — single approval",
    description:
      "One signature. For notices that need to be recorded and issued, not debated: office timings, holiday announcements, circulars of fact.",
    covers: "the shortest legal chain — one step, and it is the Final Approver",
    samples: ["Office closed on 14 August"],
    build: (id) =>
      chain(id, [
        { key: "final", label: "Final Approval", role: "finalApproval", type: "FINAL_APPROVER" },
      ]),
  },
  {
    name: "Departmental Memo — two steps",
    description:
      "Department Head approves, then Final Approval signs. For memos that stay inside one department and carry no cost.",
    covers: "two steps, APPROVER then FINAL_APPROVER",
    samples: ["Revised seating plan for Ladies Pret"],
    build: (id) =>
      chain(id, [
        { key: "dept", label: "Department Head", role: "deptHead", type: "APPROVER" },
        { key: "final", label: "Final Approval", role: "finalApproval", type: "FINAL_APPROVER" },
      ]),
  },
  {
    name: "Office Memorandum — standard",
    description:
      "The default route for an HR memo: HR reviews it, the Department Head approves it, Final Approval signs it.",
    covers: "the classic three-step chain — REVIEWER, APPROVER, FINAL_APPROVER",
    samples: ["Office Memorandum — revised attendance policy"],
    build: (id) =>
      chain(id, [
        { key: "hr", label: "HR Review", role: "hrReview", type: "REVIEWER" },
        { key: "dept", label: "Department Head", role: "deptHead", type: "APPROVER" },
        { key: "final", label: "Final Approval", role: "finalApproval", type: "FINAL_APPROVER" },
      ]),
  },
  {
    name: "Policy Circular — four steps",
    description:
      "For anything that changes a standing policy: HR drafts the review, Compliance checks it against regulation, the Department Head approves, Final Approval signs.",
    covers: "a four-step chain with two reviewers before the approver",
    samples: ["Policy Circular — updated leave entitlement"],
    build: (id) =>
      chain(id, [
        { key: "hr", label: "HR Review", role: "hrReview", type: "REVIEWER" },
        { key: "compliance", label: "Compliance Review", role: "compliance", type: "REVIEWER" },
        { key: "dept", label: "Department Head", role: "deptHead", type: "APPROVER" },
        { key: "final", label: "Final Approval", role: "finalApproval", type: "FINAL_APPROVER" },
      ]),
  },
  {
    name: "Disciplinary / Show-cause — tight deadlines",
    description:
      "Same shape as a standard memo, but every step is given a short working-day deadline. A show-cause notice that sits in a queue for a fortnight has stopped being one.",
    covers: "per-step slaDays, which drive the overdue sweep and the chasing notice",
    samples: ["Show-cause notice — repeated late arrival"],
    build: (id) =>
      chain(id, [
        { key: "hr", label: "HR Review", role: "hrReview", type: "REVIEWER", slaDays: 2 },
        { key: "dept", label: "Department Head", role: "deptHead", type: "APPROVER", slaDays: 2 },
        {
          key: "final",
          label: "Final Approval",
          role: "finalApproval",
          type: "FINAL_APPROVER",
          slaDays: 3,
        },
      ]),
  },
  {
    name: "Recruitment Approval",
    description:
      "Hiring costs money, so Finance sits between HR and the Department Head. Deadlines are generous because the approvers are reading a business case, not a notice.",
    covers: "a four-step chain with Finance in the middle and realistic SLAs",
    samples: ["Recruitment — two Sales Associates for Gulberg"],
    build: (id) =>
      chain(id, [
        { key: "hr", label: "HR Review", role: "hrReview", type: "REVIEWER", slaDays: 3 },
        { key: "finance", label: "Finance Review", role: "finance", type: "REVIEWER", slaDays: 3 },
        { key: "dept", label: "Department Head", role: "deptHead", type: "APPROVER", slaDays: 5 },
        {
          key: "final",
          label: "Final Approval",
          role: "finalApproval",
          type: "FINAL_APPROVER",
          slaDays: 5,
        },
      ]),
  },
  {
    name: "Separation / Clearance — full chain",
    description:
      "The longest route, because a departure touches everybody: HR, the Department Head, Finance for dues, Administration for assets, then Final Approval.",
    covers: "a five-step chain — the longest shape in this set",
    samples: ["Separation and clearance — Ali Hassan, Retail"],
    build: (id) =>
      chain(id, [
        { key: "hr", label: "HR Review", role: "hrReview", type: "REVIEWER" },
        { key: "dept", label: "Department Head", role: "deptHead", type: "APPROVER" },
        { key: "finance", label: "Finance Clearance", role: "finance", type: "REVIEWER" },
        { key: "admin", label: "Administration Clearance", role: "admin", type: "REVIEWER" },
        { key: "final", label: "Final Approval", role: "finalApproval", type: "FINAL_APPROVER" },
      ]),
  },
  {
    name: "Confidential Memo — conditional legal review",
    description:
      'If the title contains "CONFIDENTIAL" the memo goes through Legal before Final Approval; otherwise it skips that step. Both routes end at the same signature.',
    covers: "a yes/no decision whose two arms converge on one Final Approver",
    samples: [
      "CONFIDENTIAL — restructuring of the Studio team",
      "Team lunch on Friday",
    ],
    build: (id) => ({
      nodes: [
        node("start", "start", 0, 0, { label: "Submitted" }),
        node("hr", "approval", 1, 0, {
          label: "HR Review",
          approverId: id("hrReview"),
          approvalType: "REVIEWER",
        }),
        node("isConfidential", "decision", 2, 0, {
          label: "Marked confidential?",
          condition: { field: "title", operator: "contains", value: "CONFIDENTIAL" },
        }),
        node("legal", "approval", 3, -1, {
          label: "Legal Review",
          approverId: id("legal"),
          approvalType: "REVIEWER",
        }),
        node("final", "approval", 4, 0, {
          label: "Final Approval",
          approverId: id("finalApproval"),
          approvalType: "FINAL_APPROVER",
        }),
        node("end", "end", 5, 0, { label: "Approved" }),
      ],
      edges: [
        edge("start", "hr"),
        edge("hr", "isConfidential"),
        edge("isConfidential", "legal", "yes", "Confidential"),
        edge("isConfidential", "final", "no", "Ordinary"),
        edge("legal", "final"),
        edge("final", "end"),
      ],
    }),
  },
  {
    name: "Capital Expenditure — conditional finance gate",
    description:
      'If the title contains "CAPEX" the memo picks up a Finance review after the Department Head; anything else goes straight to Final Approval. The "no" arm is drawn as the default branch.',
    covers: "a decision using a DEFAULT branch rather than an explicit no",
    samples: [
      "CAPEX — new POS terminals for three stores",
      "Revised stationery supplier",
    ],
    build: (id) => ({
      nodes: [
        node("start", "start", 0, 0, { label: "Submitted" }),
        node("dept", "approval", 1, 0, {
          label: "Department Head",
          approverId: id("deptHead"),
          approvalType: "APPROVER",
        }),
        node("isCapex", "decision", 2, 0, {
          label: "Capital expenditure?",
          condition: { field: "title", operator: "contains", value: "CAPEX" },
        }),
        node("finance", "approval", 3, -1, {
          label: "Finance Review",
          approverId: id("finance"),
          approvalType: "REVIEWER",
        }),
        node("final", "approval", 4, 0, {
          label: "Final Approval",
          approverId: id("finalApproval"),
          approvalType: "FINAL_APPROVER",
        }),
        node("end", "end", 5, 0, { label: "Approved" }),
      ],
      edges: [
        edge("start", "dept"),
        edge("dept", "isCapex"),
        edge("isCapex", "finance", "yes", "Capital"),
        edge("isCapex", "final", "default", "Everything else"),
        edge("finance", "final"),
        edge("final", "end"),
      ],
    }),
  },
  {
    name: "Parallel review — HR and Administration, then sign",
    description:
      "HR and Administration both review the memo, and Final Approval waits for both. Use it where two functions have to see something but neither needs to wait for the other.",
    covers: "two branches from Start joining on one node — the compiler's topological ordering",
    samples: ["Revised office access and attendance procedure"],
    build: (id) => ({
      nodes: [
        node("start", "start", 0, 0, { label: "Submitted" }),
        node("hr", "approval", 1, -1, {
          label: "HR Review",
          approverId: id("hrReview"),
          approvalType: "REVIEWER",
        }),
        node("admin", "approval", 1, 1, {
          label: "Administration Review",
          approverId: id("admin"),
          approvalType: "REVIEWER",
        }),
        node("final", "approval", 2, 0, {
          label: "Final Approval",
          approverId: id("finalApproval"),
          approvalType: "FINAL_APPROVER",
        }),
        node("end", "end", 3, 0, { label: "Approved" }),
      ],
      edges: [
        edge("start", "hr"),
        edge("start", "admin"),
        edge("hr", "final"),
        edge("admin", "final"),
        edge("final", "end"),
      ],
    }),
  },
];

async function main() {
  const apply = process.argv.includes("--apply");

  const emails = [...new Set(Object.values(PLACEHOLDER))];
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true, firstName: true, lastName: true, loginRole: true },
  });

  const byEmail = new Map(users.map((u) => [u.email, u]));
  const byId = new Map(users.map((u) => [u.id, u]));
  const missing = emails.filter((e) => !byEmail.has(e));
  if (missing.length) {
    console.error("Cannot seed: these placeholder accounts do not exist:");
    for (const m of missing) console.error(`  ${m}`);
    console.error("\nEdit PLACEHOLDER at the top of this file to accounts that do.");
    process.exit(1);
  }

  const id = (role: Role): string => byEmail.get(PLACEHOLDER[role])!.id;

  const actor = users.find((u) => u.loginRole === "ADMINISTRATOR") ?? users[0];

  console.log("");
  console.log("=== PLACEHOLDER ASSIGNEES (change these in Workflow Studio) ===");
  for (const [role, email] of Object.entries(PLACEHOLDER)) {
    const u = byEmail.get(email)!;
    console.log(`  ${role.padEnd(14)} ${`${u.firstName} ${u.lastName}`.padEnd(16)} ${email}`);
  }

  const existing = new Set(
    (await prisma.workflowTemplate.findMany({ select: { name: true } })).map((t) => t.name),
  );

  let created = 0;
  let skipped = 0;
  let refused = 0;

  for (const spec of TEMPLATES) {
    console.log("");
    console.log(`--- ${spec.name}`);
    console.log(`    covers: ${spec.covers}`);

    const graph = spec.build(id);

    // Exactly what the API would do with it, so a template that would be
    // refused at the route is refused here rather than written to the table.
    const parsed = createWorkflowTemplateSchema.safeParse({
      body: { name: spec.name, description: spec.description, isActive: true, graph },
    });
    if (!parsed.success) {
      refused += 1;
      console.log("    REFUSED by the graph schema:");
      for (const issue of parsed.error.issues) {
        console.log(`      ${issue.path.join(".")}: ${issue.message}`);
      }
      continue;
    }

    // And what it actually produces at submission - the real proof. A graph
    // that validates can still compile to a chain nobody intended.
    for (const title of spec.samples) {
      const steps = workflowTemplatesService.compileGraphToSteps(graph, {
        title,
        description: null,
      });
      /*
       * A compiled step carries the user id, not the node it came from — so
       * when two nodes share an approver, looking the label up by user finds
       * whichever node comes first and prints it twice. That is exactly what
       * happened to Separation/Clearance, where Finance and Administration are
       * the same stand-in account: the chain was right and the printout lied.
       *
       * Matched by consuming each node once instead, in the order the graph
       * lists them.
       */
      const unmatched = graph.nodes.filter((n) => n.type === "approval");
      const shown = steps
        .map((s) => {
          const at = unmatched.findIndex((n) => n.data.approverId === s.assignedUserId);
          const label = at >= 0 ? unmatched.splice(at, 1)[0].data.label : undefined;
          const who = byId.get(s.assignedUserId)!;
          return `${s.order}. ${(label ?? "?").padEnd(26)} ${s.approvalType}${
            s.slaDays ? `, ${s.slaDays}d` : ""
          } → ${who.firstName} ${who.lastName}`;
        })
        .join("\n         ");
      console.log(`    "${title}"`);
      console.log(`         ${shown}`);

      const finals = steps.filter((s) => s.approvalType === "FINAL_APPROVER");
      if (finals.length !== 1) {
        refused += 1;
        console.log(
          `    REFUSED: this route compiles to ${finals.length} final approvers, not 1`,
        );
      }
      if (finals.length === 1 && steps[steps.length - 1]?.approvalType !== "FINAL_APPROVER") {
        refused += 1;
        console.log("    REFUSED: the final approver is not the last step of this route");
      }
    }

    /*
     * Five accounts and more roles than that, so some templates put the same
     * person on two steps. It is legal - nothing enforces one step per person -
     * and it is almost certainly not what anybody wants: that approver signs
     * twice and the second signature adds nothing. Named here rather than left
     * to be discovered on a live memo.
     */
    const perUser = new Map<string, string[]>();
    for (const n of graph.nodes) {
      if (n.type !== "approval" || !n.data.approverId) continue;
      const list = perUser.get(n.data.approverId) ?? [];
      list.push(String(n.data.label));
      perUser.set(n.data.approverId, list);
    }
    for (const [userId, labels] of perUser) {
      if (labels.length < 2) continue;
      const who = byId.get(userId)!;
      console.log(
        `    REASSIGN: ${who.firstName} ${who.lastName} holds ${labels.length} steps here` +
          ` — ${labels.join(" and ")}`,
      );
    }

    if (existing.has(spec.name)) {
      skipped += 1;
      console.log("    already present — left alone");
      continue;
    }

    if (apply) {
      await workflowTemplatesService.createTemplate(parsed.data.body, actor.id);
      created += 1;
      console.log("    created");
    } else {
      console.log("    would create (dry run)");
    }
  }

  console.log("");
  console.log(
    `${apply ? "APPLIED" : "DRY RUN"}: ${created} created, ${skipped} already present, ` +
      `${refused} refused, ${TEMPLATES.length} templates in this set`,
  );
  if (!apply && refused === 0) console.log("Re-run with --apply to write them.");

  await prisma.$disconnect();
  return refused;
}

main()
  .then((refused) => {
    process.exit(refused > 0 ? 1 : 0);
  })
  .catch((error: unknown) => {
    console.error(
      `\nThe seed could not finish: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
