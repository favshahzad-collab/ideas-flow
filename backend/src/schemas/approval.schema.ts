import { z } from "zod";

const documentIdParams = z.object({
  id: z.uuid("Invalid document id"),
});

/**
 * A sanity ceiling on the signature box, not a styling rule.
 *
 * The viewer sizes the box in PDF points against the page it was drawn on, so
 * a small initial is legitimately a few points wide and a full-width ink
 * stroke on A4 is legitimately about 595. Both are real signatures, so the
 * only thing worth refusing here is a number no page could ever hold; the fit
 * against the actual page box happens in the service, which is the only place
 * that knows how big this document's pages are.
 */
const MAX_SIGNATURE_DIMENSION = 2000;

/**
 * The drawn signature is a cropped canvas export - tens of kilobytes even on a
 * high-DPI screen. Every approval re-embeds the image and rewrites the stored
 * PDF in place, so an unbounded image grows the document once per approver and
 * everyone downloads the result for the rest of the chain's life.
 */
const MAX_SIGNATURE_IMAGE_CHARS = 2 * 1024 * 1024;

/**
 * PNG and JPEG are the only formats pdf-lib can embed. Without this, valid
 * base64 that is not an image at all - a truncated canvas export, most often -
 * travels all the way into pdf-lib and comes back as 500 "Internal server
 * error" at the moment somebody is trying to approve something.
 */
function hasImageHeader(base64: string): boolean {
  // Eight base64 characters decode to six bytes, which covers both magic
  // numbers, so a megabyte of image is never decoded just to identify it.
  const head = Buffer.from(base64.slice(0, 8), "base64");
  const isPng =
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  return isPng || isJpeg;
}

export const approveDocumentSchema = z.object({
  params: documentIdParams,
  body: z
    .object({
      /** When true, the server loads the actor's saved signature from storage. */
      useSavedSignature: z.boolean().optional(),
      /** PNG/JPEG from the sign-here canvas (raw base64 or data URL). */
      signatureImage: z
        .string()
        .max(
          MAX_SIGNATURE_IMAGE_CHARS,
          "Signature image is too large. Draw it again, or use your saved signature"
        )
        .optional(),
      /*
       * The signer ticked "this is my signature". Required: a signature
       * applied without the agreement in words is a picture on a page, and
       * the statement they agreed to is recorded with it in the ledger.
       */
      consent: z.literal(true, {
        error: "Tick the box to confirm this is your signature.",
      }),
      signaturePage: z.number().int().min(1, "Page number must be at least 1"),
      signatureX: z.number().min(0, "Signature must be placed on the page"),
      signatureY: z.number().min(0, "Signature must be placed on the page"),
      signatureWidth: z
        .number()
        .positive("Signature width must be positive")
        .max(MAX_SIGNATURE_DIMENSION, "Signature is too large for any page"),
      signatureHeight: z
        .number()
        .positive("Signature height must be positive")
        .max(MAX_SIGNATURE_DIMENSION, "Signature is too large for any page"),
    })
    .superRefine((data, ctx) => {
      if (data.useSavedSignature) {
        return;
      }

      if (!data.signatureImage?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Signature drawing is required",
          path: ["signatureImage"],
        });
        return;
      }

      const base64 = data.signatureImage.replace(/^data:image\/\w+;base64,/, "");
      if (base64.length === 0 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Signature must be a valid base64-encoded image",
          path: ["signatureImage"],
        });
        return;
      }

      if (!hasImageHeader(base64)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Signature image could not be read as a PNG or JPEG. Draw it again, or use your saved signature",
          path: ["signatureImage"],
        });
      }
    }),
});

// A rejection ends the workflow and is written to an append-only record the
// preparer has to act on. "No" without a reason is not an answer they can use,
// so the reason is required here as it already is for a revision request.
export const rejectDocumentSchema = z.object({
  params: documentIdParams,
  body: z.object({
    comment: z
      .string()
      .trim()
      .min(1, "A reason is required when rejecting a document")
      .max(2000, "Comment cannot exceed 2000 characters"),
  }),
});

export const requestRevisionSchema = z.object({
  params: documentIdParams,
  body: z.object({
    comment: z
      .string()
      .trim()
      .min(1, "Comment is required for revision requests")
      .max(2000, "Comment cannot exceed 2000 characters"),
  }),
});

export const skipWorkflowStepSchema = z.object({
  params: documentIdParams,
  body: z.object({
    reason: z
      .string()
      .trim()
      .min(1, "A reason is required to skip a workflow step")
      .max(2000, "Reason cannot exceed 2000 characters"),
  }),
});

/**
 * Moving a step to a different approver.
 *
 * The reason is required for the same argument that makes it required on a
 * skip, only stronger: this is the one action that changes who is entitled to
 * sign a memo after it was submitted, and "the chain says so" stops being an
 * answer the moment the chain can be edited. It goes on the memo's own thread
 * where everybody party to it can read it, not only into the trail.
 */
export const reassignStepSchema = z.object({
  params: documentIdParams,
  body: z.object({
    userId: z.uuid("Choose the person to hand this step to"),
    reason: z
      .string()
      .trim()
      .min(1, "A reason is required to move a step to a different approver")
      .max(2000, "Reason cannot exceed 2000 characters"),
    /*
     * Which step to move. Left out, it is the one the memo is sitting on -
     * which is what the first version of this could do and all it could do.
     *
     * A memo also stops at an approver who cannot act further down the chain,
     * and it stops just as completely; the only difference is that the
     * organisation had warning and no way to use it. The step already signed
     * is not on offer either way: the service refuses anything behind where
     * the memo has got to.
     */
    stepOrder: z
      .number()
      .int("Choose a step on this memo")
      .positive("Choose a step on this memo")
      .optional(),
  }),
});

/**
 * A reminder carries no body at all: who is waiting, who is holding it and
 * what it says are all the server's to decide. A free-text note would be a
 * message field with no thread behind it - the memo already has a comment
 * thread, which is where a question belongs.
 */
export const remindApproverSchema = z.object({
  params: documentIdParams,
});

/*
 * `consent` is required of a request - the route refuses a signature without
 * the tick - but optional to the services. Agreeing is something a person does
 * at the screen; a caller inside the process (a seed, a walkthrough, a test)
 * has nobody to agree, and the ledger entry it writes says so by recording no
 * statement. See `signedRecord`.
 */
type ConsentOptional<T> = Omit<T, "consent"> & { consent?: true };
export type ApproveDocumentInput = ConsentOptional<z.infer<typeof approveDocumentSchema>["body"]>;
export type RejectDocumentInput = z.infer<typeof rejectDocumentSchema>["body"];
export type RequestRevisionInput = z.infer<typeof requestRevisionSchema>["body"];
export type SkipWorkflowStepInput = z.infer<typeof skipWorkflowStepSchema>["body"];
export type ReassignStepInput = z.infer<typeof reassignStepSchema>["body"];
