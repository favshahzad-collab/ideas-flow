/**
 * What a memo typed in the portal is made of.
 *
 * MIRRORS `backend/src/schemas/memoBody.schema.ts`, which is what actually
 * decides. Every node here is one the PDF template can draw, and the server
 * refuses anything else rather than dropping it - a body that saves cleanly
 * and then renders without the table somebody typed is worse than one that
 * refuses to save.
 *
 * So the editor's job is not to sanitise on the way out; it is to be
 * incapable of producing anything outside this set in the first place.
 */

export type MemoMark = 'bold' | 'italic' | 'underline'

export interface MemoTextNode {
  type: 'text'
  text: string
  marks?: { type: MemoMark }[]
}

export interface MemoParagraphNode {
  type: 'paragraph'
  content?: MemoTextNode[]
}

/** Two levels, because the template draws two. */
export interface MemoHeadingNode {
  type: 'heading'
  attrs: { level: 1 | 2 }
  content?: MemoTextNode[]
}

export interface MemoListItemNode {
  type: 'listItem'
  content: MemoParagraphNode[]
}

export interface MemoListNode {
  type: 'bulletList' | 'orderedList'
  content: MemoListItemNode[]
}

export interface MemoTableCellNode {
  type: 'tableCell' | 'tableHeader'
  attrs?: {
    /** How many columns this cell covers. Absent, or 1, is one column. */
    colspan?: number
  }
  content?: MemoParagraphNode[]
}

export interface MemoTableRowNode {
  type: 'tableRow'
  attrs?: {
    /** How tall the row should be, in points - a minimum, never a maximum. */
    height?: number
  }
  content: MemoTableCellNode[]
}

export interface MemoTableNode {
  type: 'table'
  attrs?: {
    /**
     * Column widths, as fractions of the text column.
     *
     * Fractions because the sheet on screen is a scaled A4 and the renderer
     * draws in points: a fraction is the one number both agree on without
     * either having to know the other's size. Absent means the renderer
     * sizes the columns from what is in them.
     */
    widths?: number[]
  }
  content: MemoTableRowNode[]
}

export interface MemoPageBreakNode {
  type: 'pageBreak'
}

/**
 * A picture, carried in the body as a `data:image/png;base64,` or
 * `data:image/jpeg;base64,` URI. In the body rather than in a store, so a
 * version is complete in itself - the same reason a colleague's name is
 * written in as text.
 */
export interface MemoImageNode {
  type: 'image'
  attrs: {
    src: string
    /** What the picture shows, for a reader who cannot see it. Not drawn. */
    alt?: string
    /**
     * How much of the text column the picture spans, as a fraction. Absent
     * means its own size, never wider than the column.
     */
    share?: number
  }
}

export type MemoBlockNode =
  | MemoParagraphNode
  | MemoHeadingNode
  | MemoListNode
  | MemoTableNode
  | MemoImageNode
  | MemoPageBreakNode

/**
 * The families a memo may be set in, mirroring the renderer's own list.
 *
 * `css` is what the editor shows the memo in on screen: the same faces,
 * served from `public/fonts/`, so what is typed looks like what is filed.
 */
export const MEMO_FONTS = [
  { key: 'jakarta', label: 'Plus Jakarta Sans', css: "'Plus Jakarta Sans', system-ui, sans-serif" },
  {
    key: 'serif',
    label: 'Liberation Serif (Times-like)',
    css: "'Liberation Serif', 'Times New Roman', Times, serif",
  },
  {
    key: 'sans',
    label: 'Liberation Sans (Arial-like)',
    css: "'Liberation Sans', Arial, Helvetica, sans-serif",
  },
] as const
export type MemoFont = (typeof MEMO_FONTS)[number]['key']
export const DEFAULT_MEMO_FONT: MemoFont = 'jakarta'

/** The sizes a memo may be set at, in points. Ten is what every memo was. */
export const MEMO_SIZES = [9, 10, 11, 12] as const
export type MemoSize = (typeof MEMO_SIZES)[number]
export const DEFAULT_MEMO_SIZE: MemoSize = 10

/**
 * How the whole memo is set. One family, one size, for the document: a run
 * of a different face is deliberately not a thing a memo can hold. Absent
 * means Plus Jakarta Sans at ten points, which every earlier memo was.
 */
export interface MemoBodyAttrs {
  font?: MemoFont
  size?: MemoSize
}

export interface MemoBody {
  type: 'doc'
  attrs?: MemoBodyAttrs
  content: MemoBlockNode[]
}

/** One kind of memo somebody can write, as the server's registry lists it. */
/**
 * The page a memo will be drawn on, resolved by the server.
 *
 * Carried with the memo types because the composer needs it to size the
 * column the preparer types into: that column has to be the one the memo is
 * actually filed at, or a table sized on screen is a different table on the
 * page. Setting it is an administrator's job on a different screen; knowing
 * it is everybody's.
 */
export interface MemoPageGeometry {
  paper: 'A4' | 'LETTER'
  marginLeft: number
  marginRight: number
  marginTop: number
  marginBottom: number
  width: number
  height: number
  textWidth: number
  textHeight: number
}

export interface MemoTypeDefinition {
  key: string
  label: string
  description: string
  defaultTemplateName?: string
  /** Headings to start from, so the preparer types into a memo not a blank page. */
  outlineHeadings: string[]
  /**
   * Whether writing this kind of memo means signing it.
   *
   * Resolved by the server: the memo type's own preference where it has one,
   * the organisation's policy otherwise. The client never works this out for
   * itself, because a screen that disagreed with the service would either ask
   * for a signature the submission refuses or omit one it requires.
   *
   * Optional on the wire so a client open across a deploy of the older server
   * keeps working; absent reads as true, which is how it has always behaved.
   */
  preparerSigns?: boolean
}

/**
 * Where one signatory's signature belongs on the drawn page.
 *
 * PDF points, top-left origin - the same space `PdfPlacement` uses, so a slot
 * can be handed to the signing editor untranslated.
 */
export interface MemoSignatureSlot {
  key?: string
  name: string
  page: number
  x: number
  y: number
  width: number
  height: number
}

/**
 * A note placed on the page rather than typed into the body.
 *
 * PDF points from the top-left of the page it names - the same space
 * `MemoSignatureSlot` uses, so the sheet that places one and the renderer
 * that draws it agree without either converting.
 */
export interface MemoNote {
  page: number
  x: number
  y: number
  width: number
  height: number
  text: string
}

export interface MemoPreviewResponse {
  /** The drawn memo, base64. */
  pdfBase64: string
  slots: MemoSignatureSlot[]
  pageCount: number
  /**
   * Whether submitting this memo means signing it.
   *
   * Comes back with the drawing, from the request that laid the strip out, so
   * the page and the instruction about the page cannot disagree. Absent reads
   * as true — how it has always behaved, and what an older server means.
   */
  preparerSigns?: boolean
}

/** Mirrors `MEMO_BODY_LIMITS` on the server, so the editor refuses first. */
export const MEMO_BODY_LIMITS = {
  textNodeChars: 8_000,
  totalChars: 120_000,
  blocks: 500,
  listItems: 200,
  tableRows: 400,
  tableColumns: 20,
  rowHeight: 600,
  images: 8,
  imageBytes: 400_000,
  imageTotalBytes: 1_500_000,
  imageAltChars: 300,
} as const
