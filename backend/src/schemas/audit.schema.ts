import { z } from "zod";

// A path id that reaches Prisma unchecked is not a 404: the driver rejects a
// malformed uuid with an error the handler cannot recognise, so a stale link or
// a URL that lost a character tells the reader the system broke rather than
// that the document is no longer there.
const documentIdParams = z.object({
  id: z.uuid("That document link is not valid. Open it again from the ledger."),
});

export const getAuditHistorySchema = z.object({
  params: documentIdParams,
});

export const exportDocumentAuditSchema = z.object({
  params: documentIdParams,
});

export const getAllDocumentsAuditSchema = z.object({
  query: z.object({
    // The two ceilings mirror ALL_DOCUMENTS_MAX_LIMIT and
    // ALL_DOCUMENTS_MAX_OFFSET in audit.service.ts. Refusing here rather than
    // clamping silently is the difference between a caller who knows they
    // asked for too much and one who thinks they got what they asked for.
    limit: z.coerce.number().int().min(1).max(200).optional(),
    /**
     * Where the window starts. Both halves of the ledger - approval actions and
     * lifecycle rows - have to be read down to `offset + limit` before they can
     * be merged, so a deep offset is a large read on two tables; past the
     * ceiling the export is the honest answer rather than another page.
     */
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(
        10000,
        "That is too far back to page to. Export the ledger to read the rest."
      )
      .optional(),
  }),
});

/**
 * The administration trail: one table, one window, so the offset ceiling the
 * merged document ledger needs does not apply here. `area` narrows to one
 * group of entities; an area nobody recognises narrows to nothing rather than
 * quietly widening to everything, which would be the wrong way round for a
 * screen somebody is using to look for one particular change.
 */
export const getAdministrationAuditSchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    area: z.string().trim().min(1).max(40).optional(),
  }),
});
