import { describe, expect, it } from "vitest";

import {
  findMemoType,
  isMemoType,
  listMemoTypes,
  memoTypeKeys,
} from "./memoTypes";

/**
 * The registry of memo types.
 *
 * It had no test file, which was tolerable while it held one entry and is not
 * now: a key is stored on every document that uses it and can never be renamed
 * afterwards, and two of the general type's fields are deliberately empty in a
 * way that reads like an oversight. Both are pinned here so neither gets
 * tidied up by somebody filling in what looks like a gap.
 */
describe("the registry", () => {
  it("offers more than one kind of memo", () => {
    // A single option is a question with one answer. The composer hides the
    // picker entirely when there is only one, so this is what puts it back.
    expect(listMemoTypes().length).toBeGreaterThan(1);
  });

  it("has no duplicate keys", () => {
    const keys = memoTypeKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every type a label and a description to choose by", () => {
    for (const type of listMemoTypes()) {
      expect(type.label.trim()).not.toBe("");
      expect(type.description.trim()).not.toBe("");
    }
  });

  it("recognises what it lists and refuses what it does not", () => {
    for (const key of memoTypeKeys()) expect(isMemoType(key)).toBe(true);

    expect(isMemoType("NOT_A_MEMO_TYPE")).toBe(false);
    expect(isMemoType("")).toBe(false);
    expect(isMemoType(undefined)).toBe(false);
    expect(findMemoType("NOT_A_MEMO_TYPE")).toBeNull();
  });
});

describe("Approval Request", () => {
  const approval = findMemoType("APPROVAL_REQUEST");

  it("exists", () => {
    expect(approval).not.toBeNull();
  });

  it("no longer offers a fuel request", () => {
    /*
     * It replaced FUEL_REQUEST, which was safe to remove only because nothing
     * had been filed against it - checked against the live database before
     * the change, and zero documents carried the key. A type that HAS been
     * used can never be removed: the documents carrying it would point at
     * something nothing can look up.
     */
    expect(findMemoType("FUEL_REQUEST")).toBeNull();
    expect(isMemoType("FUEL_REQUEST")).toBe(false);
  });

  it("keeps the paper form's three-part shape without the fuel in it", () => {
    // "Details:" rather than "Employee Details:", because the same structure
    // carries a purchase or a change in terms as readily as an allowance.
    expect(approval?.outlineHeadings).toEqual([
      "BACKGROUND:",
      "Details:",
      "Recommendation",
    ]);
  });

  it("says outright that its preparer signs", () => {
    // Stated rather than inherited: an organisation turning the default off
    // must not silently take the author's signature off a memo that
    // recommends something in their name.
    expect(approval?.preparerSigns).toBe(true);
  });
});

describe("Office Memorandum", () => {
  const general = findMemoType("OFFICE_MEMORANDUM");

  it("exists, so a memo that is not a fuel request can be written", () => {
    expect(general).not.toBeNull();
  });

  it("imposes no outline", () => {
    /*
     * Deliberately empty, not unfinished. Its subject and department change
     * with every memo written, which is the reason it exists; headings would
     * be a structure nobody asked for and the preparer would delete them
     * before starting.
     */
    expect(general?.outlineHeadings).toEqual([]);
  });

  it("leaves signing to the organisation's policy", () => {
    /*
     * Also deliberately absent. `undefined` means "ask the policy", which is
     * not the same as `false`. Setting it either way here would decide on a
     * deployment's behalf whether writing a general memo means signing it.
     */
    expect(general?.preparerSigns).toBeUndefined();
  });

  it("starts from a route rather than from nothing", () => {
    expect(general?.defaultTemplateName).toBeTruthy();
  });
});
