import { describe, expect, it } from "vitest";

import { diffMemoBodies, diffNotes, inlineRuns } from "./memoDiff";
import type { MemoDiffBlock } from "./memoDiff";
import type {
  MemoBlockNode,
  MemoBody,
  MemoNote,
  MemoTableNode,
} from "./memoTemplate/types";

/**
 * The comparison an approver reads instead of re-reading the whole memo.
 *
 * Each case is a correction somebody actually makes: one figure in a
 * paragraph, one row of a table, a paragraph inserted above the rest. What
 * is asserted is what the screen would then say - which blocks are reported
 * changed, and that the untouched ones are reported untouched, because a
 * comparison that marks everything below an insertion as changed is a
 * comparison nobody reads twice.
 */

const p = (text: string): MemoBlockNode => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const h = (text: string): MemoBlockNode => ({
  type: "heading",
  attrs: { level: 1 },
  content: [{ type: "text", text }],
});

const doc = (...content: MemoBlockNode[]): MemoBody => ({ type: "doc", content });

const table = (rows: string[][], header = true): MemoTableNode => ({
  type: "table",
  content: rows.map((cells, at) => ({
    type: "tableRow",
    content: cells.map((text) => ({
      type: header && at === 0 ? "tableHeader" : "tableCell",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    })),
  })),
});

const kinds = (diff: { blocks: MemoDiffBlock[] }): string[] =>
  diff.blocks.map((block) => block.kind);

describe("two bodies that are the same body", () => {
  it("says so, and reports every block as the same", () => {
    const body = doc(h("BACKGROUND:"), p("One."), p("Two."));
    const diff = diffMemoBodies(body, body);

    expect(diff.identical).toBe(true);
    expect(kinds(diff)).toEqual(["same", "same", "same"]);
    expect(diff.summary).toEqual({ same: 3, added: 0, removed: 0, changed: 0 });
  });
});

describe("one figure in one paragraph", () => {
  const before = doc(
    h("BACKGROUND:"),
    p("The allowance is PKR 10,000 per month."),
    h("Recommendation"),
    p("Approval is sought.")
  );
  const after = doc(
    h("BACKGROUND:"),
    p("The allowance is PKR 12,000 per month."),
    h("Recommendation"),
    p("Approval is sought.")
  );

  it("marks that paragraph changed and nothing else", () => {
    const diff = diffMemoBodies(before, after);

    expect(kinds(diff)).toEqual(["same", "changed", "same", "same"]);
    expect(diff.identical).toBe(false);
  });

  it("breaks the paragraph into runs at the word that moved", () => {
    const changed = diffMemoBodies(before, after).blocks[1];
    if (changed?.kind !== "changed" || changed.type !== "text") throw new Error("expected a changed text block");

    expect(changed.runs).toEqual([
      { kind: "same", text: "The allowance is PKR " },
      { kind: "removed", text: "10,000" },
      { kind: "added", text: "12,000" },
      { kind: "same", text: " per month." },
    ]);
    expect(changed.emphasisOnly).toBe(false);
  });
});

describe("a paragraph inserted above the rest", () => {
  it("is the only thing reported, and the paragraphs below it stay the same", () => {
    /*
     * The case that decides whether the comparison is by position or by
     * content. By position, every paragraph after the insertion would be
     * "changed" into the one that used to follow it.
     */
    const before = doc(p("One."), p("Two."), p("Three."));
    const after = doc(p("Zero."), p("One."), p("Two."), p("Three."));

    expect(kinds(diffMemoBodies(before, after))).toEqual(["added", "same", "same", "same"]);
  });

  it("does not pair the insertion with an edit further down", () => {
    const before = doc(p("Employees on the roster are listed below."), p("Approval is sought for the revision."));
    const after = doc(
      p("Note: this supersedes the memo of 3 March."),
      p("Employees on the roster are listed below."),
      p("Approval is sought for the revision of the allowance.")
    );

    const diff = diffMemoBodies(before, after);
    expect(kinds(diff)).toEqual(["added", "same", "changed"]);
  });
});

describe("a paragraph taken out", () => {
  it("is reported removed, with its text, rather than silently missing", () => {
    const before = doc(p("Keep."), p("Drop this."), p("Keep too."));
    const after = doc(p("Keep."), p("Keep too."));

    const diff = diffMemoBodies(before, after);
    expect(kinds(diff)).toEqual(["same", "removed", "same"]);
    expect(diff.blocks[1]).toMatchObject({ kind: "removed", block: p("Drop this.") });
  });
});

describe("a paragraph rewritten entirely", () => {
  it("is still that paragraph, changed, when it is the only difference", () => {
    const before = doc(h("Recommendation"), p("Please approve."));
    const after = doc(h("Recommendation"), p("Kind approval is solicited for the revised scale."));

    const diff = diffMemoBodies(before, after);
    expect(kinds(diff)).toEqual(["same", "changed"]);
  });

  it("is reported removed and added when two unlike paragraphs each change", () => {
    const before = doc(p("Alpha bravo charlie delta."), p("Echo foxtrot golf hotel."));
    const after = doc(p("India juliet kilo lima."), p("Mike november oscar papa."));

    // Nothing here resembles anything, so nothing is pretended to be an edit.
    expect(kinds(diffMemoBodies(before, after))).toEqual(["removed", "removed", "added", "added"]);
  });
});

describe("emphasis alone", () => {
  it("is reported as a change of emphasis, with the words unchanged", () => {
    const before = doc({ type: "paragraph", content: [{ type: "text", text: "Urgent." }] });
    const after = doc({
      type: "paragraph",
      content: [{ type: "text", text: "Urgent.", marks: [{ type: "bold" }] }],
    });

    const changed = diffMemoBodies(before, after).blocks[0];
    expect(changed).toMatchObject({ kind: "changed", type: "text", emphasisOnly: true });
    if (changed?.kind === "changed" && changed.type === "text") {
      expect(changed.runs).toEqual([{ kind: "same", text: "Urgent." }]);
    }
  });
});

describe("a paragraph that became a heading", () => {
  it("is a change to the same text, not a removal and an addition", () => {
    const diff = diffMemoBodies(doc(p("Recommendation")), doc(h("Recommendation")));

    expect(kinds(diff)).toEqual(["changed"]);
    expect(diff.blocks[0]).toMatchObject({ kind: "changed", type: "text", emphasisOnly: true });
  });
});

describe("one figure in one row of a table", () => {
  const before = doc(
    table([
      ["AX ID", "Employee", "Allowance"],
      ["1644", "Mr. Inayat Hussain", "10,000"],
      ["2210", "Ms. Areeba Khan", "9,500"],
    ])
  );
  const after = doc(
    table([
      ["AX ID", "Employee", "Allowance"],
      ["1644", "Mr. Inayat Hussain", "12,000"],
      ["2210", "Ms. Areeba Khan", "9,500"],
    ])
  );

  it("marks the table changed, that row changed, and that cell changed", () => {
    const changed = diffMemoBodies(before, after).blocks[0];
    if (changed?.kind !== "changed" || changed.type !== "table") throw new Error("expected a changed table");

    expect(changed.layoutOnly).toBe(false);
    expect(changed.rows.map((row) => row.kind)).toEqual(["same", "changed", "same"]);
    expect(changed.rows[0].header).toBe(true);

    const cells = changed.rows[1].cells;
    expect(cells.map((cell) => cell.kind)).toEqual(["same", "same", "changed"]);
    expect(cells[2].runs).toEqual([
      { kind: "removed", text: "10,000" },
      { kind: "added", text: "12,000" },
    ]);
  });
});

describe("a row added to a table", () => {
  it("is reported as an added row, with the rows around it the same", () => {
    const before = doc(table([["Name", "Amount"], ["Inayat", "10"], ["Areeba", "9"]]));
    const after = doc(
      table([["Name", "Amount"], ["Inayat", "10"], ["Moiz", "8"], ["Areeba", "9"]])
    );

    const changed = diffMemoBodies(before, after).blocks[0];
    if (changed?.kind !== "changed" || changed.type !== "table") throw new Error("expected a changed table");

    expect(changed.rows.map((row) => row.kind)).toEqual(["same", "same", "added", "same"]);
    expect(changed.rows[2].cells.map((cell) => cell.text)).toEqual(["Moiz", "8"]);
  });
});

describe("a column added to a table", () => {
  it("shows the new cell on every row rather than every row rewritten", () => {
    const before = doc(table([["Name", "Amount"], ["Inayat", "10"]]));
    const after = doc(table([["Name", "Amount", "Note"], ["Inayat", "10", "Revised"]]));

    const changed = diffMemoBodies(before, after).blocks[0];
    if (changed?.kind !== "changed" || changed.type !== "table") throw new Error("expected a changed table");

    // Each row is "changed" because it grew, and within it the two old cells
    // are the same and only the third is new.
    expect(changed.rows.map((row) => row.kind)).toEqual(["changed", "changed"]);
    expect(changed.rows[1].cells.map((cell) => cell.kind)).toEqual(["same", "same", "added"]);
  });
});

describe("a table whose columns were only dragged wider", () => {
  it("is reported as a layout change, with every row the same", () => {
    const plain = table([["A", "B"], ["1", "2"]]);
    const sized: MemoTableNode = { ...plain, attrs: { widths: [0.7, 0.3] } };

    const changed = diffMemoBodies(doc(plain), doc(sized)).blocks[0];
    expect(changed).toMatchObject({ kind: "changed", type: "table", layoutOnly: true });
  });
});

describe("a merged cell", () => {
  it("is counted as the columns it covers, so the rows still line up", () => {
    const merged: MemoTableNode = {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableCell", attrs: { colspan: 2 }, content: [p("Both") as never] },
          ],
        },
        { type: "tableRow", content: [{ type: "tableCell", content: [p("a") as never] }, { type: "tableCell", content: [p("b") as never] }] },
      ],
    };
    const edited: MemoTableNode = {
      ...merged,
      content: [
        merged.content[0],
        { type: "tableRow", content: [{ type: "tableCell", content: [p("a") as never] }, { type: "tableCell", content: [p("c") as never] }] },
      ],
    };

    const changed = diffMemoBodies(doc(merged), doc(edited)).blocks[0];
    if (changed?.kind !== "changed" || changed.type !== "table") throw new Error("expected a changed table");

    expect(changed.rows[0].cells.map((cell) => cell.text)).toEqual(["Both", ""]);
    expect(changed.rows[1].cells.map((cell) => cell.kind)).toEqual(["same", "changed"]);
  });
});

describe("a list", () => {
  const list = (kind: "bulletList" | "orderedList", ...items: string[]): MemoBlockNode => ({
    type: kind,
    content: items.map((text) => ({ type: "listItem", content: [p(text) as never] })),
  });

  it("reports the item that changed and the item that was added", () => {
    const before = doc(list("bulletList", "Fuel", "Medical", "Housing"));
    const after = doc(list("bulletList", "Fuel", "Medical (revised)", "Housing", "Transport"));

    const changed = diffMemoBodies(before, after).blocks[0];
    if (changed?.kind !== "changed" || changed.type !== "list") throw new Error("expected a changed list");

    expect(changed.items.map((item) => item.kind)).toEqual(["same", "changed", "same", "added"]);
    expect(changed.items[1].runs).toEqual([
      { kind: "same", text: "Medical" },
      { kind: "added", text: " (revised)" },
    ]);
  });

  it("treats a bulleted list turned numbered as the same list, changed", () => {
    const diff = diffMemoBodies(
      doc(list("bulletList", "One", "Two")),
      doc(list("orderedList", "One", "Two"))
    );

    expect(kinds(diff)).toEqual(["changed"]);
    const changed = diff.blocks[0];
    if (changed?.kind === "changed" && changed.type === "list") {
      expect(changed.items.map((item) => item.kind)).toEqual(["same", "same"]);
    }
  });
});

describe("a page break", () => {
  it("is never paired with a paragraph", () => {
    const diff = diffMemoBodies(doc({ type: "pageBreak" }), doc(p("Text.")));

    expect(kinds(diff)).toEqual(["removed", "added"]);
  });
});

describe("runs within a line", () => {
  it("keeps the whitespace, so the runs rebuild the text exactly", () => {
    const before = "Approval is  sought for the scale.";
    const after = "Approval is sought for the revised scale.";
    const runs = inlineRuns(before, after);

    expect(runs.filter((run) => run.kind !== "added").map((run) => run.text).join("")).toBe(before);
    expect(runs.filter((run) => run.kind !== "removed").map((run) => run.text).join("")).toBe(after);
  });

  it("reports an unchanged line as one run and an empty one as none", () => {
    expect(inlineRuns("Same.", "Same.")).toEqual([{ kind: "same", text: "Same." }]);
    expect(inlineRuns("", "")).toEqual([]);
  });
});

describe("notes on the page", () => {
  const note = (text: string, page = 1, x = 10, y = 10): MemoNote => ({
    text,
    page,
    x,
    y,
    width: 100,
    height: 30,
  });

  it("lists what was added and removed by what it says", () => {
    const diff = diffNotes([note("Old"), note("Kept")], [note("Kept"), note("New")]);

    expect(diff).toEqual({ added: ["New"], removed: ["Old"], moved: 0 });
  });

  it("counts a note moved rather than listing it twice", () => {
    const diff = diffNotes([note("Same words", 1, 10, 10)], [note("Same words", 2, 40, 90)]);

    expect(diff).toEqual({ added: [], removed: [], moved: 1 });
  });

  it("matches two notes saying the same thing one to one", () => {
    const diff = diffNotes([note("Twice"), note("Twice")], [note("Twice")]);

    expect(diff.removed).toEqual(["Twice"]);
    expect(diff.added).toEqual([]);
  });
});

describe("a picture", () => {
  const picture = (src: string): MemoBlockNode => ({ type: "image", attrs: { src } });
  const one = "data:image/png;base64,AAAA";
  const two = "data:image/png;base64,BBBB";

  it("put in is reported added, and the paragraphs around it stay the same", () => {
    const diff = diffMemoBodies(doc(p("Before"), p("After")), doc(p("Before"), picture(one), p("After")));

    expect(kinds(diff)).toEqual(["same", "added", "same"]);
    expect(diff.blocks[1]).toMatchObject({ kind: "added", block: { type: "image" } });
  });

  it("left alone is reported the same, whatever changed around it", () => {
    const diff = diffMemoBodies(doc(picture(one), p("One")), doc(picture(one), p("Two")));

    expect(kinds(diff)).toEqual(["same", "changed"]);
  });

  it("swapped for another is the old one taken out and the new one put in, never a change", () => {
    const diff = diffMemoBodies(doc(p("Before"), picture(one)), doc(p("Before"), picture(two)));

    expect(kinds(diff)).not.toContain("changed");
    expect(kinds(diff).filter((kind) => kind !== "same").sort()).toEqual(["added", "removed"]);
    expect(diff.summary).toMatchObject({ same: 1, added: 1, removed: 1, changed: 0 });
  });
});
