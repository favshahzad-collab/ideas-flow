import { describe, expect, it } from "vitest";
import { ApprovalType } from "../generated/prisma/browser";
import type {
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from "../schemas/workflow-templates.schema";
import { workflowTemplatesService } from "./workflow-templates.service";

/**
 * The template compiler turns a graph somebody drew into the approval chain a
 * document is routed through. It is the one piece of the workflow that
 * produces a chain nobody reviewed step by step, so what it does with an
 * incomplete or ambiguous graph is worth stating rather than discovering.
 *
 * `compileGraphToSteps` touches no database despite living on a service that
 * does, which is why these are unit tests.
 */

const compile = (graph: WorkflowGraph, title = "Q3 budget", description: string | null = null) =>
  workflowTemplatesService.compileGraphToSteps(graph, { title, description });

const APPROVER_A = "11111111-1111-4111-8111-111111111111";
const APPROVER_B = "22222222-2222-4222-8222-222222222222";
const APPROVER_C = "33333333-3333-4333-8333-333333333333";
const APPROVER_D = "44444444-4444-4444-8444-444444444444";

const node = (
  id: string,
  type: WorkflowNode["type"],
  data: WorkflowNode["data"] = {}
): WorkflowNode => ({ id, type, position: { x: 0, y: 0 }, data });

const approval = (id: string, approverId: string, approvalType: ApprovalType) =>
  node(id, "approval", { approverId, approvalType });

const edge = (
  source: string,
  target: string,
  branch?: WorkflowEdge["branch"]
): WorkflowEdge => ({
  id: `${source}->${target}${branch ? `:${branch}` : ""}`,
  source,
  target,
  ...(branch ? { branch } : {}),
});

const graph = (nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowGraph => ({
  nodes,
  edges,
});

const assigned = (steps: { assignedUserId: string }[]) =>
  steps.map((step) => step.assignedUserId);

describe("a straight-through template", () => {
  const straight = graph(
    [
      node("start", "start"),
      approval("a", APPROVER_A, ApprovalType.REVIEWER),
      approval("b", APPROVER_B, ApprovalType.FINAL_APPROVER),
      node("end", "end"),
    ],
    [edge("start", "a"), edge("a", "b"), edge("b", "end")]
  );

  it("compiles the approvers in graph order", () => {
    expect(compile(straight)).toEqual([
      {
        assignedUserId: APPROVER_A,
        approvalType: ApprovalType.REVIEWER,
        order: 1,
        // Null rather than absent: a step that names no deadline of its own
        // falls back to the deployment default, and a compiled step that
        // simply omitted the field would be indistinguishable from one whose
        // deadline had been lost on the way through.
        slaDays: null,
      },
      {
        assignedUserId: APPROVER_B,
        approvalType: ApprovalType.FINAL_APPROVER,
        order: 2,
        slaDays: null,
      },
    ]);
  });

  it("numbers the steps from one", () => {
    // documents.service reassigns stepOrder as `index + 1` when it writes the
    // chain, so these two have to start from the same place.
    expect(compile(straight).map((step) => step.order)).toEqual([1, 2]);
  });

  it("produces no steps from a template that only starts and ends", () => {
    expect(
      compile(graph([node("start", "start"), node("end", "end")], [edge("start", "end")]))
    ).toEqual([]);
  });

  it("refuses a graph with no start node", () => {
    expect(() =>
      compile(graph([approval("a", APPROVER_A, ApprovalType.FINAL_APPROVER)], []))
    ).toThrow(/missing a Start node/);
  });

  it("stops at an end node", () => {
    const past = graph(
      [
        node("start", "start"),
        approval("a", APPROVER_A, ApprovalType.FINAL_APPROVER),
        node("end", "end"),
        approval("orphan", APPROVER_B, ApprovalType.APPROVER),
      ],
      [edge("start", "a"), edge("a", "end"), edge("end", "orphan")]
    );

    expect(assigned(compile(past))).toEqual([APPROVER_A]);
  });
});

describe("decision nodes", () => {
  const branching = (condition: WorkflowNode["data"]["condition"]) =>
    graph(
      [
        node("start", "start"),
        node("d", "decision", { condition }),
        approval("yes", APPROVER_A, ApprovalType.FINAL_APPROVER),
        approval("no", APPROVER_B, ApprovalType.FINAL_APPROVER),
      ],
      [
        edge("start", "d"),
        edge("d", "yes", "yes"),
        edge("d", "no", "no"),
      ]
    );

  const overTenThousand = {
    field: "title" as const,
    operator: "contains" as const,
    value: "capital",
  };

  it("takes the yes branch when the condition matches", () => {
    expect(assigned(compile(branching(overTenThousand), "Capital request"))).toEqual([
      APPROVER_A,
    ]);
  });

  it("takes the no branch when it does not", () => {
    expect(assigned(compile(branching(overTenThousand), "Stationery order"))).toEqual([
      APPROVER_B,
    ]);
  });

  it("follows one branch only", () => {
    expect(compile(branching(overTenThousand), "Capital request")).toHaveLength(1);
  });

  it("matches without regard to case, on either side", () => {
    expect(
      assigned(compile(branching(overTenThousand), "CAPITAL EXPENDITURE"))
    ).toEqual([APPROVER_A]);
  });

  it("reads the description when the condition names it", () => {
    const onDescription = branching({
      field: "description",
      operator: "startsWith",
      value: "urgent",
    });

    expect(assigned(compile(onDescription, "Anything", "Urgent: needs sign-off"))).toEqual(
      [APPROVER_A]
    );
  });

  it("treats a missing description as empty rather than failing", () => {
    const onDescription = branching({
      field: "description",
      operator: "contains",
      value: "urgent",
    });

    expect(assigned(compile(onDescription, "Anything", null))).toEqual([APPROVER_B]);
  });

  it("compares exactly when the operator is equals", () => {
    const exact = branching({
      field: "title",
      operator: "equals",
      value: "Capital request",
    });

    expect(assigned(compile(exact, "Capital request"))).toEqual([APPROVER_A]);
    expect(assigned(compile(exact, "Capital request v2"))).toEqual([APPROVER_B]);
  });

  it("takes the default branch when there is no condition", () => {
    const undecided = graph(
      [
        node("start", "start"),
        node("d", "decision"),
        approval("first", APPROVER_A, ApprovalType.FINAL_APPROVER),
        approval("fallback", APPROVER_B, ApprovalType.FINAL_APPROVER),
      ],
      [
        edge("start", "d"),
        edge("d", "first"),
        edge("d", "fallback", "default"),
      ]
    );

    expect(assigned(compile(undecided))).toEqual([APPROVER_B]);
  });
});

describe("graphs that are not a straight line", () => {
  it("walks every branch out of a node that is not a decision", () => {
    // Two edges out of Start is how the designer expresses "and also", so
    // both branches are compiled, one after the other.
    const fan = graph(
      [
        node("start", "start"),
        approval("a", APPROVER_A, ApprovalType.APPROVER),
        approval("b", APPROVER_B, ApprovalType.FINAL_APPROVER),
      ],
      [edge("start", "a"), edge("start", "b")]
    );

    expect(assigned(compile(fan))).toEqual([APPROVER_A, APPROVER_B]);
  });

  it("places a join after every branch that reaches it, not the first", () => {
    /*
     * The graph says "left and right, then join". A depth-first walk used to
     * compile the join the moment the LEFT branch arrived, before the right
     * branch had been walked at all, giving "left, join, right" - and since
     * the join is the Final Approver, as it usually is, the chain came out
     * with its final step in the middle and the submission was refused for a
     * reason that talked about the chain to somebody who drew a graph.
     */
    const diamond = graph(
      [
        node("start", "start"),
        approval("left", APPROVER_A, ApprovalType.REVIEWER),
        approval("right", APPROVER_B, ApprovalType.APPROVER),
        approval("join", APPROVER_C, ApprovalType.FINAL_APPROVER),
      ],
      [
        edge("start", "left"),
        edge("start", "right"),
        edge("left", "join"),
        edge("right", "join"),
      ]
    );

    expect(assigned(compile(diamond))).toEqual([
      APPROVER_A, // left
      APPROVER_B, // right
      APPROVER_C, // join, once both branches have been through
    ]);
  });

  it("waits for the longer branch before compiling the join", () => {
    // The join is not simply "last". It is after everything that leads to it,
    // however uneven the two sides are - which is what a topological order
    // buys that "compile the join last" would not.
    const uneven = graph(
      [
        node("start", "start"),
        approval("left1", APPROVER_A, ApprovalType.REVIEWER),
        approval("left2", APPROVER_B, ApprovalType.REVIEWER),
        approval("right", APPROVER_C, ApprovalType.APPROVER),
        approval("join", APPROVER_D, ApprovalType.FINAL_APPROVER),
      ],
      [
        edge("start", "left1"),
        edge("left1", "left2"),
        edge("start", "right"),
        edge("left2", "join"),
        edge("right", "join"),
      ]
    );

    const order = assigned(compile(uneven));

    expect(order[order.length - 1]).toBe(APPROVER_D);
    expect(order).toHaveLength(4);
    expect(order.indexOf(APPROVER_B)).toBeLessThan(order.indexOf(APPROVER_D));
  });

  it("refuses a graph that loops back on itself", () => {
    // It used to compile one lap and stop, quietly producing a chain from a
    // graph that describes an approval going round for ever. There is no
    // right chain to make from it, so the honest answer is to refuse and say
    // why while somebody is still looking at the template.
    const loop = graph(
      [
        node("start", "start"),
        approval("a", APPROVER_A, ApprovalType.REVIEWER),
        approval("b", APPROVER_B, ApprovalType.FINAL_APPROVER),
      ],
      [edge("start", "a"), edge("a", "b"), edge("b", "a")]
    );

    expect(() => compile(loop)).toThrow(/cycle or is too deep/);
  });

  it("refuses a graph deeper than it will walk", () => {
    const nodes: WorkflowNode[] = [node("start", "start")];
    const edges: WorkflowEdge[] = [];
    for (let i = 0; i < 205; i += 1) {
      nodes.push(approval(`n${i}`, APPROVER_A, ApprovalType.APPROVER));
      edges.push(edge(i === 0 ? "start" : `n${i - 1}`, `n${i}`));
    }

    expect(() => compile(graph(nodes, edges))).toThrow(/cycle or is too deep/);
  });
});

describe("incomplete approval nodes", () => {
  /*
   * These used to compile to a chain with the step silently missing, which
   * routed the document past somebody the person who drew the graph put
   * there, with nothing anywhere recording it. The save-time schema refuses
   * this shape, so what reaches the compiler is a graph stored before it did
   * or written straight to the database - and the compiler now refuses it
   * too, at submission, where there is a person present who can go and finish
   * the template.
   */
  it("refuses an approval node with nobody assigned", () => {
    const incomplete = graph(
      [
        node("start", "start"),
        node("a", "approval", { approvalType: ApprovalType.REVIEWER }),
        approval("b", APPROVER_B, ApprovalType.FINAL_APPROVER),
      ],
      [edge("start", "a"), edge("a", "b")]
    );

    expect(() => compile(incomplete)).toThrow(/has nobody assigned/);
  });

  it("refuses an approval node with no approval type", () => {
    const incomplete = graph(
      [
        node("start", "start"),
        node("a", "approval", { approverId: APPROVER_A }),
        approval("b", APPROVER_B, ApprovalType.FINAL_APPROVER),
      ],
      [edge("start", "a"), edge("a", "b")]
    );

    expect(() => compile(incomplete)).toThrow(/no approval type/);
  });

  it("names the step, so the message says which one to go and fix", () => {
    // "An approval step has nobody assigned" is unactionable on a graph with
    // six of them. The label is what the person sees on the canvas.
    const labelled = graph(
      [
        node("start", "start"),
        node("a", "approval", { label: "Finance review" }),
        approval("b", APPROVER_B, ApprovalType.FINAL_APPROVER),
      ],
      [edge("start", "a"), edge("a", "b")]
    );

    expect(() => compile(labelled)).toThrow(/Finance review/);
  });

  it("falls back to the node id when the step was never named", () => {
    const unlabelled = graph(
      [node("start", "start"), node("step-3", "approval"), node("end", "end")],
      [edge("start", "step-3"), edge("step-3", "end")]
    );

    expect(() => compile(unlabelled)).toThrow(/step-3/);
  });
});

describe("a decision with a branch missing", () => {
  const halfWired = graph(
    [
      node("start", "start"),
      node("d", "decision", {
        condition: { field: "title", operator: "contains", value: "capital" },
      }),
      approval("yes", APPROVER_A, ApprovalType.FINAL_APPROVER),
    ],
    [edge("start", "d"), edge("d", "yes", "yes")]
  );

  it("still takes the branch it does have when the condition matches", () => {
    expect(assigned(compile(halfWired, "Capital request"))).toEqual([APPROVER_A]);
  });

  it("ends the route rather than taking the branch it was not given", () => {
    /*
     * This is the one that mattered. The document does not match, there is no
     * `no` edge and no `default`, and the compiler used to take `outgoing[0]`
     * - which is the `yes` branch. A document that FAILED the condition was
     * routed exactly as though it had passed, through approvers it was never
     * meant to reach.
     *
     * "If the title says CAPITAL, add the CFO" is how this graph is drawn in
     * the designer, and a document that is not capital expenditure simply
     * does not get that step. Ending here is what the graph says.
     */
    expect(compile(halfWired, "Stationery order")).toEqual([]);
  });

  it("prefers an explicit default over ending the route", () => {
    const withDefault = graph(
      [
        node("start", "start"),
        node("d", "decision", {
          condition: { field: "title", operator: "contains", value: "capital" },
        }),
        approval("yes", APPROVER_A, ApprovalType.FINAL_APPROVER),
        approval("otherwise", APPROVER_B, ApprovalType.FINAL_APPROVER),
      ],
      [edge("start", "d"), edge("d", "yes", "yes"), edge("d", "otherwise", "default")]
    );

    expect(assigned(compile(withDefault, "Stationery order"))).toEqual([APPROVER_B]);
  });

  it("follows a single unlabelled edge, which carries no yes/no meaning", () => {
    // A decision drawn without using the Yes/No handles has no branch to get
    // wrong. Ending the route there would break graphs that work today.
    const unlabelled = graph(
      [
        node("start", "start"),
        node("d", "decision", {
          condition: { field: "title", operator: "contains", value: "capital" },
        }),
        approval("next", APPROVER_A, ApprovalType.FINAL_APPROVER),
      ],
      [edge("start", "d"), edge("d", "next")]
    );

    expect(assigned(compile(unlabelled, "Stationery order"))).toEqual([APPROVER_A]);
  });

  it("refuses to guess between labelled branches with no condition to judge by", () => {
    // Picking one would be a coin toss over which approvers see the document.
    const undecidable = graph(
      [
        node("start", "start"),
        node("d", "decision", { label: "Over £10k?" }),
        approval("yes", APPROVER_A, ApprovalType.FINAL_APPROVER),
        approval("no", APPROVER_B, ApprovalType.FINAL_APPROVER),
      ],
      [edge("start", "d"), edge("d", "yes", "yes"), edge("d", "no", "no")]
    );

    expect(() => compile(undecidable)).toThrow(/has no condition/);
  });
});
