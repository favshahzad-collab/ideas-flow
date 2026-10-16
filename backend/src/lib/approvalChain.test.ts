import { describe, expect, it } from "vitest";
import { findApprovalChainIssues, preparerIsInChain } from "./approvalChain";
import { ApprovalType } from "../generated/prisma/browser";

const REVIEWER = ApprovalType.REVIEWER;
const APPROVER = ApprovalType.APPROVER;
const FINAL = ApprovalType.FINAL_APPROVER;

const step = (userId: string, approvalType: ApprovalType) => ({
  userId,
  approvalType,
});

describe("findApprovalChainIssues", () => {
  it("accepts a well-formed chain", () => {
    expect(
      findApprovalChainIssues([
        step("a", REVIEWER),
        step("b", APPROVER),
        step("c", FINAL),
      ])
    ).toEqual([]);
  });

  it("accepts a single final approver", () => {
    expect(findApprovalChainIssues([step("a", FINAL)])).toEqual([]);
  });

  it("rejects an empty chain", () => {
    expect(findApprovalChainIssues([])).toEqual([
      "At least one approval step is required",
    ]);
  });

  /**
   * The one that matters: completion is triggered by the step's type, not its
   * position, so a chain without a FINAL_APPROVER runs off the end of itself
   * and the next actor gets a 500. Template-compiled chains used to reach the
   * database without this check.
   */
  it("rejects a chain with no final approver", () => {
    expect(
      findApprovalChainIssues([step("a", REVIEWER), step("b", APPROVER)])
    ).toContain("Exactly one Final Approver is required");
  });

  it("rejects more than one final approver", () => {
    expect(
      findApprovalChainIssues([step("a", FINAL), step("b", FINAL)])
    ).toContain("Exactly one Final Approver is required");
  });

  it("rejects a final approver that is not last", () => {
    expect(
      findApprovalChainIssues([step("a", FINAL), step("b", REVIEWER)])
    ).toContain("Final Approver must be the last step");
  });

  it("rejects duplicate users", () => {
    expect(
      findApprovalChainIssues([step("a", REVIEWER), step("a", FINAL)])
    ).toContain("Duplicate users are not allowed in the approval chain");
  });

  it("reports every broken rule at once", () => {
    // Duplicate user, no final approver, and so the last step is wrong too.
    expect(
      findApprovalChainIssues([step("a", REVIEWER), step("a", APPROVER)])
    ).toHaveLength(3);
  });
});

describe("preparerIsInChain", () => {
  it("finds the preparer wherever they sit", () => {
    const chain = [step("a", REVIEWER), step("preparer", FINAL)];
    expect(preparerIsInChain(chain, "preparer")).toBe(true);
  });

  it("is false when the preparer stays out of their own chain", () => {
    const chain = [step("a", REVIEWER), step("b", FINAL)];
    expect(preparerIsInChain(chain, "preparer")).toBe(false);
  });

  it("is false for an empty chain", () => {
    expect(preparerIsInChain([], "preparer")).toBe(false);
  });
});
