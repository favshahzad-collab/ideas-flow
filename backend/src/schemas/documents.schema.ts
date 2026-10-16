import { z } from "zod";
import { isMemoType, memoTypeKeys } from "../lib/memoTypes";
import {
  memoBodyIsEmpty,
  memoBodySchema,
  memoDateSchema,
  memoHeaderFieldsSchema,
} from "./memoBody.schema";
import { memoNotesSchema } from "./memoNotes.schema";
import { ApprovalType, DocumentStatus } from "../generated/prisma/browser";
import { findApprovalChainIssues } from "../lib/approvalChain";

/**
 * One page of documents, not one page of the corpus.
 *
 * `MAX` is the largest page the query string may ask for; `DEFAULT` is what a
 * caller that pages without saying how many gets. Both live beside the schema
 * so the number zod refuses and the number the service clamps to cannot drift
 * apart and start disagreeing about what a page is.
 */
export const DOCUMENTS_DEFAULT_LIMIT = 25;
export const DOCUMENTS_MAX_LIMIT = 100;

/**
 * The memo reference as a person quotes it: `MEMO-2026-0043`. The sequence
 * restarts every January, so the year has to be part of it.
 *
 * The format lives beside the schema rather than in the service because more
 * than one place has to agree on it: the service mints it, the list searches
 * for it, and anyone matching it back has to recognise the same shape. A
 * second spelling of the format somewhere else is how one memo ends up with
 * two references, and a reference nobody can look up is worse than none -
 * it is already written on the paper file by then.
 */
export const MEMO_REFERENCE_PREFIX = "MEMO";
export const MEMO_REFERENCE_SEQUENCE_DIGITS = 4;
export const MEMO_REFERENCE_PATTERN = /^MEMO-\d{4}-\d{4,}$/;

/** Everything before the sequence, for a given year: `MEMO-2026-`. */
export function memoReferenceYearPrefix(year: number): string {
  return `${MEMO_REFERENCE_PREFIX}-${year}-`;
}

/**
 * `MEMO-2026-0043` for the forty-third memo of 2026.
 *
 * A year that gets past 9999 memos grows a fifth digit rather than wrapping:
 * the column is unique, so wrapping would refuse a real submission, and a
 * reference that repeats one already cited on a file is worse still.
 */
export function formatMemoReference(year: number, sequence: number): string {
  return `${memoReferenceYearPrefix(year)}${String(sequence).padStart(
    MEMO_REFERENCE_SEQUENCE_DIGITS,
    "0"
  )}`;
}

/** The orders the list can be asked for; absent means most recent activity first. */
export const DOCUMENT_SORTS = [
  "newest",
  "oldest",
  "recently_updated",
  "least_recently_updated",
] as const;

export type DocumentSort = (typeof DOCUMENT_SORTS)[number];

// A path id that reaches Prisma unchecked is not a 404: the driver rejects a
// malformed uuid with an error the handler cannot recognise, so a stale
// bookmark or a link that lost a character tells the reader the system broke
// rather than that the document is no longer there.
const documentIdParams = z.object({
  id: z.uuid(
    "That document link is not valid. Open the document from your list."
  ),
});

export const documentIdParamsSchema = z.object({
  params: documentIdParams,
});

/** Withdrawing or cancelling a memo: always with a reason, for the record. */
export const withdrawDocumentSchema = z.object({
  params: documentIdParams,
  body: z
    .object({
      reason: z
        .string()
        .trim()
        .min(1, "Say why, so the record shows it.")
        .max(1000, "Keep the reason under 1000 characters."),
    })
    .strict(),
});

/**
 * Serving a memo's bytes, and why.
 *
 * The same route answers the viewer on screen, the page thumbnails, the sign
 * dialog, Download and Print - and the audit trail has to tell reading a memo
 * apart from taking a copy of it away. Only the caller knows which it is, so
 * the caller says.
 *
 * Absent means `download`, which is what every row written before this said.
 * A caller that has not been taught to declare itself is recorded the way it
 * always was, rather than being quietly downgraded to a view.
 */
export const documentFileSchema = z.object({
  params: documentIdParams,
  query: z.object({
    reason: z
      .enum(["view", "download"], "That is not a way to open a memo.")
      .optional(),
  }),
});

export const supportingDocumentFileSchema = z.object({
  params: documentIdParams.extend({
    attachmentId: z.uuid(
      "That attachment link is not valid. Open the document and pick the attachment again."
    ),
  }),
});

const DOCUMENT_STATUSES = Object.values(DocumentStatus);

/**
 * Status filtering speaks the database's vocabulary, not the screen's.
 *
 * The documents table splits PENDING_REVIEW into "pending review" and
 * "pending approval" from whichever step the workflow is sitting on, and that
 * is not a value any column holds. The split stays in the browser, and asking
 * for one of those two words is refused by name rather than quietly answered
 * with the wrong half of the pending pile.
 */
const documentStatusFilter = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((part) => part.trim().toUpperCase())
      .filter(Boolean)
  )
  .superRefine((values, ctx) => {
    for (const value of values) {
      if (!(DOCUMENT_STATUSES as string[]).includes(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Filter by status using one or more of ${DOCUMENT_STATUSES.join(
            ", "
          )}, separated by commas.`,
        });
      }
    }
  })
  .transform((values) => values as DocumentStatus[]);

/**
 * The document list: searched, filtered, sorted and paged by the server.
 *
 * Every parameter is optional and absence is load-bearing. A request with no
 * query string has to answer with what it answered before this schema
 * existed - every document the caller may see, most recent activity first -
 * because the dashboard's KPI row, the approval queue's tab counts and the
 * command palette are all still computed in the browser over the whole list.
 * A default page size applied here would silently shrink numbers people read
 * as totals.
 */
export const listDocumentsSchema = z.object({
  query: z.object({
    /** Free-text match on title, description or the preparer's name. */
    q: z
      .string()
      .trim()
      .max(200, "Shorten the search to 200 characters or fewer.")
      .optional(),
    status: documentStatusFilter.optional(),
    sort: z
      .enum(DOCUMENT_SORTS, {
        error: `Sort by one of ${DOCUMENT_SORTS.join(", ")}.`,
      })
      .optional(),
    limit: z.coerce
      .number({ error: "Ask for a whole number of documents." })
      .int("Ask for a whole number of documents.")
      .min(1, "Ask for at least one document.")
      .max(
        DOCUMENTS_MAX_LIMIT,
        `Ask for at most ${DOCUMENTS_MAX_LIMIT} documents at a time.`
      )
      .optional(),
    offset: z.coerce
      .number({ error: "Start the page a whole number of documents in." })
      .int("Start the page a whole number of documents in.")
      .min(0, "A page cannot start before the first document.")
      .optional(),
  }),
});

export const approvalChainStepSchema = z.object({
  userId: z.uuid("Invalid user ID"),
  approvalType: z.nativeEnum(ApprovalType),
  /**
   * Working days this approver is given once the memo reaches them.
   *
   * Optional, and optional all the way down: omit it and the step falls back
   * to `SLA_DEFAULT_DAYS`, and with that unset the step simply has no
   * deadline. A deadline is a commitment an organisation makes to itself, so
   * nothing here invents one - the queue goes on showing age, which is true.
   */
  slaDays: z.coerce
    .number()
    .int("A deadline is a whole number of working days.")
    .min(1, "A deadline of less than a day is not a deadline.")
    .max(365, "A deadline over a year away is not one either.")
    .optional(),
});

// The rules themselves live in lib/approvalChain so the service can apply the
// same ones to a chain compiled from a workflow template, which never passes
// through this schema.
const approvalChainRefine = (
  steps: z.infer<typeof approvalChainStepSchema>[],
  ctx: z.RefinementCtx
) => {
  for (const message of findApprovalChainIssues(steps)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  }
};

/** Preparer must sign the PDF before the document enters the approval chain. */
export const preparerSignatureSchema = z
  .object(
    {
      useSavedSignature: z.boolean().optional(),
      signatureImage: z.string().optional(),
      /*
       * The signer ticked "this is my signature". Required: a signature
       * applied without the agreement in words is a picture on a page, and
       * the statement they agreed to is recorded with it in the ledger.
       */
      consent: z.literal(true, {
        error: "Tick the box to confirm this is your signature.",
      }),
      signaturePage: z.number().int().min(1, "Page number must be at least 1"),
      signatureX: z.number(),
      signatureY: z.number(),
      signatureWidth: z.number().positive("Signature width must be positive"),
      signatureHeight: z.number().positive("Signature height must be positive"),
    },
    {
      // The signature travels as a JSON string inside a multipart form, so the
      // whole part can be absent where a JSON body could only get it wrong.
      // Zod's own "expected object, received undefined" names nothing the
      // preparer can go and fix; this does.
      error: "Sign the document before submitting it.",
    }
  )
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
    }
  });

export const createDocumentSchema = z.object({
  body: z
    .object({
      title: z.string().trim().min(1, "Title is required").max(500, "Title cannot exceed 500 characters"),
      description: z.string().trim().max(5000, "Description cannot exceed 5000 characters").optional().or(z.literal("")),
      approvalChain: z
        .array(approvalChainStepSchema)
        .min(1, "At least one approval step is required")
        .superRefine(approvalChainRefine)
        .optional(),
      templateId: z.uuid("Invalid template id").optional(),
      /*
       * Optional here, decided in the service.
       *
       * Whether the submitter signs depends on the memo type and on the
       * organisation's policy, and this schema can see neither - so it
       * accepts a request with or without one and the service refuses the
       * wrong one with a sentence that can say why. Both directions are
       * refused: a missing signature where one is required, and a signature
       * offered where the submitter does not sign, which would otherwise be
       * a way to put a mark on a document the strip prints no line for.
       */
      signature: preparerSignatureSchema.optional(),

      /*
       * The draft this submission came from, so it stops being offered the
       * moment it becomes a document.
       *
       * Optional, and a draft that is missing or somebody else's is simply
       * not deleted: a submission that succeeded must not be rolled back
       * because the tidying-up afterwards found nothing to tidy.
       */
      draftId: z.uuid("Invalid draft id").optional(),

      /*
       * A memo typed in the portal rather than uploaded.
       *
       * All three arrive together or none do: `memoType` says which template
       * draws it, `body` is what to draw, and the To/From lines are part of
       * the header the template prints. A request carrying some of them is a
       * client that has half-implemented the feature, and guessing which half
       * it meant would produce a memo missing its addressee.
       */
      memoType: z
        .string()
        .refine(isMemoType, {
          message: `Unknown memo type. Available: ${memoTypeKeys().join(", ")}.`,
        })
        .optional(),
      body: memoBodySchema.optional(),
      /*
       * Notes placed on the page, which are not body content.
       *
       * A note is a box somebody put in a particular place; the body is a
       * flow that reflows. Keeping them apart is what stops a note moving
       * when the paragraph above it grows.
       */
      notes: memoNotesSchema.optional(),
      memoTo: memoHeaderFieldsSchema.shape.memoTo.optional(),
      memoFrom: memoHeaderFieldsSchema.shape.memoFrom.optional(),
      /*
       * The date the memo bears. Optional even for a typed memo, and absent
       * means the day it was submitted - which is what every memo drawn
       * before this existed was dated, so leaving it out keeps the old
       * behaviour exactly.
       */
      memoDate: memoDateSchema.optional(),
    })
    .superRefine((data, ctx) => {
      const typed = [data.memoType, data.body, data.memoTo, data.memoFrom];

      if (data.memoDate && !data.memoType) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Only a memo written in the portal carries its own date; an uploaded PDF brings its own.",
          path: ["memoDate"],
        });
      }

      if (typed.some(Boolean) && !typed.every(Boolean)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "A memo typed in the portal needs its type, its addressee, its sender and its body together.",
          path: ["memoType"],
        });
      }

      if (data.body && memoBodyIsEmpty(data.body)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Write the memo before submitting it.",
          path: ["body"],
        });
      }

      if (!data.approvalChain && !data.templateId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Either an approval chain or a workflow template is required",
          path: ["approvalChain"],
        });
      }
      if (data.approvalChain && data.templateId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Provide either an approval chain or a template, not both",
          path: ["approvalChain"],
        });
      }
    }),
});

export const updateDocumentSchema = z.object({
  params: documentIdParams,
  body: z.object({
    title: z.string().trim().min(1, "Title is required").max(500).optional(),
    description: z
      .string()
      .trim()
      .max(5000, "Description cannot exceed 5000 characters")
      .optional()
      .or(z.literal("")),
    approvalChain: z
      .array(approvalChainStepSchema)
      .min(1, "At least one approval step is required")
      .optional()
      .superRefine((steps, ctx) => {
        if (!steps) return;
        approvalChainRefine(steps, ctx);
      }),
    /* Optional for the same reason as on a first submission, and decided the
       same way: whether the preparer signs a resubmission is a property of
       the memo, which this schema cannot see. */
    signature: preparerSignatureSchema.optional(),

    /*
     * A revision to a memo that was typed in the portal: the body as it now
     * reads, which the server redraws into v2.
     *
     * Only the body is required, because the rest of the header is already on
     * the document row and a revision is the same memo said differently. The
     * two address lines are accepted as well, since "send it to the MD
     * instead" is a revision a reviewer actually asks for, but a request that
     * leaves them out keeps what the document already says rather than
     * blanking them.
     */
    body: memoBodySchema.optional(),
    /* As on a first submission: a correction may move, add or remove notes. */
    notes: memoNotesSchema.optional(),
    /*
     * Supporting files the current version carries that the new one should
     * not. Everything else is kept; new files are added beside them.
     */
    removeSupportingIds: z
      .array(z.uuid("That supporting file is not on this memo."))
      .max(50)
      .optional(),
    memoTo: memoHeaderFieldsSchema.shape.memoTo.optional(),
    memoFrom: memoHeaderFieldsSchema.shape.memoFrom.optional(),
    memoDate: memoDateSchema.optional(),
  })
    .superRefine((data, ctx) => {
      if (data.body && memoBodyIsEmpty(data.body)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Write the memo before resubmitting it.",
          path: ["body"],
        });
      }
    }),
});

export type ListDocumentsQuery = z.infer<typeof listDocumentsSchema>["query"];
/*
 * `consent` is required of a request - the route refuses a signature without
 * the tick - but optional to the services. Agreeing is something a person does
 * at the screen; a caller inside the process (a seed, a walkthrough, a test)
 * has nobody to agree, and the ledger entry it writes says so by recording no
 * statement. See `signedRecord`.
 */
type ConsentOptional<T> = Omit<T, "consent"> & { consent?: true };
type WithPreparerSignature<T extends { signature?: unknown }> = Omit<T, "signature"> & {
  signature?: PreparerSignatureInput;
};
export type UpdateDocumentInput = WithPreparerSignature<z.infer<typeof updateDocumentSchema>["body"]>;
export type CreateDocumentInput = WithPreparerSignature<z.infer<typeof createDocumentSchema>["body"]>;
export type ApprovalChainStepInput = z.infer<typeof approvalChainStepSchema>;
export type PreparerSignatureInput = ConsentOptional<z.infer<typeof preparerSignatureSchema>>;
