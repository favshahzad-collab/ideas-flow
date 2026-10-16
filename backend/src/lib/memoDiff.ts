/**
 * What changed between two versions of a typed memo.
 *
 * A memo sent back for correction comes round again as v2, and every approver
 * on the chain is asked to read it again. Nothing on the screen said which
 * sentence had changed, so they re-read all of it to find the figure that
 * moved - or, more likely, did not, and signed the second round on the
 * strength of the first. Each version records the body it was drawn from, so
 * the comparison costs nothing to store; this file works it out.
 *
 * It is a comparison of the authored bodies, not of the PDFs. The PDF is the
 * artefact and stays untouched; this is a reading aid laid beside it. It is
 * pure - two bodies in, a description out - so it can be tested on fixtures
 * and never needs the database or the renderer.
 *
 * Blocks are matched by longest common subsequence, so a paragraph inserted
 * near the top does not make every paragraph below it "changed". Within a
 * gap, a removed block and an added block of the same kind are paired as one
 * changed block when they resemble each other (or when they are the only two
 * there), and a changed paragraph is broken into runs at the word so the eye
 * lands on the words that moved rather than on the paragraph that holds them.
 * Tables are compared row by row and then cell by cell, because the rows are
 * records and a table's usual correction is one figure in one of them.
 */
import type {
  MemoBlockNode,
  MemoBody,
  MemoHeadingNode,
  MemoListNode,
  MemoNote,
  MemoParagraphNode,
  MemoTableNode,
  MemoTableRowNode,
  MemoTextNode,
} from "./memoTemplate/types";

export type DiffKind = "same" | "added" | "removed" | "changed";

/** A stretch of a changed line: kept, put in, or taken out. */
export type MemoDiffRun = {
  kind: "same" | "added" | "removed";
  text: string;
};

export type MemoDiffCell = {
  kind: DiffKind;
  /** The cell's text as it stands in the newer version (or the older, if removed). */
  text: string;
  /** Present when the cell changed: its text broken into runs. */
  runs?: MemoDiffRun[];
};

export type MemoDiffRow = {
  kind: DiffKind;
  header: boolean;
  cells: MemoDiffCell[];
};

export type MemoDiffItem = {
  kind: DiffKind;
  text: string;
  runs?: MemoDiffRun[];
};

export type MemoTextBlock = MemoParagraphNode | MemoHeadingNode;

export type MemoDiffBlock =
  | { kind: "same"; block: MemoBlockNode }
  | { kind: "added"; block: MemoBlockNode }
  | { kind: "removed"; block: MemoBlockNode }
  | {
      kind: "changed";
      type: "text";
      before: MemoTextBlock;
      after: MemoTextBlock;
      runs: MemoDiffRun[];
      /** The words are the same; only bold, italic or underline moved. */
      emphasisOnly: boolean;
    }
  | {
      kind: "changed";
      type: "table";
      before: MemoTableNode;
      after: MemoTableNode;
      rows: MemoDiffRow[];
      /** Every cell reads the same; only widths or heights were adjusted. */
      layoutOnly: boolean;
    }
  | {
      kind: "changed";
      type: "list";
      before: MemoListNode;
      after: MemoListNode;
      items: MemoDiffItem[];
    };

export type MemoDiffSummary = {
  same: number;
  added: number;
  removed: number;
  changed: number;
};

export type MemoDiff = {
  /** True when the two bodies are the same body. */
  identical: boolean;
  summary: MemoDiffSummary;
  blocks: MemoDiffBlock[];
};

export type MemoNotesDiff = {
  added: string[];
  removed: string[];
  /** Notes whose text is unchanged but which sit somewhere else on the page. */
  moved: number;
};

// ── Text ────────────────────────────────────────────────────────────────────

const textOf = (runs: MemoTextNode[] | undefined): string =>
  (runs ?? []).map((run) => run.text).join("");

/** The paragraphs of a cell or an item, as one string a line at a time. */
const paragraphsText = (paragraphs: MemoParagraphNode[] | undefined): string =>
  (paragraphs ?? []).map((paragraph) => textOf(paragraph.content)).join("\n");

/** A row's cells as text, a merged cell counted as the columns it covers. */
function rowCells(row: MemoTableRowNode): string[] {
  return row.content.flatMap((cell) => {
    const span = Math.max(1, Math.floor(cell.attrs?.colspan ?? 1));
    return [paragraphsText(cell.content), ...new Array<string>(span - 1).fill("")];
  });
}

/** Everything a block says, for measuring how alike two blocks are. */
function blockText(block: MemoBlockNode): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return textOf(block.content);
    case "bulletList":
    case "orderedList":
      return block.content.map((item) => paragraphsText(item.content)).join("\n");
    case "table":
      return block.content.map((row) => rowCells(row).join("\t")).join("\n");
    case "pageBreak":
    case "image":
      return "";
  }
}

/**
 * A block's identity for matching. Everything counts - a word, a mark, a
 * column width - so that two blocks are "the same" only when nothing about
 * them differs; what differs is then worked out in finer grain below.
 */
const blockKey = (block: MemoBlockNode): string => JSON.stringify(block);

/** What kind of thing a block is, for deciding what it may be paired with. */
function family(block: MemoBlockNode): "text" | "table" | "list" | "break" | "image" {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return "text";
    case "table":
      return "table";
    case "bulletList":
    case "orderedList":
      return "list";
    case "pageBreak":
      return "break";
    case "image":
      return "image";
  }
}

/**
 * Whether two unmatched blocks may be reported as one block changed.
 *
 * A page break has nothing in it to change. A picture is either the same
 * picture or a different one, and "different" is shown as the old one taken
 * out and the new one put in - there is no honest finer grain for pixels.
 */
const pairable = (one: MemoBlockNode, other: MemoBlockNode): boolean =>
  family(one) === family(other) && family(one) !== "break" && family(one) !== "image";

const words = (text: string): Set<string> =>
  new Set(text.toLowerCase().split(/\s+/).filter(Boolean));

/** How alike two pieces of text are, by the words they share. 0 to 1. */
function similarity(one: string, other: string): number {
  const a = words(one);
  const b = words(other);
  if (a.size === 0 && b.size === 0) return 1;

  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// ── Longest common subsequence ──────────────────────────────────────────────

type Edit<T> =
  | { kind: "same"; before: T; after: T }
  | { kind: "removed"; before: T }
  | { kind: "added"; after: T };

/**
 * Above this the table is not built and the two sides are reported as
 * replaced outright. A memo is bounded - 500 blocks, 400 rows, 8,000
 * characters a run - so this is a backstop, not a budget anybody meets.
 */
const MAX_CELLS = 4_000_000;

/**
 * The edit script between two sequences, by longest common subsequence.
 *
 * Common prefix and suffix are peeled off first, which is most of the work
 * for the usual correction - one paragraph among twenty - and keeps the
 * table small for the rest.
 */
function editScript<T>(
  before: T[],
  after: T[],
  key: (item: T) => string
): Edit<T>[] {
  const a = before.map(key);
  const b = after.map(key);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const head: Edit<T>[] = [];
  for (let at = 0; at < start; at += 1) {
    head.push({ kind: "same", before: before[at], after: after[at] });
  }
  const tail: Edit<T>[] = [];
  for (let at = endA; at < a.length; at += 1) {
    tail.push({
      kind: "same",
      before: before[at],
      after: after[at - endA + endB],
    });
  }

  const n = endA - start;
  const m = endB - start;
  const middle: Edit<T>[] = [];

  if ((n + 1) * (m + 1) > MAX_CELLS) {
    for (let at = start; at < endA; at += 1) middle.push({ kind: "removed", before: before[at] });
    for (let at = start; at < endB; at += 1) middle.push({ kind: "added", after: after[at] });
    return [...head, ...middle, ...tail];
  }

  // lengths[i][j] is the LCS length of a[start+i..] and b[start+j..].
  const width = m + 1;
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        a[start + i] === b[start + j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      middle.push({ kind: "same", before: before[start + i], after: after[start + j] });
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      middle.push({ kind: "removed", before: before[start + i] });
      i += 1;
    } else {
      middle.push({ kind: "added", after: after[start + j] });
      j += 1;
    }
  }
  while (i < n) {
    middle.push({ kind: "removed", before: before[start + i] });
    i += 1;
  }
  while (j < m) {
    middle.push({ kind: "added", after: after[start + j] });
    j += 1;
  }

  return [...head, ...middle, ...tail];
}

// ── Pairing what was removed with what was added ────────────────────────────

type Paired<T> =
  | { kind: "same"; before: T; after: T }
  | { kind: "changed"; before: T; after: T }
  | { kind: "removed"; before: T }
  | { kind: "added"; after: T };

/**
 * Turn a script's runs of removals and additions into changes where they
 * are one thing edited rather than one thing gone and another arrived.
 *
 * A gap holding exactly one of each is paired outright: a paragraph
 * rewritten from the first word to the last is still that paragraph,
 * changed. A larger gap is paired greedily by resemblance, best match first,
 * so a paragraph inserted above an edited one does not steal its partner.
 * Whatever finds no partner is reported as it was.
 */
function pairGaps<T>(
  edits: Edit<T>[],
  canPair: (before: T, after: T) => boolean,
  alike: (before: T, after: T) => number,
  threshold: number
): Paired<T>[] {
  const out: Paired<T>[] = [];
  let removed: T[] = [];
  let added: T[] = [];

  const flush = (): void => {
    if (removed.length === 0 && added.length === 0) return;

    if (removed.length === 1 && added.length === 1 && canPair(removed[0], added[0])) {
      out.push({ kind: "changed", before: removed[0], after: added[0] });
    } else {
      const candidates: { r: number; a: number; score: number }[] = [];
      removed.forEach((before, r) => {
        added.forEach((after, a) => {
          if (!canPair(before, after)) return;
          const score = alike(before, after);
          if (score >= threshold) candidates.push({ r, a, score });
        });
      });
      candidates.sort((one, other) => other.score - one.score);

      const partnerOf = new Map<number, number>(); // added index -> removed index
      const taken = new Set<number>();
      for (const { r, a } of candidates) {
        if (taken.has(r) || partnerOf.has(a)) continue;
        taken.add(r);
        partnerOf.set(a, r);
      }

      removed.forEach((before, r) => {
        if (!taken.has(r)) out.push({ kind: "removed", before });
      });
      added.forEach((after, a) => {
        const r = partnerOf.get(a);
        if (r === undefined) out.push({ kind: "added", after });
        else out.push({ kind: "changed", before: removed[r], after });
      });
    }

    removed = [];
    added = [];
  };

  for (const edit of edits) {
    if (edit.kind === "same") {
      flush();
      out.push(edit);
    } else if (edit.kind === "removed") {
      removed.push(edit.before);
    } else {
      added.push(edit.after);
    }
  }
  flush();

  return out;
}

// ── Inside a changed line ───────────────────────────────────────────────────

/** Words and the whitespace between them, both kept, so the text rebuilds exactly. */
const tokens = (text: string): string[] => text.split(/(\s+)/).filter(Boolean);

/** A line before and after, as runs at the word. */
export function inlineRuns(before: string, after: string): MemoDiffRun[] {
  if (before === after) return before ? [{ kind: "same", text: before }] : [];

  const runs: MemoDiffRun[] = [];
  const push = (kind: MemoDiffRun["kind"], text: string): void => {
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.text += text;
    else runs.push({ kind, text });
  };

  for (const edit of editScript(tokens(before), tokens(after), (token) => token)) {
    if (edit.kind === "same") push("same", edit.after);
    else if (edit.kind === "removed") push("removed", edit.before);
    else push("added", edit.after);
  }

  return runs;
}

// ── Tables ──────────────────────────────────────────────────────────────────

const isHeaderRow = (row: MemoTableRowNode): boolean =>
  row.content.length > 0 && row.content.every((cell) => cell.type === "tableHeader");

function diffCells(before: string[], after: string[]): MemoDiffCell[] {
  const cells: MemoDiffCell[] = [];
  for (let at = 0; at < Math.max(before.length, after.length); at += 1) {
    const one = before[at];
    const other = after[at];
    if (one === undefined) cells.push({ kind: "added", text: other ?? "" });
    else if (other === undefined) cells.push({ kind: "removed", text: one });
    else if (one === other) cells.push({ kind: "same", text: other });
    else cells.push({ kind: "changed", text: other, runs: inlineRuns(one, other) });
  }
  return cells;
}

/** Cells that read the same, over the cells there are. */
function rowLikeness(one: string[], other: string[]): number {
  const length = Math.max(one.length, other.length);
  if (length === 0) return 1;
  let same = 0;
  for (let at = 0; at < length; at += 1) if (one[at] === other[at]) same += 1;
  return same / length;
}

function diffTables(before: MemoTableNode, after: MemoTableNode): MemoDiffRow[] {
  type Row = { node: MemoTableRowNode; cells: string[] };
  const rows = (table: MemoTableNode): Row[] =>
    table.content.map((node) => ({ node, cells: rowCells(node) }));

  const script = editScript(rows(before), rows(after), (row) => row.cells.join("\u001f"));

  return pairGaps(
    script,
    () => true,
    (one, other) => rowLikeness(one.cells, other.cells),
    0.5
  ).map((entry): MemoDiffRow => {
    switch (entry.kind) {
      case "same":
        return {
          kind: "same",
          header: isHeaderRow(entry.after.node),
          cells: entry.after.cells.map((text) => ({ kind: "same", text })),
        };
      case "added":
        return {
          kind: "added",
          header: isHeaderRow(entry.after.node),
          cells: entry.after.cells.map((text) => ({ kind: "added", text })),
        };
      case "removed":
        return {
          kind: "removed",
          header: isHeaderRow(entry.before.node),
          cells: entry.before.cells.map((text) => ({ kind: "removed", text })),
        };
      case "changed":
        return {
          kind: "changed",
          header: isHeaderRow(entry.after.node),
          cells: diffCells(entry.before.cells, entry.after.cells),
        };
    }
  });
}

// ── Lists ───────────────────────────────────────────────────────────────────

function diffLists(before: MemoListNode, after: MemoListNode): MemoDiffItem[] {
  const items = (list: MemoListNode): string[] =>
    list.content.map((item) => paragraphsText(item.content));

  return pairGaps(
    editScript(items(before), items(after), (text) => text),
    () => true,
    similarity,
    0.3
  ).map((entry): MemoDiffItem => {
    switch (entry.kind) {
      case "same":
        return { kind: "same", text: entry.after };
      case "added":
        return { kind: "added", text: entry.after };
      case "removed":
        return { kind: "removed", text: entry.before };
      case "changed":
        return {
          kind: "changed",
          text: entry.after,
          runs: inlineRuns(entry.before, entry.after),
        };
    }
  });
}

// ── The body ────────────────────────────────────────────────────────────────

function changedBlock(before: MemoBlockNode, after: MemoBlockNode): MemoDiffBlock {
  if (before.type === "table" && after.type === "table") {
    const rows = diffTables(before, after);
    return {
      kind: "changed",
      type: "table",
      before,
      after,
      rows,
      layoutOnly: rows.every((row) => row.kind === "same"),
    };
  }

  if (
    (before.type === "bulletList" || before.type === "orderedList") &&
    (after.type === "bulletList" || after.type === "orderedList")
  ) {
    return { kind: "changed", type: "list", before, after, items: diffLists(before, after) };
  }

  const one = before as MemoTextBlock;
  const other = after as MemoTextBlock;
  const oneText = textOf(one.content);
  const otherText = textOf(other.content);

  return {
    kind: "changed",
    type: "text",
    before: one,
    after: other,
    runs: inlineRuns(oneText, otherText),
    emphasisOnly: oneText === otherText,
  };
}

/** What changed between two bodies, block by block. */
export function diffMemoBodies(before: MemoBody, after: MemoBody): MemoDiff {
  const script = editScript(before.content, after.content, blockKey);

  const blocks = pairGaps(
    script,
    pairable,
    (one, other) => similarity(blockText(one), blockText(other)),
    0.3
  ).map((entry): MemoDiffBlock => {
    switch (entry.kind) {
      case "same":
        return { kind: "same", block: entry.after };
      case "added":
        return { kind: "added", block: entry.after };
      case "removed":
        return { kind: "removed", block: entry.before };
      case "changed":
        return changedBlock(entry.before, entry.after);
    }
  });

  const summary: MemoDiffSummary = { same: 0, added: 0, removed: 0, changed: 0 };
  for (const block of blocks) summary[block.kind] += 1;

  return {
    identical: summary.added === 0 && summary.removed === 0 && summary.changed === 0,
    summary,
    blocks,
  };
}

// ── Notes on the page ───────────────────────────────────────────────────────

const samePlace = (one: MemoNote, other: MemoNote): boolean =>
  one.page === other.page &&
  Math.abs(one.x - other.x) < 0.5 &&
  Math.abs(one.y - other.y) < 0.5;

/**
 * Notes matched by what they say. A note with the same words in a different
 * place was moved, not rewritten, and is counted rather than listed - the
 * words are what an approver would want to re-read, and they have not
 * changed.
 */
export function diffNotes(before: MemoNote[], after: MemoNote[]): MemoNotesDiff {
  const remaining = [...before];
  const added: string[] = [];
  let moved = 0;

  for (const note of after) {
    const at = remaining.findIndex((old) => old.text.trim() === note.text.trim());
    if (at < 0) {
      added.push(note.text);
      continue;
    }
    const [old] = remaining.splice(at, 1);
    if (old && !samePlace(old, note)) moved += 1;
  }

  return { added, removed: remaining.map((note) => note.text), moved };
}
