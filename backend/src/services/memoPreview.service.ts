/**
 * The memo as it will be filed, drawn before it is submitted.
 *
 * This is not a convenience. The preparer's signature is mandatory and is
 * placed by dragging a box onto a page, which means there has to *be* a page
 * before they can sign - and for a typed memo nothing has drawn one yet. An
 * uploaded memo brings its own PDF; a typed one is only a body and a chain
 * until the server draws it.
 *
 * Nothing here is written down. The preview is rendered, returned, and
 * forgotten: it is not an artefact, carries no reference number, and must
 * never be mistaken for one. The bytes the submission files are drawn again
 * at submission, from the body as it stands then.
 */
import { preparerMustSign } from "../lib/preparerSigning";
import { buildMemoSignatories } from "../lib/memoSignatories";
import { errors } from "../lib/errors";
import { pageSetupService } from "./pageSetup.service";
import {
  renderMemoDocument,
  type MemoBody,
  type MemoSignatureSlot,
} from "../lib/memoTemplate";
import { prisma } from "../prisma";
import { memoDateToUtc, startOfTodayUtc } from "../schemas/memoBody.schema";
import {
  usableNotes,
  type MemoNoteInput,
} from "../schemas/memoNotes.schema";
import { brandingService } from "./branding.service";

export type MemoPreviewInput = {
  title?: string;
  memoTo?: string;
  memoFrom?: string;
  /** `2026-08-06`. Absent means today, which is what a submission defaults to. */
  memoDate?: string;
  /**
   * Which kind of memo this is.
   *
   * It decides whether the preparer takes the first column of the strip, so
   * a preview that left it out would draw a different page from the one the
   * submission files.
   */
  memoType?: string;
  /** Notes placed on the page, drawn over the flow exactly as filing will. */
  notes?: MemoNoteInput[];
  body: MemoBody;
  chain?: { userId: string }[];
  /**
   * The memo being revised, when this preview is of a rewrite rather than of
   * something new.
   *
   * Given one, the header and the chain come off the document rather than
   * out of the request. That is not a shortcut: the strip's geometry depends
   * on how many people are on it, so a preview drawn from a chain the client
   * reassembled would put the ruled lines somewhere the resubmission does
   * not, and the preparer would sign a line that moves under them.
   */
  documentId?: string;
};

export type MemoPreview = {
  /** The drawn memo, base64. */
  pdfBase64: string;
  /** Where each signature belongs, keyed by user id. */
  slots: MemoSignatureSlot[];
  pageCount: number;
  /**
   * Whether submitting this memo means signing it.
   *
   * Sent with the drawing rather than worked out by the screen, and from the
   * same call that laid the strip out. The two answers have to match: a page
   * drawn with no column for the preparer, on a screen that then asks them to
   * sign one, has nowhere to put the signature.
   */
  preparerSigns: boolean;
};

/**
 * Stand-ins for the header fields while they are still empty.
 *
 * A preview of a memo with no subject should show the memo with no subject,
 * not refuse to draw. These are the only strings in the feature that are
 * placed by the server rather than typed by somebody, and each says plainly
 * that it is a gap rather than pretending to be content.
 */
const PLACEHOLDER = {
  title: "[Subject not set]",
  to: "[Addressee not set]",
  from: "[Department not set]",
} as const;

export const memoPreviewService = {
  async renderPreview(
    userId: string,
    input: MemoPreviewInput
  ): Promise<MemoPreview> {
    const preparer = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        designation: true,
        // The strip prints the office under the designation, and this preview
        // must be the page the submission will file - byte for byte.
        department: { select: { name: true } },
      },
    });

    if (!preparer) throw errors.notFound("User not found");

    /*
     * Only the preparer of that memo, because only they can resubmit it -
     * and a preview names every signatory of a document this caller would
     * otherwise merely have to know the id of.
     */
    const revising = input.documentId
      ? await prisma.document.findUnique({
          where: { id: input.documentId },
          select: {
            preparerId: true,
            title: true,
            memoTo: true,
            memoFrom: true,
            memoType: true,
            memoDate: true,
            approvalChain: {
              select: {
                steps: {
                  orderBy: { stepOrder: "asc" },
                  select: { assignedUserId: true },
                },
              },
            },
          },
        })
      : null;

    if (input.documentId && !revising) throw errors.notFound("Document not found");
    if (revising && revising.preparerId !== userId) {
      throw errors.forbidden("Only the preparer of this memo can redraw it.");
    }

    const chain =
      input.chain ??
      revising?.approvalChain?.steps.map((step) => ({
        userId: step.assignedUserId,
      })) ??
      [];

    /*
     * Only the people the chain actually names, and only ones that exist.
     *
     * A draft is edited over days; somebody named in it can leave in between.
     * The preview draws the strip it can and the submission refuses the chain
     * outright - which is the right way round, because refusing to draw a
     * preview would leave the preparer with no way to see what is wrong.
     */
    const people = chain.length
      ? await prisma.user.findMany({
          where: { id: { in: [...new Set(chain.map((step) => step.userId))] } },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            designation: true,
            department: { select: { name: true } },
          },
        })
      : [];

    /*
     * The memo's own type when one is being revised, exactly as the
     * resubmission reads it - a revision cannot change what kind of memo this
     * is, so it cannot change who signs it either.
     *
     * Read once and used twice, for the strip and for the answer sent back
     * with it. Reading it twice would let the page and the instruction about
     * the page disagree across a policy change made between the two.
     */
    const preparerSigns = preparerMustSign(
      revising?.memoType ?? input.memoType
    );

    const { bytes, slots, pageCount } = await renderMemoDocument({
      /*
       * The notes as they stand, on the page the preparer is about to sign.
       *
       * A preview drawn without them would be a different page from the one
       * filed - and the signature is placed against the preview.
       */
      notes: usableNotes(input.notes),
      header: {
        to: input.memoTo?.trim() || revising?.memoTo || PLACEHOLDER.to,
        from: input.memoFrom?.trim() || revising?.memoFrom || PLACEHOLDER.from,
        subject: input.title?.trim() || revising?.title || PLACEHOLDER.title,
        /*
         * Exactly as the submission will date it: the date the preparer set,
         * the one the memo being revised already bears, or today.
         *
         * The preparer places their signature against this drawing, so a
         * preview dated differently from the filed copy would be a different
         * page, laid out differently, with the ruled lines somewhere else.
         */
        date: input.memoDate
          ? memoDateToUtc(input.memoDate)
          : (revising?.memoDate ?? startOfTodayUtc()),
      },
      body: input.body,
      branding: await brandingService.getBranding(),
      /*
       * The organisation's current page.
       *
       * The preparer signs against this drawing, so it has to be the page the
       * submission will file on. `renderTypedMemo` reads the same setting the
       * same way; a preview drawn on A4 and filed on Letter would put every
       * ruled line somewhere else.
       */
      page: await pageSetupService.getPageSetup(),
      /*
       * The same strip submission will draw, from the same rule.
       *
       * If the preview printed the preparer a line and the submission did
       * not, every slot after it would shift one column left between the
       * page somebody signed on and the page that was filed - and the
       * signature they placed would land under the wrong name on a document
       * that cannot be redrawn.
       */
      signatories: buildMemoSignatories(preparer, chain, people, {
        preparerSigns,
      }),
    });

    return {
      pdfBase64: bytes.toString("base64"),
      slots,
      pageCount,
      preparerSigns,
    };
  },
};
