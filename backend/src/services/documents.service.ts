import { findSignatoryLines } from "../lib/signatoryLines";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger";
import { prisma } from "../prisma";
import { actingForMemo } from "../lib/delegation";
import { ACCESS_SELECT, capabilitiesOf } from "../lib/capabilities";
import { errors } from "../lib/errors";
import {
  memoBodySchema,
  memoDateToUtc,
  startOfTodayUtc,
} from "../schemas/memoBody.schema";
import { diffMemoBodies, diffNotes } from "../lib/memoDiff";
import type { MemoBody, MemoNote } from "../lib/memoTemplate/types";
import { dueAtFor } from "../lib/sla";
import { policySnapshot, runDeadlineDefault } from "../lib/runPolicy";
import {
  decodeSignatureImage,
  fitPlacementToPage,
  stampSignature,
} from "../lib/pdfSignature";
import { storageService } from "../lib/storage";
import { isDefaultSetup, type PageSetup } from "../lib/memoTemplate/geometry";
import { pageSetupService } from "./pageSetup.service";
import {
  renderMemoDocument,
  type MemoSignatureSlot,
} from "../lib/memoTemplate";
import {
  buildMemoSignatories,
  type SignatoryPerson,
} from "../lib/memoSignatories";
import { preparerMustSign } from "../lib/preparerSigning";
import { isCancelledByAdministrator } from "../lib/cancellation";
import {
  usableNotes,
  type MemoNoteInput,
} from "../schemas/memoNotes.schema";
import {
  findSignatureSlot,
  isTypedMemoSlots,
  placementForSlot,
  slotOwnerAt,
} from "../lib/memoSignatureSlots";
import { brandingService } from "./branding.service";
import { delegationsService } from "./delegations.service";
import { ApprovalType, Prisma } from "../generated/prisma/client";
import {
  notificationsService,
  type NotificationData,
} from "./notifications.service";
import { auditService } from "./audit.service";
import { usersService } from "./users.service";
import { workflowTemplatesService } from "./workflow-templates.service";
import {
  CreateDocumentInput,
  DocumentSort,
  DOCUMENTS_DEFAULT_LIMIT,
  DOCUMENTS_MAX_LIMIT,
  formatMemoReference,
  ListDocumentsQuery,
  memoReferenceYearPrefix,
  PreparerSignatureInput,
  UpdateDocumentInput,
} from "../schemas/documents.schema";
import {
  canUserViewDocument,
  documentHasUserActed,
  isAwaitingActionBy,
  prismaDocumentAccessFilter,
} from "../lib/documentAccess";
import { sha256, verifyChecksum } from "../lib/checksum";
import {
  signatureMethod,
  signedRecord,
  type SigningAttestation,
} from "../lib/signingAttestation";
import { viewerFor } from "./viewer.service";
import {
  findApprovalChainIssues,
  preparerIsInChain,
  PREPARER_IN_CHAIN_MESSAGE,
} from "../lib/approvalChain";

function sanitizeFileName(fileName: string): string {
  const base = fileName.replace(/[/\\?%*:|"<>]/g, "_").trim();
  return base.slice(0, 200) || "attachment";
}

function supportingStoragePath(
  documentId: string,
  attachmentId: string,
  fileName: string
): string {
  return `documents/${documentId}/supporting/${attachmentId}-${sanitizeFileName(fileName)}`;
}

/**
 * A search term is matched one word at a time and every word has to land
 * somewhere, so "Chen budget" finds Maria Chen's budget paper - which a single
 * whole-string match against one column never would. The cap is here because
 * each extra word costs another OR across four columns.
 */
const DOCUMENT_SEARCH_MAX_TOKENS = 5;

/**
 * The advisory-lock namespace memo references are numbered under - the four
 * bytes of "MEMO", so it cannot collide by accident with a lock some other
 * feature takes for its own reasons. Two features sharing a key would block
 * each other for no reason a reader could ever work out.
 */
const MEMO_REFERENCE_LOCK_NAMESPACE = 0x4d454d4f;

/**
 * The orders the list can be asked for, as a lookup rather than a chain of
 * ifs, so the named orders and the default cannot drift: an absent `sort` has
 * to keep meaning exactly what the list meant before it accepted parameters.
 *
 * Every order ends on the id. Documents submitted in the same second are
 * ordinary - a batch submitted from one screen - and without a deterministic
 * tiebreak the same row can appear on two consecutive pages while another
 * never appears at all.
 *
 * Drafts sort last in both submission orders: they have no submittedAt, and a
 * list asked for "oldest submitted first" that opens with things nobody has
 * submitted yet is answering a different question.
 */
const DOCUMENT_SORT_ORDER_BY: Record<
  DocumentSort,
  Prisma.DocumentOrderByWithRelationInput[]
> = {
  newest: [{ submittedAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
  oldest: [{ submittedAt: { sort: "asc", nulls: "last" } }, { id: "asc" }],
  recently_updated: [{ updatedAt: "desc" }, { id: "asc" }],
  least_recently_updated: [{ updatedAt: "asc" }, { id: "asc" }],
};

/**
 * One reason a memo stops at one person.
 *
 * `stepOrder`, `approvalType` and `totalSteps` are null for a memo sent back
 * for revision: that one waits on its preparer, who has no step on the chain
 * at all. `heldSince` is the moment the wait began either way - the step
 * started, or the revision was asked for.
 */
export type HeldMemo = {
  documentId: string;
  referenceNumber: string | null;
  title: string;
  submittedAt: Date;
  preparer: { id: string; firstName: string; lastName: string };
  stepOrder: number | null;
  approvalType: ApprovalType | null;
  totalSteps: number | null;
  heldSince: Date | null;
  dueAt: Date | null;
  /** Approvals between the memo and them. Zero means it is with them now. */
  stepsAway: number;
};

/**
 * Everything the renderer needs that is not branding or a person.
 *
 * Spelled out rather than taken from the submission input, because the two
 * callers assemble it from different places: a first submission has all of it
 * in the request, while a revision takes the header from the document row and
 * only the body from the request. A parameter shaped like one caller's input
 * made the other one read as a pile of non-null assertions.
 */
type TypedMemoToDraw = {
  title: string;
  /**
   * Notes placed on the page, drawn over the flow once it is laid out.
   *
   * Separate from `body` for the reason they are separate everywhere: the
   * body reflows and a note does not move with it.
   */
  notes: MemoNoteInput[];
  /**
   * Which kind of memo this is, which is what decides whether its author
   * signs it and therefore whether they get a column on the printed strip.
   */
  memoType: string | null;
  memoTo: string;
  memoFrom: string;
  /** What the header prints. Midnight UTC on the day the memo bears. */
  date: Date;
  body: unknown;
  /** In signing order. The strip is printed from it, preparer first. */
  chain: { userId: string }[];
};

class DocumentsService {
  /**
   * The signing lines on an attached PDF: each person on it - the preparer
   * and everybody in the chain - found by their printed name. See
   * `lib/signatoryLines.ts` for how cautious the matching is.
   */
  private async detectSignatoryLines(
    pdf: Buffer,
    preparerId: string,
    chainUserIds: string[]
  ): Promise<MemoSignatureSlot[] | null> {
    const people = await prisma.user.findMany({
      where: { id: { in: [preparerId, ...chainUserIds] } },
      select: { id: true, firstName: true, lastName: true },
    });
    return findSignatoryLines(
      pdf,
      people.map((person) => ({ key: person.id, name: `${person.firstName} ${person.lastName}`.trim() }))
    );
  }

  private async stampPreparerSignature(
    pdfBuffer: Buffer,
    userId: string,
    signature: PreparerSignatureInput,
    /** The printed strip, for a typed memo. Null for an uploaded one. */
    slots: MemoSignatureSlot[] | null = null
  ): Promise<{ pdf: Buffer; imageChecksum: string }> {
    const signatureBuffer = signature.useSavedSignature
      ? (await usersService.getSignature(userId)).buffer
      : decodeSignatureImage(signature.signatureImage!);

    // The preparer's mark gets the same printed block as every approver's:
    // name, title, department and the date. Without it the first signature
    // on the memo is the one nobody can read, and the person who put the
    // memo up is the one whose title is missing from it. No capacity: the
    // preparer is none of REVIEWER / APPROVER / FINAL_APPROVER.
    const preparer = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        firstName: true,
        lastName: true,
        designation: true,
        department: { select: { name: true } },
      },
    });

    /*
     * The preparer's own column on the printed strip, when there is one.
     *
     * A typed memo prints their name and title under the first ruled line, so
     * the block below their signature would say it all a second time, over
     * the top of it. Snapping also puts their mark on the line rather than
     * near it, which is what makes the filed page look like the paper form it
     * replaces.
     *
     * The preparer is held to the same rule as every approver: they may sign
     * on their own line or in open space, and on nobody else's line. They are
     * the one signer with the whole strip in front of them before anyone has
     * signed anything, so without this the first column is the one place a
     * signature could be planted under another person's printed name.
     */
    const targetedOwner = slotOwnerAt(slots, signature);

    if (targetedOwner !== null && targetedOwner !== userId) {
      throw errors.forbidden(
        "That signature was placed on a line the memo prints for somebody " +
          "else. Sign on your own line, or somewhere clear of the signature block."
      );
    }

    const mySlot = findSignatureSlot(slots, userId);
    // An attached PDF prints its own signatories' names and titles, so the
    // preparer's mark goes on alone there, exactly as on a printed line.
    const typedMemo = isTypedMemoSlots(slots);
    const onOwnLine = mySlot !== null || !typedMemo;

    const signoff = preparer
      ? {
          name: `${preparer.firstName} ${preparer.lastName}`.trim(),
          designation: preparer.designation,
          department: preparer.department?.name ?? null,
          signedAt: new Date(),
          onOwnLine,
          // Drawn by the portal, not found in an attached PDF.
          onTypedMemo: typedMemo,
        }
      : null;

    /*
     * Fitted first, exactly as an approval is.
     *
     * This path used to hand the placement straight to the renderer, so the
     * block above was drawn wherever the arithmetic put it: a signature
     * dropped at the foot of a page had its name, title and date drawn below
     * y=0, off the bottom edge and gone. The preparer's mark is the first one
     * on the memo and every approver signs around it, so it is also the one
     * loss nobody can correct afterwards.
     *
     * A placement that misses the page entirely is refused here rather than
     * accepted and drawn into nowhere - the submission schema deliberately
     * allows a negative offset on the grounds that "clamping is the
     * renderer's job", and this is the renderer.
     */
    const placement = await fitPlacementToPage(
      pdfBuffer,
      mySlot ? placementForSlot(mySlot) : signature,
      signoff,
      {
        unreadablePdf:
          "This PDF could not be read, so it cannot be signed. Export it again and upload a fresh copy.",
      }
    );

    return {
      pdf: await stampSignature(pdfBuffer, signatureBuffer, placement, signoff),
      // Which image went on the page, for the signature's ledger entry.
      imageChecksum: sha256(signatureBuffer),
    };
  }

  /**
   * The next memo reference for the current year, minted inside the caller's
   * transaction.
   *
   * The advisory lock is the whole of the concurrency story. `reference_number`
   * is UNIQUE, so two submissions that read the same maximum mint the same
   * reference and the second one's insert fails: somebody's memo is refused
   * for a reason that has nothing to do with them and nothing they can do
   * about it. `pg_advisory_xact_lock` is held until this transaction commits
   * or rolls back, so a second submitter waits here and then reads a maximum
   * that already counts the first one's row. That is why the read has to be
   * inside the same transaction as the insert and after the lock - a
   * `SELECT max()` taken outside, or before the lock, is exactly the race.
   *
   * Keyed on the year, so the first submissions of January never queue behind
   * anything, and taken as the transaction's first statement so it is held
   * for as little of the transaction as the transaction allows.
   */
  private async nextMemoReference(
    tx: Prisma.TransactionClient,
    now: Date = new Date()
  ): Promise<string> {
    const year = now.getFullYear();

    // Called in the FROM clause so the row that comes back is a boolean: the
    // lock function itself returns `void`, which the client cannot read back
    // and fails the whole submission on.
    await tx.$queryRaw`
      SELECT true AS locked
      FROM pg_advisory_xact_lock(${MEMO_REFERENCE_LOCK_NAMESPACE}::int, ${year}::int)
    `;

    // Only rows whose sequence is digits are counted, and the maximum is read
    // off the number rather than the string: past 9999 the sequence grows a
    // digit, and "10000" sorts below "9999" as text - which would hand the
    // next submission a reference that is already in use.
    const [row] = await tx.$queryRaw<{ next: number }[]>`
      SELECT COALESCE(MAX(substring(reference_number FROM '[0-9]+$')::int), 0) + 1 AS next
      FROM documents
      WHERE reference_number ~ ${`^${memoReferenceYearPrefix(year)}[0-9]+$`}
    `;

    return formatMemoReference(year, Number(row?.next ?? 1));
  }

  private async uploadSupportingFiles(
    documentId: string,
    userId: string,
    files: Express.Multer.File[],
    /** The version they are attached to; they stay on later ones until removed. */
    versionNumber = 1
  ): Promise<string[]> {
    const uploadedPaths: string[] = [];

    try {
      for (const file of files) {
        const attachmentId = randomUUID();
        const storagePath = supportingStoragePath(
          documentId,
          attachmentId,
          file.originalname
        );

        await storageService.uploadFile(
          storagePath,
          file.buffer,
          file.mimetype
        );
        uploadedPaths.push(storagePath);

        await prisma.supportingDocument.create({
          data: {
            id: attachmentId,
            documentId,
            fileName: sanitizeFileName(file.originalname),
            contentType: file.mimetype,
            storagePath,
            sizeBytes: file.size,
            uploadedById: userId,
            addedInVersion: versionNumber,
          },
        });
      }

      return uploadedPaths;
    } catch (error) {
      for (const path of uploadedPaths) {
        await storageService.deleteDocument(path);
      }
      throw error;
    }
  }

  /**
   * Draw a memo that was typed in the portal.
   *
   * The signature strip is built from the chain that was just validated, so
   * the printed names under the ruled lines are the people the memo is
   * actually going to - not a fixed four copied from a Word template that
   * nobody updated when somebody left.
   */
  private async renderTypedMemo(
    memo: TypedMemoToDraw,
    preparer: SignatoryPerson,
    approvers: SignatoryPerson[]
  ): Promise<{
    file: Express.Multer.File;
    slots: MemoSignatureSlot[];
    /** The page this was drawn on, to be recorded against the version. */
    pageSetup: PageSetup | null;
  }> {
    /*
     * The same list the preview drew, from the same function.
     *
     * The preparer takes the first column when submitting this kind of memo
     * means signing it: they sign before anybody else does, and a strip that
     * named only the approvers left them with no line to sign on - so their
     * signature went into the body while three printed lines stayed blank.
     *
     * When it does not, the strip starts at the first approver, because the
     * same failure runs the other way: a line printed for somebody who will
     * never be asked to sign stays blank for the life of the document.
     */
    const signatories = buildMemoSignatories(preparer, memo.chain, approvers, {
      preparerSigns: preparerMustSign(memo.memoType),
    });

    /*
     * The page, resolved once.
     *
     * `pageSetup` is what to draw on; `recorded` is what to store against the
     * version, which is null while the organisation is still on the delivered
     * default - an empty column then means "the page it has always been"
     * rather than a value somebody forgot to write.
     */
    const pageSetup = await pageSetupService.getPageSetup();
    const recorded = isDefaultSetup(pageSetup) ? null : pageSetup;

    const { bytes: pdf, slots } = await renderMemoDocument({
      notes: memo.notes,
      header: {
        to: memo.memoTo,
        from: memo.memoFrom,
        subject: memo.title,
        /*
         * The date the preparer gave the memo, falling back to today.
         *
         * Not the submission date: a memo written on the 6th, agreed
         * verbally and put through the system on the 11th is dated the 6th,
         * and that is what its header has to say. `submittedAt` still
         * records when it actually entered the workflow.
         *
         * It is also what the PDF's own creation and modification dates are
         * pinned to, which is why a date-only value matters: two renders of
         * the same memo on the same day are then byte-identical, so the
         * preview the preparer signed against and the copy that gets filed
         * are the same drawing.
         */
        date: memo.date,
      },
      body: memo.body as never,
      branding: await brandingService.getBranding(),
      signatories,
      /*
       * Read once here and returned alongside the bytes, so the version row
       * records the page these exact bytes were drawn on. Reading it again
       * at the point of writing the row would leave a window in which an
       * administrator saving the settings screen mid-submission recorded a
       * page the document was not drawn with.
       */
      page: pageSetup,
    });

    // Wrapped as an upload so every line after this one is the path an
    // uploaded PDF already takes, unchanged.
    return {
      pageSetup: recorded,
      file: {
        fieldname: "file",
        originalname: `${memo.title}.pdf`,
        encoding: "7bit",
        mimetype: "application/pdf",
        size: pdf.length,
        buffer: pdf,
        stream: undefined as never,
        destination: "",
        filename: "",
        path: "",
      },
      slots,
    };
  }

  async createDocument(
    input: CreateDocumentInput,
    uploadedFile: Express.Multer.File | null,
    userId: string,
    supportingFiles: Express.Multer.File[] = [],
    attestation?: SigningAttestation
  ) {
    const { title, description, signature } = input;

    /*
     * Does submitting this document mean signing it?
     *
     * Decided here rather than in the schema, which cannot see the memo type
     * or the organisation's policy. Both mismatches are refused: a document
     * that must be signed and arrived without a signature, and one that
     * arrived with a signature nobody is going to print a line for.
     *
     * The second refusal is the one worth having. Without it, a client could
     * put the submitter's mark on a document whose strip names only the
     * approvers - a signature on the page that no printed line accounts for
     * and no workflow step ever asked for.
     */
    const mustSign = preparerMustSign(input.memoType);

    /*
     * The notes this submission files, resolved once.
     *
     * Read twice - for the drawing and for the row - and a note dropped as
     * empty by one and kept by the other would leave the stored set
     * disagreeing with the page it claims to describe.
     */
    const filedNotes = usableNotes(input.notes);

    if (mustSign && !signature) {
      throw errors.badRequest(
        "This document has to be signed by the person submitting it."
      );
    }

    if (!mustSign && signature) {
      throw errors.badRequest(
        "This document is not signed by the person submitting it. It goes to " +
          "the first approver as it stands."
      );
    }

    const documentId = randomUUID();
    const versionNumber = 1;
    const storagePath = `documents/${documentId}/v${versionNumber}.pdf`;

    // Resolve the effective approval chain:
    //  - if the user supplied a templateId, compile the template graph
    //  - otherwise use the inline approvalChain
    //
    // Everything that can reject the submission runs before a single byte is
    // written. A template that fails to compile used to throw after the PDF
    // had already been uploaded, and the rollback handler below had not been
    // entered yet, so the orphaned file stayed in storage.
    let effectiveChain: {
      userId: string;
      approvalType: ApprovalType;
      slaDays?: number | null;
    }[] = [];
    let templateId: string | null = null;

    if (input.templateId) {
      const template = await prisma.workflowTemplate.findUnique({
        where: { id: input.templateId },
      });
      if (!template || !template.isActive) {
        throw errors.badRequest("Selected workflow template is not available");
      }
      templateId = template.id;
      const compiled = workflowTemplatesService.compileGraphToSteps(
        template.graph as never,
        { title, description: description ?? null }
      );
      effectiveChain = compiled.map((step) => ({
        userId: step.assignedUserId,
        approvalType: step.approvalType,
        slaDays: step.slaDays,
      }));
      if (effectiveChain.length === 0) {
        throw errors.badRequest(
          "Selected workflow template did not produce any approval steps"
        );
      }
    } else if (input.approvalChain) {
      effectiveChain = input.approvalChain;
    } else {
      throw errors.badRequest(
        "Either an approval chain or a workflow template is required"
      );
    }

    // An inline chain has already been through these rules in zod; a compiled
    // one has not, and a compiled chain with no FINAL_APPROVER produces a
    // document that can never finish.
    const chainIssues = findApprovalChainIssues(effectiveChain);
    if (chainIssues.length > 0) {
      throw errors.badRequest(
        templateId
          ? `Selected workflow template produced an invalid approval chain: ${chainIssues.join("; ")}`
          : chainIssues.join("; ")
      );
    }

    if (preparerIsInChain(effectiveChain, userId)) {
      throw errors.badRequest(PREPARER_IN_CHAIN_MESSAGE);
    }

    // Make sure every assigned user exists
    const users = await prisma.user.findMany({
      where: {
        id: {
          in: effectiveChain.map((step) => step.userId),
        },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        // Printed under this person's ruled line on a generated memo. Read
        // here because the chain has already been resolved and these are
        // exactly the people the strip names.
        designation: true,
        // And the office they sign for, on the line below it.
        department: { select: { name: true } },
        deactivatedAt: true,
      },
    });

    if (users.length !== effectiveChain.length) {
      throw errors.badRequest(
        "One or more users in the approval chain do not exist."
      );
    }

    /*
     * And that every one of them can still sign it.
     *
     * A switched-off account cannot get in, so a chain that names one produces
     * a memo that stops the moment it reaches that step - dead on arrival,
     * with no signature possible and nothing on the screen to say why. The
     * pickers do not offer these people, so reaching this needs a saved
     * workflow template written before somebody left, or a request made
     * directly. Both happen, and the template is the likelier: it is written
     * once and used for years.
     *
     * Named, because "one or more users" would send the preparer through a
     * chain of six looking for which.
     */
    const switchedOff = users.filter((user) => user.deactivatedAt !== null);

    if (switchedOff.length > 0) {
      const names = switchedOff
        .map((user) => `${user.firstName} ${user.lastName}`.trim())
        .join(", ");

      throw errors.badRequest(
        switchedOff.length === 1
          ? `${names} no longer has an account here, so they cannot approve this. Choose somebody else for that step.`
          : `These people no longer have accounts here, so they cannot approve this: ${names}. Choose somebody else for those steps.`
      );
    }

    /*
     * A memo typed in the portal becomes a PDF here, and from this line on
     * nothing downstream can tell the difference.
     *
     * The position is deliberate. Everything that can reject the submission
     * has already run - the chain is resolved and valid, every approver
     * exists and can still sign - and nothing has been written yet. So a
     * render that fails throws before the first byte reaches STORAGE_DIR,
     * which is what "a memo must never go in flight without its artefact"
     * requires. Rendering earlier would draw a signature strip for a chain
     * that turns out to be invalid; rendering later would need a rollback.
     */
    let file = uploadedFile;
    let signatureSlots: MemoSignatureSlot[] | null = null;
    /*
     * Null for an uploaded PDF, and null for a typed memo drawn on the
     * default page. Only a memo drawn on a page the organisation changed
     * records anything.
     */
    let filedPageSetup: PageSetup | null = null;

    if (!file) {
      /*
       * The preparer is on the strip too, so they have to be looked up. Read
       * here rather than earlier because this is the only branch that needs
       * it: an uploaded memo has no strip to print anybody on.
       */
      const preparer = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          designation: true,
          department: { select: { name: true } },
        },
      });

      if (!preparer) throw errors.notFound("User not found");

      const rendered = await this.renderTypedMemo(
        {
          title: input.title,
          memoType: input.memoType ?? null,
          notes: filedNotes,
          memoTo: input.memoTo!,
          memoFrom: input.memoFrom!,
          date: input.memoDate
            ? memoDateToUtc(input.memoDate)
            : startOfTodayUtc(),
          body: input.body,
          /*
           * The resolved chain, not `input.approvalChain`. A memo submitted
           * against a workflow template has no inline chain at all, and
           * printing the strip from one drew a memo whose only ruled line
           * was the preparer's while the template's approvers were the
           * people actually asked to sign it.
           */
          chain: effectiveChain,
        },
        preparer,
        users
      );
      file = rendered.file;
      signatureSlots = rendered.slots;
      filedPageSetup = rendered.pageSetup;
    } else {
      // An attached PDF: each signatory's line, found above their printed
      // name. Null when none is recognisable - then it is placed by hand.
      signatureSlots = await this.detectSignatoryLines(
        file.buffer,
        userId,
        effectiveChain.map((step) => step.userId)
      );
    }

    /*
     * Unsigned means untouched: the drawn or uploaded bytes are filed exactly
     * as they are, and the first mark on the page is the first approver's.
     *
     * Still two stored objects either way - `storagePath` and
     * `originalStoragePath` - because everything downstream reads both, and a
     * submission that wrote only one would be a second shape for every
     * version, checksum, download and rollback path to know about.
     */
    const stamped = signature
      ? await this.stampPreparerSignature(
          file.buffer,
          userId,
          signature,
          signatureSlots
        )
      : null;
    const signedBuffer = stamped?.pdf ?? file.buffer;
    const signedFile: Express.Multer.File = {
      ...file,
      buffer: signedBuffer,
    };

    // Keep exactly what was uploaded, before the preparer's signature was
    // burned in. `storagePath` is the memo as submitted and is what approvers
    // sign; this is the file it was made from, and nothing ever writes to it
    // again. Without it the uploaded document is unrecoverable from the first
    // signature onwards.
    const originalStoragePath = `documents/${documentId}/v${versionNumber}-original.pdf`;
    await storageService.uploadFile(
      originalStoragePath,
      file.buffer,
      file.mimetype || "application/pdf"
    );
    await storageService.uploadDocument(storagePath, signedFile);

    // Taken from the buffers that were just written, not read back from disk:
    // the digest has to describe what this request produced, and a re-read
    // would digest whatever is on disk by then instead.
    const originalChecksum = sha256(file.buffer);
    const storageChecksum = sha256(signedBuffer);

    const uploadedSupportingPaths: string[] = [];
    /*
     * Set the moment the memo's transaction commits. From then on the memo is
     * filed - its version row points at the files written above - so nothing
     * that fails afterwards (supporting files, the first approver's notice)
     * may delete them, and the person must not be told it failed outright, or
     * they submit it a second time.
     */
    let filed: { referenceNumber: string | null } | null = null;

    try {
      const document = await prisma.$transaction(async (tx) => {
        // Minted here, once, in the transaction that creates the row - so a
        // reference exists for every submitted memo and only for submitted
        // memos. Nothing else in the service writes this column: a reference
        // that changed later would already be quoted in a reply, written on
        // a file cover, and typed into search by someone who cannot find it.
        const referenceNumber = await this.nextMemoReference(tx);

        // Create Document and mark it as submitted for review
        const createdDocument = await tx.document.create({
          data: {
            id: documentId,
            referenceNumber,
            title,
            description: description || null,
            preparerId: userId,
            currentVersionNumber: versionNumber,
            status: "PENDING_REVIEW",
            /*
             * This row IS the submission - the status above says so, and the
             * workflow run starts in the same transaction - so it carries the
             * moment it happened. Leaving it null, which it did, put every
             * memo submitted through this path last under "newest first", and
             * meant the median cycle time on the dashboard could never be
             * computed, because it is measured from here.
             */
            submittedAt: new Date(),
            ...(templateId ? { templateId } : {}),
            // Null for an uploaded memo, which is what every memo before
            // in-app authoring is and what the uploaded path keeps producing.
            ...(input.memoType
              ? {
                  memoType: input.memoType,
                  memoTo: input.memoTo,
                  memoFrom: input.memoFrom,
                  /*
                   * Recorded even when it was defaulted, so the header can be
                   * redrawn identically later. Reading it back off
                   * `submittedAt` would be a different value - that one
                   * carries a time, and a revision months later would redraw
                   * the memo with a different date on it.
                   */
                  memoDate: input.memoDate
                    ? memoDateToUtc(input.memoDate)
                    : startOfTodayUtc(),
                }
              : {}),
          },
        });

        // Create Version 1
        const version = await tx.documentVersion.create({
          data: {
            documentId,
            versionNumber,
            storagePath,
            originalStoragePath,
            storageChecksum,
            originalChecksum,
            uploadedById: userId,
            // What this version's PDF was drawn from. Held per version so v1
            // keeps saying what v1 was, whatever a later revision renders.
            ...(input.body
              ? { bodyJson: input.body }
              : {}),
            // Where the printed lines are, so the people who have to sign on
            // them can be offered their own rather than left to guess.
            ...(signatureSlots
              ? {
                  signatureSlots:
                    signatureSlots,
                }
              : {}),
            /*
             * The notes as drawn, for the same reason the slots are kept:
             * the artefact is immutable and hashed, so what was put on the
             * page has to be answerable later without redrawing the memo as
             * it would look today.
             */
            ...(filedNotes.length
              ? {
                  pageNotesJson:
                    filedNotes,
                }
              : {}),
            /*
             * The page these bytes were drawn on. Written only when it is not
             * the delivered default, so the column stays empty on a
             * deployment that has never changed it - and a null then means
             * "the page it has always been" rather than a missing value.
             */
            ...(filedPageSetup
              ? {
                  pageSetupJson:
                    filedPageSetup,
                }
              : {}),
          },
        });

        // Create Approval Chain
        const chain = await tx.approvalChain.create({
          data: {
            documentId,
            createdById: userId,
          },
        });

        // Create Chain Steps
        await tx.approvalChainStep.createMany({
          data: effectiveChain.map((step, index) => ({
            chainId: chain.id,
            assignedUserId: step.userId,
            approvalType: step.approvalType,
            stepOrder: index + 1,
            slaDays: step.slaDays ?? null,
          })),
        });

        // Start workflow run for the submitted document
        const workflowRun = await tx.workflowRun.create({
          data: {
            documentId,
            documentVersionId: version.id,
            chainId: chain.id,
            status: "IN_PROGRESS",
            currentStepOrder: 1,
            // The policy this cycle runs under, kept for its whole life (lib/runPolicy).
            ...policySnapshot(),
          },
        });

        await tx.document.update({
          where: { id: documentId },
          data: {
            currentWorkflowRunId: workflowRun.id,
          },
        });

        await auditService.createAuditLog({
          actorId: userId,
          action: "DOCUMENT_SUBMITTED",
          entityType: "Document",
          entityId: documentId,
          newValue: {
            status: "PENDING_REVIEW",
            // The reference is on the row that opens the trail, so the ledger
            // can be read against the paper file without joining anything.
            referenceNumber,
            versionNumber,
            workflowRunId: workflowRun.id,
            /*
             * Whether the submitter signed, and where.
             *
             * This read `true` unconditionally, which was true of every
             * document that could exist at the time. Now that a submission
             * can go forward unsigned, the trail has to say which it was -
             * a reader asking "whose marks are on this page" must not be
             * told the preparer's is one of them when it is not.
             */
            preparerSigned: Boolean(signature),
            ...(signature ? { signaturePage: signature.signaturePage } : {}),
            supportingFileCount: supportingFiles.length,
            ...(templateId ? { templateId } : {}),
            // How the artefact came to exist. The trail should answer "was
            // this PDF uploaded or drawn by us" without anyone having to
            // infer it from a null column.
            authoring: input.memoType ? "GENERATED" : "UPLOADED",
            ...(input.memoType ? { memoType: input.memoType } : {}),
          },
          tx,
        });

        // The preparer's signature, as its own ledger entry: see
        // `signedRecord` for what an auditor gets from it.
        if (signature) {
          await auditService.createAuditLog({
            actorId: userId,
            action: "DOCUMENT_SIGNED",
            entityType: "Document",
            entityId: documentId,
            newValue: signedRecord({
              capacity: "PREPARER",
              versionNumber,
              method: signatureMethod(signature),
              signaturePage: signature.signaturePage,
              signedPdfChecksum: sha256(signedBuffer),
              signatureImageChecksum: stamped?.imageChecksum ?? null,
              attestation,
            }),
            ipAddress: attestation?.ipAddress,
            tx,
          });
        }

        /*
         * The draft this came from stops existing the moment it becomes a
         * document, in the same transaction, so there is never a window in
         * which the Submit screen offers to resume a memo that is already in
         * somebody's queue.
         *
         * `deleteMany` scoped by preparer, not `delete`: a draft id that is
         * stale, already deleted, or somebody else's matches nothing and the
         * submission stands. `delete` would throw on a missing row and roll
         * back a memo that was otherwise perfectly filed.
         */
        if (input.draftId) {
          await tx.memoDraft.deleteMany({
            where: { id: input.draftId, preparerId: userId },
          });
        }

        return {
          ...createdDocument,
          version,
          approvalChainId: chain.id,
          workflowRunId: workflowRun.id,
        };
      });
      filed = { referenceNumber: document.referenceNumber };

      if (supportingFiles.length > 0) {
        const paths = await this.uploadSupportingFiles(
          documentId,
          userId,
          supportingFiles
        );
        uploadedSupportingPaths.push(...paths);
      }

      // `effectiveChain` is the resolved chain — compiled from the template
      // when one was chosen, otherwise the inline chain. The old name was
      // left behind when template support was added and no longer exists,
      // so this threw a ReferenceError on every submission.
      const firstStep = effectiveChain[0];
      if (firstStep) {
        const isReview = firstStep.approvalType === ApprovalType.REVIEWER;
        await notificationsService.createNotifications(
          await notificationsService.approvalNeeded({
            recipientId: firstStep.userId,
            type: "APPROVAL_NEEDED",
            title: isReview ? "Review Required" : "Approval Required",
            message: `Document "${title}" requires your ${isReview ? "review" : "approval"}.`,
            documentId,
            workflowRunId: document.workflowRunId,
          })
        );
      }

      // The preparer's receipt: their memo went in, under this reference.
      await notificationsService.createNotifications([
        {
          recipientId: userId,
          type: "SUBMITTED",
          title: "Memo submitted",
          message: `"${title}" was submitted as ${document.referenceNumber ?? "a new memo"} and is with its first approver.`,
          documentId,
          workflowRunId: document.workflowRunId,
        },
      ]);

      return {
        message: "Document created successfully.",
        document,
      };
    } catch (error) {
      /*
       * After the memo was filed: keep every file, and say what happened.
       * Deleting here used to remove the PDF of a memo that exists, because a
       * supporting upload or a notice failed after the transaction committed.
       */
      if (filed) {
        logger.error("document.after_submit_failed", {
          documentId,
          referenceNumber: filed.referenceNumber,
          error: error instanceof Error ? error.message : String(error),
        });
        throw errors.internal(
          `The memo was submitted as ${filed.referenceNumber ?? "a new memo"}, but something after that failed (its supporting files or the first approver's notice). Open it from Documents to check before submitting it again.`,
          "SUBMITTED_WITH_ERRORS"
        );
      }

      /*
       * Roll back every file this request wrote, if the transaction fails.
       *
       * Both of them: the signed copy AND the one it was made from. Only the
       * first was removed, so a submission that got as far as storage and no
       * further left `vN-original.pdf` behind for good - nothing points at
       * it, because the version row was rolled back, so nothing will ever
       * find it again to clean it up.
       */
      await storageService.deleteDocument(storagePath);
      await storageService.deleteDocument(originalStoragePath);
      for (const path of uploadedSupportingPaths) {
        await storageService.deleteDocument(path);
      }
      throw error;
    }
  }

  async uploadVersion(
    documentId: string,
    file: Express.Multer.File,
    userId: string
  ) {

    const document = await prisma.document.findUnique({
      where: {
        id: documentId,
      },
      select: {
        id: true,
        preparerId: true,
        status: true,
        currentVersionNumber: true,
      },
    });

    if (!document) {
      throw errors.notFound("Document not found");
    }

    const oldVersion = await prisma.documentVersion.findFirst({
      where: {
        documentId,
        versionNumber: document.currentVersionNumber,
      },
    });


    if (document.preparerId !== userId) {
      throw errors.forbidden(
        "Only the document preparer can upload new versions."
      );
    }

    const versionNumber = document.currentVersionNumber + 1;

    const storagePath = `documents/${documentId}/v${versionNumber}.pdf`;

    await storageService.uploadDocument(storagePath, file);
    const storageChecksum = sha256(file.buffer);

    try {
      // This was a transaction nested inside another transaction, opening a
      // second pooled connection while the first was still held. The inner
      // result was also never returned, so `version` came back undefined.
      const version = await prisma.$transaction(async (tx) => {
        await tx.document.update({
          where: { id: documentId },
          data: { currentVersionNumber: versionNumber },
        });

        if (oldVersion) {
          await tx.documentVersion.update({
            where: { id: oldVersion.id },
            data: { isDeleted: true },
          });
        }

        return tx.documentVersion.create({
          data: {
            documentId,
            versionNumber,
            storagePath,
            storageChecksum,
            uploadedById: userId,
          },
        });
      });

      // The version this one replaces is marked superseded, and its file is
      // left where it is. It was submitted for approval and may have been
      // signed, so deleting it - which is what used to happen here - threw
      // away the only copy of what those signatures were placed on.

      return {
        message: "Document version uploaded successfully.",
        version,
      };
    } catch (error) {
      await storageService.deleteDocument(storagePath);
      throw error;
    }
  }
  /**
   * The documents this user may see, narrowed and paged by the server.
   *
   * `options` is entirely optional and an empty one has to answer exactly what
   * this method answered before it took any: every visible document, most
   * recently updated first. Several screens still read the whole list to count
   * things, so a default page size here would quietly change their totals.
   */
  async getDocuments(userId: string, options: ListDocumentsQuery = {}) {
    const tokens = (options.q ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, DOCUMENT_SEARCH_MAX_TOKENS);

    const statuses = options.status ?? [];

    // Who is asking: whose steps count as theirs today, and whether they are
    // an administrator, who reads every memo rather than only their own.
    const { actingFor, cover, isAdministrator } = await viewerFor(userId);

    const where: Prisma.DocumentWhereInput = {
      AND: [
        // A coarse prefilter, not the access rule. Whether the workflow has
        // actually reached this person is decided in JS below, on purpose:
        // expressing that in SQL is how a document becomes readable by an
        // approver whose turn has not come, and this list is where that would
        // be least visible.
        prismaDocumentAccessFilter(userId, actingFor, isAdministrator),
        ...(statuses.length > 0 ? [{ status: { in: statuses } }] : []),
        // Every word must land somewhere, so word order does not matter and
        // "budget Chen" finds the same paper as "Chen budget".
        ...tokens.map((token) => ({
          OR: [
            // The reference is the handle people carry away from the system -
            // it is what is quoted in a reply and written on the file cover -
            // so typing it back in has to find the memo it names.
            {
              referenceNumber: {
                contains: token,
                mode: "insensitive" as const,
              },
            },
            { title: { contains: token, mode: "insensitive" as const } },
            { description: { contains: token, mode: "insensitive" as const } },
            {
              preparer: {
                firstName: { contains: token, mode: "insensitive" as const },
              },
            },
            {
              preparer: {
                lastName: { contains: token, mode: "insensitive" as const },
              },
            },
          ],
        })),
      ],
    };

    /*
     * Two passes, because the access rule stays in JavaScript.
     *
     * Whether the workflow has actually reached a person is decided below,
     * deliberately - expressing it in SQL is how a document becomes readable
     * by an approver whose turn has not come. That means every candidate row
     * has to be *considered*, which is fine. What was not fine was fetching
     * each one in full to do it: every matching document with its chain,
     * every step, and a user object per step. At ten thousand memos that is
     * thirty thousand nested rows built, shipped and thrown away in order to
     * show twenty-five - and it cost the same on page forty as on page one.
     *
     * This pass reads only what the rule needs. The rich shape is fetched
     * afterwards, for the page, which is twenty-five rows however large the
     * corpus gets.
     */
    const candidates = await prisma.document.findMany({
      where,
      select: {
        id: true,
        preparerId: true,
        // Read by the administrator rule, which lets a draft stay its
        // author's. Nothing else in this pass uses it.
        status: true,
        currentWorkflowRun: {
          select: {
            status: true,
            currentStepOrder: true,
            chain: {
              select: {
                steps: { select: { assignedUserId: true, stepOrder: true } },
              },
            },
          },
        },
        workflowRuns: {
          select: {
            currentStepOrder: true,
            actions: {
              where: { actorId: userId },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
      orderBy: DOCUMENT_SORT_ORDER_BY[options.sort ?? "recently_updated"],
    });

    const visibleIds = candidates
      .filter((document) =>
        canUserViewDocument({
          preparerId: document.preparerId,
          status: document.status,
          userId,
          actingFor,
          isAdministrator,
          currentWorkflowRun: document.currentWorkflowRun,
          workflowRunHistory: document.workflowRuns,
          hasUserActed: documentHasUserActed(document.workflowRuns),
        })
      )
      .map((document) => document.id);

    /*
     * The page, cut here - after the access filter, and never with a `take`
     * in the query above. The database can only apply the coarse prefilter,
     * so a `take: 10` would count rows this person turns out not to be
     * allowed to see: the page would arrive with three documents on it and
     * `total` would be a count of documents nobody can open.
     *
     * With neither limit nor offset the whole list comes back, unpaged. Every
     * caller that sends no parameters reads the result as the complete set -
     * the KPI row, the queue tab counts and the command palette all count
     * over it - so paging by default would not paginate those screens, it
     * would make them wrong.
     */
    const offset = Math.max(options.offset ?? 0, 0);
    const take = Math.min(
      Math.max(options.limit ?? DOCUMENTS_DEFAULT_LIMIT, 1),
      DOCUMENTS_MAX_LIMIT
    );
    const pageIds =
      options.limit === undefined && options.offset === undefined
        ? visibleIds
        : visibleIds.slice(offset, offset + take);

    const documents = await prisma.document.findMany({
      where: { id: { in: pageIds } },

      include: {
        preparer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            designation: true,
          },
        },
        currentWorkflowRun: {
          select: {
            id: true,
            status: true,
            currentStepOrder: true,
            currentStepStartedAt: true,
            policyFrozenAt: true,
            policySlaDefaultDays: true,
            chain: {
              select: {
                steps: {
                  orderBy: {
                    stepOrder: "asc",
                  },
                  select: {
                    id: true,
                    stepOrder: true,
                    approvalType: true,
                    assignedUserId: true,
                    slaDays: true,
                    assignedUser: {
                      select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        designation: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        workflowRuns: {
          select: {
            currentStepOrder: true,
            actions: {
              where: { actorId: userId },
              select: { id: true },
              take: 1,
            },
          },
        },
      },

      orderBy: DOCUMENT_SORT_ORDER_BY[options.sort ?? "recently_updated"],
    });

    /*
     * Back into the order the first pass established.
     *
     * `where: { id: { in: [...] } }` says nothing about order, so without
     * this a sorted list arrives shuffled - and it would arrive shuffled
     * only once there was more than one page, which is the worst way for
     * that to be discovered.
     */
    const byId = new Map(documents.map((document) => [document.id, document]));
    const pageOfDocuments = pageIds
      .map((id) => byId.get(id))
      .filter((document): document is (typeof documents)[number] => Boolean(document));

    const documentsResult = pageOfDocuments.map(
      ({ currentWorkflowRun, workflowRuns: _workflowRuns, ...rest }) => {
      const run = currentWorkflowRun;
      const totalSteps = run?.chain.steps.length ?? 0;
      const isActiveRun =
        rest.status !== "REVISION_REQUESTED" && run?.status === "IN_PROGRESS";

      const currentStep = isActiveRun
        ? run.chain.steps.find(
            (step) => step.stepOrder === run.currentStepOrder
          )
        : null;

      // Who this goes to after the current holder acts. An approver deciding
      // whether to approve or send back benefits from knowing whether they
      // are the last gate; the chain is already loaded, so this costs nothing.
      const nextStep = isActiveRun
        ? run.chain.steps.find(
            (step) => step.stepOrder === run.currentStepOrder + 1
          )
        : null;

      let workflow: { currentStepOrder: number; totalSteps: number } | null =
        null;

      if (isActiveRun && run) {
        workflow = {
          currentStepOrder: run.currentStepOrder,
          totalSteps,
        };
      } else if (rest.status === "REVISION_REQUESTED" && run) {
        workflow = {
          currentStepOrder: 0,
          totalSteps,
        };
      } else if (
        (rest.status === "APPROVED" || rest.status === "REJECTED") &&
        run
      ) {
        workflow = {
          currentStepOrder:
            rest.status === "APPROVED" ? totalSteps : run.currentStepOrder,
          totalSteps,
        };
      } else if (rest.status === "DELETED" && run) {
        workflow = {
          currentStepOrder: 0,
          totalSteps,
        };
      }

      /*
       * When this step is due, or null when nothing has set a deadline.
       *
       * Computed rather than stored: the allowance lives on the step and the
       * clock on the run, and a third copy is one more thing that can drift
       * away from both. `dueAtFor` answers null unless the step or the
       * deployment named a number of days, which is why the column can be
       * shown at all - there is no invented date in it.
       */
      const dueAt =
        isActiveRun && run && currentStep
          ? dueAtFor(run.currentStepStartedAt, currentStep.slaDays, runDeadlineDefault(run))
          : null;

      return {
        ...rest,
        dueAt,
        /*
         * Whether this belongs in My queue. Decided here, with the viewer's
         * delegations, rather than in the browser from `currentStep`: that
         * names the person the step is assigned to, which for a delegate is
         * somebody else.
         */
        // A cover limited to some kinds of memo makes only those wait on them.
        awaitingMyAction: isAwaitingActionBy(
          { status: rest.status, preparerId: rest.preparerId, currentWorkflowRun },
          userId,
          actingForMemo(cover, rest.memoType ?? null)
        ),
        currentStep: currentStep
          ? {
              id: currentStep.id,
              stepOrder: currentStep.stepOrder,
              approvalType: currentStep.approvalType,
              assignedUser: currentStep.assignedUser,
              slaDays: currentStep.slaDays,
            }
          : null,
        nextStep: nextStep
          ? {
              stepOrder: nextStep.stepOrder,
              approvalType: nextStep.approvalType,
              assignedUser: nextStep.assignedUser,
            }
          : null,
        workflow,
      };
    }
    );

    // `total` counts what matched, `returned` counts what came back. Without
    // both, a screen showing 25 of 300 rows cannot tell whether it is looking
    // at a page or at everything there is.
    return {
      documents: documentsResult,
      total: visibleIds.length,
      returned: documentsResult.length,
    };
  }

  /**
   * Every workflow currently in progress across the organisation, with who it
   * is waiting on and since when. Administrators are the only role that can
   * act on a stalled workflow, and until now they had no way to find one —
   * their own document list is narrower than an ordinary approver's.
   *
   * Deliberately not filtered by the caller: this is an oversight view, and
   * the route restricts it to administrators.
   */
  async getApprovalOversight() {
    const documents = await prisma.document.findMany({
      where: {
        status: "PENDING_REVIEW",
        currentWorkflowRun: { status: "IN_PROGRESS" },
      },
      select: {
        id: true,
        referenceNumber: true,
        title: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        submittedAt: true,
        currentVersionNumber: true,
        preparer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            designation: true,
            department: { select: { name: true } },
          },
        },
        currentWorkflowRun: {
          select: {
            currentStepOrder: true,
            startedAt: true,
            currentStepStartedAt: true,
            policyFrozenAt: true,
            policySlaDefaultDays: true,
            breachNotifiedAt: true,
            chain: {
              select: {
                steps: {
                  orderBy: { stepOrder: "asc" },
                  select: {
                    stepOrder: true,
                    approvalType: true,
                    slaDays: true,
                    assignedUser: {
                      select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        designation: true,
                        department: { select: { name: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { updatedAt: "asc" },
    });

    const items = documents.map((document) => {
      const run = document.currentWorkflowRun!;
      const steps = run.chain.steps;
      const current = steps.find((s) => s.stepOrder === run.currentStepOrder);

      /*
       * How long it has sat with the *current* holder, which is the number an
       * administrator is chasing — not how long the document has existed.
       *
       * Read from the run's own column rather than rebuilt from the last
       * approval action. The two agreed for as long as approving was the only
       * thing that could move a step, and parted company the moment one could
       * be reassigned: that writes no approval action, because nobody
       * approved anything, so the reconstruction still named the moment the
       * memo was submitted. An administrator who moved a stuck memo off
       * somebody saw the board unchanged - same row, same week, same red -
       * against a person who had held it for a minute. `dueAt` two lines down
       * has always read this column; having a second answer to "since when"
       * is what let them disagree.
       */
      const heldSince = run.currentStepStartedAt;

      return {
        id: document.id,
        // An administrator chasing a stalled memo is chasing it by the
        // reference somebody quoted at them, not by its uuid.
        referenceNumber: document.referenceNumber,
        title: document.title,
        versionNumber: document.currentVersionNumber,
        submittedAt: document.submittedAt ?? document.createdAt,
        updatedAt: document.updatedAt,
        heldSince,
        preparer: {
          id: document.preparer.id,
          firstName: document.preparer.firstName,
          lastName: document.preparer.lastName,
          designation: document.preparer.designation ?? null,
          department: document.preparer.department?.name ?? null,
        },
        holder: current
          ? {
              id: current.assignedUser.id,
              firstName: current.assignedUser.firstName,
              lastName: current.assignedUser.lastName,
              designation: current.assignedUser.designation ?? null,
              department: current.assignedUser.department?.name ?? null,
              approvalType: current.approvalType,
            }
          : null,
        currentStepOrder: run.currentStepOrder,
        totalSteps: steps.length,
        /*
         * The deadline, and whether anybody has been told about it.
         *
         * Both null on a deployment that has set no deadlines, which is what
         * keeps the Control room's breach figures off rather than zero: a
         * board reading "0 breaching" where no deadline exists is a claim,
         * and the board says nothing instead.
         */
        dueAt: dueAtFor(run.currentStepStartedAt, current?.slaDays ?? null, runDeadlineDefault(run)),
        chasedAt: run.breachNotifiedAt,
      };
    });

    return { items, total: items.length };
  }

  /**
   * What stops if this person does.
   *
   * The question an administrator has when somebody resigns, goes on long
   * leave, or changes job, and the one the product could not answer. Every
   * screen was organised by memo: open a memo, see who is holding it. Nothing
   * was organised by person, so "Kazim leaves on Friday - what breaks?" could
   * only be answered by opening every memo in flight and reading its chain.
   * In practice it was answered by waiting: the memo travelled to somebody
   * who could not act, stopped, and was noticed on the Control room a week
   * later as a red row.
   *
   * Four ways one person stops a memo, and they are genuinely different
   * problems rather than four shades of one:
   *
   *   - it is with them now. The memo has stopped already.
   *   - their step is ahead of where the memo has got to. It has not stopped
   *     yet and it will, and this is the whole reason for asking in advance.
   *   - it was sent back to them for revision. Only the preparer can resubmit
   *     a memo - the service refuses anybody else in so many words - so this
   *     one has no cure in reassignment: moving an approver changes nothing
   *     about who may correct the document. The screen has to say so rather
   *     than offering a button that cannot help.
   *   - it was sent back to SOMEBODY ELSE, and their step is on its chain.
   *     A resubmission starts a fresh run at step 1 over the same chain, so
   *     every approver on it sees the memo again - including one who already
   *     signed the run that was returned. This answered zero for all of them:
   *     the query above asks for documents in flight, and a memo out for
   *     revision is not one. So an approver could be switched off, on the
   *     word of this list, while a memo that will stop dead at their step
   *     sat with its preparer. They cannot be moved either, not yet -
   *     `reassignStep` refuses a document that is not PENDING_REVIEW - which
   *     is exactly why it has to be said early.
   *
   * Nothing here is scoped to the reader: it crosses every memo in the
   * organisation by construction, which is why it sits behind the same
   * administrator-only rule as the oversight queue.
   */
  async getMemosHeldBy(userId: string) {
    const person = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        loginRole: true,
        department: { select: { name: true } },
      },
    });

    if (!person) {
      throw errors.notFound("That person is no longer listed.");
    }

    const [onChains, sentBack, sentBackPastThem] = await Promise.all([
      /*
       * Every in-flight memo whose chain names them anywhere. The steps they
       * hold come back with the row - `where` inside the relation - because
       * one person can hold two steps on one chain only by a route nobody
       * offers, and reading the whole chain back to find one name would be
       * the same query with more rows.
       */
      prisma.document.findMany({
        where: {
          status: "PENDING_REVIEW",
          currentWorkflowRun: {
            status: "IN_PROGRESS",
            chain: { steps: { some: { assignedUserId: userId } } },
          },
        },
        select: {
          id: true,
          referenceNumber: true,
          title: true,
          submittedAt: true,
          createdAt: true,
          preparer: {
            select: { id: true, firstName: true, lastName: true },
          },
          currentWorkflowRun: {
            select: {
              currentStepOrder: true,
              currentStepStartedAt: true,
              policyFrozenAt: true,
              policySlaDefaultDays: true,
              chain: {
                select: {
                  _count: { select: { steps: true } },
                  steps: {
                    where: { assignedUserId: userId },
                    orderBy: { stepOrder: "asc" },
                    select: {
                      stepOrder: true,
                      approvalType: true,
                      slaDays: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { updatedAt: "asc" },
      }),
      prisma.document.findMany({
        where: { status: "REVISION_REQUESTED", preparerId: userId },
        select: {
          id: true,
          referenceNumber: true,
          title: true,
          submittedAt: true,
          createdAt: true,
          updatedAt: true,
          preparer: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { updatedAt: "asc" },
      }),
      /*
       * The same memos, read from the other side: sent back to somebody else,
       * with this person's name on the chain it will travel again.
       *
       * Read off `approvalChain` rather than off the workflow run. The run
       * that was returned is superseded the moment the memo is resubmitted,
       * and a new one is built over this same chain starting at step one - so
       * the chain, not the run, is what says who this memo will reach.
       */
      prisma.document.findMany({
        where: {
          status: "REVISION_REQUESTED",
          preparerId: { not: userId },
          approvalChain: { steps: { some: { assignedUserId: userId } } },
        },
        select: {
          id: true,
          referenceNumber: true,
          title: true,
          submittedAt: true,
          createdAt: true,
          preparer: { select: { id: true, firstName: true, lastName: true } },
          approvalChain: {
            select: {
              _count: { select: { steps: true } },
              steps: {
                where: { assignedUserId: userId },
                orderBy: { stepOrder: "asc" },
                select: { stepOrder: true, approvalType: true },
              },
            },
          },
        },
        orderBy: { updatedAt: "asc" },
      }),
    ]);

    const holdingNow: HeldMemo[] = [];
    const ahead: HeldMemo[] = [];

    for (const document of onChains) {
      const run = document.currentWorkflowRun!;
      const totalSteps = run.chain._count.steps;

      for (const step of run.chain.steps) {
        /*
         * A step the memo has already passed is not a reason it will stop:
         * they signed it, or it was skipped past them, and either way the
         * memo is done with that name. Counting those would put somebody who
         * approved forty memos last month at the top of a list of people
         * holding things up.
         */
        if (step.stepOrder < run.currentStepOrder) continue;

        const isCurrent = step.stepOrder === run.currentStepOrder;
        const entry: HeldMemo = {
          documentId: document.id,
          referenceNumber: document.referenceNumber,
          title: document.title,
          submittedAt: document.submittedAt ?? document.createdAt,
          preparer: document.preparer,
          stepOrder: step.stepOrder,
          approvalType: step.approvalType,
          totalSteps,
          // Only meaningful for the step the memo is sitting on: a step ahead
          // has not started, so there is no "since when" to report and no
          // deadline running against it.
          heldSince: isCurrent ? run.currentStepStartedAt : null,
          dueAt: isCurrent
            ? dueAtFor(run.currentStepStartedAt, step.slaDays ?? null, runDeadlineDefault(run))
            : null,
          // How many approvals stand between the memo and them, which is the
          // difference between "look at this today" and "before month end".
          stepsAway: step.stepOrder - run.currentStepOrder,
        };

        (isCurrent ? holdingNow : ahead).push(entry);
      }
    }

    const returned: HeldMemo[] = sentBack.map((document) => ({
      documentId: document.id,
      referenceNumber: document.referenceNumber,
      title: document.title,
      submittedAt: document.submittedAt ?? document.createdAt,
      preparer: document.preparer,
      stepOrder: null,
      approvalType: null,
      totalSteps: null,
      heldSince: document.updatedAt,
      dueAt: null,
      stepsAway: 0,
    }));

    const comingBack: HeldMemo[] = sentBackPastThem.flatMap((document) =>
      (document.approvalChain?.steps ?? []).map((step) => ({
        documentId: document.id,
        referenceNumber: document.referenceNumber,
        title: document.title,
        submittedAt: document.submittedAt ?? document.createdAt,
        preparer: document.preparer,
        stepOrder: step.stepOrder,
        approvalType: step.approvalType,
        totalSteps: document.approvalChain?._count.steps ?? null,
        /*
         * Neither a wait nor a deadline. The memo is with its preparer, and
         * nothing is running against this step - it has not started, and the
         * run it last started under has been superseded.
         */
        heldSince: null,
        dueAt: null,
        // How many approvals will come before theirs when the memo goes round
        // again, which starts at step one however far it got last time.
        stepsAway: step.stepOrder - 1,
      }))
    );

    return {
      person: {
        id: person.id,
        firstName: person.firstName,
        lastName: person.lastName,
        email: person.email,
        department: person.department?.name ?? null,
      },
      holdingNow,
      ahead,
      returned,
      comingBack,
      /*
       * One number for "how much stops", which is what a confirmation dialog
       * has room for. Counted across all four because all four stop a memo,
       * even though only the first two can be moved to somebody else today.
       */
      total:
        holdingNow.length + ahead.length + returned.length + comingBack.length,
    };
  }

  async getPendingApprovalCount(userId: string) {
    /*
     * The steps this person is answerable for: their own, and anybody's they
     * are currently covering.
     *
     * Counting only their own is what made a delegation invisible. The
     * delegate was emailed that a memo needed them, the badge stayed at zero,
     * and the memo was counted against the person who was away - so the one
     * number meant to say "what is waiting on me" answered it for everybody
     * except the person the feature exists for.
     */
    const cover = await delegationsService.coverHeldBy(userId);
    const holders = [userId, ...new Set(cover.map((held) => held.delegatorId))];

    const documents = await prisma.document.findMany({
      where: {
        status: "PENDING_REVIEW",
        preparerId: { not: userId },
        currentWorkflowRun: {
          status: "IN_PROGRESS",
          chain: {
            steps: {
              some: {
                assignedUserId: { in: holders },
              },
            },
          },
        },
      },
      select: {
        status: true,
        preparerId: true,
        memoType: true,
        currentWorkflowRun: {
          select: {
            status: true,
            currentStepOrder: true,
            chain: {
              select: {
                steps: {
                  where: { assignedUserId: { in: holders } },
                  select: { assignedUserId: true, stepOrder: true },
                },
              },
            },
          },
        },
      },
    });

    // The same rule the document list marks `awaitingMyAction` with, so the
    // badge and My queue cannot disagree.
    const count = documents.filter((document) =>
      isAwaitingActionBy(document, userId, actingForMemo(cover, document.memoType))
    ).length;

    return { count };
  }

  async getDocumentById(documentId: string, userId: string) {
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      include: {
        preparer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            designation: true,
          },
        },
        versions: {
          where: { isDeleted: false },
          orderBy: { versionNumber: "desc" },
          take: 1,
        },
        approvalChain: {
          include: {
            steps: {
              orderBy: { stepOrder: "asc" },
              include: {
                assignedUser: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    designation: true,
                  },
                },
              },
            },
          },
        },
        currentWorkflowRun: {
          include: {
            documentVersion: true,
            chain: {
              include: {
                steps: {
                  orderBy: { stepOrder: "asc" },
                  include: {
                    assignedUser: {
                      select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        designation: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        workflowRuns: {
          select: {
            currentStepOrder: true,
            actions: {
              where: { actorId: userId },
              select: { id: true },
              take: 1,
            },
          },
        },
        // Every attachment the memo has had, so each version's own set can
        // be shown; `supportingDocuments` below is the current version's.
        supportingDocuments: {
          orderBy: { uploadedAt: "asc" },
          select: {
            id: true,
            fileName: true,
            contentType: true,
            sizeBytes: true,
            uploadedAt: true,
            isDeleted: true,
            addedInVersion: true,
            removedInVersion: true,
          },
        },
      },
    });

    if (!document) {
      throw errors.notFound("Document not found");
    }

    const currentRun = document.currentWorkflowRun;

    if (
      !canUserViewDocument({
        preparerId: document.preparerId,
        status: document.status,
        ...(await viewerFor(userId)),
        approvalChain: document.approvalChain,
        currentWorkflowRun: currentRun,
        workflowRunHistory: document.workflowRuns,
        hasUserActed: documentHasUserActed(document.workflowRuns),
      })
    ) {
      throw errors.forbidden("Access denied");
    }

    const {
      workflowRuns: _workflowRuns,
      supportingDocuments: everyAttachment,
      ...documentResult
    } = document;

    const currentStep =
      document.status !== "REVISION_REQUESTED" &&
      currentRun?.status === "IN_PROGRESS"
        ? currentRun.chain.steps.find(
            (step) => step.stepOrder === currentRun.currentStepOrder
          )
        : null;

    /*
     * The version that is actually in flight, which is what anybody signing
     * this document is signing. `versions[0]` is the newest row, and during a
     * revision cycle those are not the same thing.
     */
    const liveVersion =
      currentRun?.status === "IN_PROGRESS"
        ? currentRun.documentVersion
        : document.versions[0];

    return {
      ...documentResult,
      /** What the current version carries. */
      supportingDocuments: everyAttachment
        .filter((attachment) => !attachment.isDeleted)
        .map(({ isDeleted: _isDeleted, ...attachment }) => attachment),
      /**
       * Every attachment the memo has had, with the versions it was on: a
       * version carries those added at or before it and not removed by it.
       */
      supportingHistory: everyAttachment.map(({ isDeleted: _isDeleted, ...attachment }) => attachment),
      /*
       * Whether a resubmission of this memo has to be signed by its preparer -
       * the rule `updateDocument` enforces, from the memo's own type. The
       * screen used to guess from the organisation's switch alone, and for an
       * Approval Request with that switch off it sent an unsigned upload the
       * server then refused.
       */
      resubmissionSigned: preparerMustSign(document.memoType),
      currentStep: currentStep
        ? {
            id: currentStep.id,
            stepOrder: currentStep.stepOrder,
            approvalType: currentStep.approvalType,
            assignedUser: currentStep.assignedUser,
          }
        : null,
      /*
       * Where this reader's own signature belongs, if the memo was typed in
       * the portal and prints a line with their name under it.
       *
       * Only their own. The whole strip is printed on the page for anybody
       * who can open it, so this hides nothing - it is narrowed because a
       * caller that is handed every slot has to work out which one is theirs,
       * and getting that wrong means signing on somebody else's line of a
       * document that cannot be redrawn.
       *
       * Null for an uploaded memo, for a reader who is not on the strip, and
       * for every memo submitted before this existed.
       */
      mySignatureSlot: findSignatureSlot(liveVersion?.signatureSlots, userId),
    };
  }

  /**
   * What changed between the version in flight and the one before it.
   *
   * For an approver asked to read a memo a second time. Each version records
   * the body it was drawn from, so the two are compared block by block (see
   * `lib/memoDiff`) and the reading is laid beside the PDF. The PDFs are not
   * touched and nothing is written: this is the same access as opening the
   * document, applied to text the reader could already open version by
   * version.
   *
   * The previous version is read whether or not it is superseded
   * (`isDeleted`), because superseded is exactly what the version being
   * compared against is. The comparison is of what was written, so a
   * version uploaded as a PDF on either side has nothing to compare and the
   * answer says so rather than guessing.
   */
  async getVersionChanges(documentId: string, userId: string) {
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      include: {
        versions: {
          where: { isDeleted: false },
          orderBy: { versionNumber: "desc" },
          take: 1,
        },
        approvalChain: {
          include: { steps: { orderBy: { stepOrder: "asc" } } },
        },
        currentWorkflowRun: {
          include: {
            documentVersion: true,
            chain: { include: { steps: { orderBy: { stepOrder: "asc" } } } },
          },
        },
        workflowRuns: {
          select: {
            currentStepOrder: true,
            actions: {
              where: { actorId: userId },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    });

    if (!document) {
      throw errors.notFound("Document not found");
    }

    const currentRun = document.currentWorkflowRun;

    if (
      !canUserViewDocument({
        preparerId: document.preparerId,
        status: document.status,
        ...(await viewerFor(userId)),
        approvalChain: document.approvalChain,
        currentWorkflowRun: currentRun,
        workflowRunHistory: document.workflowRuns,
        hasUserActed: documentHasUserActed(document.workflowRuns),
      })
    ) {
      throw errors.forbidden("Access denied");
    }

    // The version in flight, as `getDocumentById` picks it: during a
    // revision cycle the newest row and the one being signed differ.
    const live =
      currentRun?.status === "IN_PROGRESS"
        ? currentRun.documentVersion
        : document.versions[0];

    const previous =
      live && live.versionNumber > 1
        ? await prisma.documentVersion.findFirst({
            where: { documentId, versionNumber: live.versionNumber - 1 },
          })
        : null;

    /*
     * Who sent the previous version back, and what they said. The request
     * for revision is recorded against the version it was made on, which is
     * the one being compared against - so this is the reason v2 exists.
     */
    const returned = previous
      ? await prisma.approvalAction.findFirst({
          where: {
            documentVersionId: previous.id,
            action: "REQUEST_REVISION",
          },
          orderBy: { createdAt: "desc" },
          select: {
            comment: true,
            createdAt: true,
            actor: { select: { firstName: true, lastName: true } },
          },
        })
      : null;

    const bodyOf = (json: Prisma.JsonValue | null): MemoBody | null => {
      if (!json) return null;
      const parsed = memoBodySchema.safeParse(json);
      return parsed.success ? (parsed.data) : null;
    };
    const notesOf = (json: Prisma.JsonValue | null): MemoNote[] =>
      Array.isArray(json) ? (json as unknown as MemoNote[]) : [];

    const describe = (version: {
      versionNumber: number;
      uploadedAt: Date;
      bodyJson: Prisma.JsonValue | null;
    }) => ({
      versionNumber: version.versionNumber,
      filedAt: version.uploadedAt,
      typed: bodyOf(version.bodyJson) !== null,
    });

    const currentBody = live ? bodyOf(live.bodyJson) : null;
    const previousBody = previous ? bodyOf(previous.bodyJson) : null;

    return {
      current: live ? describe(live) : null,
      previous: previous ? describe(previous) : null,
      returned: returned
        ? {
            by: `${returned.actor.firstName} ${returned.actor.lastName}`,
            at: returned.createdAt,
            comment: returned.comment,
          }
        : null,
      changes:
        currentBody && previousBody
          ? diffMemoBodies(previousBody, currentBody)
          : null,
      notes:
        live && previous
          ? diffNotes(notesOf(previous.pageNotesJson), notesOf(live.pageNotesJson))
          : null,
    };
  }

  /**
   * @param reason Why the bytes were asked for. `VIEW` is the memo being read
   * on screen; `DOWNLOAD` is a copy leaving the system. It decides which row
   * the trail gets, and nothing else - both serve identical bytes, and
   * neither is a weaker permission than the other.
   */
  async getDocumentFile(
    documentId: string,
    userId: string,
    reason: "VIEW" | "DOWNLOAD" = "DOWNLOAD"
  ) {
    const document = await this.getDocumentById(documentId, userId);

    // A withdrawn memo is on record, and its file with it.
    const version =
      document.currentWorkflowRun?.status === "IN_PROGRESS"
        ? document.currentWorkflowRun.documentVersion
        : document.versions[0];

    if (!version) {
      throw errors.notFound("Document file not found");
    }

    // What to serve, in order of what the reader is entitled to see:
    //
    //   1. the approved version, once there is one — fixed at final approval
    //      and never recomputed, so HR prints the same bytes every time;
    //   2. otherwise the document as it stands, which is the version plus
    //      every signature applied so far in the current run;
    //   3. otherwise the version itself, which is the case before anyone has
    //      signed and for any document approved before signatures were kept
    //      as separate objects.
    //
    // Approvals no longer write over the version's own file, so (3) is the
    // document as submitted rather than whatever the last approver left.
    const inProgressSigned = document.finalSignedStoragePath
      ? null
      : await this.latestSignedPath(document.currentWorkflowRun?.id);

    const storagePath =
      document.finalSignedStoragePath ??
      inProgressSigned?.path ??
      version.storagePath;

    // Whatever was written down about the file being served, and nothing
    // else: the approved memo's own digest, or this approver's, or the one
    // taken when the version was submitted.
    const recordedChecksum = document.finalSignedStoragePath
      ? document.finalSignedChecksum
      : (inProgressSigned?.checksum ?? version.storageChecksum);

    const buffer = await storageService.downloadDocument(storagePath);

    /*
     * The one place a changed file can still be caught before it is believed.
     *
     * Nothing in the service overwrites these objects, but the digest is not
     * a check on the service - it is a check on the filesystem underneath it,
     * where a restore from the wrong backup, a botched migration or somebody
     * with a shell all land. A memo that does not match what was signed is
     * not a memo with a caveat; it is refused, and the refusal says so.
     *
     * `unrecorded` passes: those are the memos approved before digests were
     * kept, and there is nothing to check them against.
     */
    if (verifyChecksum(buffer, recordedChecksum) === "mismatch") {
      /*
       * Logged at error and named, because this is the one line here that
       * might matter to somebody other than an engineer: it says a signed
       * file on disk no longer matches what was signed. Everything needed to
       * investigate is an identifier - nothing about the memo's contents
       * belongs in a log, least of all this memo's.
       */
      logger.error("document.integrity.mismatch", { documentId, storagePath });
      throw errors.internal(
        "This file no longer matches the copy that was signed, so it has not been served. Report this to your administrator quoting the document reference."
      );
    }
    const fileName = `document-${documentId.slice(0, 8)}-v${version.versionNumber}.pdf`;

    // Recorded after the bytes were actually produced, so the trail claims a
    // copy left the system only when one did. A memo carries somebody's pay
    // or their conduct on it: once a copy is in circulation, "who has one"
    // is a question the record has to be able to answer, and it cannot
    // answer it later for a download it never saw.
    await auditService.createAuditLog({
      actorId: userId,
      action: reason === "VIEW" ? "DOCUMENT_VIEWED" : "DOCUMENT_DOWNLOADED",
      entityType: "Document",
      entityId: documentId,
      newValue: {
        fileName,
        // Which file, not just which document: the same memo has an as-
        // submitted copy, a part-signed one and an approved one, and a row
        // that does not say which of them was served cannot settle an
        // argument about what somebody was holding.
        storagePath,
        versionNumber: version.versionNumber,
        servedFile: document.finalSignedStoragePath
          ? "APPROVED"
          : inProgressSigned
            ? "PART_SIGNED"
            : "AS_SUBMITTED",
        // The digest of what actually left, so a copy in circulation can be
        // matched back to this row rather than argued about.
        checksum: recordedChecksum ?? sha256(buffer),
        integrity: recordedChecksum ? "VERIFIED" : "UNRECORDED",
      },
    });

    return { buffer, fileName };
  }

  /**
   * Record that the approved memo went to a printer.
   *
   * The gate, not the audit row, is the point of this call. "Print" here means
   * the approved memo: a part-signed draft sent to a printer and put in the
   * file looks exactly like the real thing on paper, and there is nothing on
   * the sheet to say the last approver never signed it. Refusing before the
   * document is APPROVED, and before the approved file has actually been
   * fixed, is what keeps a draft out of the registry.
   *
   * Access is decided first, by the same rule as reading the document: who is
   * allowed to print it is not a separate question from who may open it.
   */
  async printDocument(documentId: string, userId: string) {
    const document = await this.getDocumentById(documentId, userId);

    if (document.status !== "APPROVED") {
      throw errors.conflict(
        "This memo is not yet approved, so there is no approved copy to print."
      );
    }

    if (!document.finalSignedStoragePath) {
      // Approved, but no signed file was ever fixed against it - the memos
      // approved before the approved version was recorded. There is nothing
      // to certify as the printed record, so this is still a refusal.
      throw errors.conflict(
        "This memo is not yet approved for printing: no approved copy was recorded when it was approved."
      );
    }

    await auditService.createAuditLog({
      actorId: userId,
      action: "DOCUMENT_PRINTED",
      entityType: "Document",
      entityId: documentId,
      newValue: {
        referenceNumber: document.referenceNumber,
        storagePath: document.finalSignedStoragePath,
      },
    });
  }

  /**
   * The newest signature artefact in a run, if any approver has signed, with
   * the digest recorded when it was written - the two belong together, since
   * checking a file against another file's digest is worse than not checking.
   */
  private async latestSignedPath(
    workflowRunId: string | undefined
  ): Promise<{ path: string; checksum: string | null } | null> {
    if (!workflowRunId) return null;

    const latest = await prisma.approvalAction.findFirst({
      where: {
        workflowRunId,
        action: "APPROVE",
        signedPdfStoragePath: { not: null },
      },
      orderBy: { createdAt: "desc" },
      select: { signedPdfStoragePath: true, signedPdfChecksum: true },
    });

    return latest?.signedPdfStoragePath
      ? { path: latest.signedPdfStoragePath, checksum: latest.signedPdfChecksum }
      : null;
  }

  async getSupportingDocumentFile(
    documentId: string,
    attachmentId: string,
    userId: string
  ) {
    // Access check via document visibility
    await this.getDocumentById(documentId, userId);

    // Current or not: one taken off a later version is what an earlier
    // version carried, and stays readable to whoever can open the memo.
    const attachment = await prisma.supportingDocument.findFirst({
      where: {
        id: attachmentId,
        documentId,
      },
    });

    if (!attachment) {
      throw errors.notFound("Supporting document not found");
    }

    const buffer = await storageService.downloadDocument(attachment.storagePath);

    return {
      buffer,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
    };
  }

  async updateDocument(
  documentId: string,
  input: UpdateDocumentInput,
  file: Express.Multer.File | undefined,
  userId: string,
  supportingFiles: Express.Multer.File[] = [],
  attestation?: SigningAttestation
) {
  const { title, description, approvalChain, signature } = input;

  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      title: true,
      preparerId: true,
      status: true,
      currentVersionNumber: true,
      currentWorkflowRunId: true,
      // What this memo is. A revision to one that was typed in the portal is
      // typed again, and the header it prints comes from these three rather
      // than from the request - the memo being revised is the same memo.
      memoType: true,
      memoTo: true,
      memoFrom: true,
      memoDate: true,
      withdrawnById: true,
      rejectionClosedAt: true,
    },
  });

  if (!document) throw errors.notFound("Document not found");
  if (document.preparerId !== userId) {
    throw errors.forbidden("Only the document preparer can update the document.");
  }

  /*
   * An administrator's cancel is final. It used to leave the memo exactly as
   * a withdrawal does, so its preparer could upload over it and send it round
   * again - undoing, alone, a decision somebody with the power had taken. The
   * way on is a new memo, with its own reference and route.
   */
  if (document.status === "DELETED" && isCancelledByAdministrator(document)) {
    throw errors.conflict(
      "An administrator cancelled this memo, so it cannot be sent round again. Its record stays as it is. To go ahead, submit a new memo.",
      "CANCELLED_BY_ADMINISTRATOR"
    );
  }

  // The preparer's own decision, and as final as an administrator's cancel.
  if (document.status === "REJECTED" && document.rejectionClosedAt) {
    throw errors.conflict(
      "You left this memo as rejected, so it cannot be sent round again. Its record stays as it is. To go ahead, submit a new memo.",
      "REJECTION_CLOSED"
    );
  }

  const canResubmitRevision = document.status === "REVISION_REQUESTED";
  const canResubmitAfterDelete = document.status === "DELETED";
  /*
   * A rejection closes that approval cycle, not the memo. The preparer may
   * revise it and send it round again as a new version, which starts a new
   * cycle from the first step with the same approvers. The rejected cycle is
   * left exactly as it ended - its run stays REJECTED, its version and every
   * action on it stay on record - so the history shows both.
   *
   * This used to be reachable only by deleting the rejected memo and
   * uploading over the deleted one, which revived it under the same
   * reference with the rejection cleared from the document. Deleting a
   * rejected memo is now refused, and this is the way back.
   */
  const canResubmitAfterRejection = document.status === "REJECTED";

  if (!canResubmitRevision && !canResubmitAfterDelete && !canResubmitAfterRejection) {
    throw errors.badRequest(
      "Document can only be resubmitted after a revision request, after a rejection, or after it was withdrawn by the preparer."
    );
  }
  // The attachments the preparer took off, checked before anything is filed:
  // each must be one the current version carries.
  const removeSupportingIds = [...new Set(input.removeSupportingIds ?? [])];
  if (removeSupportingIds.length > 0) {
    const attached = await prisma.supportingDocument.count({
      where: { documentId, id: { in: removeSupportingIds }, isDeleted: false },
    });
    if (attached !== removeSupportingIds.length) {
      throw errors.badRequest(
        "One of the supporting files to remove is not on this memo any more. Reload it and try again."
      );
    }
  }

  /*
   * A revision arrives the way the memo did: a typed memo is typed again and
   * redrawn, an uploaded one is uploaded again.
   *
   * Both together is a client that has not decided which, and rather than
   * silently preferring one - the file, say, discarding an edit the preparer
   * spent an afternoon on - it is refused.
   */
  const typedRevision = input.body !== undefined;

  if (!file && !typedRevision) {
    throw errors.badRequest(
      document.memoType
        ? "Write the memo before resubmitting it, or upload a PDF in its place."
        : "A PDF is required to resubmit the document."
    );
  }
  if (file && typedRevision) {
    throw errors.badRequest(
      "Send either the memo text or a PDF to replace it, not both."
    );
  }
  if (typedRevision && !document.memoType) {
    throw errors.badRequest(
      "This memo was submitted as an uploaded PDF, so a revision to it is uploaded too."
    );
  }

  /*
   * Whether a correction is signed, decided from the memo's own type.
   *
   * Never from the request: a resubmission of a memo whose author signs it
   * must not be able to arrive unsigned, and one whose author does not must
   * not be able to arrive signed. Both would produce a v2 whose printed strip
   * and actual marks disagree with v1's, on the same document.
   */
  const mustSign = preparerMustSign(document.memoType);

  /* Resolved once, for the same reason as on a first submission. */
  const revisedNotes = usableNotes(input.notes);

  if (mustSign && !signature) {
    throw errors.badRequest(
      "This document has to be signed by the person submitting it."
    );
  }

  if (!mustSign && signature) {
    throw errors.badRequest(
      "This document is not signed by the person submitting it. It goes to " +
        "the first approver as it stands."
    );
  }

  if (approvalChain) {
    if (preparerIsInChain(approvalChain, userId)) {
      throw errors.badRequest(PREPARER_IN_CHAIN_MESSAGE);
    }

    const assignees = await prisma.user.findMany({
      where: { id: { in: approvalChain.map((step) => step.userId) } },
      select: { id: true },
    });
    if (assignees.length !== approvalChain.length) {
      throw errors.badRequest(
        "One or more users in the approval chain do not exist."
      );
    }

    // Replacing the chain deletes its steps, and ApprovalAction.chainStepId is
    // a required foreign key — so once anyone has acted, the delete is
    // restricted and the whole request used to fail with a 500. After a
    // revision request there is always such an action, which made this the
    // normal case rather than the edge one.
    const acted = await prisma.approvalAction.findFirst({
      where: { chainStep: { chain: { documentId } } },
      select: { id: true },
    });
    if (acted) {
      throw errors.badRequest(
        "The approval chain cannot be changed once an approver has acted on this document."
      );
    }
  }

  /*
   * Whoever the new cycle will go to must still be here. A first submission
   * refuses a chain naming somebody who has left; a resubmission sends the
   * memo round the chain it already has, and without this it would go
   * straight to an account nobody signs in to and wait there for good.
   */
  if (!approvalChain) {
    const leavers = await prisma.user.findMany({
      where: {
        deactivatedAt: { not: null },
        assignedChainSteps: { some: { chain: { documentId } } },
      },
      select: { firstName: true, lastName: true },
    });

    if (leavers.length > 0) {
      const names = leavers
        .map((user) => `${user.firstName} ${user.lastName}`.trim())
        .join(", ");
      throw errors.badRequest(
        leavers.length === 1
          ? `${names} no longer has an account here, so this memo cannot go back to them. Ask an administrator to hand their step to somebody else, then resubmit.`
          : `These people no longer have accounts here, so this memo cannot go back to them: ${names}. Ask an administrator to hand their steps to somebody else, then resubmit.`
      );
    }
  }

  const currentVersion = await prisma.documentVersion.findFirst({
    where: { documentId, versionNumber: document.currentVersionNumber },
  });

  if (!currentVersion) {
    throw errors.internal("Current document version not found.");
  }

  const oldVersion = currentVersion;
  const versionNumber = currentVersion.versionNumber + 1;
  /*
   * Named per attempt, not only per version. Two resubmissions arriving
   * together both compute the same next version; with a shared name the one
   * that lost cleaned up by deleting the file the winner had just filed. The
   * stored path is what every reader uses, so the suffix costs nothing.
   */
  const attempt = randomUUID().slice(0, 8);
  const storagePath = `documents/${documentId}/v${versionNumber}-${attempt}.pdf`;
  const originalStoragePath = `documents/${documentId}/v${versionNumber}-${attempt}-original.pdf`;

  /*
   * A revision to a typed memo is drawn here, from the body as it now reads.
   *
   * v1 is not touched by any of this. It keeps its own file, its own
   * checksums, its own `body_json` and its own slots; what a revision
   * produces is a new row, on new storage paths, and the reason the body is
   * held per version rather than per document is exactly so that asking
   * "what was signed the first time round" still has an answer.
   *
   * Drawn before a byte is written, like a first submission: a render that
   * throws has to leave v1 live and storage untouched.
   */
  let memoFile = file;
  let signatureSlots: MemoSignatureSlot[] | null = null;
  let revisedPageSetup: PageSetup | null = null;

  if (!memoFile) {
    if (!document.memoTo || !document.memoFrom) {
      throw errors.internal("This memo is missing the lines its header prints.");
    }

    const preparer = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        designation: true,
      },
    });
    if (!preparer) throw errors.notFound("User not found");

    /*
     * The chain the strip is printed from: the one arriving with this
     * revision, or the one already on the document when the preparer only
     * rewrote the text. Read rather than assumed, so the printed names and
     * the people who will actually be asked to sign stay the same list.
     */
    const revisedChain =
      approvalChain ??
      (
        await prisma.approvalChainStep.findMany({
          where: { chain: { documentId } },
          orderBy: { stepOrder: "asc" },
          select: { assignedUserId: true },
        })
      ).map((step) => ({ userId: step.assignedUserId }));

    const people = await prisma.user.findMany({
      where: { id: { in: revisedChain.map((step) => step.userId) } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        designation: true,
      },
    });

    const rendered = await this.renderTypedMemo(
      {
        // A revision may retitle the memo, and the subject line the template
        // prints is the title - so it follows the rename onto the page.
        title: title ?? document.title,
        /*
         * The notes as this correction has them.
         *
         * A resubmission that leaves them out has removed them, which is a
         * real edit somebody can make - unlike the header fields beside this,
         * where absence means "unchanged". The difference is that a note is
         * placed and removed on the same screen as the text, so a rewrite
         * always knows the whole set.
         */
        notes: revisedNotes,
        // The memo's own type, never the request's: a revision corrects the
        // wording of a document that already exists, and it cannot change
        // what kind of memo it is - nor, therefore, who signs it.
        memoType: document.memoType,
        memoTo: input.memoTo ?? document.memoTo,
        memoFrom: input.memoFrom ?? document.memoFrom,
        /*
         * The date the memo already bears, unless this revision changes it.
         *
         * Not today: a memo sent back for a wording correction is the same
         * memo, and silently re-dating it to the day the correction happened
         * would make v2 claim to be a different document from the v1 three
         * people have already signed.
         */
        date: input.memoDate
          ? memoDateToUtc(input.memoDate)
          : (document.memoDate ?? startOfTodayUtc()),
        body: input.body,
        chain: revisedChain,
      },
      preparer,
      people
    );

    memoFile = rendered.file;
    signatureSlots = rendered.slots;
    revisedPageSetup = rendered.pageSetup;
  } else {
    const chainUserIds = approvalChain
      ? approvalChain.map((step) => step.userId)
      : (
          await prisma.approvalChainStep.findMany({
            where: { chain: { documentId } },
            orderBy: { stepOrder: "asc" },
            select: { assignedUserId: true },
          })
        ).map((step) => step.assignedUserId);
    signatureSlots = await this.detectSignatoryLines(memoFile.buffer, userId, chainUserIds);
  }

  const stamped = signature
    ? await this.stampPreparerSignature(
        memoFile.buffer,
        userId,
        signature,
        signatureSlots
      )
    : null;
  const signedBuffer = stamped?.pdf ?? memoFile.buffer;
  const signedFile: Express.Multer.File = {
    ...memoFile,
    buffer: signedBuffer,
  };

  // A revision is an upload like any other, and the file behind it is kept
  // like any other. Only the first submission used to keep one, so from the
  // second cycle onwards the memo as it arrived was gone.
  await storageService.uploadFile(
    originalStoragePath,
    memoFile.buffer,
    memoFile.mimetype || "application/pdf"
  );
  await storageService.uploadDocument(storagePath, signedFile);
  const originalChecksum = sha256(memoFile.buffer);
  const storageChecksum = sha256(signedBuffer);

  // As on a first submission: set once the new version is filed, after which
  // a later failure keeps its files and says it was filed.
  let filed = false;

  try {
    const previousStatus = document.status;

    const result = await prisma.$transaction(async (tx) => {
      const updateData: Record<string, unknown> = {
        status: "PENDING_REVIEW",
        revisionRequestedByActionId: null,
        currentVersionNumber: versionNumber,
        deletedAt: null,
        approvedAt: null,
        rejectedAt: null,
        submittedAt: new Date(),
      };

      if (title !== undefined) updateData.title = title;
      if (description !== undefined) updateData.description = description || null;
      // Only when the revision actually says so. Left out, the memo keeps the
      // addressee it already has rather than losing it.
      if (input.memoTo !== undefined) updateData.memoTo = input.memoTo;
      if (input.memoFrom !== undefined) updateData.memoFrom = input.memoFrom;
      if (input.memoDate !== undefined) {
        updateData.memoDate = memoDateToUtc(input.memoDate);
      }

      /*
       * Claimed, and only if the memo is still as it was read. The checks
       * above ran outside this transaction: a second resubmission, or an
       * administrator cancelling it, could have landed in between - and an
       * unconditional write reopened a memo that had just been cancelled.
       * The row lock makes this wait for whichever got there first, and the
       * condition then refuses.
       */
      const claimed = await tx.document.updateMany({
        where: {
          id: documentId,
          status: document.status,
          currentVersionNumber: document.currentVersionNumber,
          // Not left as rejected in the meantime, which is final.
          rejectionClosedAt: null,
        },
        data: updateData,
      });
      if (claimed.count !== 1) {
        throw errors.conflict(
          "This memo changed while you were resubmitting it. Reload it to see where it stands, then try again if it still needs it."
        );
      }

      const chain = await tx.approvalChain.findUnique({
        where: { documentId },
        include: {
          steps: {
            orderBy: { stepOrder: "asc" },
          },
        },
      });
      if (!chain) throw errors.internal("Approval chain missing");

      if (approvalChain) {
        await tx.approvalChainStep.deleteMany({ where: { chainId: chain.id } });
        await tx.approvalChainStep.createMany({
          data: approvalChain.map((step, index) => ({
            chainId: chain.id,
            assignedUserId: step.userId,
            approvalType: step.approvalType,
            stepOrder: index + 1,
            slaDays: step.slaDays ?? null,
          })),
        });
      }

      // Only a cycle still open is superseded. A rejected one has already
      // ended, and it keeps saying REJECTED: that is the record of what
      // happened to the version that went round in it.
      if (document.currentWorkflowRunId) {
        await tx.workflowRun.updateMany({
          where: { id: document.currentWorkflowRunId, status: "IN_PROGRESS" },
          data: { status: "SUPERSEDED", endedAt: new Date() },
        });
      }

      const version = await tx.documentVersion.create({
        data: {
          documentId,
          versionNumber,
          storagePath,
          originalStoragePath,
          storageChecksum,
          originalChecksum,
          uploadedById: userId,
          // What v2 was drawn from, and where its ruled lines ended up. v1's
          // own copies of both stay exactly as they were.
          ...(input.body
            ? { bodyJson: input.body }
            : {}),
          ...(signatureSlots
            ? {
                signatureSlots:
                  signatureSlots,
              }
            : {}),
          // v2's notes, as v2 was drawn with them. v1 keeps its own set.
          ...(revisedNotes.length
            ? {
                pageNotesJson:
                  revisedNotes,
              }
            : {}),
          // v2's page, as v2 was drawn on it. v1 keeps whatever it was filed
          // with, so a margin changed between the two revisions does not
          // silently re-draw the version somebody already signed.
          ...(revisedPageSetup
            ? {
                pageSetupJson:
                  revisedPageSetup,
              }
            : {}),
        },
      });

      await tx.documentVersion.update({
        where: { id: oldVersion.id },
        data: { isDeleted: true },
      });

      const workflowRun = await tx.workflowRun.create({
        data: {
          documentId,
          documentVersionId: version.id,
          chainId: chain.id,
          status: "IN_PROGRESS",
          currentStepOrder: 1,
          // The policy this cycle runs under, kept for its whole life (lib/runPolicy).
          ...policySnapshot(),
        },
      });

      await tx.document.update({
        where: { id: documentId },
        data: {
          currentWorkflowRunId: workflowRun.id,
        },
      });

      await auditService.createAuditLog({
        actorId: userId,
        action: "DOCUMENT_VERSION_UPLOADED",
        entityType: "Document",
        entityId: documentId,
        oldValue: { versionNumber: oldVersion.versionNumber },
        newValue: { versionNumber },
        tx,
      });

      await auditService.createAuditLog({
        actorId: userId,
        action: "DOCUMENT_SUBMITTED",
        entityType: "Document",
        entityId: documentId,
        oldValue: { status: previousStatus },
        newValue: {
          status: "PENDING_REVIEW",
          versionNumber,
          workflowRunId: workflowRun.id,
          // As on a first submission: whether the preparer actually signed
          // this version, not whether they used to have to.
          preparerSigned: Boolean(signature),
          ...(signature ? { signaturePage: signature.signaturePage } : {}),
          supportingFileCount: supportingFiles.length,
          // Per version, not per document: a memo typed the first time round
          // can come back as an upload, and the trail should say which this
          // one was rather than which the document started as.
          authoring: input.body ? "GENERATED" : "UPLOADED",
        },
        tx,
      });

      // The preparer's signature, as its own ledger entry: see
      // `signedRecord` for what an auditor gets from it.
      if (signature) {
        await auditService.createAuditLog({
          actorId: userId,
          action: "DOCUMENT_SIGNED",
          entityType: "Document",
          entityId: documentId,
          newValue: signedRecord({
            capacity: "PREPARER",
            versionNumber,
            method: signatureMethod(signature),
            signaturePage: signature.signaturePage,
            signedPdfChecksum: sha256(signedBuffer),
            signatureImageChecksum: stamped?.imageChecksum ?? null,
            attestation,
          }),
          ipAddress: attestation?.ipAddress,
          tx,
        });
      }

      const chainSteps = approvalChain
        ? approvalChain.map((step, index) => ({
            assignedUserId: step.userId,
            approvalType: step.approvalType,
            stepOrder: index + 1,
          }))
        : chain.steps;

      return {
        version,
        workflowRunId: workflowRun.id,
        documentTitle: (title ?? document.title),
        firstStep: chainSteps[0] ?? null,
        previousStatus,
      };
    });
    filed = true;

    /*
     * Supporting files, version by version (fit-gap decision 8).
     *
     * The new version keeps everything the last one carried, less what the
     * preparer took off one by one, plus what they added. Nothing is
     * deleted - a file taken off is marked with the version it left at, and
     * stays readable as part of the versions that carried it. Adding a file
     * used to replace every attachment at once, which lost the rest without
     * anybody choosing to.
     */
    const newVersionNumber = result.version.versionNumber;

    if (removeSupportingIds.length > 0) {
      await prisma.supportingDocument.updateMany({
        where: { documentId, id: { in: removeSupportingIds }, isDeleted: false },
        data: { isDeleted: true, removedInVersion: newVersionNumber },
      });
    }

    if (supportingFiles.length > 0) {
      await this.uploadSupportingFiles(documentId, userId, supportingFiles, newVersionNumber);
    }

    if (result.firstStep) {
      const isReview = result.firstStep.approvalType === ApprovalType.REVIEWER;
      const wasDeleted = result.previousStatus === "DELETED";
      await notificationsService.createNotifications(
        await notificationsService.approvalNeeded({
          recipientId: result.firstStep.assignedUserId,
          /*
           * Still APPROVAL_NEEDED, deliberately, even though a RESUBMITTED
           * type exists: this notice IS an approval waiting on somebody, and
           * the inbox files anything else under news rather than under
           * "Needs you". The type decides what has to be done; the subject
           * decides whether the inbox can tell two of them apart.
           */
          type: "APPROVAL_NEEDED",
          title: isReview ? "Review Required" : "Approval Required",
          /*
           * The reason this line exists. Without it the reviewer who sent the
           * memo back gets a second mail whose subject is character for
           * character the first one - "Approval needed: MEMO-2026-0001 -
           * Annual increment" - and nothing in the inbox says whether this is
           * the memo they already read or the corrected one they asked for.
           * The body said "Revised document"; nobody reads the body to decide
           * whether to open the mail.
           */
          subjectVerb: wasDeleted ? "Re-uploaded" : "Resubmitted",
          message: wasDeleted
            ? `Document "${result.documentTitle}" was re-uploaded and requires your ${isReview ? "review" : "approval"}.`
            : `Revised document "${result.documentTitle}" requires your ${isReview ? "review" : "approval"}.`,
          documentId,
          workflowRunId: result.workflowRunId,
        })
      );
    }

    // The preparer's receipt for the new version.
    await notificationsService.createNotifications([
      {
        recipientId: userId,
        type: "SUBMITTED",
        title: "Memo resubmitted",
        message: `"${result.documentTitle}" was resubmitted as version ${result.version.versionNumber} and starts again from the first approver.`,
        documentId,
        workflowRunId: result.workflowRunId,
      },
    ]);

    // The superseded version's file stays. Someone approved or rejected the
    // memo on those bytes, and the reason for the revision is written against
    // them; a records system that deletes the paper it acted on cannot show
    // what was acted on.

    return {
      message: "Document resubmitted successfully.",
      version: result.version,
      workflowRunId: result.workflowRunId,
    };
  } catch (error) {
    if (filed) {
      logger.error("document.after_resubmit_failed", {
        documentId,
        versionNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      throw errors.internal(
        `The memo was resubmitted as version ${versionNumber}, but something after that failed (its supporting files or the first approver's notice). Open it to check before resubmitting it again.`,
        "SUBMITTED_WITH_ERRORS"
      );
    }

    await storageService.deleteDocument(storagePath);
    await storageService.deleteDocument(originalStoragePath);
    throw error;
  }
}

  /**
   * Withdraw a memo: its preparer takes it back, with a reason.
   *
   * Agreed after the fit-gap review, replacing "delete". Nothing that entered
   * a workflow disappears: the memo stays on record - its versions, its
   * files, every action on it - marked withdrawn, with who did it and why, and
   * it can be resubmitted as a new version. The stored status is still
   * DELETED, which every screen calls "Withdrawn".
   */
  async withdrawDocument(documentId: string, userId: string, reason: string) {
    return this.takeOutOfCirculation(documentId, userId, reason, "preparer");
  }

  /**
   * Cancel an abandoned memo: an administrator with the power does what its
   * preparer would, with a reason - the preparer has left, or stopped
   * answering, and the memo is holding approvers' queues hostage. The
   * preparer is told.
   */
  async cancelDocument(documentId: string, actorId: string, reason: string) {
    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: ACCESS_SELECT,
    });
    if (!actor || !capabilitiesOf(actor).includes("memos.cancel")) {
      throw errors.forbidden("You do not have the power to cancel memos.", "POWER_REQUIRED");
    }
    return this.takeOutOfCirculation(documentId, actorId, reason, "administrator");
  }

  /**
   * Leave as rejected: the preparer of a rejected memo decides not to send it
   * round again.
   *
   * A rejection ends that cycle, not the memo, so it waits on its preparer
   * for a decision - resubmit, or this. Closing it takes the rejection out of
   * their "Needs you" and makes it final; the memo, its versions and every
   * action on it stay on record, exactly as rejected.
   */
  async leaveRejected(documentId: string, userId: string) {
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, preparerId: true, status: true, rejectionClosedAt: true },
    });

    if (!document) throw errors.notFound("Document not found");
    if (document.preparerId !== userId) {
      throw errors.forbidden("Only the memo's preparer can decide to leave it as rejected.");
    }
    if (document.status !== "REJECTED") {
      throw errors.conflict("Only a rejected memo can be left as rejected.");
    }
    if (document.rejectionClosedAt) {
      throw errors.conflict("This memo has already been left as rejected.");
    }

    const closedAt = new Date();
    await prisma.$transaction(async (tx) => {
      // Claimed only if still rejected and still open: a resubmission
      // landing first has made it a new cycle, and that wins.
      const claimed = await tx.document.updateMany({
        where: { id: documentId, status: "REJECTED", rejectionClosedAt: null },
        data: { rejectionClosedAt: closedAt },
      });
      if (claimed.count === 0) {
        throw errors.conflict(
          "This memo changed while it was being closed - it may just have been resubmitted. Reload it and check."
        );
      }

      await auditService.createAuditLog({
        actorId: userId,
        action: "REJECTION_CLOSED",
        entityType: "Document",
        entityId: documentId,
        oldValue: { status: "REJECTED" },
        newValue: { status: "REJECTED", closedAt: closedAt.toISOString() },
        tx,
      });
    });

    return { id: documentId, rejectionClosedAt: closedAt };
  }

  private async takeOutOfCirculation(
    documentId: string,
    userId: string,
    reason: string,
    by: "preparer" | "administrator"
  ) {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      throw errors.badRequest("Say why, so the record shows it.");
    }

    const document = await prisma.document.findUnique({
      where: { id: documentId },
      include: {
        approvalChain: {
          include: {
            steps: {
              select: { assignedUserId: true },
            },
          },
        },
        currentWorkflowRun: {
          select: { id: true, status: true },
        },
      },
    });

    if (!document) {
      throw errors.notFound("Document not found");
    }

    if (by === "preparer" && document.preparerId !== userId) {
      throw errors.forbidden("Only the document preparer can withdraw this document.");
    }

    if (document.status === "DELETED") {
      throw errors.badRequest("This memo has already been withdrawn.");
    }

    // Deleting is for retracting something still in flight — submitted by
    // mistake, or no longer needed. An approved document is a finished record:
    // its final version carries the approvers' signatures, and the audit trail
    // cites that file. The preparer alone could retract it, and a resubmit
    // afterwards writes over the signed PDF the trail points at.
    if (document.status === "APPROVED") {
      throw errors.conflict(
        "An approved document cannot be withdrawn. Its signed version is the record the audit ledger refers to."
      );
    }

    // A rejected memo is a closed cycle, kept as a record. Deleting it and
    // uploading over the deleted memo used to revive it with the rejection
    // cleared; resubmitting it as a new version is the way back now.
    if (document.status === "REJECTED") {
      throw errors.conflict(
        "A rejected document cannot be withdrawn. Its rejection stays on record. To send it round again, resubmit it as a new version."
      );
    }

    const recipientIds = new Set(
      document.approvalChain?.steps.map((step) => step.assignedUserId) ?? []
    );
    // An administrator cancelling it tells the preparer, who did not do it.
    if (by === "administrator") recipientIds.add(document.preparerId);
    recipientIds.delete(userId);

    /*
     * Everybody named in the chain, AND whoever is covering for any of them.
     *
     * The delegate is the one actually holding the memo while a delegation
     * runs, so they are exactly who needs to know it has gone - they were
     * told it needed them. Without this they kept a row in "Needs you" for a
     * document that no longer existed.
     *
     * Computed before the transaction: the fan-out reads the delegation table
     * once per person, and none of that belongs inside the write.
     */
    const deletionNotices = new Map<string, NotificationData>();

    for (const fanned of await Promise.all(
      [...recipientIds].map((recipientId) =>
        notificationsService.andTheirDelegate({
          recipientId,
          type: "DOCUMENT_DELETED" as const,
          title: by === "preparer" ? "Memo withdrawn" : "Memo cancelled",
          message:
            by === "preparer"
              ? `The preparer withdrew "${document.title}": ${trimmedReason}`
              : `An administrator cancelled "${document.title}": ${trimmedReason}`,
          documentId,
        })
      )
    )) {
      for (const notice of fanned) {
        // One notice per person. A deputy covering two of the approvers is
        // still one person being told about one memo.
        if (notice.recipientId === userId) continue;
        if (!deletionNotices.has(notice.recipientId)) {
          deletionNotices.set(notice.recipientId, notice);
        }
      }
    }

    await prisma.$transaction(async (tx) => {
      /*
       * Claimed first, and only if the memo is still in the state it was read
       * in. The checks above ran before this transaction, so a final approval
       * committing in between used to be overwritten: an approved memo, its
       * signed file and its ledger entries, marked deleted. The row lock makes
       * this wait for that approval, and the condition then refuses.
       */
      const claimed = await tx.document.updateMany({
        where: { id: documentId, status: document.status },
        data: {
          status: "DELETED",
          deletedAt: new Date(),
          withdrawalReason: trimmedReason,
          withdrawnById: userId,
        },
      });

      if (claimed.count === 0) {
        throw errors.conflict(
          "This document changed while it was being withdrawn - it may just have been approved or returned. Reload it and check before trying again."
        );
      }

      // The same for the run: only one still open is ended here.
      if (document.currentWorkflowRunId) {
        await tx.workflowRun.updateMany({
          where: { id: document.currentWorkflowRunId, status: "IN_PROGRESS" },
          data: {
            status: "SUPERSEDED",
            endedAt: new Date(),
          },
        });
      }

      // The versions stay as they are: on record, and readable.
      await auditService.createAuditLog({
        actorId: userId,
        action: by === "preparer" ? "DOCUMENT_WITHDRAWN" : "DOCUMENT_CANCELLED",
        entityType: "Document",
        entityId: documentId,
        oldValue: { status: document.status },
        newValue: { status: "DELETED", reason: trimmedReason },
        tx,
      });

      await notificationsService.createNotifications(
        [...deletionNotices.values()],
        tx
      );
    });

    // Deliberately no storage deletion here. This is a soft delete: the
    // document row survives as DELETED, every approval action still names the
    // signed PDF it produced, and the preparer may re-upload from this state.
    // Removing the bytes left the audit trail pointing at files that were no
    // longer there, and left supporting attachments readable by id but
    // unreadable from disk.
    return {
      message: by === "preparer" ? "Memo withdrawn." : "Memo cancelled.",
    };
  }
}

export const documentsService = new DocumentsService();