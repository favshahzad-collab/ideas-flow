/**
 * The shape of a memo the template can draw.
 *
 * The body is the editor's own JSON, not HTML: the renderer walks a tree it
 * can predict instead of parsing markup, and there is no sanitisation surface
 * because there is no markup. Every node type here is one the renderer can
 * draw - if a node cannot be drawn it does not belong in this union, and the
 * validator rejects it rather than dropping it silently.
 */
import type { MemoFontFamily } from "./assets";
import type { PageSetup } from "./geometry";

/** Inline emphasis. Underline is drawn as a rule; the others are font picks. */
export type MemoMark = "bold" | "italic" | "underline";

export type MemoTextNode = {
  type: "text";
  text: string;
  marks?: { type: MemoMark }[];
};

export type MemoParagraphNode = {
  type: "paragraph";
  content?: MemoTextNode[];
};

/** Two levels, as the brief allows. `BACKGROUND:` and `Recommendation`. */
export type MemoHeadingNode = {
  type: "heading";
  attrs: { level: 1 | 2 };
  content?: MemoTextNode[];
};

export type MemoListItemNode = {
  type: "listItem";
  content: MemoParagraphNode[];
};

export type MemoListNode = {
  type: "bulletList" | "orderedList";
  content: MemoListItemNode[];
};

export type MemoTableCellNode = {
  type: "tableCell" | "tableHeader";
  attrs?: {
    /**
     * How many columns this cell covers. Absent, or 1, is one column.
     *
     * Horizontal only. A vertical merge has no honest drawing when the rows
     * it spans fall either side of a page break, and this table repeats its
     * header row precisely because it is expected to cross pages.
     */
    colspan?: number;
  };
  content?: MemoParagraphNode[];
};

export type MemoTableRowNode = {
  type: "tableRow";
  attrs?: {
    /**
     * How tall the row should be, in points - a minimum, never a maximum.
     *
     * A row somebody made taller for room to write in stays that tall; one
     * whose content outgrows it still grows, because a clipped cell loses a
     * figure off a document somebody signs.
     */
    height?: number;
  };
  content: MemoTableCellNode[];
};

export type MemoTableNode = {
  type: "table";
  attrs?: {
    /**
     * Column widths, as fractions of the text column.
     *
     * Fractions rather than points because the editor and the renderer
     * measure in different units - a sheet on screen is a scaled A4 - and a
     * fraction is the one number both agree on without either having to know
     * the other's size.
     *
     * Absent means "size the columns from what is in them", which is what
     * every table drew before widths existed and what most still do.
     */
    widths?: number[];
  };
  content: MemoTableRowNode[];
};

export type MemoPageBreakNode = { type: "pageBreak" };

/**
 * A picture, carried in the body as a `data:image/png;base64,` or
 * `data:image/jpeg;base64,` URI - so a version is complete in itself and
 * drawing it needs no store and no network.
 */
export type MemoImageNode = {
  type: "image";
  attrs: {
    src: string;
    /** What the picture shows, for a reader who cannot see it. Not drawn. */
    alt?: string;
    /**
     * How much of the text column the picture spans, as a fraction. Absent
     * means its own size at 96 pixels to the inch, never wider than the
     * column.
     */
    share?: number;
  };
};

export type MemoBlockNode =
  | MemoParagraphNode
  | MemoHeadingNode
  | MemoListNode
  | MemoTableNode
  | MemoImageNode
  | MemoPageBreakNode;

/** The sizes a memo may be set at, in points. Ten is what every memo was. */
export const MEMO_TEXT_SIZES = [9, 10, 11, 12] as const;
export type MemoTextSize = (typeof MEMO_TEXT_SIZES)[number];
export const DEFAULT_TEXT_SIZE: MemoTextSize = 10;

/**
 * How the whole memo is set. Absent, or absent fields, mean what every memo
 * filed before this existed was drawn in: Plus Jakarta Sans at ten points.
 * Kept on the body so a version carries its own setting and re-renders as
 * it was filed.
 */
export type MemoBodyAttrs = {
  font?: MemoFontFamily;
  size?: MemoTextSize;
};

export type MemoBody = {
  type: "doc";
  attrs?: MemoBodyAttrs;
  content: MemoBlockNode[];
};

/**
 * The header block. These are columns on the memo, not prose inside the body,
 * so they render the same way every time and stay queryable.
 */
export type MemoHeader = {
  to: string;
  from: string;
  subject: string;
  /**
   * The memo's own date. Also what the PDF's creation and modification dates
   * are pinned to - pdf-lib otherwise stamps the wall clock, and two renders
   * of one memo would then have different digests.
   */
  date: Date;
  reference?: string | null;
};

/**
 * Whose letterhead this is. Nothing here is hardcoded in the renderer, so a
 * second organisation - or a rebrand - is configuration.
 */
export type MemoBranding = {
  organisationName: string;
  /** PNG bytes. Omitted falls back to the organisation name set as text. */
  logo?: Buffer | null;
};

/**
 * One column of the printed signature strip at the foot of the memo.
 *
 * This is NOT the stamped signature an approver applies after a decision -
 * that stays with `pdfSignature.ts`. This is the ruled line with a name under
 * it that is printed on the memo before anyone has signed anything, exactly
 * as the paper form has always had.
 */
export type MemoSignatory = {
  name: string;
  designation?: string | null;
  /**
   * The office this person signs for, printed under their designation.
   *
   * A designation alone says what somebody does; it does not always say which
   * part of the organisation they did it for, and a memo that travels between
   * departments is read by people who do not know every job title in it.
   *
   * Optional, and absent on every memo filed before this existed - those keep
   * drawing exactly as they were filed.
   */
  department?: string | null;
  /**
   * How the caller recognises this column again in the returned slots.
   *
   * The renderer never interprets it - a user id, a step number, anything the
   * caller can map back. Without it the slots come back as an ordered list
   * that the caller has to re-derive the meaning of, and the ordering of the
   * strip is exactly the thing that changes when a chain is edited.
   */
  key?: string;
};

/**
 * Where one signatory's signature belongs on the finished page.
 *
 * The strip prints a ruled line with a name under it. This is the clear space
 * *above* that line - the place a signature has always gone on the paper form,
 * and the reason the strip exists at all.
 *
 * Coordinates are PDF points with a top-left origin, which is what the viewer
 * reports and what `SignaturePlacement` already carries, so a slot can be
 * handed to the signing path untranslated.
 */
/**
 * A note placed on the page rather than typed into the body.
 *
 * Coordinates are PDF points from the top-left of the page it names - the
 * same space `MemoSignatureSlot` reports and `SignaturePlacement` accepts, so
 * a viewer that can place a signature box can place one of these with no
 * conversion of its own.
 */
export type MemoNote = {
  /** 1-based, as `MemoSignatureSlot.page` is. */
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** What it says. Newlines are kept; the box clips what will not fit. */
  text: string;
};

export type MemoSignatureSlot = {
  /** Echoed from the signatory that produced it. */
  key?: string;
  /** The printed name under the line, so a caller can show what it belongs to. */
  name: string;
  /** 1-based, as `SignaturePlacement.signaturePage` is. */
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RenderMemoInput = {
  header: MemoHeader;
  /**
   * Notes placed on the page, drawn after the body has been laid out.
   *
   * Absent on a memo that has none, which is most of them - and on every memo
   * filed before notes existed, which must keep drawing exactly as it did.
   */
  notes?: MemoNote[];
  body: MemoBody;
  branding: MemoBranding;
  /**
   * Drawn left to right across the text width. The count comes from the
   * approval chain, so the strip is as wide as the chain is long rather than
   * a fixed four.
   */
  signatories: MemoSignatory[];
  /**
   * The paper and margins to draw on.
   *
   * Absent means the default page, which is what every memo filed before page
   * setup existed was drawn on - so an old version re-renders exactly as it
   * was filed rather than picking up whatever the setting says now. A filed
   * version records this only when it differs from the default; see
   * `lib/memoTemplate/geometry.ts`.
   */
  page?: PageSetup;
};
