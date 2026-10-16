/**
 * What changed between two versions of a typed memo, as the server reports it.
 *
 * Mirrors `lib/memoDiff.ts` on the server, which does the comparing. The
 * screen only draws this; it never works out a difference of its own, so
 * what an approver reads here is exactly what the record says.
 */
import type {
  MemoBlockNode,
  MemoHeadingNode,
  MemoListNode,
  MemoParagraphNode,
  MemoTableNode,
} from './memo'

export type MemoDiffKind = 'same' | 'added' | 'removed' | 'changed'

/** A stretch of a changed line: kept, put in, or taken out. */
export interface MemoDiffRun {
  kind: 'same' | 'added' | 'removed'
  text: string
}

export interface MemoDiffCell {
  kind: MemoDiffKind
  text: string
  runs?: MemoDiffRun[]
}

export interface MemoDiffRow {
  kind: MemoDiffKind
  header: boolean
  cells: MemoDiffCell[]
}

export interface MemoDiffItem {
  kind: MemoDiffKind
  text: string
  runs?: MemoDiffRun[]
}

export type MemoTextBlock = MemoParagraphNode | MemoHeadingNode

export type MemoDiffBlock =
  // Three members rather than one with a union `kind`, so that narrowing on
  // `kind` leaves only the changed members behind.
  | { kind: 'same'; block: MemoBlockNode }
  | { kind: 'added'; block: MemoBlockNode }
  | { kind: 'removed'; block: MemoBlockNode }
  | {
      kind: 'changed'
      type: 'text'
      before: MemoTextBlock
      after: MemoTextBlock
      runs: MemoDiffRun[]
      /** The words are the same; only bold, italic or underline moved. */
      emphasisOnly: boolean
    }
  | {
      kind: 'changed'
      type: 'table'
      before: MemoTableNode
      after: MemoTableNode
      rows: MemoDiffRow[]
      /** Every cell reads the same; only widths or heights were adjusted. */
      layoutOnly: boolean
    }
  | {
      kind: 'changed'
      type: 'list'
      before: MemoListNode
      after: MemoListNode
      items: MemoDiffItem[]
    }

export interface MemoDiffSummary {
  same: number
  added: number
  removed: number
  changed: number
}

export interface MemoDiff {
  identical: boolean
  summary: MemoDiffSummary
  blocks: MemoDiffBlock[]
}

export interface MemoNotesDiff {
  added: string[]
  removed: string[]
  moved: number
}

export interface MemoChangesVersion {
  versionNumber: number
  filedAt: string
  /** Typed in the portal, so it has a body to compare. */
  typed: boolean
}

export interface ApiMemoChanges {
  current: MemoChangesVersion | null
  /** Null on a first version: there is nothing before it. */
  previous: MemoChangesVersion | null
  /** Who sent the previous version back, and what they said. */
  returned: { by: string; at: string; comment: string | null } | null
  /** Null when either version was uploaded as a PDF and has no text to compare. */
  changes: MemoDiff | null
  notes: MemoNotesDiff | null
}
