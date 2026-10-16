import { describe, expect, it } from "vitest";
import {
  canUserViewDocument,
  documentHasUserActed,
  hasWorkflowReachedUser,
  isUserInApprovalChain,
  prismaDocumentAccessFilter,
} from "./documentAccess";

/**
 * This module decides who is allowed to see a document. It is the only place
 * that decision is made, so the rules it encodes are worth stating as tests
 * rather than leaving to be re-derived from the code each time.
 *
 * Step numbers are 1-based: documents.service creates chain steps with
 * `stepOrder: index + 1` and starts the run at `currentStepOrder: 1`.
 */

const PREPARER = "preparer";
const FIRST = "first-approver";
const SECOND = "second-approver";
const THIRD = "third-approver";
const STRANGER = "someone-else";

const chainOf = (...assignedUserIds: string[]) => ({
  steps: assignedUserIds.map((assignedUserId, index) => ({
    assignedUserId,
    stepOrder: index + 1,
  })),
});

const CHAIN = chainOf(FIRST, SECOND, THIRD);

/** A live run sitting on `currentStepOrder`. */
const runAt = (currentStepOrder: number) => ({
  status: "IN_PROGRESS" as const,
  currentStepOrder,
  chain: CHAIN,
});

describe("canUserViewDocument", () => {
  it("lets the preparer see their own document before it is submitted", () => {
    expect(
      canUserViewDocument({ preparerId: PREPARER, userId: PREPARER })
    ).toBe(true);
  });

  it("refuses someone who is not in the chain at all", () => {
    expect(
      canUserViewDocument({
        preparerId: PREPARER,
        userId: STRANGER,
        approvalChain: CHAIN,
        currentWorkflowRun: runAt(3),
      })
    ).toBe(false);
  });

  it("refuses an approver while the document is still a draft", () => {
    // A chain exists, but no run has started: nobody has been asked yet, and
    // an unsubmitted draft must not be readable by its future approvers.
    expect(
      canUserViewDocument({
        preparerId: PREPARER,
        userId: FIRST,
        approvalChain: CHAIN,
        currentWorkflowRun: null,
      })
    ).toBe(false);
  });

  it("refuses an approver when the run history is explicitly empty", () => {
    expect(
      canUserViewDocument({
        preparerId: PREPARER,
        userId: FIRST,
        approvalChain: CHAIN,
        workflowRunHistory: [],
      })
    ).toBe(false);
  });

  it("lets the approver at the current step see it", () => {
    expect(
      canUserViewDocument({
        preparerId: PREPARER,
        userId: FIRST,
        approvalChain: CHAIN,
        currentWorkflowRun: runAt(1),
      })
    ).toBe(true);
  });

  it("hides it from an approver the workflow has not reached yet", () => {
    expect(
      canUserViewDocument({
        preparerId: PREPARER,
        userId: SECOND,
        approvalChain: CHAIN,
        currentWorkflowRun: runAt(1),
      })
    ).toBe(false);
  });

  it("keeps it visible to an approver the workflow has moved past", () => {
    expect(
      canUserViewDocument({
        preparerId: PREPARER,
        userId: FIRST,
        approvalChain: CHAIN,
        currentWorkflowRun: runAt(3),
      })
    ).toBe(true);
  });

  it("does not un-see a document when a revision restarts the run", () => {
    // The first run reached step 3; a revision request started run 2 back at
    // step 1. The third approver has already read the document - taking it
    // back off them would be a surprise, not a security boundary.
    expect(
      canUserViewDocument({
        preparerId: PREPARER,
        userId: THIRD,
        approvalChain: CHAIN,
        workflowRunHistory: [{ currentStepOrder: 3 }, { currentStepOrder: 1 }],
      })
    ).toBe(true);
  });

  it("requires chain membership even from someone who has acted", () => {
    // `hasUserActed` is a shortcut past the step-order check, not past the
    // membership check. Order matters here and this pins it.
    expect(
      canUserViewDocument({
        preparerId: PREPARER,
        userId: STRANGER,
        approvalChain: CHAIN,
        hasUserActed: true,
      })
    ).toBe(false);
  });

  it("falls back to the chain hanging off the current run", () => {
    // Some queries select the chain through the run rather than off the
    // document, and the answer has to be the same either way.
    expect(
      canUserViewDocument({
        preparerId: PREPARER,
        userId: FIRST,
        currentWorkflowRun: runAt(2),
      })
    ).toBe(true);
  });
});

describe("hasWorkflowReachedUser", () => {
  it("is true for anyone who has already acted, chain or no chain", () => {
    expect(
      hasWorkflowReachedUser({ userId: STRANGER, hasUserActed: true })
    ).toBe(true);
  });

  it("is false when the user has no step in the chain", () => {
    expect(
      hasWorkflowReachedUser({
        userId: STRANGER,
        approvalChain: CHAIN,
        currentWorkflowRun: runAt(3),
      })
    ).toBe(false);
  });

  it("takes the furthest step any run reached, not the latest run", () => {
    expect(
      hasWorkflowReachedUser({
        userId: SECOND,
        approvalChain: CHAIN,
        workflowRunHistory: [{ currentStepOrder: 1 }, { currentStepOrder: 2 }],
      })
    ).toBe(true);
  });

  it("prefers an explicit history over the current run", () => {
    expect(
      hasWorkflowReachedUser({
        userId: THIRD,
        approvalChain: CHAIN,
        currentWorkflowRun: runAt(1),
        workflowRunHistory: [{ currentStepOrder: 3 }],
      })
    ).toBe(true);
  });
});

describe("isUserInApprovalChain", () => {
  it("is false for a document with no chain", () => {
    expect(isUserInApprovalChain(null, FIRST)).toBe(false);
    expect(isUserInApprovalChain(undefined, FIRST)).toBe(false);
  });

  it("is false for an empty chain", () => {
    expect(isUserInApprovalChain(chainOf(), FIRST)).toBe(false);
  });

  it("finds a member at any position", () => {
    expect(isUserInApprovalChain(CHAIN, THIRD)).toBe(true);
  });
});

describe("documentHasUserActed", () => {
  it("is false when there are no runs", () => {
    expect(documentHasUserActed(undefined)).toBe(false);
    expect(documentHasUserActed([])).toBe(false);
  });

  it("is false when a run exists but carries no actions", () => {
    expect(
      documentHasUserActed([{ currentStepOrder: 1, actions: [] }])
    ).toBe(false);
    expect(documentHasUserActed([{ currentStepOrder: 1 }])).toBe(false);
  });

  it("is true when any run carries an action", () => {
    expect(
      documentHasUserActed([
        { currentStepOrder: 1, actions: [] },
        { currentStepOrder: 2, actions: [{ id: "action-1" }] },
      ])
    ).toBe(true);
  });
});

describe("prismaDocumentAccessFilter", () => {
  // The database-side twin of canUserViewDocument. If the two drift apart the
  // list and the detail screen disagree about the same document, so the shape
  // is asserted rather than assumed.
  it("matches documents the user prepared or appears in the chain of", () => {
    expect(prismaDocumentAccessFilter(FIRST)).toEqual({
      OR: [
        { preparerId: FIRST },
        {
          approvalChain: { steps: { some: { assignedUserId: { in: [FIRST] } } } },
        },
      ],
    });
  });

  it("also matches the chains of people who delegated to them", () => {
    expect(prismaDocumentAccessFilter(FIRST, [SECOND])).toEqual({
      OR: [
        { preparerId: FIRST },
        {
          approvalChain: {
            steps: { some: { assignedUserId: { in: [FIRST, SECOND] } } },
          },
        },
      ],
    });
  });

  it("does not extend authorship", () => {
    // A delegate covers somebody's approvals, not their drafts. If this
    // widened `preparerId` too, standing in for a colleague for a week would
    // open every document they had ever written.
    const filter = prismaDocumentAccessFilter(FIRST, [SECOND]);

    expect(filter.OR?.[0]).toEqual({ preparerId: FIRST });
  });
});

describe("acting for somebody else", () => {
  const chainOf = (...ids: string[]) => ({
    steps: ids.map((assignedUserId, index) => ({
      assignedUserId,
      stepOrder: index + 1,
    })),
  });

  it("lets a delegate see a document that has reached the person they cover", () => {
    expect(
      canUserViewDocument({
        preparerId: "preparer",
        userId: "delegate",
        actingFor: [SECOND],
        approvalChain: chainOf(FIRST, SECOND),
        workflowRunHistory: [{ currentStepOrder: 2 }],
      })
    ).toBe(true);
  });

  it("keeps the same waiting rule for a delegate as for the person themselves", () => {
    // Covering for the approver at step 2 does not open a document still
    // sitting at step 1. The delegation hands over their authority, not more
    // of it.
    expect(
      canUserViewDocument({
        preparerId: "preparer",
        userId: "delegate",
        actingFor: [SECOND],
        approvalChain: chainOf(FIRST, SECOND),
        workflowRunHistory: [{ currentStepOrder: 1 }],
      })
    ).toBe(false);
  });

  it("refuses a delegate of somebody who is not on the chain at all", () => {
    expect(
      canUserViewDocument({
        preparerId: "preparer",
        userId: "delegate",
        actingFor: ["a-stranger"],
        approvalChain: chainOf(FIRST, SECOND),
        workflowRunHistory: [{ currentStepOrder: 2 }],
      })
    ).toBe(false);
  });

  it("opens it at the earliest step in reach when they cover two people", () => {
    expect(
      hasWorkflowReachedUser({
        userId: "delegate",
        actingFor: [SECOND, FIRST],
        approvalChain: chainOf(FIRST, SECOND),
        workflowRunHistory: [{ currentStepOrder: 1 }],
      })
    ).toBe(true);
  });
});

describe("an administrator", () => {
  /*
   * The rule that was missing, and the gap it left.
   *
   * Everybody else sees a memo because they prepared it or because the
   * workflow reached them. An administrator had neither, so an administrator
   * who had taken no part in a memo could not see it - not in the documents
   * list, not by opening it, not in its history. The oversight screen was no
   * answer either: it shows only what is still in flight, so the moment a
   * memo was finally approved it became invisible to the one person
   * answerable for the process.
   */

  const stranger = {
    preparerId: PREPARER,
    userId: "an-administrator",
    approvalChain: chainOf(FIRST, SECOND),
    workflowRunHistory: [{ currentStepOrder: 2 }],
  };

  it("could not see a memo it took no part in, which was the bug", () => {
    expect(canUserViewDocument(stranger)).toBe(false);
  });

  it("sees it", () => {
    expect(canUserViewDocument({ ...stranger, isAdministrator: true })).toBe(true);
  });

  it("sees one whose workflow has not reached anybody yet", () => {
    // A draft or a memo sitting at step 1 is still an organisation's record.
    expect(
      canUserViewDocument({
        ...stranger,
        isAdministrator: true,
        workflowRunHistory: [{ currentStepOrder: 1 }],
      })
    ).toBe(true);
  });

  it("sees one with no approval chain at all", () => {
    expect(
      canUserViewDocument({
        preparerId: PREPARER,
        userId: "an-administrator",
        isAdministrator: true,
      })
    ).toBe(true);
  });

  it("stops at somebody else's draft, which is still theirs", () => {
    // `memos.view.own` promises a draft is seen by nobody else. Reading every
    // submitted memo does not need that promise broken.
    expect(
      canUserViewDocument({ ...stranger, isAdministrator: true, status: "DRAFT" })
    ).toBe(false);
  });

  it("still sees its own draft", () => {
    expect(
      canUserViewDocument({
        preparerId: "an-administrator",
        userId: "an-administrator",
        isAdministrator: true,
        status: "DRAFT",
      })
    ).toBe(true);
  });

  it("asks the database for everything except another author's draft", () => {
    expect(prismaDocumentAccessFilter("an-administrator", [], true)).toEqual({
      OR: [{ preparerId: "an-administrator" }, { status: { not: "DRAFT" } }],
    });
  });

  it("still filters for everybody else", () => {
    const filter = prismaDocumentAccessFilter(FIRST, []);

    expect(filter).not.toEqual({});
    expect(filter.OR).toHaveLength(2);
  });

  it("defaults to off, so a caller that forgets it gets the strict rule", () => {
    // The flag has to be passed deliberately. A read path that does not know
    // about it keeps the behaviour it had.
    expect(prismaDocumentAccessFilter("somebody", [])).not.toEqual({});
    expect(canUserViewDocument(stranger)).toBe(false);
  });
});
