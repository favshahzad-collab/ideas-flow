/**
 * Undo and redo for the memo editor, owned by the editor.
 *
 * The browser keeps an undo stack of its own for a contenteditable region,
 * and it covers exactly what the browser did: typing, and the commands run
 * through `execCommand`. It does not cover what this code did to the DOM
 * directly - adding a row, merging cells, dragging a column boundary, filling
 * a table from the clipboard - so those were the one kind of edit Ctrl+Z
 * could not take back, on a control that changes more of the page than any
 * keystroke. Worse, a direct change under the browser's stack leaves that
 * stack describing a document that no longer exists.
 *
 * So the editor keeps its own history and takes the shortcut over. Every
 * entry is a snapshot of the region - its markup and where the caret was -
 * taken BEFORE a change, so undo is "put the region back as it was" and
 * nothing has to know how to invert an operation. Typing is grouped a word
 * at a time, which is what the browser did; everything else is one entry.
 *
 * This file knows about the DOM (the snapshot is markup and a selection)
 * but nothing about React or the editor, so it can be tested on a bare
 * element.
 */

/** Where a selection endpoint is, as a path of child indexes from the region. */
export type NodePath = { path: number[]; offset: number }

export type SelectionPath = { anchor: NodePath; focus: NodePath }

export type Snapshot = {
  html: string
  selection: SelectionPath | null
}

/**
 * Typing that pauses for longer than this starts a new entry, so a sentence
 * typed with a think in the middle is two undos rather than one.
 */
export const GROUP_MS = 1_000

/** Enough for an afternoon's editing; small enough that markup does not pile up. */
export const HISTORY_LIMIT = 200

export class EditHistory {
  private past: Snapshot[] = []
  private future: Snapshot[] = []
  /** The open group, or null. Consecutive records in one group share an entry. */
  private group: string | null = null
  private lastAt = 0
  private readonly limit: number
  private readonly now: () => number

  constructor(limit = HISTORY_LIMIT, now: () => number = () => Date.now()) {
    this.limit = limit
    this.now = now
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  /**
   * Remember the state a change is about to leave behind.
   *
   * `before` is the region as it stood BEFORE the change. With a `group`,
   * a record that follows another of the same group within `GROUP_MS`
   * adds nothing: the entry already there holds the state from before the
   * group began, which is where one undo should return to.
   *
   * A record identical to the last one is dropped. Two callers can each
   * take the snapshot for one change - the editor around `execCommand` and
   * the browser's own `beforeinput` for the same command - and one undo
   * must not then cost two presses.
   */
  record(before: Snapshot, group: string | null = null): void {
    const at = this.now()
    const continuing =
      group !== null && group === this.group && at - this.lastAt <= GROUP_MS

    this.group = group
    this.lastAt = at

    if (continuing) return

    const last = this.past[this.past.length - 1]
    if (last && sameSnapshot(last, before)) return

    this.past.push(before)
    if (this.past.length > this.limit) this.past.shift()
    this.future = []
  }

  /** End the open group, so the next keystroke starts a new entry. */
  breakGroup(): void {
    this.group = null
  }

  /** The state to put back, given the state the region is in now. */
  undo(current: Snapshot): Snapshot | null {
    const previous = this.past.pop()
    if (!previous) return null

    this.future.push(current)
    this.group = null
    return previous
  }

  redo(current: Snapshot): Snapshot | null {
    const next = this.future.pop()
    if (!next) return null

    this.past.push(current)
    this.group = null
    return next
  }
}

function sameSnapshot(one: Snapshot, other: Snapshot): boolean {
  if (one.html !== other.html) return false
  return JSON.stringify(one.selection) === JSON.stringify(other.selection)
}

// ── Snapshots of a region ───────────────────────────────────────────────────

function pathTo(region: HTMLElement, node: Node, offset: number): NodePath | null {
  const path: number[] = []
  let current: Node = node

  while (current !== region) {
    const parent: Node | null = current.parentNode
    if (!parent) return null
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, current))
    current = parent
  }

  return { path, offset }
}

function nodeAt(region: HTMLElement, at: NodePath): { node: Node; offset: number } | null {
  let node: Node = region
  for (const index of at.path) {
    const child = node.childNodes[index]
    if (!child) return null
    node = child
  }

  const length =
    node.nodeType === Node.TEXT_NODE
      ? (node.textContent ?? '').length
      : node.childNodes.length

  return { node, offset: Math.min(at.offset, length) }
}

/** The region as it stands: its markup and the selection inside it, if any. */
export function snapshotOf(region: HTMLElement): Snapshot {
  const selection = region.ownerDocument.getSelection()
  let where: SelectionPath | null = null

  if (
    selection &&
    selection.anchorNode &&
    selection.focusNode &&
    region.contains(selection.anchorNode) &&
    region.contains(selection.focusNode)
  ) {
    const anchor = pathTo(region, selection.anchorNode, selection.anchorOffset)
    const focus = pathTo(region, selection.focusNode, selection.focusOffset)
    if (anchor && focus) where = { anchor, focus }
  }

  return { html: region.innerHTML, selection: where }
}

/**
 * Put a snapshot back.
 *
 * Markup first, then the selection resolved against the new nodes. A path
 * that no longer resolves - which cannot happen for a snapshot of this same
 * markup, but is cheap to survive - leaves the caret at the end.
 */
export function restore(region: HTMLElement, snapshot: Snapshot): void {
  // The markup being assigned is the region's own, read out of it by
  // `snapshotOf` earlier in this session - never anything from a clipboard
  // or a server. Paste never lets foreign markup into the region (see
  // `memoPaste`), so nothing can reach here that was not already drawn.
  region.innerHTML = snapshot.html

  const selection = region.ownerDocument.getSelection()
  if (!selection) return

  const range = region.ownerDocument.createRange()
  const anchor = snapshot.selection ? nodeAt(region, snapshot.selection.anchor) : null
  const focus = snapshot.selection ? nodeAt(region, snapshot.selection.focus) : null

  if (anchor && focus) {
    range.setStart(anchor.node, anchor.offset)
    range.setEnd(focus.node, focus.offset)
    if (range.collapsed && (anchor.node !== focus.node || anchor.offset !== focus.offset)) {
      // Anchor after focus: a backwards selection. Keep the direction.
      range.setStart(focus.node, focus.offset)
      range.setEnd(anchor.node, anchor.offset)
    }
  } else {
    range.selectNodeContents(region)
    range.collapse(false)
  }

  selection.removeAllRanges()
  selection.addRange(range)
}

/**
 * How a keystroke's input is grouped, from the `inputType` the browser
 * reports before it lands.
 *
 * Typed characters share an entry until a word ends; deletions share one
 * of their own. Anything else - a paste, a paragraph break, a format
 * command - is an entry by itself, because "undo" after pasting a table
 * should take the table out and leave the word before it alone.
 */
export function groupFor(inputType: string): string | null {
  if (inputType === 'insertText' || inputType === 'insertCompositionText') return 'type'
  if (inputType === 'deleteContentBackward' || inputType === 'deleteContentForward') {
    return 'delete'
  }
  return null
}

/** True when what was typed ends a word, so the group ends with it. */
export function endsWord(data: string | null | undefined): boolean {
  return typeof data === 'string' && /\s$/.test(data)
}
