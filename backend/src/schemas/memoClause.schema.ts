/**
 * What a piece of standard wording may be.
 *
 * The body is a memo body - the same schema, the same limits - because that
 * is what makes it insertable: a clause that the renderer could not draw
 * would be a clause that makes a memo unsubmittable at the moment of
 * signing, discovered by the preparer rather than by the administrator who
 * wrote it.
 */
import { z } from "zod";

import { memoBodySchema } from "./memoBody.schema";

const title = z
  .string()
  .trim()
  .min(1, "Give the wording a title, so a preparer can pick it out of the list.")
  .max(120, "A title cannot exceed 120 characters.");

const body = memoBodySchema.refine(
  (value) =>
    value.content.some(
      (block) => block.type !== "paragraph" || (block.content?.length ?? 0) > 0
    ),
  "Write the wording before saving it."
);

const clauseIdParams = z.object({
  id: z.uuid("That wording link is not valid. Open it from the list."),
});

export const createMemoClauseSchema = z.object({
  body: z.object({ title, body }).strict(),
});

export const updateMemoClauseSchema = z.object({
  params: clauseIdParams,
  body: z
    .object({
      title: title.optional(),
      body: body.optional(),
      /** True takes it off the preparer's list; false puts it back. */
      archived: z.boolean().optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.title !== undefined ||
        value.body !== undefined ||
        value.archived !== undefined,
      "Nothing to change."
    ),
});

export type CreateMemoClauseInput = z.infer<typeof createMemoClauseSchema>["body"];
export type UpdateMemoClauseInput = z.infer<typeof updateMemoClauseSchema>["body"];
