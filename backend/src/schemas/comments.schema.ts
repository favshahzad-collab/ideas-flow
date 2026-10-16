import { z } from "zod";

export const createCommentSchema = z.object({
  body: z.object({
    comment: z
      .string()
      .trim()
      .min(1, "Comment is required")
      .max(2000),
  }),
});

export type CreateCommentInput =
  z.infer<typeof createCommentSchema>["body"];