import { z } from "zod";

/**
 * Notes placed on the page, as they arrive from a client.
 *
 * Bounded in every direction, because these are coordinates and lengths that
 * a request supplies and the renderer then draws with. An unbounded count is
 * a way to make the server draw for a very long time; an unbounded string is
 * a way to make it wrap one; a coordinate far outside the page is a note
 * nobody will ever see, filed on a document that cannot be corrected.
 *
 * A4 is 595.28 x 841.89pt. The bounds below are the page plus a little, not
 * the page exactly: a box dragged to the edge can end a fraction over it, and
 * refusing a submission over a rounding error would be its own defect. The
 * renderer clamps what it draws, so anything inside these bounds is safe.
 */
export const MEMO_NOTE_LIMITS = {
  /** Enough for a page dense with annotations, far short of a denial. */
  count: 40,
  chars: 2_000,
  /** The smallest box worth drawing: below this nothing legible fits. */
  minSize: 12,
  maxX: 620,
  maxY: 870,
  maxSize: 620,
  maxPage: 200,
} as const;

export const memoNoteSchema = z
  .object({
    page: z
      .number("A note has to say which page it is on.")
      .int("A page number is a whole number.")
      .min(1, "Page numbers start at 1.")
      .max(
        MEMO_NOTE_LIMITS.maxPage,
        `A memo cannot run past page ${MEMO_NOTE_LIMITS.maxPage}.`
      ),
    x: z
      .number("A note needs a position on the page.")
      .min(0, "A note cannot sit off the left edge of the page.")
      .max(MEMO_NOTE_LIMITS.maxX, "A note cannot sit off the right edge of the page."),
    y: z
      .number("A note needs a position on the page.")
      .min(0, "A note cannot sit above the top edge of the page.")
      .max(MEMO_NOTE_LIMITS.maxY, "A note cannot sit below the bottom edge of the page."),
    width: z
      .number("A note needs a width.")
      .min(MEMO_NOTE_LIMITS.minSize, "That note is too narrow to read.")
      .max(MEMO_NOTE_LIMITS.maxSize, "A note cannot be wider than the page."),
    height: z
      .number("A note needs a height.")
      .min(MEMO_NOTE_LIMITS.minSize, "That note is too short to read.")
      .max(MEMO_NOTE_LIMITS.maxSize, "A note cannot be taller than the page."),
    text: z
      .string("A note needs something written in it.")
      .max(
        MEMO_NOTE_LIMITS.chars,
        `A note cannot exceed ${MEMO_NOTE_LIMITS.chars} characters. Write it in the memo instead.`
      ),
  })
  .strict();

export const memoNotesSchema = z
  .array(memoNoteSchema)
  .max(
    MEMO_NOTE_LIMITS.count,
    `A memo cannot carry more than ${MEMO_NOTE_LIMITS.count} notes.`
  );

export type MemoNoteInput = z.infer<typeof memoNoteSchema>;

/**
 * Notes worth filing.
 *
 * An empty box is something somebody placed and then thought better of, and
 * the editor cannot always tell the difference between that and one they are
 * about to type in. Dropping them here rather than refusing the submission
 * keeps that from being an error message about a box the preparer has
 * already forgotten placing.
 */
export function usableNotes(notes: MemoNoteInput[] | undefined): MemoNoteInput[] {
  return (notes ?? [])
    .map((note) => ({ ...note, text: note.text.trim() }))
    .filter((note) => note.text.length > 0);
}
