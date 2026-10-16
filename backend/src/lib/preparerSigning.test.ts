import { afterEach, describe, expect, it } from "vitest";

import { useStoredWorkflowPolicy } from "./workflowPolicy";
import { preparerMustSign } from "./preparerSigning";

/**
 * Who signs at the moment of submission.
 *
 * The answer has to be the same in four places - the submit screen, the
 * request schema, the printed strip and the stamping service - so it is worth
 * pinning down precisely here rather than four times over.
 */

const policy = (preparerSignsOnSubmit: boolean) =>
  useStoredWorkflowPolicy({
    slaDefaultDays: null,
    allowStepSkip: false,
    preparerSignsOnSubmit,
    sealApprovedMemos: true,
  });

afterEach(() => {
  useStoredWorkflowPolicy(null);
  delete process.env.PREPARER_SIGNS_ON_SUBMIT;
});

describe("whether the person submitting also signs", () => {
  it("says yes when nothing has been configured at all", () => {
    // The default that matters most. Every document already filed was signed
    // by its preparer, and a deployment upgrading into this feature has not
    // asked for that to change.
    expect(preparerMustSign(null)).toBe(true);
  });

  it("says yes for an uploaded document, which has no memo type to ask", () => {
    expect(preparerMustSign(null)).toBe(true);
    expect(preparerMustSign(undefined)).toBe(true);
  });

  it("follows the organisation's policy when it is turned off", () => {
    policy(false);
    expect(preparerMustSign(null)).toBe(false);
  });

  it("lets a memo type insist on a signature the policy would skip", () => {
    // A memo somebody authors and recommends in their own name is signed by
    // them whatever the default is. Approval Request says so explicitly, which is
    // what stops an organisation turning the default off and silently taking
    // the author's signature off a recommendation.
    policy(false);
    expect(preparerMustSign("APPROVAL_REQUEST")).toBe(true);
  });

  it("ignores a memo type nobody has heard of and asks the policy", () => {
    // A key that resolves to nothing is not a reason to invent an answer:
    // submission refuses such a memo anyway, and guessing here would make
    // the preview draw a strip the submission then contradicts.
    policy(false);
    expect(preparerMustSign("NOT_A_MEMO_TYPE")).toBe(false);

    policy(true);
    expect(preparerMustSign("NOT_A_MEMO_TYPE")).toBe(true);
  });

  it("reads the environment when no policy row is stored", () => {
    process.env.PREPARER_SIGNS_ON_SUBMIT = "false";
    expect(preparerMustSign(null)).toBe(false);
  });

  it("takes only the word false as turning it off", () => {
    // Defaulted the opposite way round from the step-skip flag, deliberately.
    // A misspelt variable must leave submitters signing rather than quietly
    // stop a signature appearing on everything the organisation files.
    for (const value of ["", "  ", "no", "0", "off", "FALSE  "]) {
      process.env.PREPARER_SIGNS_ON_SUBMIT = value;
      expect(preparerMustSign(null)).toBe(value.trim().toLowerCase() !== "false");
    }
  });

  it("lets a stored policy overrule the environment", () => {
    process.env.PREPARER_SIGNS_ON_SUBMIT = "false";
    policy(true);
    expect(preparerMustSign(null)).toBe(true);
  });
});
