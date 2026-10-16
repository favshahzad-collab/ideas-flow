/**
 * What a typed memo's body is allowed to contain.
 *
 * Every node here is one the PDF template can draw. That is the whole rule:
 * the editor is restricted to this set, and anything outside it is refused
 * rather than dropped, because a body that saves cleanly and then renders
 * without the table somebody typed is worse than a body that refuses to save.
 *
 * `.strict()` throughout is deliberate. A node carrying extra keys is a node
 * from a different editor version or a hand-written request, and accepting
 * the parts we recognise while ignoring the rest is how a document ends up
 * meaning something other than what was written.
 */
import { z } from "zod";

import { assertEmbeddableImage, bytesOfImageDataUri } from "../lib/imageBytes";

/** Bounds. Generous for a memo, small enough that nothing here is a weapon. */
export const MEMO_BODY_LIMITS = {
  textNodeChars: 8_000,
  totalChars: 120_000,
  blocks: 500,
  listItems: 200,
  tableRows: 400,
  tableColumns: 20,
  /** A row cannot be asked to be taller than a page has room for. */
  rowHeight: 600,
  marksPerNode: 3,
  /**
   * Pictures travel inside the body, so the body's size is the memo's size:
   * a handful of photographs, each resized by the editor before it is
   * offered, and never a scanned file - that is a supporting document.
   */
  images: 8,
  imageBytes: 400_000,
  imageTotalBytes: 1_500_000,
  imageAltChars: 300,
} as const;

/** Base64 is four characters to three bytes; a little room for the header. */
const MAX_IMAGE_SRC_CHARS = Math.ceil((MEMO_BODY_LIMITS.imageBytes * 4) / 3) + 64;

const markSchema = z
  .object({
    type: z.enum(["bold", "italic", "underline"], {
      message: "Only bold, italic and underline are available in a memo.",
    }),
  })
  .strict();

const textNodeSchema = z
  .object({
    type: z.literal("text"),
    text: z
      .string()
      .max(
        MEMO_BODY_LIMITS.textNodeChars,
        `A single run of text cannot exceed ${MEMO_BODY_LIMITS.textNodeChars} characters.`
      ),
    marks: z.array(markSchema).max(MEMO_BODY_LIMITS.marksPerNode).optional(),
  })
  .strict();

const inlineContent = z.array(textNodeSchema).optional();

const paragraphSchema = z
  .object({
    type: z.literal("paragraph"),
    content: inlineContent,
  })
  .strict();

const headingSchema = z
  .object({
    type: z.literal("heading"),
    attrs: z
      .object({
        // Two levels, because the template draws two.
        level: z.union([z.literal(1), z.literal(2)], {
          message: "A memo has two heading levels.",
        }),
      })
      .strict(),
    content: inlineContent,
  })
  .strict();

const listItemSchema = z
  .object({
    type: z.literal("listItem"),
    content: z.array(paragraphSchema).min(1),
  })
  .strict();

const listSchema = z
  .object({
    type: z.enum(["bulletList", "orderedList"]),
    content: z.array(listItemSchema).max(MEMO_BODY_LIMITS.listItems),
  })
  .strict();

const tableCellSchema = z
  .object({
    type: z.enum(["tableCell", "tableHeader"]),
    attrs: z
      .object({
        /**
         * Merged cells, horizontally. There is no rowspan: a cell spanning
         * rows that fall either side of a page break has no honest drawing,
         * and this table repeats its header precisely because it is expected
         * to cross pages.
         */
        colspan: z
          .number()
          .int("A cell covers a whole number of columns.")
          .min(1)
          .max(MEMO_BODY_LIMITS.tableColumns)
          .optional(),
      })
      .strict()
      .optional(),
    content: z.array(paragraphSchema).optional(),
  })
  .strict();

const tableRowSchema = z
  .object({
    type: z.literal("tableRow"),
    attrs: z
      .object({
        /** A minimum, in points. Content needing more still gets more. */
        height: z
          .number()
          .min(0)
          .max(
            MEMO_BODY_LIMITS.rowHeight,
            `A table row cannot be taller than ${MEMO_BODY_LIMITS.rowHeight} points; a page has no room for one.`
          )
          .optional(),
      })
      .strict()
      .optional(),
    content: z.array(tableCellSchema).max(MEMO_BODY_LIMITS.tableColumns),
  })
  .strict();

/** The columns a row covers, which is not the number of cells it holds. */
function rowSpan(row: z.infer<typeof tableRowSchema>): number {
  return row.content.reduce(
    (total, cell) => total + (cell.attrs?.colspan ?? 1),
    0
  );
}

const tableSchema = z
  .object({
    type: z.literal("table"),
    attrs: z
      .object({
        /**
         * Column widths as fractions of the text column.
         *
         * Fractions, because the editor's sheet is a scaled A4 and the
         * renderer draws in points - a fraction is the one number both agree
         * on. They are normalised when drawn, so they need not sum to
         * exactly one; floating point would never let them.
         */
        widths: z
          .array(
            z
              .number()
              .positive("A column has to have some width.")
              .max(1, "A column width is a fraction of the table's width.")
          )
          .max(MEMO_BODY_LIMITS.tableColumns)
          .optional(),
      })
      .strict()
      .optional(),
    content: z.array(tableRowSchema).max(MEMO_BODY_LIMITS.tableRows),
  })
  .strict()
  .superRefine((table, ctx) => {
    // A ragged table is drawable but not readable: the columns stop lining
    // up with their headers, and the figures under them stop meaning what
    // the header says. Counted by span, so a merged cell covering three
    // columns counts as three rather than as one short row.
    const spans = new Set(table.content.map(rowSpan));

    if (spans.size > 1) {
      ctx.addIssue({
        code: "custom",
        message:
          "Every row of a table must cover the same number of columns. Add or remove cells so the columns line up.",
      });
    }

    /*
     * Widths that no longer describe this table are refused, not dropped.
     *
     * A mismatch means a column was added or taken away after the widths
     * were set. Drawing it anyway would need a guess at which column the
     * missing width belonged to, and a wrong guess puts the figures under
     * the wrong headings on a document somebody signs.
     */
    const widths = table.attrs?.widths;
    const columns = table.content.length > 0 ? rowSpan(table.content[0]) : 0;

    if (widths && spans.size === 1 && widths.length !== columns) {
      ctx.addIssue({
        code: "custom",
        path: ["attrs", "widths"],
        message: `This table has ${columns} columns but ${widths.length} column widths. Resize a column again, or remove the widths, so the two agree.`,
      });
    }
  });

const pageBreakSchema = z
  .object({ type: z.literal("pageBreak") })
  .strict();

const TOO_LARGE_IMAGE = (bytes: number): string =>
  `A picture in the memo is ${Math.round(bytes / 1024)} KB; a memo picture can be ${Math.round(MEMO_BODY_LIMITS.imageBytes / 1024)} KB. Attach it as a supporting document instead.`;

/**
 * A picture, carried in the body as a data URI.
 *
 * In the body rather than in a store, so that a version is complete in
 * itself - the same reason a colleague's name is written in as text. The
 * bytes are walked before anything decodes them, for the reason
 * `imageBytes` gives: pdf-lib decodes on the thread that serves every
 * request, and a body is something any signed-in account can send.
 */
const imageSchema = z
  .object({
    type: z.literal("image"),
    attrs: z
      .object({
        src: z
          .string()
          .max(MAX_IMAGE_SRC_CHARS, TOO_LARGE_IMAGE(MEMO_BODY_LIMITS.imageBytes + 1)),
        /** What the picture shows, for a reader who cannot see it. */
        alt: z.string().trim().max(MEMO_BODY_LIMITS.imageAltChars).optional(),
        /**
         * How much of the text column the picture spans, as a fraction.
         * Absent means its own size, and never wider than the column.
         */
        share: z
          .number()
          .min(0.2, "A picture cannot be narrower than a fifth of the column.")
          .max(1, "A picture cannot be wider than the column.")
          .optional(),
      })
      .strict()
      .superRefine((attrs, ctx) => {
        const bytes = bytesOfImageDataUri(attrs.src);
        if (!bytes) {
          ctx.addIssue({
            code: "custom",
            path: ["src"],
            message:
              "A picture in a memo is carried in the memo itself, as a PNG or a JPEG. Take it out and add it again from the toolbar.",
          });
          return;
        }
        if (bytes.length > MEMO_BODY_LIMITS.imageBytes) {
          ctx.addIssue({ code: "custom", path: ["src"], message: TOO_LARGE_IMAGE(bytes.length) });
          return;
        }
        try {
          assertEmbeddableImage(
            bytes,
            "A picture in the memo",
            "Take it out and add it again as a PNG or a JPEG."
          );
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            path: ["src"],
            message:
              error instanceof Error ? error.message : "A picture in the memo could not be read.",
          });
        }
      }),
  })
  .strict();

/**
 * Named so the failure reads as a sentence rather than as
 * "Invalid discriminator value, expected paragraph | heading | ...".
 */
const blockSchema = z.discriminatedUnion(
  "type",
  [
    paragraphSchema,
    headingSchema,
    listSchema,
    tableSchema,
    imageSchema,
    pageBreakSchema,
  ],
  {
    message:
      "A memo can contain paragraphs, headings, bullet and numbered lists, tables, pictures and page breaks. Anything else has to be removed before it can be saved.",
  }
);

function countCharacters(blocks: z.infer<typeof blockSchema>[]): number {
  let total = 0;

  const walk = (nodes: { text?: string; content?: unknown[] }[]): void => {
    for (const node of nodes) {
      if (typeof node.text === "string") total += node.text.length;
      if (Array.isArray(node.content)) {
        walk(node.content as { text?: string; content?: unknown[] }[]);
      }
    }
  };

  walk(blocks as unknown as { text?: string; content?: unknown[] }[]);
  return total;
}

/**
 * How the whole memo is set: one family, one size, for the document. A run
 * of a different size or face is deliberately not a thing a memo can hold.
 */
const bodyAttrsSchema = z
  .object({
    font: z
      .enum(["jakarta", "serif", "sans"], {
        message:
          "A memo can be set in Plus Jakarta Sans, Liberation Serif or Liberation Sans.",
      })
      .optional(),
    size: z
      .union([z.literal(9), z.literal(10), z.literal(11), z.literal(12)], {
        message: "A memo can be set at 9, 10, 11 or 12 points.",
      })
      .optional(),
  })
  .strict();

export const memoBodySchema = z
  .object({
    type: z.literal("doc", {
      message: "The memo body must be a document.",
    }),
    attrs: bodyAttrsSchema.optional(),
    content: z
      .array(blockSchema)
      .max(
        MEMO_BODY_LIMITS.blocks,
        `A memo cannot contain more than ${MEMO_BODY_LIMITS.blocks} blocks.`
      ),
  })
  .strict()
  .superRefine((body, ctx) => {
    const characters = countCharacters(body.content);

    if (characters > MEMO_BODY_LIMITS.totalChars) {
      ctx.addIssue({
        code: "custom",
        message: `This memo is ${characters.toLocaleString()} characters long; the limit is ${MEMO_BODY_LIMITS.totalChars.toLocaleString()}. Attach the detail as a supporting document instead.`,
        path: ["content"],
      });
    }

    // Pictures are bounded twice: each one above, and all of them here,
    // because eight pictures at the limit each would be a body nothing
    // downstream expects to carry.
    const images = body.content.filter((block) => block.type === "image");
    if (images.length > MEMO_BODY_LIMITS.images) {
      ctx.addIssue({
        code: "custom",
        message: `This memo has ${images.length} pictures; a memo can carry ${MEMO_BODY_LIMITS.images}. Attach the rest as supporting documents instead.`,
        path: ["content"],
      });
    }
    const imageBytes = images.reduce(
      (total, block) => total + (bytesOfImageDataUri(block.attrs.src)?.length ?? 0),
      0
    );
    if (imageBytes > MEMO_BODY_LIMITS.imageTotalBytes) {
      ctx.addIssue({
        code: "custom",
        message: `The pictures in this memo come to ${Math.round(imageBytes / 1024)} KB together; a memo can carry ${Math.round(MEMO_BODY_LIMITS.imageTotalBytes / 1024)} KB of pictures. Attach some as supporting documents instead.`,
        path: ["content"],
      });
    }
  });

export type MemoBodyInput = z.infer<typeof memoBodySchema>;

/** True when the body would put no visible text on the page. */
export function memoBodyIsEmpty(body: MemoBodyInput): boolean {
  return countCharacters(body.content) === 0;
}

export const memoHeaderFieldsSchema = z.object({
  memoTo: z
    .string()
    .trim()
    .min(1, "Say who the memo is addressed to.")
    .max(200, "The addressee cannot exceed 200 characters."),
  memoFrom: z
    .string()
    .trim()
    .min(1, "Say which department the memo is from.")
    .max(200, "The sender cannot exceed 200 characters."),
});

/**
 * The date the memo bears, as `2026-08-06`.
 *
 * A calendar date and not a timestamp, because that is what a memo carries:
 * nobody dates one to the minute, and the header prints "August 06, 2026".
 * It travels as a plain string so that no timezone is applied on the way -
 * a memo dated the 6th in Karachi must not be filed as the 5th because a
 * server in another zone parsed it as midnight UTC.
 *
 * The range is deliberately wide rather than "not in the future": memos are
 * genuinely backdated to the day they were written, and a memo prepared for
 * a board meeting next week is dated next week.
 */
export const memoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Give the memo's date as YYYY-MM-DD.")
  .refine(
    (value) => {
      const [year, month, day] = value.split("-").map(Number) as [
        number,
        number,
        number,
      ];
      if (year < 1900 || year > 2999) return false;
      const parsed = new Date(Date.UTC(year, month - 1, day));
      // Round-trip, so 2026-02-31 is refused rather than sliding to March.
      return (
        parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month - 1 &&
        parsed.getUTCDate() === day
      );
    },
    { message: "That is not a date." }
  );

/** The stored date as the renderer wants it: midnight UTC on that day. */
export function memoDateToUtc(value: string): Date {
  const [year, month, day] = value.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(year, month - 1, day));
}

/** And back, for handing a stored date to a client. */
export function memoDateToString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Today, with no clock on it.
 *
 * What a memo carrying no date of its own is dated. Date-only because the
 * PDF's own dates are pinned to it: with a time on them, two renders seconds
 * apart differ, and the preview a preparer placed their signature against
 * would not be the drawing that gets filed.
 */
export function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}
