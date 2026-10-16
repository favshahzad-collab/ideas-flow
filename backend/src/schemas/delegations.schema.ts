import { z } from "zod";

/**
 * A delegation hands one person's approvals to another between two dates.
 *
 * The one subtlety is the end date. The panel collects "away until" as a day,
 * and a day parsed as a timestamp is midnight - so a delegation "until the
 * 30th" would stop covering its delegate at one minute past midnight on the
 * 30th, on a boundary nobody was told about. A bare date therefore means the
 * end of that day.
 */
const END_OF_DAY = "T23:59:59.999Z";
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

const timestamp = z
  .string()
  .trim()
  .min(1)
  .transform((value) => (BARE_DATE.test(value) ? `${value}${END_OF_DAY}` : value))
  .pipe(z.coerce.date());

/** A start is a moment, not a day: "from now" is the ordinary case. */
const startTimestamp = z.string().trim().min(1).pipe(z.coerce.date());

const delegationIdParams = z.object({
  id: z
    .string()
    .uuid("That delegation is no longer on this screen. Reload and try again."),
});

export const createDelegationSchema = z.object({
  body: z
    .object({
      /**
       * Whose approvals are being handed over. Absent means the caller's own;
       * an administrator may name somebody else, and nobody else may.
       */
      delegatorId: z.string().uuid("Choose whose approvals are moving.").optional(),
      delegateId: z
        .string()
        .uuid("Choose the person who will approve while they are away."),
      startsAt: startTimestamp.optional(),
      endsAt: timestamp.nullish(),
      reason: z.string().trim().max(500).optional(),
      /**
       * The kinds of memo it covers. Absent or empty is every memo; "UPLOADED"
       * is a memo uploaded as a PDF.
       */
      memoTypes: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    })
    .refine(
      (body) =>
        !body.startsAt || !body.endsAt || body.endsAt >= body.startsAt,
      {
        message: "The delegation cannot end before it starts.",
        path: ["endsAt"],
      }
    ),
});

/**
 * What `validate(createDelegationSchema)` leaves on `req.body`.
 *
 * Named here rather than re-parsed at the route, because the two are not the
 * same value: `startsAt` and `endsAt` go in as strings and come out as Dates,
 * so feeding the output back through the schema that produced it fails.
 */
export type CreateDelegationBody = z.infer<
  typeof createDelegationSchema
>["body"];

export const revokeDelegationSchema = z.object({
  params: delegationIdParams,
});

export const listDelegationsSchema = z.object({
  query: z.object({
    /** Administrators only: whose delegations to read. Absent means your own. */
    userId: z.string().uuid("That person is no longer listed.").optional(),
  }),
});

export type CreateDelegationInput = z.infer<
  typeof createDelegationSchema
>["body"];
