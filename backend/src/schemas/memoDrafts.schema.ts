/**
 * What a draft may carry.
 *
 * A draft is incomplete by nature - somebody is still writing it - so almost
 * everything is optional and nothing about the approval chain is enforced
 * here. The rules that reject a chain with no final approver, or one naming
 * its own preparer, belong at submission, where refusing is useful. Refusing
 * an autosave because the preparer has picked only two of three approvers
 * would make the draft unsaveable precisely while it is being written.
 *
 * The body is the exception: it is validated against the allowed node set on
 * every save, so a draft can never hold something the template could not draw.
 */
import { z } from "zod";
import { memoNotesSchema } from "./memoNotes.schema";

import { memoBodySchema, memoDateSchema } from "./memoBody.schema";
import { isMemoType, memoTypeKeys } from "../lib/memoTypes";

const memoTypeSchema = z.string().refine(isMemoType, {
  message: `Unknown memo type. Available: ${memoTypeKeys().join(", ")}.`,
});

/**
 * The chain as picked so far. Shape only - who, in what order, in what
 * capacity - with no completeness rules.
 */
const draftChainStepSchema = z
  .object({
    userId: z.uuid("Invalid user id"),
    approvalType: z.enum(["REVIEWER", "APPROVER", "FINAL_APPROVER"]),
    slaDays: z.number().int().min(1).max(365).nullable().optional(),
  })
  .strict();

const draftFields = {
  memoType: memoTypeSchema.optional(),
  title: z.string().trim().max(500, "The subject cannot exceed 500 characters").optional(),
  memoTo: z.string().trim().max(200).optional(),
  memoFrom: z.string().trim().max(200).optional(),
  /** The date the memo will bear, as the preparer set it. */
  memoDate: memoDateSchema.optional(),
  body: memoBodySchema.optional(),
  chain: z.array(draftChainStepSchema).max(20).optional(),
  templateId: z.uuid("Invalid template id").nullable().optional(),
};

export const createMemoDraftSchema = z.object({
  body: z.object(draftFields),
});

export const updateMemoDraftSchema = z.object({
  params: z.object({ id: z.uuid("Invalid draft id") }),
  body: z.object(draftFields),
});

export const memoDraftIdSchema = z.object({
  params: z.object({ id: z.uuid("Invalid draft id") }),
});

export type CreateMemoDraftInput = z.infer<typeof createMemoDraftSchema>["body"];
export type UpdateMemoDraftInput = z.infer<typeof updateMemoDraftSchema>["body"];
export type DraftChainStepInput = z.infer<typeof draftChainStepSchema>;

/**
 * What the preview draws.
 *
 * The body is required and validated exactly as a draft's is - a preview of
 * something that could never be saved would be a picture of a memo nobody can
 * submit. Everything else is optional: the whole point of previewing is to
 * see the memo before it is finished, and a header field that has not been
 * filled in yet renders as a stated gap rather than refusing the request.
 */
export const previewMemoSchema = z.object({
  body: z
    .object({
      title: z.string().trim().max(500).optional(),
      memoTo: z.string().trim().max(200).optional(),
      memoFrom: z.string().trim().max(200).optional(),
      memoDate: memoDateSchema.optional(),
      /*
       * Which kind of memo is being drawn.
       *
       * It decides whether the preparer takes the first column of the printed
       * strip, so a preview that omitted it could lay the ruled lines out
       * differently from the page the submission files - and the signature
       * placed against the preview would land under the wrong name.
       */
      memoType: z.string().trim().max(64).optional(),
      /* Drawn on the preview exactly as filing will draw them. */
      notes: memoNotesSchema.optional(),
      body: memoBodySchema,
      chain: z.array(draftChainStepSchema).max(20).optional(),
      /*
       * The memo being rewritten, for a preview of a revision. The server
       * takes the header and the chain off that document, so the drawing the
       * preparer signs is laid out exactly like the one the resubmission
       * files.
       */
      documentId: z.uuid("Invalid document id").optional(),
    })
    .strict(),
});

export type PreviewMemoInput = z.infer<typeof previewMemoSchema>["body"];
