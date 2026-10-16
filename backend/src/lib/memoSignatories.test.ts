import { describe, expect, it } from "vitest";

import { buildMemoSignatories, personName } from "./memoSignatories";

/**
 * Who gets a ruled line at the foot of a generated memo.
 *
 * Two callers depend on this answering identically - the preview the preparer
 * signs against, and the submission that files the artefact. A disagreement
 * between them does not fail; it puts every signature one column out on a
 * document that can never be redrawn.
 */

const person = (id: string, first: string, last: string, designation?: string) => ({
  id,
  firstName: first,
  lastName: last,
  designation: designation ?? null,
});

const preparer = person("p1", "Rizwan", "Mushtaq", "Director - Human Resources");
const reviewer = person("a1", "Maryam", "Ali", "Director - Audit");
const approver = person("a2", "Bashir", "Dawood", "Chairman");

const chain = [{ userId: "a1" }, { userId: "a2" }];

describe("the printed strip", () => {
  it("puts the preparer first and the chain in signing order", () => {
    const strip = buildMemoSignatories(preparer, chain, [reviewer, approver]);

    expect(strip.map((s) => s.key)).toEqual(["p1", "a1", "a2"]);
  });

  it("prints each signatory's name and title under their line", () => {
    const strip = buildMemoSignatories(preparer, chain, [reviewer, approver]);

    expect(strip[0]).toEqual({
      key: "p1",
      name: "Rizwan Mushtaq",
      designation: "Director - Human Resources",
      department: null,
    });
  });

  it("prints the office they sign for, under the title", () => {
    /*
     * A designation says what somebody does; it does not always say which
     * part of the organisation they did it for, and a memo that travels
     * between departments is read by people who know neither.
     */
    const withOffice = {
      ...person("p9", "Inayat", "Hussain", "Security Executive"),
      department: { name: "Security & Loss Prevention" },
    };

    const strip = buildMemoSignatories(withOffice, [], []);

    expect(strip[0].department).toBe("Security & Loss Prevention");
  });

  it("takes the office as a plain name too", () => {
    // Prisma hands back the joined row; a caller that already has the name
    // should not have to wrap it back up to pass it in.
    const strip = buildMemoSignatories(
      { ...person("p8", "Maryam", "Ali", "Director - Audit"), department: "Audit" },
      [],
      []
    );

    expect(strip[0].department).toBe("Audit");
  });

  it("carries a missing office as null rather than an empty line", () => {
    // The same rule the designation follows: a blank line under a name reads
    // as a document somebody forgot to finish.
    const strip = buildMemoSignatories(preparer, [], []);

    expect(strip[0].department).toBeNull();
  });

  it("carries a missing title as null rather than an empty line", () => {
    const anon = person("a3", "Fresh", "Approver");
    const strip = buildMemoSignatories(preparer, [{ userId: "a3" }], [anon]);

    expect(strip[1].designation).toBeNull();
  });

  it("skips a step naming somebody who cannot be resolved", () => {
    // A draft is edited over days and somebody named in it can leave. The
    // preview draws what it can; submission refuses the chain outright.
    const strip = buildMemoSignatories(preparer, chain, [reviewer]);

    expect(strip.map((s) => s.key)).toEqual(["p1", "a1"]);
  });

  it("gives somebody named twice one column, at their first position", () => {
    // Two columns with one key would make the slots ambiguous exactly where
    // they are used - matching a signature back to whose line it is.
    const strip = buildMemoSignatories(
      preparer,
      [{ userId: "a1" }, { userId: "a1" }],
      [reviewer]
    );

    expect(strip.map((s) => s.key)).toEqual(["p1", "a1"]);
  });

  it("gives the preparer no second column when they are also in the chain", () => {
    const strip = buildMemoSignatories(
      preparer,
      [{ userId: "p1" }, { userId: "a1" }],
      [preparer, reviewer]
    );

    expect(strip.map((s) => s.key)).toEqual(["p1", "a1"]);
  });
});

describe("a memo whose author does not sign it", () => {
  it("starts the strip at the first approver", () => {
    // A ruled line printed for somebody who will never be asked to sign stays
    // blank for the life of the document - the same failure the strip was
    // built to end, arrived at from the other direction.
    const strip = buildMemoSignatories(preparer, chain, [reviewer, approver], {
      preparerSigns: false,
    });

    expect(strip.map((s) => s.key)).toEqual(["a1", "a2"]);
  });

  it("still prints them a line when they are named on the chain themselves", () => {
    // Not signing *as the author* is a different thing from not signing at
    // all. Somebody who is also an approver signs at their step, and needs
    // the line that step prints.
    const strip = buildMemoSignatories(
      preparer,
      [{ userId: "a1" }, { userId: "p1" }],
      [reviewer, preparer],
      { preparerSigns: false }
    );

    expect(strip.map((s) => s.key)).toEqual(["a1", "p1"]);
  });

  it("keeps the preparer's column when told nothing at all", () => {
    // Every existing caller, and every memo already filed, keeps what it has.
    const strip = buildMemoSignatories(preparer, chain, [reviewer, approver], {});

    expect(strip[0].key).toBe("p1");
  });
});

describe("naming a person", () => {
  it("joins the two halves", () => {
    expect(personName({ firstName: "Reham", lastName: "Nawaz" })).toBe(
      "Reham Nawaz"
    );
  });

  it("does not leave a stray space when half of it is missing", () => {
    expect(personName({ firstName: "BMD", lastName: "" })).toBe("BMD");
  });
});
