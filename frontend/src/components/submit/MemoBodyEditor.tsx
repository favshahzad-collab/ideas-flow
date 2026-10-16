import {
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  Heading1,
  Heading2,
  Table as TableIcon,
  Scissors,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Columns2,
  Columns3,
  Rows2,
  Rows3,
  TableCellsMerge,
  TableCellsSplit,
  ArrowRight,
  ImagePlus,
  Keyboard,
  Maximize2,
  Minimize2,
  Pilcrow,
  Redo2,
  Replace,
  Sigma,
  SpellCheck,
  TableOfContents,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'

import type { MemoBody, MemoBodyAttrs, MemoFont, MemoSize } from '../../types/memo'
import {
  DEFAULT_MEMO_FONT,
  DEFAULT_MEMO_SIZE,
  MEMO_BODY_LIMITS,
  MEMO_FONTS,
  MEMO_SIZES,
} from '../../types/memo'
import {
  IMAGE_ATTRIBUTE,
  IMAGE_SHARE_ATTRIBUTE,
  applyBodyAttrs,
  hoistNestedBlocks,
  htmlToMemoBody,
  imageHtml,
  memoBodyLength,
  memoBodyToHtml,
  pageBreakHtml,
} from '../../utils/memoDom'
import {
  IMAGE_TYPES,
  IN_A_TABLE,
  dataUriBytes,
  pictureRoom,
  prepareImage,
  shareFor,
} from '../../utils/memoImage'
import {
  cellGrid,
  paragraphsOnly,
  readClipboard,
  tooLargeTable,
} from '../../utils/memoPaste'
import {
  EditHistory,
  endsWord,
  groupFor,
  restore,
  snapshotOf,
  type Snapshot,
} from '../../utils/memoHistory'
import { mentionAtCaret, personLine } from '../../utils/memoMention'
import { staleTotals, staleTotalsMessage, totalColumn } from '../../utils/memoTotals'
import {
  SpellChecker,
  caretOffset,
  clearMisspellings,
  indexText,
  loadSpeller,
  misspellingAt,
  misspellings,
  paintMisspellings,
  type Misspelling,
} from '../../utils/memoSpelling'
import { blockMarker, convertTyped } from '../../utils/memoAutoformat'
import { caretToStartOf, outlineOf, type OutlineEntry } from '../../utils/memoOutline'
import {
  clearMatches,
  findAll,
  paintMatches,
  replaceAll,
  replaceRange,
  tidy,
} from '../../utils/memoFind'
import type { AssignableUser } from '../../types/submitDocument'
import type { StandardWording } from '../../services/memoClausesApi'
import { FindReplaceBar } from './FindReplaceBar'
import {
  SpellingPopover,
  type SpellingChoice,
  type SpellingPopoverHandle,
} from './SpellingPopover'
import { OutlinePopover } from './OutlinePopover'
import { ShortcutsPanel } from './ShortcutsPanel'
import { PersonMention, type PersonMentionHandle } from './PersonMention'
import {
  COLUMN_STEP,
  MIN_ROW_HEIGHT,
  ROW_STEP,
  TEXT_WIDTH,
  addColumn,
  addRow,
  cellOf,
  clearRowHeight,
  columnCount,
  columnOf,
  evenWidths,
  fillTableFrom,
  heightOf,
  mergeCells,
  mergeTarget,
  removeColumn,
  removeRow,
  resizeColumn,
  rowsOf,
  selectedCells,
  setRowHeight,
  spanOf,
  splitCell,
  stepColumn,
  tableOf,
  widthsOf,
} from '../../utils/memoTableDom'

/**
 * Where a memo is written.
 *
 * Deliberately not a general rich-text editor. The body has to come out as a
 * handful of node types the PDF template can draw, and the server refuses
 * anything else outright - so the useful property is not "can express a lot"
 * but "cannot express anything that will be refused at the moment of signing".
 *
 * That is also why there is no editor library here. The node set is six
 * blocks and three marks, the browser already implements all of them on a
 * `contenteditable` region, and `utils/memoDom` turns whatever the browser
 * leaves behind into exactly that set. A library would bring a second
 * document model, its own schema, and a much larger set of things it is
 * willing to produce - all of which would then have to be narrowed back down
 * to this one.
 *
 * Uncontrolled on purpose: the DOM is the model. Writing `innerHTML` on every
 * keystroke would destroy the caret and the undo stack on every keystroke.
 */

interface MemoBodyEditorProps {
  /**
   * The memo's text column, in points.
   *
   * A row height is stored in points, so the conversion from a pixel drag has
   * to use the column the memo will actually be filed at. Left out, this is
   * the delivered default, which is what every memo filed before page setup
   * existed was drawn at - and what the editor should assume before the
   * organisation's page has loaded.
   */
  textWidth?: number
  /** Seeds the region once. Later changes to it are ignored while typing. */
  initialBody: MemoBody
  onChange: (body: MemoBody) => void
  disabled?: boolean
  /** The heading that names this region, for screen readers. */
  labelledBy?: string
  describedBy?: string
  invalid?: boolean
  id?: string
  /**
   * Draw the editor as a field, with a border and a background.
   *
   * Off when it sits on the memo sheet, where the editor *is* the page and a
   * box drawn around it would be a box drawn on a piece of paper.
   */
  framed?: boolean
  /**
   * Standard wording the writer may insert - kept by an administrator,
   * copied into the memo at the caret. Nothing is offered when there is none.
   */
  wording?: StandardWording[]
  /**
   * Words the spell check should not flag: the organisation's own, and the
   * names in the directory. Without it the English dictionary stands alone.
   */
  dictionary?: string[]
  /** Whether "add to the dictionary" is offered on a flagged word. */
  canAddWords?: boolean
  onAddWord?: (word: string) => Promise<void>
  /**
   * Whether the face and the size the memo is set in are offered. On by
   * default; off where the body is not a memo of its own - a clause,
   * which takes the memo's setting when it is inserted.
   */
  typography?: boolean
}

/** One stable empty list, so an absent prop does not re-make callbacks. */
const NO_WORDING: StandardWording[] = []
const NO_DICTIONARY: string[] = []

/**
 * How long after a keystroke a word is still "being typed", and left out
 * of the spelling check: an unfinished word is not a misspelling.
 */
const TYPING_MS = 1200

type BlockFormat = 'p' | 'h1' | 'h2'

type EditorAction =
  | 'undo'
  | 'redo'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'paragraph'
  | 'heading'
  | 'subheading'
  | 'bulletList'
  | 'orderedList'
  | 'table'
  | 'pageBreak'
  | 'picture'
  | 'find'
  | 'spelling'
  | 'spellingNext'
  | 'outline'
  | 'focus'
  | 'shortcuts'
  | TableAction
  | PictureAction

type PictureAction = 'pictureSmaller' | 'pictureLarger' | 'pictureRemove'

type TableAction =
  | 'rowAdd'
  | 'rowRemove'
  | 'columnAdd'
  | 'columnRemove'
  | 'columnTotal'
  | 'cellsMerge'
  | 'cellSplit'
  | 'columnNarrower'
  | 'columnWider'
  | 'rowShorter'
  | 'rowTaller'

/** What the caret is standing in, as far as a table is concerned. */
type TableCaret = {
  inside: boolean
  /** The cell the caret is in covers more than one column. */
  merged: boolean
  /** There is something to merge it with. */
  mergeable: boolean
  rows: number
  columns: number
}

const NO_TABLE: TableCaret = {
  inside: false,
  merged: false,
  mergeable: false,
  rows: 0,
  columns: 0,
}

const sameCaret = (one: TableCaret, other: TableCaret): boolean =>
  one.inside === other.inside &&
  one.merged === other.merged &&
  one.mergeable === other.mergeable &&
  one.rows === other.rows &&
  one.columns === other.columns

/** Where in a table the caret is, for an operation that needs all of it. */
type CaretInTable = {
  table: HTMLTableElement
  row: HTMLTableRowElement
  cell: HTMLTableCellElement
  selection: Selection | null
}

/** How close to a cell's edge counts as reaching for it, in pixels. */
const GRIP = 5

/** A boundary being dragged. Held while the pointer is down, and no longer. */
type Resize =
  | { kind: 'column'; table: HTMLTableElement; boundary: number }
  | { kind: 'row'; table: HTMLTableElement; row: HTMLTableRowElement }

/**
 * The toolbar, as data.
 *
 * Declared out here rather than built inside the component so that the render
 * only ever reads labels and icons. The handlers reach into the editable
 * region, and a render that closes over them is a render that touches a ref -
 * which is both a lint error and a real hazard, since a ref read during
 * render is a value React has not promised is current.
 */
const TOOLBAR: {
  group: string
  buttons: { label: string; icon: typeof Bold; action: EditorAction }[]
}[] = [
  {
    group: 'History',
    buttons: [
      { label: 'Undo', icon: Undo2, action: 'undo' },
      { label: 'Redo', icon: Redo2, action: 'redo' },
    ],
  },
  {
    group: 'Text',
    buttons: [
      { label: 'Bold', icon: Bold, action: 'bold' },
      { label: 'Italic', icon: Italic, action: 'italic' },
      { label: 'Underline', icon: Underline, action: 'underline' },
    ],
  },
  {
    group: 'Structure',
    buttons: [
      { label: 'Body text', icon: Pilcrow, action: 'paragraph' },
      { label: 'Heading', icon: Heading1, action: 'heading' },
      { label: 'Sub-heading', icon: Heading2, action: 'subheading' },
      { label: 'Bulleted list', icon: List, action: 'bulletList' },
      { label: 'Numbered list', icon: ListOrdered, action: 'orderedList' },
    ],
  },
  {
    group: 'Insert',
    buttons: [
      { label: 'Table', icon: TableIcon, action: 'table' },
      { label: 'Picture', icon: ImagePlus, action: 'picture' },
      { label: 'Page break', icon: Scissors, action: 'pageBreak' },
    ],
  },
  {
    group: 'Find',
    buttons: [{ label: 'Find and replace', icon: Replace, action: 'find' }],
  },
  {
    group: 'Spelling',
    buttons: [
      { label: 'Check spelling', icon: SpellCheck, action: 'spelling' },
      { label: 'Next misspelling', icon: ArrowRight, action: 'spellingNext' },
    ],
  },
  {
    group: 'View',
    buttons: [
      { label: 'Outline', icon: TableOfContents, action: 'outline' },
      { label: 'Focus mode', icon: Maximize2, action: 'focus' },
      { label: 'Keyboard shortcuts', icon: Keyboard, action: 'shortcuts' },
    ],
  },
]

/** The box for a range, relative to the editor shell; the origin where a test DOM has no layout. */
function anchorFor(range: Range, shell: HTMLElement | null): { top: number; left: number } {
  const box = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null
  const shellBox = shell?.getBoundingClientRect()
  if (!box || !shellBox) return { top: 0, left: 0 }
  return {
    top: Math.round(box.bottom - shellBox.top + 4),
    left: Math.round(Math.max(0, Math.min(box.left - shellBox.left, shellBox.width - 320))),
  }
}

/**
 * Put the region back into blocks side by side after a command, keeping
 * the caret. Chromium nests the list it makes inside the paragraph it made
 * it from (see `hoistNestedBlocks`); the text node the caret is in survives
 * the move, so the caret is put back onto it afterwards.
 */
function tidyBlocks(region: HTMLElement): void {
  const selection = document.getSelection()
  const anchor = selection?.anchorNode ?? null
  const offset = selection?.anchorOffset ?? 0

  if (!hoistNestedBlocks(region)) return

  if (selection && anchor && region.contains(anchor)) {
    selection.collapse(anchor, Math.min(offset, anchor.nodeType === Node.TEXT_NODE ? (anchor as Text).length : anchor.childNodes.length))
  }
}

/**
 * The picture controls, with the selection on a picture. A picture is a
 * block of its own that the caret steps over, so what can be done to it is
 * done from here: made narrower or wider by a tenth of the column, given a
 * description, taken out.
 */
const PICTURE_TOOLBAR: { label: string; icon: typeof Bold; action: PictureAction }[] = [
  { label: 'Smaller picture', icon: ZoomOut, action: 'pictureSmaller' },
  { label: 'Larger picture', icon: ZoomIn, action: 'pictureLarger' },
  { label: 'Remove picture', icon: Trash2, action: 'pictureRemove' },
]

/** One press of Smaller or Larger, as a share of the column. */
const SHARE_STEP = 0.1

const shareOf = (figure: HTMLElement): number =>
  Number(figure.getAttribute(IMAGE_SHARE_ATTRIBUTE)) || 1

/** Written twice - the CSS width the browser lays out, the attribute the reader takes back. */
function setShare(figure: HTMLElement, share: number): void {
  figure.setAttribute(IMAGE_SHARE_ATTRIBUTE, String(share))
  figure.style.width = `${(share * 100).toFixed(1)}%`
}

/**
 * The picture the selection is on: the one the caret is inside or beside,
 * or the one selected whole, which is how a click leaves it.
 */
function pictureAt(selection: Selection, region: HTMLElement): HTMLElement | null {
  const anchor = selection.anchorNode
  if (!anchor) return null

  const element =
    anchor.nodeType === Node.ELEMENT_NODE ? (anchor as HTMLElement) : anchor.parentElement
  const inside = element?.closest(`[${IMAGE_ATTRIBUTE}]`)
  if (inside && region.contains(inside)) return inside as HTMLElement

  if (anchor.nodeType !== Node.ELEMENT_NODE) return null
  for (const at of [selection.anchorOffset, selection.anchorOffset - 1]) {
    const child = anchor.childNodes[at]
    if (child instanceof HTMLElement && child.hasAttribute(IMAGE_ATTRIBUTE)) return child
  }
  return null
}

const isPicture = (node: Node | null | undefined): node is HTMLElement =>
  node instanceof HTMLElement && node.hasAttribute(IMAGE_ATTRIBUTE)

/**
 * The picture a Backspace or a Delete would take out, if the caret stands
 * against one: selected whole, or the caret at the very start of what
 * follows it (Backspace), or at the very end of what precedes it (Delete).
 *
 * Worked out here rather than left to the browser because a selected
 * `contenteditable="false"` block is not deleted by every engine - Chromium
 * left the picture standing and the key did nothing - and because the caret
 * beside a picture is put in different places by different engines. The
 * walk climbs from the caret while it stands at the edge of its container,
 * so "the start of the paragraph after the picture" reaches the picture.
 */
function pictureUnderKey(
  selection: Selection,
  key: 'Backspace' | 'Delete',
  region: HTMLElement,
): HTMLElement | null {
  if (selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)

  if (!selection.isCollapsed) {
    const whole =
      range.startContainer === range.endContainer && range.endOffset - range.startOffset === 1
        ? range.startContainer.childNodes[range.startOffset]
        : null
    return isPicture(whole) && region.contains(whole) ? whole : null
  }

  let node: Node = range.startContainer
  let offset = range.startOffset
  for (;;) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const beside = node.childNodes[key === 'Backspace' ? offset - 1 : offset]
      if (isPicture(beside)) return region.contains(beside) ? beside : null
    }
    if (node === region) return null

    const length =
      node.nodeType === Node.TEXT_NODE ? (node as Text).length : node.childNodes.length
    const atEdge = key === 'Backspace' ? offset === 0 : offset === length
    if (!atEdge) return null

    const parent = node.parentNode
    if (!parent) return null
    const index = Array.prototype.indexOf.call(parent.childNodes, node)
    offset = key === 'Backspace' ? index : index + 1
    node = parent
  }
}

/**
 * A click on a picture selects it whole, so that Backspace takes it out and
 * the picture controls know which one they are for. The browser, left to
 * itself, puts the caret somewhere beside a `contenteditable="false"`
 * element, and where depends on the engine.
 */
function selectPicture(region: HTMLElement, target: EventTarget | null): void {
  const figure = (target as Element | null)?.closest?.(`[${IMAGE_ATTRIBUTE}]`)
  if (!figure || !region.contains(figure)) return

  const selection = document.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNode(figure)
  selection.removeAllRanges()
  selection.addRange(range)
}

/** The find bar's state, owned here because the matches live in the region. */
type FindState = {
  query: string
  replacement: string
  matchCase: boolean
  wholeWord: boolean
  /** The match the preparer is on, as asked for; clamped to what exists. */
  current: number
  focusOn: 'find' | 'replace'
  focusKey: number
  /** "Replaced 3", said once in place of the count. */
  announcement: string | null
}

const currentOf = (state: FindState, count: number): number =>
  count === 0 ? -1 : Math.min(Math.max(state.current, 0), count - 1)

/** Bring a match onto the screen, as a find in any editor does. */
function reveal(range: Range | undefined): void {
  const element = range?.startContainer.parentElement
  // Guarded because a test DOM has no layout to scroll.
  if (element && typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ block: 'nearest' })
  }
}

/**
 * The table controls, which appear only with the caret inside a table.
 *
 * A second bar rather than ten more buttons on the first: offering "Merge
 * cells" against a paragraph is a control that can only do nothing, which
 * reads as the editor being broken. It also keeps the controls near what
 * they act on, which is how every word processor does this.
 *
 * Each of these has a keyboard path on purpose. Dragging a column boundary
 * is a mouse gesture, and a table that can only be shaped with a mouse is
 * not a table everybody can use.
 */
const TABLE_TOOLBAR: {
  group: string
  buttons: { label: string; icon: typeof Bold; action: TableAction }[]
}[] = [
  {
    group: 'Rows',
    buttons: [
      { label: 'Add row', icon: Rows3, action: 'rowAdd' },
      { label: 'Remove row', icon: Rows2, action: 'rowRemove' },
    ],
  },
  {
    group: 'Columns',
    buttons: [
      { label: 'Add column', icon: Columns3, action: 'columnAdd' },
      { label: 'Remove column', icon: Columns2, action: 'columnRemove' },
      { label: 'Total column', icon: Sigma, action: 'columnTotal' },
    ],
  },
  {
    group: 'Cells',
    buttons: [
      { label: 'Merge cells', icon: TableCellsMerge, action: 'cellsMerge' },
      { label: 'Split cell', icon: TableCellsSplit, action: 'cellSplit' },
    ],
  },
  {
    group: 'Size',
    buttons: [
      { label: 'Narrower column', icon: ChevronLeft, action: 'columnNarrower' },
      { label: 'Wider column', icon: ChevronRight, action: 'columnWider' },
      { label: 'Shorter row', icon: ChevronUp, action: 'rowShorter' },
      { label: 'Taller row', icon: ChevronDown, action: 'rowTaller' },
    ],
  },
]

export default function MemoBodyEditor({
  initialBody,
  onChange,
  disabled = false,
  labelledBy,
  describedBy,
  invalid = false,
  id,
  framed = true,
  textWidth = TEXT_WIDTH,
  wording = NO_WORDING,
  dictionary = NO_DICTIONARY,
  canAddWords = false,
  onAddWord,
  typography = true,
}: MemoBodyEditorProps) {
  const regionRef = useRef<HTMLDivElement | null>(null)
  /**
   * Where the caret was when the region last lost focus.
   *
   * The wording control is a select, and opening one takes the focus - so
   * by the time a title is chosen the region has no caret to insert at. The
   * last one it had is put back first.
   */
  const savedRange = useRef<Range | null>(null)
  const wordingId = useId()
  const [marks, setMarks] = useState({
    bold: false,
    italic: false,
    underline: false,
  })
  const [block, setBlock] = useState<BlockFormat>('p')
  const [caret, setCaret] = useState<TableCaret>(NO_TABLE)
  /** The picture the selection is on, and its description as it is typed. */
  const [picture, setPicture] = useState<HTMLElement | null>(null)
  const [pictureAlt, setPictureAlt] = useState('')
  const pictureAltId = useId()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  /** The region as it stood when the description field took the focus. */
  const altBefore = useRef<Snapshot | null>(null)
  const [grip, setGrip] = useState<'column' | 'row' | null>(null)
  const [drag, setDrag] = useState<Resize | null>(null)
  const [length, setLength] = useState(() => memoBodyLength(initialBody))
  /**
   * Why the last paste was refused, until the next keystroke.
   *
   * A paste that does nothing with no word said reads as a broken editor. It
   * clears on input rather than on blur so that clicking away to read the
   * message does not take the message with it.
   */
  const [notice, setNotice] = useState<string | null>(null)
  /*
   * The columns whose total no longer adds up, by heading.
   *
   * A total is written as text (see `utils/memoTotals`), so a figure changed
   * above it leaves it standing wrong. Checked after every edit, and once at
   * the start against the seed - a draft reopened with a stale total in it
   * is told so before anything is typed. The seed is read off a detached
   * element so the check needs no region and no effect.
   */
  const [stale, setStale] = useState<string[]>(() => {
    const host = document.createElement('div')
    host.innerHTML = memoBodyToHtml(initialBody)
    return staleTotals(host)
  })
  /*
   * Find and replace. The bar is open while `find` is set; the matches are
   * ranges over the region's own text, kept in a ref because they are DOM
   * objects that change under every keystroke, with only their count in
   * state. `findRef` mirrors `find` so that handlers fired between renders
   * read what was just asked for. See `utils/memoFind`.
   */
  const [find, setFind] = useState<FindState | null>(null)
  const findRef = useRef<FindState | null>(null)
  const [matchCount, setMatchCount] = useState(0)
  const matchesRef = useRef<Range[]>([])
  /** What was last searched for, so the bar reopens on it. */
  const rememberedFind = useRef<Pick<FindState, 'query' | 'replacement' | 'matchCase' | 'wholeWord'>>({
    query: '',
    replacement: '',
    matchCase: false,
    wholeWord: false,
  })
  /*
   * Spelling. The checker is built once the dictionary has loaded (see
   * `utils/memoSpelling`); until then the browser's own check stands in.
   * The misspellings are ranges over the region's text, kept in a ref like
   * the find matches, with only their count in state. `spellPopover` is the
   * list of suggestions under the caret, when the caret rests in one.
   */
  const checkerRef = useRef<SpellChecker | null>(null)
  const [spelling, setSpelling] = useState({ on: true, ready: false })
  const spellingRef = useRef(spelling)
  const misspelledRef = useRef<Misspelling[]>([])
  const [misspelledCount, setMisspelledCount] = useState(0)
  const [spellPopover, setSpellPopover] = useState<{
    word: string
    suggestions: string[]
    anchor: { top: number; left: number }
    start: number
  } | null>(null)
  const [spellOption, setSpellOption] = useState<string | null>(null)
  const spellPopoverRef = useRef<SpellingPopoverHandle>(null)
  /** The word Escape was pressed on, by where it starts, so it stays closed. */
  const spellSuppress = useRef<number | null>(null)
  /** When the last keystroke landed: a word still being typed is not checked. */
  const lastTypedAt = useRef(0)
  const spellTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const checkSpellingRef = useRef<() => void>(() => {})
  /** What the last keystroke was, for the conversions made as text is typed. */
  const lastTyped = useRef<{ type: string; data: string }>({ type: '', data: '' })
  /**
   * How the memo is set: one face, one size, for the whole of it. Seeded
   * from the body and written onto the region, where the reader takes it
   * back with the blocks.
   */
  const [setting, setSetting] = useState<Required<MemoBodyAttrs>>(() => ({
    font: initialBody.attrs?.font ?? DEFAULT_MEMO_FONT,
    size: initialBody.attrs?.size ?? DEFAULT_MEMO_SIZE,
  }))
  const fontId = useId()
  const sizeId = useId()
  /** The headings while the outline is open; the focus mode; the shortcuts list. */
  const [outline, setOutline] = useState<OutlineEntry[] | null>(null)
  const [focusMode, setFocusMode] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  /*
   * The editor's own undo history. See `utils/memoHistory` for why the
   * browser's is not enough: it cannot see a row added or a column dragged,
   * and those are the edits that change the most. Held in state so the
   * instance survives renders; never set, so it never causes one. What the
   * toolbar shows is mirrored into `historyState` after each change.
   */
  const [history] = useState(() => new EditHistory())
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false })
  /** The region as it stood when a boundary drag began. */
  const dragBefore = useRef<Snapshot | null>(null)
  /*
   * The `@name` being typed, while one is. The list of matching people sits
   * under the caret; the region keeps the keyboard and drives the list
   * through `mentionRef`. Escape closes it and keeps it closed for the rest
   * of that name - `suppressMention` - until the caret leaves it.
   */
  const [mention, setMention] = useState<{
    query: string
    anchor: { top: number; left: number }
  } | null>(null)
  const [mentionOption, setMentionOption] = useState<string | null>(null)
  /** The `@` Escape was pressed on, so that one stays closed and a new one does not. */
  const suppressMention = useRef<{ node: Text; start: number } | null>(null)
  const mentionRef = useRef<PersonMentionHandle>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)

  /*
   * The seed, held in a ref so a parent re-render cannot re-seed the region
   * mid-sentence. Replacing the content while somebody is typing is the
   * single worst thing an editor can do, and a prop that looks stable is
   * only stable until somebody memoises it differently.
   */
  const seed = useRef(initialBody)

  useEffect(() => {
    const region = regionRef.current
    if (!region) return

    region.innerHTML = memoBodyToHtml(seed.current)
    applyBodyAttrs(region, seed.current.attrs)

    /*
     * Ask the browser for tags rather than styles.
     *
     * With `styleWithCSS` on, "bold" produces `<span style="font-weight:700">`
     * - which the reader in `memoDom` does understand, but which nests and
     * accumulates as text is edited until a paragraph is a thicket of spans.
     * Tags stay flat. The reader keeps handling both, because this call is
     * advisory and some engines ignore it.
     */
    try {
      document.execCommand('styleWithCSS', false, 'false')
      document.execCommand('defaultParagraphSeparator', false, 'p')
    } catch {
      // Both are optional niceties; the reader copes either way.
    }
  }, [])

  /**
   * Find the matches again and paint them, for the find state given.
   *
   * Called from the handlers that change the text or the query, never from
   * an effect: the matches are read off the DOM, and the DOM changes in
   * handlers. The highlight registry paints ranges without touching a node,
   * which is what keeps a find out of the memo and out of the history.
   */
  const syncFind = useCallback((state: FindState | null) => {
    const region = regionRef.current
    if (!state || !region) {
      matchesRef.current = []
      setMatchCount(0)
      clearMatches()
      return
    }

    const ranges = findAll(region, state.query, {
      matchCase: state.matchCase,
      wholeWord: state.wholeWord,
    })
    matchesRef.current = ranges
    setMatchCount(ranges.length)
    paintMatches(ranges, currentOf(state, ranges.length))
  }, [])

  const updateFind = useCallback(
    (next: FindState | null) => {
      findRef.current = next
      setFind(next)
      syncFind(next)
    },
    [syncFind],
  )

  /**
   * Read the memo for words the dictionary does not know, and paint them.
   *
   * Called from the handlers that change the text, never from an effect,
   * for the reason `syncFind` gives. A word under the caret within a moment
   * of a keystroke is left out - it is being typed - and a timer checks
   * again once the typing pauses, so the word is flagged then.
   */
  const checkSpelling = useCallback(() => {
    const region = regionRef.current
    const checker = checkerRef.current
    if (!region || !checker || !spellingRef.current.on) {
      misspelledRef.current = []
      setMisspelledCount(0)
      clearMisspellings()
      return
    }

    const index = indexText(region)
    const selection = document.getSelection()
    const typing =
      Date.now() - lastTypedAt.current < TYPING_MS && selection?.isCollapsed
        ? caretOffset(index, selection.anchorNode, selection.anchorOffset)
        : null

    const found = misspellings(index, checker, typing)
    misspelledRef.current = found
    setMisspelledCount(found.length)
    paintMisspellings(found.map(entry => entry.range))
  }, [])

  useEffect(() => {
    spellingRef.current = spelling
    checkSpellingRef.current = checkSpelling
  })

  /*
   * The dictionary, loaded once the editor is open and never before: half
   * a megabyte nobody reading a list of documents needs. A new organisation
   * list makes a new checker over the same loaded English.
   */
  useEffect(() => {
    let cancelled = false
    // Through a resolved promise, so a loader that throws is a rejection.
    void Promise.resolve()
      .then(() => loadSpeller())
      .then(speller => {
        if (cancelled) return
        checkerRef.current = new SpellChecker(speller, dictionary)
        setSpelling(previous => (previous.ready ? previous : { ...previous, ready: true }))
        checkSpellingRef.current()
      })
      .catch(() => {
        // Without the dictionary the browser's own check stays on. Nothing
        // to say: the region is simply as it was.
      })
    return () => {
      cancelled = true
    }
  }, [dictionary])

  // Nothing painted outlives the editor.
  useEffect(
    () => () => {
      clearMatches()
      clearMisspellings()
      if (spellTimer.current) clearTimeout(spellTimer.current)
    },
    [],
  )

  const publish = useCallback(() => {
    const region = regionRef.current
    if (!region) return

    // The text changed under the matches, if the bar is open.
    syncFind(findRef.current)
    checkSpelling()
    // And under the outline, if it is open.
    setOutline(previous => (previous ? outlineOf(region) : previous))

    const body = htmlToMemoBody(region)
    setLength(memoBodyLength(body))
    // The same list is kept as the same array, so a keystroke in a
    // paragraph does not re-render the editor for a warning that has not
    // changed.
    const found = staleTotals(region)
    setStale(previous =>
      previous.length === found.length && previous.every((name, at) => name === found[at])
        ? previous
        : found,
    )
    onChange(body)
  }, [checkSpelling, onChange, syncFind])

  /** What the toolbar should show as active, for the current selection. */
  const syncToolbar = useCallback(() => {
    const region = regionRef.current
    const selection = document.getSelection()
    if (!region || !selection?.anchorNode) return
    if (!region.contains(selection.anchorNode)) return

    // Remembered while it is here, for a control that will take the focus.
    if (selection.rangeCount > 0) savedRange.current = selection.getRangeAt(0).cloneRange()

    const state = (command: string): boolean => {
      try {
        return document.queryCommandState(command)
      } catch {
        return false
      }
    }

    setMarks({
      bold: state('bold'),
      italic: state('italic'),
      underline: state('underline'),
    })

    const element =
      selection.anchorNode.nodeType === Node.ELEMENT_NODE
        ? (selection.anchorNode as HTMLElement)
        : selection.anchorNode.parentElement

    setBlock(
      element?.closest('h1') ? 'h1' : element?.closest('h2') ? 'h2' : 'p',
    )

    const cell = cellOf(element)
    const table = cell ? tableOf(cell) : null

    const next: TableCaret =
      cell && table
        ? {
            inside: true,
            merged: spanOf(cell) > 1,
            // Either a run of cells is selected, or there is one to the
            // right of the caret to merge this one into.
            mergeable:
              selectedCells(selection).length > 1 ||
              Boolean(cell.nextElementSibling),
            rows: rowsOf(table).length,
            columns: columnCount(table),
          }
        : NO_TABLE

    // Selection changes on every keystroke, and a fresh object each time
    // would re-render the whole editor for a caret that has not left the
    // paragraph it was in.
    setCaret(previous => (sameCaret(previous, next) ? previous : next))

    const figure = pictureAt(selection, region)
    setPicture(previous => (previous === figure ? previous : figure))
    if (figure) setPictureAlt(figure.querySelector('img')?.getAttribute('alt') ?? '')
  }, [])

  useEffect(() => {
    document.addEventListener('selectionchange', syncToolbar)
    return () => document.removeEventListener('selectionchange', syncToolbar)
  }, [syncToolbar])

  const syncHistory = useCallback(() => {
    setHistoryState(previous =>
      previous.canUndo === history.canUndo && previous.canRedo === history.canRedo
        ? previous
        : { canUndo: history.canUndo, canRedo: history.canRedo },
    )
  }, [history])

  /**
   * Whether the word being typed has any letters in it yet.
   *
   * A space ends a word - but only a word. A space typed first, after a
   * command or a click, is the start of the next word and goes with it;
   * otherwise it would sit in an entry of its own and cost an undo press
   * that takes back nothing anybody can see.
   */
  const wordInGroup = useRef(false)

  /** End the word being typed, so the next keystroke starts an entry. */
  const endWord = useCallback(() => {
    history.breakGroup()
    wordInGroup.current = false
  }, [history])

  const run = useCallback(
    (command: string, value?: string) => {
      if (disabled) return
      const region = regionRef.current
      if (!region) return

      /*
       * Focus, keeping the selection. Some engines put the caret at the
       * start of an editing host when it is focused, and a command applies
       * to the selection - so a range set up by the caller (the `@name` a
       * person is being written over) must survive the focus call.
       */
      const selection = document.getSelection()
      const kept =
        selection && selection.rangeCount > 0 && region.contains(selection.anchorNode)
          ? selection.getRangeAt(0).cloneRange()
          : null
      region.focus()
      if (kept && selection) {
        selection.removeAllRanges()
        selection.addRange(kept)
      }

      const before = snapshotOf(region)
      try {
        document.execCommand(command, false, value)
      } catch {
        // An unsupported command leaves the text untouched, which is the
        // right outcome: nothing should be silently half-applied.
      }
      tidyBlocks(region)
      // Only a command that changed something earns an entry. "Bold" with
      // nothing selected changes what the NEXT keystroke will be and nothing
      // on the page; an entry for it would make one undo press do nothing.
      if (region.innerHTML !== before.html) {
        history.record(before)
        syncHistory()
      }
      // Whatever is typed after a command is its own entry, not the tail of
      // the word before it.
      endWord()
      syncToolbar()
      publish()
    },
    [disabled, endWord, history, publish, syncHistory, syncToolbar],
  )

  const undo = useCallback(() => {
    const region = regionRef.current
    if (!region || disabled) return

    const previous = history.undo(snapshotOf(region))
    if (!previous) return

    restore(region, previous)
    syncHistory()
    publish()
    syncToolbar()
  }, [disabled, history, publish, syncHistory, syncToolbar])

  const redo = useCallback(() => {
    const region = regionRef.current
    if (!region || disabled) return

    const next = history.redo(snapshotOf(region))
    if (!next) return

    restore(region, next)
    syncHistory()
    publish()
    syncToolbar()
  }, [disabled, history, publish, syncHistory, syncToolbar])

  /*
   * Typing, as the browser reports it before it lands.
   *
   * `beforeinput` is the one moment the region can be read as it was before
   * a keystroke changed it, which is what an entry has to hold. It also
   * carries the browser's own undo and redo - the menu item, a gesture on a
   * trackpad - which are taken over here so that every route to "undo" goes
   * through the same history. A native listener rather than a React prop,
   * because React's `onBeforeInput` is an older, different event.
   */
  useEffect(() => {
    const region = regionRef.current
    if (!region) return

    const onBeforeInput = (event: Event) => {
      const input = event as InputEvent
      if (input.inputType === 'historyUndo') {
        event.preventDefault()
        undo()
        return
      }
      if (input.inputType === 'historyRedo') {
        event.preventDefault()
        redo()
        return
      }
      // A composition is recorded once, when it starts.
      if (input.isComposing) return

      lastTyped.current = { type: input.inputType, data: input.data ?? '' }

      const group = groupFor(input.inputType)
      history.record(snapshotOf(region), group)
      // A word being typed is not checked until the typing pauses.
      if (group) {
        lastTypedAt.current = Date.now()
        if (spellTimer.current) clearTimeout(spellTimer.current)
        spellTimer.current = setTimeout(() => checkSpellingRef.current(), TYPING_MS + 100)
      }
      if (group === 'type') {
        const data = input.data ?? ''
        if (/\S/.test(data)) wordInGroup.current = true
        // The space that ends a word goes with the word, and the next
        // character starts a new entry - which is how the browser grouped it.
        if (endsWord(data) && wordInGroup.current) endWord()
      } else {
        wordInGroup.current = false
      }
      syncHistory()
    }
    const onCompositionStart = () => {
      history.record(snapshotOf(region))
      syncHistory()
    }
    const onCompositionEnd = () => endWord()

    region.addEventListener('beforeinput', onBeforeInput)
    region.addEventListener('compositionstart', onCompositionStart)
    region.addEventListener('compositionend', onCompositionEnd)
    return () => {
      region.removeEventListener('beforeinput', onBeforeInput)
      region.removeEventListener('compositionstart', onCompositionStart)
      region.removeEventListener('compositionend', onCompositionEnd)
    }
  }, [endWord, history, redo, syncHistory, undo])

  /**
   * Insert markup at the caret without reaching for innerHTML on the region.
   *
   * `insertHTML` is the one command that takes a fragment, and everything
   * passed to it here is built by this file - a table skeleton, a page break -
   * never anything typed or pasted by a person.
   */
  const insert = useCallback((html: string) => run('insertHTML', html), [run])

  const insertTable = useCallback(() => {
    const header = '<th><br></th>'.repeat(3)
    const cells = '<td><br></td>'.repeat(3)
    const rows = `<tr>${header}</tr>` + `<tr>${cells}</tr>`.repeat(2)
    // A trailing paragraph, so there is somewhere to carry on writing. A
    // table at the very end of a contenteditable region is a caret trap.
    insert(`<table><tbody>${rows}</tbody></table><p><br></p>`)
  }, [insert])

  /** Where the caret is standing, if it is standing in a table. */
  const caretAt = useCallback((): CaretInTable | null => {
    const region = regionRef.current
    const selection = document.getSelection()
    const anchor = selection?.anchorNode
    if (!region || !anchor || !region.contains(anchor)) return null

    const cell = cellOf(anchor)
    const row = cell?.closest('tr') ?? null
    const table = cell ? tableOf(cell) : null
    if (!cell || !row || !table) return null

    return { table, row, cell, selection }
  }, [])

  /**
   * Change the table the caret is in, and publish only if anything changed.
   *
   * An operation returns false to say it declined - removing the only row,
   * splitting a cell that was never merged. Publishing anyway would mark the
   * draft as edited for a press that did nothing, and the preparer would be
   * asked to save work they had not done.
   */
  const editTable = useCallback(
    (change: (at: CaretInTable) => boolean | void) => {
      if (disabled) return

      const region = regionRef.current
      const at = caretAt()
      if (!region || !at) return

      // Read before the change, recorded only once it is known to have
      // happened - an operation that declined has nothing to take back.
      const before = snapshotOf(region)
      if (change(at) === false) return

      history.record(before)
      syncHistory()
      publish()
      syncToolbar()
    },
    [caretAt, disabled, history, publish, syncHistory, syncToolbar],
  )

  /**
   * Points per pixel on screen.
   *
   * A table spans exactly the memo's text column, so its drawn width is the
   * whole of the scale between what is on the screen and what will be on the
   * page - nothing has to be told how large the sheet is being shown.
   */
  const pointsPerPixel = useCallback(
    (table: HTMLTableElement): number => {
      const width = table.getBoundingClientRect().width
      return width > 0 ? textWidth / width : 0
    },
    [textWidth],
  )

  const applyTable = useCallback(
    (action: TableAction) => {
      editTable(({ table, row, cell, selection }) => {
        const columns = columnCount(table)
        const last = columnOf(cell) + spanOf(cell) - 1

        /*
         * The boundary this cell can move.
         *
         * A boundary belongs to the column on its left, and the rightmost
         * column has none of its own - the table's edge is fixed. So it
         * borrows the boundary before it, and widening means moving that one
         * the other way.
         */
        const onEdge = last >= columns - 1
        const boundary = onEdge ? last - 1 : last

        const stepColumnBy = (by: number) => {
          if (boundary < 0) return false
          stepColumn(table, boundary, onEdge ? -by : by)
          return true
        }

        const stepRowBy = (by: number) => {
          const perPixel = pointsPerPixel(table)
          const measured = perPixel
            ? row.getBoundingClientRect().height * perPixel
            : MIN_ROW_HEIGHT
          const next = (heightOf(row) ?? measured) + by

          /*
           * At or below the floor means "stop asking for a height", and the
           * row goes back to being sized by its content.
           *
           * The floor is below one line of table text, so a row held there
           * has no effect on what is drawn - resting at it would be a state
           * that does nothing, reached by pressing a control that appeared
           * to work. One press past it clears instead.
           */
          if (next <= MIN_ROW_HEIGHT) {
            if (heightOf(row) === null) return false
            clearRowHeight(row)
            return true
          }

          setRowHeight(row, next)
          return true
        }

        switch (action) {
          case 'rowAdd':
            return void addRow(table, row)
          case 'rowRemove':
            return removeRow(table, row)
          case 'columnAdd':
            return void addColumn(table, last)
          case 'columnRemove':
            return removeColumn(table, columnOf(cell))
          case 'columnTotal': {
            // Written as text, under the caret's column. A refusal says
            // which cell stopped it, in the same place a refused paste does.
            const outcome = totalColumn(table, columnOf(cell))
            setNotice(outcome.ok ? null : outcome.reason)
            return outcome.ok
          }
          case 'cellsMerge':
            return mergeCells(mergeTarget(selection))
          case 'cellSplit':
            return splitCell(cell)
          case 'columnNarrower':
            return stepColumnBy(-COLUMN_STEP)
          case 'columnWider':
            return stepColumnBy(COLUMN_STEP)
          case 'rowShorter':
            return stepRowBy(-ROW_STEP)
          case 'rowTaller':
            return stepRowBy(ROW_STEP)
        }
      })
    },
    [editTable, pointsPerPixel],
  )

  /** The boundary within reach of a pointer, if there is one. */
  const gripAt = useCallback(
    (
      clientX: number,
      clientY: number,
      target: EventTarget | null,
    ): Resize | null => {
      const cell = cellOf(target as Node | null)
      const table = cell ? tableOf(cell) : null
      const row = cell?.closest('tr') ?? null
      if (!cell || !table || !row) return null

      const box = cell.getBoundingClientRect()
      const column = columnOf(cell)

      /*
       * Both sides of the line, not just one.
       *
       * A border is shared: a pointer resting on it is inside one of the two
       * cells it separates, and which one comes down to a pixel and to which
       * way the hand came. Recognising only the cell's own right edge meant
       * the grip appeared or did not depending on that, which reads as a
       * boundary that sometimes cannot be dragged at all.
       */
      if (Math.abs(clientX - box.right) <= GRIP) {
        const boundary = column + spanOf(cell) - 1
        // The table's own right edge is not a boundary between two columns:
        // there is nothing on the other side to take the width from.
        if (boundary < columnCount(table) - 1) {
          return { kind: 'column', table, boundary }
        }
      }

      if (Math.abs(clientX - box.left) <= GRIP && column > 0) {
        return { kind: 'column', table, boundary: column - 1 }
      }

      if (Math.abs(clientY - box.bottom) <= GRIP) {
        return { kind: 'row', table, row }
      }

      if (Math.abs(clientY - box.top) <= GRIP) {
        // The line above this row belongs to the row above it.
        const above = row.previousElementSibling
        if (above instanceof HTMLTableRowElement) {
          return { kind: 'row', table, row: above }
        }
      }

      return null
    },
    [],
  )

  /*
   * Dragging is tracked on the window, not on the cell.
   *
   * A pointer dragging a boundary leaves the cell it started in almost at
   * once - that is what dragging a boundary is - and the cell would stop
   * hearing about it with the column stuck halfway.
   */
  useEffect(() => {
    if (!drag) return

    const move = (event: PointerEvent) => {
      if (drag.kind === 'column') {
        const box = drag.table.getBoundingClientRect()
        if (box.width <= 0) return

        const widths =
          widthsOf(drag.table) ?? evenWidths(columnCount(drag.table))
        const before = widths
          .slice(0, drag.boundary)
          .reduce((sum, width) => sum + width, 0)

        resizeColumn(
          drag.table,
          drag.boundary,
          (event.clientX - box.left) / box.width - before,
        )
        return
      }

      const perPixel = pointsPerPixel(drag.table)
      if (!perPixel) return

      setRowHeight(
        drag.row,
        (event.clientY - drag.row.getBoundingClientRect().top) * perPixel,
      )
    }

    const up = () => {
      setDrag(null)
      setGrip(null)
      // One entry for the whole drag, however many moves it took: undo puts
      // the boundary back where it was picked up, not one pixel back.
      const region = regionRef.current
      const before = dragBefore.current
      dragBefore.current = null
      if (region && before && region.innerHTML !== before.html) {
        history.record(before)
        syncHistory()
      }
      publish()
      syncToolbar()
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [drag, history, pointsPerPixel, publish, syncHistory, syncToolbar])

  /**
   * Put the caret back where it was, if a control took it away.
   *
   * A select, a file dialog, a text field on a toolbar: each takes the
   * focus, and by the time it hands something to insert the region has no
   * caret to insert at. The last one it had is put back first; failing
   * that, the end of the memo.
   */
  const restoreSelection = useCallback(() => {
    const region = regionRef.current
    const selection = document.getSelection()
    if (!region || !selection) return
    if (selection.rangeCount > 0 && region.contains(selection.anchorNode)) return

    selection.removeAllRanges()
    if (savedRange.current) {
      selection.addRange(savedRange.current)
    } else {
      const end = document.createRange()
      end.selectNodeContents(region)
      end.collapse(false)
      selection.addRange(end)
    }
  }, [])

  /**
   * Put a picture in at the caret, as a block of its own, sized as the
   * renderer would size it. Refused inside a table - a cell holds paragraphs
   * - and past the room a memo has for pictures, in the words the server
   * would use at the moment of submitting.
   */
  const insertPicture = useCallback(
    (src: string, widthPx: number) => {
      const region = regionRef.current
      if (!region || disabled) return

      restoreSelection()
      if (caretAt()) {
        setNotice(IN_A_TABLE)
        return
      }
      const refusal = pictureRoom(htmlToMemoBody(region).content, {
        count: 1,
        bytes: dataUriBytes(src),
      })
      if (refusal) {
        setNotice(refusal)
        return
      }

      setNotice(null)
      insert(imageHtml({ src, share: shareFor(widthPx, textWidth) }) + '<p><br></p>')
    },
    [caretAt, disabled, insert, restoreSelection, textWidth],
  )

  /** Files chosen or pasted: each made ready, then put in; the first refusal stops the rest. */
  const addPictures = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        const ready = await prepareImage(file)
        if (ready.refusal !== undefined) {
          setNotice(ready.refusal)
          return
        }
        insertPicture(ready.src, ready.width)
      }
    },
    [insertPicture],
  )

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      /*
       * Never the clipboard's own markup.
       *
       * Paste is the one route by which a whole styled document - a web page,
       * a Word file with its own fonts and classes, a spreadsheet - reaches
       * this region. The browser's default would put that markup straight
       * into the DOM. Instead the clipboard is read into memo nodes off in a
       * document of its own (see `utils/memoPaste`), and what is inserted
       * here is markup this file's own serialiser built from those nodes -
       * so nothing can reach the body but the node set, and text.
       */
      event.preventDefault()
      if (disabled) return

      // A picture on the clipboard - a screenshot, a photo copied from a
      // folder - comes as a file, and is made ready the way a chosen one is.
      const files = Array.from(event.clipboardData.files ?? []).filter(file =>
        (IMAGE_TYPES as readonly string[]).includes(file.type),
      )
      if (files.length > 0) {
        void addPictures(files)
        return
      }

      const reading = readClipboard(
        event.clipboardData.getData('text/html'),
        event.clipboardData.getData('text/plain'),
      )
      if (reading.refusal) {
        setNotice(reading.refusal)
        return
      }
      if (reading.blocks.length === 0) return
      setNotice(null)

      const at = caretAt()
      if (at) {
        const only = reading.blocks.length === 1 ? reading.blocks[0] : undefined

        /*
         * A table pasted into a table fills it from the caret's cell, the way
         * a block of cells pasted into a spreadsheet does. Inserting a table
         * inside a cell would nest one, which the template cannot draw.
         */
        if (only?.type === 'table') {
          const grid = cellGrid(only)
          const size = {
            rows: grid.length,
            columns: Math.max(0, ...grid.map(row => row.length)),
          }
          const rows = rowsOf(at.table)
          const refusal = tooLargeTable(
            Math.max(rows.length, rows.indexOf(at.row) + size.rows),
            Math.max(columnCount(at.table), columnOf(at.cell) + size.columns),
          )
          if (refusal) {
            setNotice(refusal)
            return
          }

          const region = regionRef.current
          const before = region ? snapshotOf(region) : null
          fillTableFrom(at.table, at.cell, size, (cell, row, column) => {
            cell.innerHTML = memoBodyToHtml({
              type: 'doc',
              content: grid[row]?.[column] ?? [],
            })
          })
          if (before) {
            history.record(before)
            syncHistory()
          }
          publish()
          syncToolbar()
          return
        }

        // A cell holds paragraphs and nothing else.
        insert(
          memoBodyToHtml({
            type: 'doc',
            content: paragraphsOnly(reading.blocks),
          }),
        )
        return
      }

      // A table at the very end of the region is a caret trap; the same
      // trailing paragraph the Table button leaves gives somewhere to go on.
      const last = reading.blocks[reading.blocks.length - 1]
      const trailing =
        last?.type === 'table' || last?.type === 'pageBreak' || last?.type === 'image'
          ? '<p><br></p>'
          : ''

      insert(memoBodyToHtml({ type: 'doc', content: reading.blocks }) + trailing)
    },
    [addPictures, caretAt, disabled, history, insert, publish, syncHistory, syncToolbar],
  )

  /**
   * Is an `@name` being typed under the caret? Open the directory under it
   * if so, and close it if not - asked after every keystroke and click.
   *
   * The list is placed from the caret's own rectangle, relative to the
   * shell, and kept inside the shell's width so it never runs off the sheet.
   */
  const checkMention = useCallback(() => {
    const region = regionRef.current
    const found = region && !disabled ? mentionAtCaret(region) : null

    if (!found) {
      suppressMention.current = null
      setMention(null)
      return
    }
    const suppressed = suppressMention.current
    if (suppressed && suppressed.node === found.node && suppressed.start === found.start) {
      return
    }
    suppressMention.current = null

    const selection = document.getSelection()
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    // Guarded because a test DOM has no layout and no rectangle to give.
    const caretBox =
      range && typeof range.getBoundingClientRect === 'function'
        ? range.getBoundingClientRect()
        : null
    const shellBox = shellRef.current?.getBoundingClientRect()
    const anchor =
      caretBox && shellBox
        ? {
            top: Math.round(caretBox.bottom - shellBox.top + 4),
            left: Math.round(
              Math.max(0, Math.min(caretBox.left - shellBox.left, shellBox.width - 320)),
            ),
          }
        : { top: 0, left: 0 }

    setMention(previous =>
      previous &&
      previous.query === found.query &&
      previous.anchor.top === anchor.top &&
      previous.anchor.left === anchor.left
        ? previous
        : { query: found.query, anchor },
    )
  }, [disabled])

  /**
   * Write the chosen person in, as text, over the `@name` that found them.
   *
   * Through `insertText` so it is one entry in the history and on the
   * browser's own stack alike. Text, never a reference: see `memoMention`.
   */
  const insertPerson = useCallback(
    (person: AssignableUser) => {
      const region = regionRef.current
      const found = region ? mentionAtCaret(region) : null
      setMention(null)
      if (!region || !found) return

      const selection = document.getSelection()
      if (!selection) return
      const range = document.createRange()
      range.setStart(found.node, found.start)
      range.setEnd(found.node, found.end)
      selection.removeAllRanges()
      selection.addRange(range)

      run('insertText', personLine(person))
    },
    [run],
  )

  /**
   * The conversions made as text is typed - a bullet from a dash, a curly
   * quote from a straight one, a dash from two hyphens - applied after the
   * keystroke has landed and before the body is published. Only ever for
   * the character just typed, so a quote arrived at by deleting back to it
   * is left as it was. See `utils/memoAutoformat`.
   */
  const autoformat = useCallback(() => {
    const region = regionRef.current
    const selection = document.getSelection()
    const typed = lastTyped.current
    lastTyped.current = { type: '', data: '' }
    if (disabled || typed.type !== 'insertText' || !region || !selection?.isCollapsed) return

    const node = selection.anchorNode
    if (!node || node.nodeType !== Node.TEXT_NODE || !region.contains(node)) return
    const text = node as Text
    const offset = selection.anchorOffset
    // A space typed at the end of a line lands as a non-breaking one, so
    // that the browser can show it; it is still the space that was typed.
    const landed = text.data.charAt(offset - 1).replace('\xa0', ' ')
    if (landed !== typed.data.replace('\xa0', ' ')) return

    const converted = convertTyped(text.data, offset)
    if (converted) {
      text.data = converted.text
      const caret = document.createRange()
      caret.setStart(text, converted.offset)
      caret.collapse(true)
      selection.removeAllRanges()
      selection.addRange(caret)
      return
    }

    // A marker at the start of a line, once the space after it lands: only
    // a paragraph of its own, not one inside a cell or a list.
    const block = text.parentElement?.closest('p')
    if (!block || block.parentElement !== region) return
    const marker = blockMarker(block.textContent ?? '')
    if (!marker) return

    /*
     * Convert first, with the caret where the typing left it, and clear the
     * marker after. Emptying the paragraph and putting the caret in it
     * first looked the same and was not: Chromium, asked for a list from a
     * caret in an empty block, nested the list inside the paragraph, and the
     * reader then took the whole list for one line of text.
     */
    const before = snapshotOf(region)
    try {
      if (marker.kind === 'bulletList') document.execCommand('insertUnorderedList')
      else if (marker.kind === 'orderedList') document.execCommand('insertOrderedList')
      else document.execCommand('formatBlock', false, marker.level === 1 ? 'h1' : 'h2')
    } catch {
      // Left as a paragraph, which is still one undo from the marker.
    }
    tidyBlocks(region)
    const anchor = document.getSelection()?.anchorNode ?? null
    const holder: HTMLElement =
      (anchor && anchor.nodeType === Node.ELEMENT_NODE
        ? (anchor as HTMLElement)
        : anchor?.parentElement
      )?.closest<HTMLElement>('li, h1, h2, p') ?? block
    holder.replaceChildren(document.createElement('br'))
    const caret = document.createRange()
    caret.setStart(holder, 0)
    caret.collapse(true)
    selection.removeAllRanges()
    selection.addRange(caret)
    history.record(before)
    syncHistory()
    endWord()
    syncToolbar()
  }, [disabled, endWord, history, syncHistory, syncToolbar])

  const handleInput = useCallback(() => {
    setNotice(null)
    autoformat()
    publish()
    checkMention()
  }, [autoformat, checkMention, publish])

  const toggleOutline = useCallback(() => {
    const region = regionRef.current
    setOutline(previous => (previous || !region ? null : outlineOf(region)))
  }, [])

  const jumpToHeading = useCallback(
    (entry: OutlineEntry) => {
      const region = regionRef.current
      setOutline(null)
      if (!region || !region.contains(entry.element)) return
      region.focus()
      caretToStartOf(entry.element)
      endWord()
      syncToolbar()
    },
    [endWord, syncToolbar],
  )

  const toggleFocus = useCallback(() => setFocusMode(previous => !previous), [])

  /** Set the whole memo in a face or at a size, and publish it so. */
  const changeSetting = useCallback(
    (patch: Partial<Required<MemoBodyAttrs>>) => {
      const region = regionRef.current
      if (!region || disabled) return
      const next = { ...setting, ...patch }
      setSetting(next)
      applyBodyAttrs(region, next)
      publish()
    },
    [disabled, publish, setting],
  )

  // The page behind focus mode does not scroll; the editor does.
  useEffect(() => {
    if (!focusMode) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [focusMode])

  const handleBlur = useCallback(() => {
    const region = regionRef.current
    const selection = document.getSelection()
    if (region && selection && selection.rangeCount > 0 && region.contains(selection.anchorNode)) {
      savedRange.current = selection.getRangeAt(0).cloneRange()
    }
    publish()
    setMention(null)
  }, [publish])

  /**
   * Copy a piece of standard wording into the memo at the caret.
   *
   * A copy: the memo owns the words from here on, and the clause may be
   * edited or archived without this memo changing. Inside a table cell the
   * wording lands as paragraphs, which is all a cell holds; elsewhere it
   * lands as the blocks it is, with somewhere to type after a table.
   */
  const insertWording = useCallback(
    (id: string) => {
      const clause = wording.find(entry => entry.id === id)
      const region = regionRef.current
      if (!clause || !region || disabled) return

      restoreSelection()

      const blocks = clause.body.content
      if (caretAt()) {
        insert(memoBodyToHtml({ type: 'doc', content: paragraphsOnly(blocks) }))
        return
      }

      const last = blocks[blocks.length - 1]
      const trailing =
        last?.type === 'table' || last?.type === 'pageBreak' || last?.type === 'image'
          ? '<p><br></p>'
          : ''
      insert(memoBodyToHtml({ type: 'doc', content: blocks }) + trailing)
    },
    [caretAt, disabled, insert, restoreSelection, wording],
  )

  /**
   * Change a picture, and publish only if anything changed - the same
   * contract `editTable` keeps.
   */
  const editPicture = useCallback(
    (figure: HTMLElement | null, change: (figure: HTMLElement) => boolean | void) => {
      const region = regionRef.current
      if (disabled || !region || !figure || !region.contains(figure)) return

      const before = snapshotOf(region)
      if (change(figure) === false) return

      history.record(before)
      syncHistory()
      publish()
      syncToolbar()
    },
    [disabled, history, publish, syncHistory, syncToolbar],
  )

  /** Take a picture out, leaving the caret where it was. */
  const removePicture = useCallback(
    (figure: HTMLElement | null) => {
      editPicture(figure, target => {
        const next = target.nextSibling
        target.remove()
        const selection = document.getSelection()
        if (selection && next) {
          const range = document.createRange()
          range.setStart(next, 0)
          range.collapse(true)
          selection.removeAllRanges()
          selection.addRange(range)
        }
      })
    },
    [editPicture],
  )

  const applyPicture = useCallback(
    (action: PictureAction) => {
      if (action === 'pictureRemove') {
        removePicture(picture)
        return
      }
      editPicture(picture, figure => {
        const current = shareOf(figure)
        const step = action === 'pictureLarger' ? SHARE_STEP : -SHARE_STEP
        const next = Math.min(1, Math.max(0.2, Number((current + step).toFixed(2))))
        if (next === current) return false
        setShare(figure, next)
      })
    },
    [editPicture, picture, removePicture],
  )

  /*
   * The description, typed into a field on the picture toolbar and written
   * straight onto the picture. One history entry for the whole of it,
   * recorded when the field is left, rather than one a keystroke.
   */
  const startDescribing = useCallback(() => {
    const region = regionRef.current
    altBefore.current = region ? snapshotOf(region) : null
  }, [])

  const describePicture = useCallback(
    (value: string) => {
      const region = regionRef.current
      const img = picture?.querySelector('img')
      if (!region || !img || disabled) return

      img.setAttribute('alt', value.slice(0, MEMO_BODY_LIMITS.imageAltChars))
      setPictureAlt(value)
      publish()
    },
    [disabled, picture, publish],
  )

  const endDescribing = useCallback(() => {
    const region = regionRef.current
    const before = altBefore.current
    altBefore.current = null
    if (region && before && region.innerHTML !== before.html) {
      history.record(before)
      syncHistory()
    }
  }, [history, syncHistory])

  /**
   * Open the find bar - on the words selected, if any are, as every editor
   * does - or bring the focus back to it when it is already open.
   */
  const openFind = useCallback(
    (focusOn: 'find' | 'replace') => {
      const region = regionRef.current
      const selection = document.getSelection()
      const selected =
        region && selection && !selection.isCollapsed && region.contains(selection.anchorNode)
          ? selection.toString()
          : ''
      const remembered = findRef.current ?? rememberedFind.current
      const query =
        selected && !selected.includes('\n') && selected.length <= 200
          ? selected
          : remembered.query

      updateFind({
        ...remembered,
        query,
        current: 0,
        focusOn,
        focusKey: (findRef.current?.focusKey ?? 0) + 1,
        announcement: null,
      })
    },
    [updateFind],
  )

  const changeFind = useCallback(
    (patch: Partial<FindState>) => {
      const state = findRef.current
      if (!state) return
      updateFind({ ...state, ...patch, announcement: null })
    },
    [updateFind],
  )

  const stepFind = useCallback(
    (delta: 1 | -1) => {
      const state = findRef.current
      const count = matchesRef.current.length
      if (!state || count === 0) return

      const next = (currentOf(state, count) + delta + count) % count
      updateFind({ ...state, current: next, announcement: null })
      reveal(matchesRef.current[next])
    },
    [updateFind],
  )

  /**
   * Write over the current match. One entry in the history, and the match
   * that followed takes its place as current - so pressing Replace down a
   * memo walks through it, as it does everywhere else.
   */
  const replaceCurrent = useCallback(() => {
    const state = findRef.current
    const region = regionRef.current
    if (!state || !region || disabled) return

    const ranges = matchesRef.current
    const range = ranges[currentOf(state, ranges.length)]
    if (!range) return

    const before = snapshotOf(region)
    replaceRange(range, state.replacement)
    tidy(region)
    history.record(before)
    syncHistory()
    endWord()

    findRef.current = { ...state, announcement: null }
    setFind(findRef.current)
    publish()
    reveal(matchesRef.current[currentOf(findRef.current, matchesRef.current.length)])
  }, [disabled, endWord, history, publish, syncHistory])

  /** Every match at once, as one entry in the history. */
  const replaceEvery = useCallback(() => {
    const state = findRef.current
    const region = regionRef.current
    if (!state || !region || disabled) return

    const before = snapshotOf(region)
    const replaced = replaceAll(region, state.query, state.replacement, {
      matchCase: state.matchCase,
      wholeWord: state.wholeWord,
    })
    if (replaced > 0) {
      history.record(before)
      syncHistory()
      endWord()
    }

    findRef.current = {
      ...state,
      current: 0,
      announcement: replaced === 0 ? 'No matches' : `Replaced ${replaced}`,
    }
    setFind(findRef.current)
    publish()
  }, [disabled, endWord, history, publish, syncHistory])

  /** Close the bar and leave the caret on the match that was current. */
  const closeFind = useCallback(() => {
    const state = findRef.current
    const region = regionRef.current
    const ranges = matchesRef.current
    const range = state ? ranges[currentOf(state, ranges.length)] : undefined

    if (state) {
      rememberedFind.current = {
        query: state.query,
        replacement: state.replacement,
        matchCase: state.matchCase,
        wholeWord: state.wholeWord,
      }
    }
    updateFind(null)
    if (!region) return

    region.focus()
    const selection = document.getSelection()
    if (range && selection) {
      selection.removeAllRanges()
      selection.addRange(range)
    }
    syncToolbar()
  }, [syncToolbar, updateFind])

  /**
   * Open the suggestions when the caret comes to rest in a flagged word,
   * and close them when it leaves. Asked after every click and key.
   */
  const syncSpellPopover = useCallback(() => {
    const region = regionRef.current
    const checker = checkerRef.current
    const selection = document.getSelection()
    const resting =
      region &&
      checker &&
      spellingRef.current.on &&
      selection?.isCollapsed &&
      region.contains(selection.anchorNode) &&
      Date.now() - lastTypedAt.current >= TYPING_MS
    if (!region || !checker || !selection || !resting) {
      setSpellPopover(null)
      return
    }

    const found = misspellingAt(
      misspelledRef.current,
      caretOffset(indexText(region), selection.anchorNode, selection.anchorOffset),
    )
    if (!found || spellSuppress.current === found.start) {
      setSpellPopover(null)
      return
    }
    spellSuppress.current = null

    const anchor = anchorFor(found.range, shellRef.current)
    const suggestions = checker.suggestions(found.word)
    setSpellPopover(previous =>
      previous && previous.start === found.start && previous.word === found.word
        ? previous
        : { word: found.word, suggestions, anchor, start: found.start },
    )
  }, [])

  /** A click moves the caret, which ends the word being typed. */
  const handleMouseUp = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      endWord()
      const region = regionRef.current
      if (region) selectPicture(region, event.target)
      syncToolbar()
      checkMention()
      syncSpellPopover()
    },
    [checkMention, endWord, syncSpellPopover, syncToolbar],
  )

  const handleKeyUp = useCallback(() => {
    syncToolbar()
    syncSpellPopover()
  }, [syncSpellPopover, syncToolbar])

  /** Act on what was chosen under a flagged word. */
  const chooseSpelling = useCallback(
    (choice: SpellingChoice) => {
      const open = spellPopover
      const checker = checkerRef.current
      const region = regionRef.current
      setSpellPopover(null)
      if (!open || !checker || !region || disabled) return

      const found = misspelledRef.current.find(entry => entry.start === open.start)

      if (choice.kind === 'replace') {
        if (!found) return
        const selection = document.getSelection()
        if (!selection) return
        selection.removeAllRanges()
        selection.addRange(found.range)
        lastTypedAt.current = 0
        run('insertText', choice.text)
        return
      }

      if (choice.kind === 'ignore') {
        checker.ignore(open.word)
        checkSpelling()
        return
      }

      if (!onAddWord) return
      onAddWord(open.word)
        .then(() => {
          checker.learn([open.word])
          checkSpelling()
        })
        .catch((error: unknown) => {
          setNotice(
            error instanceof Error && error.message
              ? error.message
              : 'The word could not be added to the dictionary.',
          )
        })
    },
    [checkSpelling, disabled, onAddWord, run, spellPopover],
  )

  /** The caret to the end of the next flagged word, round the end, with its suggestions. */
  const stepMisspelling = useCallback(() => {
    const region = regionRef.current
    const list = misspelledRef.current
    const selection = document.getSelection()
    if (!region || !selection || list.length === 0) return

    const at = region.contains(selection.anchorNode)
      ? caretOffset(indexText(region), selection.anchorNode, selection.anchorOffset)
      : null
    const next = list.find(entry => at === null || entry.start > at) ?? list[0]!

    region.focus()
    const caret = next.range.cloneRange()
    caret.collapse(false)
    selection.removeAllRanges()
    selection.addRange(caret)
    lastTypedAt.current = 0
    spellSuppress.current = null
    reveal(next.range)
    syncToolbar()
    syncSpellPopover()
  }, [syncSpellPopover, syncToolbar])

  const toggleSpelling = useCallback(() => {
    const next = { ...spellingRef.current, on: !spellingRef.current.on }
    spellingRef.current = next
    setSpelling(next)
    setSpellPopover(null)
    checkSpelling()
  }, [checkSpelling])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      /*
       * With the directory open under the caret, the arrows move through
       * it, Enter and Tab take the highlighted person, and Escape puts it
       * away. Every other key is typing, which narrows the list.
       */
      if (mention) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          mentionRef.current?.move(event.key === 'ArrowDown' ? 1 : -1)
          return
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const person = mentionRef.current?.pick() ?? null
          if (person) {
            event.preventDefault()
            insertPerson(person)
            return
          }
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          const found = regionRef.current ? mentionAtCaret(regionRef.current) : null
          suppressMention.current = found ? { node: found.node, start: found.start } : null
          setMention(null)
          return
        }
      }

      /*
       * With the suggestions open under the caret: the arrows move through
       * them, Enter and Tab take the highlighted one, Escape puts them away
       * and keeps them away for that word.
       */
      if (spellPopover) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          spellPopoverRef.current?.move(event.key === 'ArrowDown' ? 1 : -1)
          return
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const choice = spellPopoverRef.current?.pick() ?? null
          if (choice) {
            event.preventDefault()
            chooseSpelling(choice)
            return
          }
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          spellSuppress.current = spellPopover.start
          setSpellPopover(null)
          return
        }
      }

      // With the find bar open, Escape from the text closes it too.
      if (event.key === 'Escape' && findRef.current) {
        event.preventDefault()
        closeFind()
        return
      }
      if (event.key === 'Escape' && (outline || shortcutsOpen)) {
        event.preventDefault()
        setOutline(null)
        setShortcutsOpen(false)
        return
      }
      if (event.key === 'Escape' && focusMode) {
        event.preventDefault()
        setFocusMode(false)
        return
      }
      if (event.key === 'F7') {
        event.preventDefault()
        stepMisspelling()
        return
      }

      // A picture under the key goes, through the history, whatever the
      // engine would have done with a selected block it cannot edit.
      if (event.key === 'Backspace' || event.key === 'Delete') {
        const region = regionRef.current
        const selection = document.getSelection()
        const figure = region && selection ? pictureUnderKey(selection, event.key, region) : null
        if (figure) {
          event.preventDefault()
          removePicture(figure)
          return
        }
      }

      /*
       * Shift+Enter would insert a line break, and the memo body has no
       * hard-break node - the template has no way to draw one that is not
       * just a short paragraph. Making it an ordinary paragraph break means
       * the thing people habitually press does something sensible instead of
       * something that quietly disappears on the way to the PDF.
       */
      if (event.key === 'Enter' && event.shiftKey) {
        event.preventDefault()
        run('insertParagraph')
        return
      }

      /*
       * Undo and redo, by the keys everybody presses for them. Taken here,
       * before the browser's own handling, so that the row added a moment
       * ago is what comes back - the browser's stack never saw it.
       */
      const modifier = event.ctrlKey || event.metaKey

      /*
       * The toolbar, from the keyboard. By key position (`code`) where the
       * key is a digit, because Shift changes what `key` says a digit is.
       */
      if (modifier && event.altKey && !event.shiftKey) {
        const block =
          event.code === 'Digit0'
            ? 'p'
            : event.code === 'Digit1'
              ? 'h1'
              : event.code === 'Digit2'
                ? 'h2'
                : null
        if (block) {
          event.preventDefault()
          run('formatBlock', block)
          return
        }
        if (event.code === 'KeyT') {
          event.preventDefault()
          insertTable()
          return
        }
        if (event.code === 'KeyP') {
          event.preventDefault()
          fileInputRef.current?.click()
          return
        }
        if (event.code === 'KeyO') {
          event.preventDefault()
          toggleOutline()
          return
        }
      }
      if (modifier && event.shiftKey && !event.altKey) {
        if (event.code === 'Digit8') {
          event.preventDefault()
          run('insertUnorderedList')
          return
        }
        if (event.code === 'Digit7') {
          event.preventDefault()
          run('insertOrderedList')
          return
        }
        if (event.code === 'KeyF') {
          event.preventDefault()
          toggleFocus()
          return
        }
      }
      if (modifier && !event.altKey && !event.shiftKey) {
        if (event.key === 'Enter') {
          event.preventDefault()
          insert(`${pageBreakHtml()}<p><br></p>`)
          return
        }
        if (event.key === '/') {
          event.preventDefault()
          setShortcutsOpen(open => !open)
          return
        }
      }

      if (modifier && !event.altKey) {
        const key = event.key.toLowerCase()
        /*
         * Find and replace, by the keys everybody presses for them. The
         * browser's own find would search the page and could replace
         * nothing; this one is taken while the caret is in the memo.
         */
        if ((key === 'f' || key === 'h') && !event.shiftKey) {
          event.preventDefault()
          openFind(key === 'h' ? 'replace' : 'find')
          return
        }
        if (key === 'z') {
          event.preventDefault()
          if (event.shiftKey) redo()
          else undo()
          return
        }
        if (key === 'y') {
          event.preventDefault()
          redo()
          return
        }
      }

      // Moving the caret ends the word being typed, as it does in the browser.
      if (
        event.key.startsWith('Arrow') ||
        event.key === 'Home' ||
        event.key === 'End' ||
        event.key === 'PageUp' ||
        event.key === 'PageDown'
      ) {
        endWord()
      }
    },
    [
      chooseSpelling,
      closeFind,
      endWord,
      focusMode,
      insert,
      insertPerson,
      insertTable,
      mention,
      openFind,
      outline,
      redo,
      removePicture,
      run,
      shortcutsOpen,
      spellPopover,
      stepMisspelling,
      toggleFocus,
      toggleOutline,
      undo,
    ],
  )

  const overLimit = length > MEMO_BODY_LIMITS.totalChars

  const apply = useCallback(
    (action: EditorAction) => {
      switch (action) {
        case 'undo':
          return undo()
        case 'redo':
          return redo()
        case 'bold':
        case 'italic':
        case 'underline':
          return run(action)
        case 'paragraph':
          return run('formatBlock', 'p')
        case 'heading':
          return run('formatBlock', 'h1')
        case 'subheading':
          return run('formatBlock', 'h2')
        case 'bulletList':
          return run('insertUnorderedList')
        case 'orderedList':
          return run('insertOrderedList')
        case 'table':
          return insertTable()
        case 'pageBreak':
          return insert(`${pageBreakHtml()}<p><br></p>`)
        case 'find':
          return openFind('find')
        case 'spelling':
          return toggleSpelling()
        case 'spellingNext':
          return stepMisspelling()
        case 'outline':
          return toggleOutline()
        case 'focus':
          return toggleFocus()
        case 'shortcuts':
          return setShortcutsOpen(open => !open)
        case 'picture':
          // The file dialog; what is chosen arrives through `addPictures`.
          fileInputRef.current?.click()
          return
        case 'pictureSmaller':
        case 'pictureLarger':
        case 'pictureRemove':
          return applyPicture(action)
        default:
          return applyTable(action)
      }
    },
    [
      run,
      insert,
      insertTable,
      applyTable,
      applyPicture,
      undo,
      redo,
      openFind,
      toggleSpelling,
      stepMisspelling,
      toggleOutline,
      toggleFocus,
    ],
  )

  /** Smaller and Larger stop at the ends of the range the server accepts. */
  const pictureAllowed = (action: PictureAction): boolean => {
    if (!picture) return false
    const share = shareOf(picture)
    if (action === 'pictureSmaller') return share > 0.2
    if (action === 'pictureLarger') return share < 1
    return true
  }

  /** Undo and redo are offered only while there is something to do. */
  const enabled = (action: EditorAction): boolean => {
    if (action === 'undo') return historyState.canUndo
    if (action === 'redo') return historyState.canRedo
    if (action === 'spelling') return spelling.ready
    if (action === 'spellingNext') return spelling.ready && spelling.on && misspelledCount > 0
    return true
  }

  /**
   * Controls that could only do nothing are offered switched off.
   *
   * Removing the last row would have to take the whole table with it. Undo
   * would bring it back now, but a button that says "remove row" and
   * removes the table still does more than it says.
   */
  const allowed = (action: TableAction): boolean => {
    switch (action) {
      // Totalling needs a row under the heading as much as removing one does.
      case 'rowRemove':
      case 'columnTotal':
        return caret.rows > 1
      case 'columnRemove':
      case 'columnNarrower':
      case 'columnWider':
        return caret.columns > 1
      case 'cellSplit':
        return caret.merged
      case 'cellsMerge':
        return caret.mergeable
      default:
        return true
    }
  }

  const isActive = (action: EditorAction): boolean => {
    if (action === 'bold') return marks.bold
    if (action === 'italic') return marks.italic
    if (action === 'underline') return marks.underline
    if (action === 'paragraph') return block === 'p'
    if (action === 'heading') return block === 'h1'
    if (action === 'subheading') return block === 'h2'
    if (action === 'spelling') return spelling.on && spelling.ready
    if (action === 'outline') return outline !== null
    if (action === 'focus') return focusMode
    if (action === 'shortcuts') return shortcutsOpen
    return false
  }

  const spellingActive = spelling.on && spelling.ready

  return (
    /*
     * The shell is the editor's container for query units, so a row height
     * written in the memo's own points is the same fraction of the page on
     * screen as it is in the PDF - at whatever width the sheet is being
     * shown. Without it a row set to 40 points would look right on a wide
     * screen and too tall on a narrow one.
     */
    /*
     * `relative` gives way to the focus class rather than joining it: a
     * utility's `position` outranks a component class's, and the shell has
     * to be fixed to take the page. Fixed is a containing block too, so
     * what opens under the caret still sits where it should.
     */
    <div
      ref={shellRef}
      className={`memo-editor-shell space-y-2 ${focusMode ? 'memo-editor-shell-focus' : 'relative'}`}
    >
      <div
        role="toolbar"
        aria-label="Memo formatting"
        aria-controls={id}
        className="flex flex-wrap items-center gap-1 rounded-control border border-line bg-canvas p-1"
      >
        {TOOLBAR.map((section, sectionIndex) => (
          <div key={section.group} className="flex items-center gap-1">
            {sectionIndex > 0 && (
              <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-line" />
            )}
            {section.buttons.map(button => (
              <ToolbarButton
                key={button.label}
                label={button.action === 'focus' && focusMode ? 'Leave focus mode' : button.label}
                active={isActive(button.action)}
                disabled={disabled || !enabled(button.action)}
                onActivate={() => apply(button.action)}
              >
                {button.action === 'focus' && focusMode ? (
                  <Minimize2 size={15} aria-hidden="true" />
                ) : (
                  <button.icon size={15} aria-hidden="true" />
                )}
              </ToolbarButton>
            ))}
          </div>
        ))}

        {/*
          The face and the size, for the whole memo. Two selects, because
          the choices are words and numbers; what is chosen is drawn the
          same on the page.
        */}
        {typography && (
          <div className="flex items-center gap-1">
            <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-line" />
            <label htmlFor={fontId} className="sr-only">
              Memo font
            </label>
            <select
              id={fontId}
              value={setting.font}
              disabled={disabled}
              onChange={event => changeSetting({ font: event.target.value as MemoFont })}
              className="h-7.5 max-w-52 rounded-chip border border-line bg-surface px-2 text-meta text-content-muted transition-colors hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {MEMO_FONTS.map(font => (
                <option key={font.key} value={font.key}>
                  {font.label}
                </option>
              ))}
            </select>
            <label htmlFor={sizeId} className="sr-only">
              Memo text size
            </label>
            <select
              id={sizeId}
              value={setting.size}
              disabled={disabled}
              onChange={event => changeSetting({ size: Number(event.target.value) as MemoSize })}
              className="h-7.5 rounded-chip border border-line bg-surface px-2 text-meta text-content-muted transition-colors hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {MEMO_SIZES.map(size => (
                <option key={size} value={size}>
                  {size} pt
                </option>
              ))}
            </select>
          </div>
        )}

        {focusMode && (
          <span className="ml-auto text-meta text-content-subtle">Esc leaves focus mode</span>
        )}

        {/*
          The standard wording, as a select rather than another row of icons:
          the titles are words, and a list of words is what a select is for.
          Choosing one inserts it and the control goes back to its prompt.
        */}
        {wording.length > 0 && (
          <div className="flex items-center gap-1">
            <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-line" />
            <label htmlFor={wordingId} className="sr-only">
              Insert standard wording
            </label>
            <select
              id={wordingId}
              value=""
              disabled={disabled}
              onChange={event => insertWording(event.target.value)}
              className="h-7.5 max-w-56 rounded-chip border border-line bg-surface px-2 text-meta text-content-muted transition-colors hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">Insert wording…</option>
              {wording.map(entry => (
                <option key={entry.id} value={entry.id}>
                  {entry.title}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/*
        Shown only with the caret in a table, so that none of these is ever a
        control with nothing to act on. It is announced as its own toolbar
        rather than appended to the first: a screen reader reaching it is
        told what it belongs to.
      */}
      {caret.inside && (
        <div
          role="toolbar"
          aria-label="Table"
          aria-controls={id}
          className="flex flex-wrap items-center gap-1 rounded-control border border-line bg-canvas p-1"
        >
          {TABLE_TOOLBAR.map((section, sectionIndex) => (
            <div key={section.group} className="flex items-center gap-1">
              {sectionIndex > 0 && (
                <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-line" />
              )}
              {section.buttons.map(button => (
                <ToolbarButton
                  key={button.label}
                  label={button.label}
                  active={false}
                  disabled={disabled || !allowed(button.action)}
                  onActivate={() => apply(button.action)}
                >
                  <button.icon size={15} aria-hidden="true" />
                </ToolbarButton>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* The picture controls, with the selection on a picture. */}
      {picture && (
        <div
          role="toolbar"
          aria-label="Picture"
          aria-controls={id}
          className="flex flex-wrap items-center gap-1 rounded-control border border-line bg-canvas p-1"
        >
          {PICTURE_TOOLBAR.map(button => (
            <ToolbarButton
              key={button.label}
              label={button.label}
              active={false}
              disabled={disabled || !pictureAllowed(button.action)}
              onActivate={() => apply(button.action)}
            >
              <button.icon size={15} aria-hidden="true" />
            </ToolbarButton>
          ))}
          <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-line" />
          <label htmlFor={pictureAltId} className="sr-only">
            Picture description
          </label>
          <input
            id={pictureAltId}
            type="text"
            value={pictureAlt}
            placeholder="Describe the picture, for a reader who cannot see it"
            maxLength={MEMO_BODY_LIMITS.imageAltChars}
            disabled={disabled}
            onFocus={startDescribing}
            onBlur={endDescribing}
            onChange={event => describePicture(event.target.value)}
            className="h-7.5 w-80 max-w-full rounded-chip border border-line bg-surface px-2 text-meta text-content placeholder:text-content-subtle transition-colors hover:border-content-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
      )}

      {/*
        The file dialog behind the Picture button. Hidden rather than
        visually hidden: it is opened from the button, which is what a
        screen reader is offered.
      */}
      <input
        ref={fileInputRef}
        type="file"
        accept={IMAGE_TYPES.join(',')}
        multiple
        hidden
        tabIndex={-1}
        data-testid="memo-picture-file"
        onChange={event => {
          const chosen = Array.from(event.target.files ?? [])
          event.target.value = ''
          void addPictures(chosen)
        }}
      />

      {find && (
        <FindReplaceBar
          query={find.query}
          replacement={find.replacement}
          matchCase={find.matchCase}
          wholeWord={find.wholeWord}
          count={matchCount}
          current={currentOf(find, matchCount)}
          announcement={find.announcement}
          focusOn={find.focusOn}
          focusKey={find.focusKey}
          disabled={disabled}
          onQueryChange={query => changeFind({ query, current: 0 })}
          onReplacementChange={replacement => changeFind({ replacement })}
          onMatchCaseChange={matchCase => changeFind({ matchCase, current: 0 })}
          onWholeWordChange={wholeWord => changeFind({ wholeWord, current: 0 })}
          onNext={() => stepFind(1)}
          onPrevious={() => stepFind(-1)}
          onReplace={replaceCurrent}
          onReplaceAll={replaceEvery}
          onClose={closeFind}
        />
      )}

      {/* Anchors for what opens under the toolbars, at the top of the text. */}
      {(outline || shortcutsOpen) && (
        <div className="relative">
          {outline && (
            <OutlinePopover
              entries={outline}
              onJump={jumpToHeading}
              onClose={() => {
                setOutline(null)
                regionRef.current?.focus()
              }}
            />
          )}
          {shortcutsOpen && !outline && (
            <ShortcutsPanel
              onClose={() => {
                setShortcutsOpen(false)
                regionRef.current?.focus()
              }}
            />
          )}
        </div>
      )}

      <div
        id={id}
        ref={regionRef}
        role="textbox"
        aria-multiline="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-invalid={invalid || overLimit || undefined}
        aria-activedescendant={
          mention && mentionOption
            ? mentionOption
            : spellPopover && spellOption
              ? spellOption
              : undefined
        }
        contentEditable={!disabled}
        suppressContentEditableWarning
        /* The browser's own check stands in until the dictionary has loaded;
           two sets of underlines would say two different things. */
        spellCheck={!spellingActive}
        tabIndex={0}
        onInput={handleInput}
        onBlur={handleBlur}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onMouseUp={handleMouseUp}
        /*
         * Resizing by the cell's own edges, with no handles added to the
         * document. A handle inside a table in a contenteditable region is
         * something the caret can land in and somebody can delete; the edge
         * is already there, and is where a person reaches for it anyway.
         */
        onPointerMove={event => {
          if (drag || disabled) return
          setGrip(
            gripAt(event.clientX, event.clientY, event.target)?.kind ?? null,
          )
        }}
        onPointerDown={event => {
          if (disabled) return
          const hit = gripAt(event.clientX, event.clientY, event.target)
          if (!hit) return

          // Otherwise the press puts the caret in the cell and the browser
          // starts selecting text as the boundary is dragged.
          event.preventDefault()
          dragBefore.current = regionRef.current ? snapshotOf(regionRef.current) : null
          setDrag(hit)
        }}
        onPointerLeave={() => {
          if (!drag) setGrip(null)
        }}
        className={[
          'memo-editor',
          framed ? 'memo-editor-framed' : '',
          invalid || overLimit ? 'memo-editor-invalid' : '',
          grip === 'column' ? 'memo-editor-column-grip' : '',
          grip === 'row' ? 'memo-editor-row-grip' : '',
          drag ? 'memo-editor-resizing' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      />

      {mention && (
        <PersonMention
          ref={mentionRef}
          query={mention.query}
          anchor={mention.anchor}
          onPick={insertPerson}
          onActiveChange={setMentionOption}
        />
      )}

      {spellPopover && !mention && (
        <SpellingPopover
          ref={spellPopoverRef}
          word={spellPopover.word}
          suggestions={spellPopover.suggestions}
          anchor={spellPopover.anchor}
          canAdd={canAddWords && Boolean(onAddWord)}
          onChoose={chooseSpelling}
          onActiveChange={setSpellOption}
        />
      )}

      {spellingActive && misspelledCount > 0 && (
        <p className="text-meta text-content-subtle">
          {misspelledCount === 1
            ? '1 word the dictionary does not know'
            : `${misspelledCount} words the dictionary does not know`}
        </p>
      )}

      {notice && (
        <p role="status" className="text-meta text-danger-ink">
          {notice}
        </p>
      )}

      {/*
        A warning, not a refusal: a totals row with a rounded figure or one
        agreed elsewhere is still a memo somebody may mean to send. But it
        stays on the screen until the figures and the total agree again,
        because a signed document whose own table contradicts itself is
        the one mistake nothing downstream can put right.
      */}
      {stale.length > 0 && (
        <p role="status" className="text-meta text-warning-ink">
          {staleTotalsMessage(stale)}
        </p>
      )}

      <p
        className={`text-meta ${overLimit ? 'text-danger-ink' : 'text-content-subtle'}`}
        aria-live="polite"
      >
        {overLimit
          ? `${length.toLocaleString()} characters — the limit is ${MEMO_BODY_LIMITS.totalChars.toLocaleString()}. Attach the detail as a supporting document instead.`
          : `${length.toLocaleString()} characters`}
      </p>
    </div>
  )
}

function ToolbarButton({
  label,
  active,
  disabled,
  onActivate,
  children,
}: {
  label: string
  active: boolean
  disabled: boolean
  onActivate: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      /* Without this the region loses focus on mousedown and the command is
         applied to nothing - the classic rich-text toolbar bug. */
      onMouseDown={event => event.preventDefault()}
      onClick={onActivate}
      className={`flex h-7.5 w-7.5 items-center justify-center rounded-chip transition-colors
        ${active ? 'bg-accent-soft text-accent-ink' : 'text-content-muted hover:bg-sunken hover:text-content'}
        disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {children}
    </button>
  )
}
