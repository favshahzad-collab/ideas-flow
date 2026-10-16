/**
 * What an administrator may set the memo page to.
 *
 * The renderer clamps anything it is handed, because a value that somehow
 * reached the database must not be able to crash a submission. This refuses
 * instead, with a sentence saying what to do - the two are not duplicates of
 * each other: one is a defensive floor nobody should ever meet, the other is
 * the message on the screen of the person typing.
 */
import { z } from "zod";

import {
  MAX_MARGIN,
  MIN_MARGIN,
  MIN_TEXT_HEIGHT,
  MIN_TEXT_WIDTH,
  PAPER,
  PAPER_NAMES,
} from "../lib/memoTemplate/geometry";

/** Points, to one decimal. 43.2pt is 0.6in; nobody types either by hand. */
const margin = (edge: string) =>
  z
    .number({ message: `The ${edge} margin must be a number of points.` })
    .finite({ message: `The ${edge} margin must be a real measurement.` })
    .min(MIN_MARGIN, {
      message: `The ${edge} margin must be at least ${MIN_MARGIN}pt (about 6mm). A printer cannot reproduce anything narrower.`,
    })
    .max(MAX_MARGIN, {
      message: `The ${edge} margin must be at most ${MAX_MARGIN}pt (about 76mm).`,
    });

export const pageSetupSchema = z
  .object({
    paper: z.enum(PAPER_NAMES as [string, ...string[]], {
      message: `Choose a paper size: ${PAPER_NAMES.join(" or ")}.`,
    }),
    marginLeft: margin("left"),
    marginRight: margin("right"),
    marginTop: margin("top"),
    marginBottom: margin("bottom"),
  })
  .superRefine((setup, ctx) => {
    const sheet = PAPER[setup.paper as keyof typeof PAPER];

    /*
     * Each margin can be legal on its own and the pair still leave nothing to
     * write on. Reported against the axis rather than one edge, because
     * either of the two is equally the one to reduce.
     */
    const width = sheet.width - setup.marginLeft - setup.marginRight;
    if (width < MIN_TEXT_WIDTH) {
      ctx.addIssue({
        code: "custom",
        path: ["marginLeft"],
        message: `The left and right margins leave only ${Math.round(width)}pt to write on, and a memo needs at least ${MIN_TEXT_WIDTH}pt. Reduce one of them.`,
      });
    }

    const height = sheet.height - setup.marginTop - setup.marginBottom;
    if (height < MIN_TEXT_HEIGHT) {
      ctx.addIssue({
        code: "custom",
        path: ["marginTop"],
        message: `The top and bottom margins leave only ${Math.round(height)}pt to write on, and a memo needs at least ${MIN_TEXT_HEIGHT}pt. Reduce one of them.`,
      });
    }
  });

export const updatePageSetupSchema = z.object({
  body: pageSetupSchema,
});

export type UpdatePageSetupInput = z.infer<typeof pageSetupSchema>;
