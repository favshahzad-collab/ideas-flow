import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger";
import { prisma } from "../prisma";
import { errors } from "../lib/errors";
import { sha256 } from "../lib/checksum";
import { appendSignatureCertificate } from "../lib/signatureCertificate";
import { configuredSeal, sealPdf } from "../lib/pdfSeal";
import { certificateFor } from "./signatureCertificate.service";
import {
  signatureMethod,
  signedRecord,
  type SigningAttestation,
} from "../lib/signingAttestation";
import { policyOf } from "../lib/runPolicy";
import { delegationsService } from "./delegations.service";
import {
  findSignatureSlot,
  isTypedMemoSlots,
  placementForSlot,
  slotOwnerAt,
} from "../lib/memoSignatureSlots";
import {
  CAPACITY_LABEL,
  decodeSignatureImage,
  fitPlacementToPage,
  stampSignature,
  type SignoffDetails,
} from "../lib/pdfSignature";
import { storageService } from "../lib/storage";
import { auditService } from "./audit.service";
import {
  notificationsService,
  type NotificationData,
} from "./notifications.service";
import { usersService } from "./users.service";
import {
  ApproveDocumentInput,
  ReassignStepInput,
  RejectDocumentInput,
  RequestRevisionInput,
  SkipWorkflowStepInput,
} from "../schemas/approval.schema";
import { ACCESS_SELECT, capabilitiesOf } from "../lib/capabilities";
import { PREPARER_IN_CHAIN_MESSAGE } from "../lib/approvalChain";
import {
  ApprovalChainStep,
  ApprovalType,
  Document,
  DocumentVersion,
  Prisma,
  WorkflowRun,
} from "../generated/prisma/client";

/**
 * Where one approver's signed result lives.
 *
 * Every approval used to write back over the version's own file, so the
 * document as uploaded was destroyed by the first signature and each
 * approver's `signedPdfStoragePath` named a file that later approvals had
 * rewritten. Nobody could be shown what they signed, and a revision cycle
 * deleted the lot. A path per step fixes both: the objects are immutable and
 * each one is exactly what its approver saw.
 *
 * The step id is in the name so a chain that is replaced between revision
 * cycles cannot collide with its predecessor at the same step order.
 *
 * And an id per attempt, because the name used to identify the step rather
 * than the write. Two clicks on one button are two attempts at the same step,
 * so both computed the same path - and when the losing one rolled back, its
 * cleanup deleted the file the winner had just committed a row against. The
 * approval survived; the PDF it pointed at did not, and the next approver in
 * the chain could not open what they were being asked to countersign. Only
 * one attempt now writes any given object, so a rollback can only ever remove
 * its own.
 */
function signedArtefactPath(
  documentId: string,
  versionNumber: number,
  stepOrder: number,
  chainStepId: string,
  attemptId: string
): string {
  return `documents/${documentId}/v${versionNumber}/step-${stepOrder}-${chainStepId}-${attemptId}.pdf`;
}

type ValidatedStepContext = {
  document: Document & { preparerId: string; title: string };
  run: WorkflowRun;
  currentStep: ApprovalChainStep;
  version: DocumentVersion;
  steps: ApprovalChainStep[];
  /**
   * Null when the actor is the assigned approver, which is nearly always.
   * Set to the assigned approver's id when the actor is standing in for them
   * under a delegation - the action row and the page both carry it, so the
   * record never has to be reconstructed from the delegation table later.
   */
  onBehalfOfId: string | null;
};

/**
 * The refusal when somebody who is not the current approver tries to act.
 *
 * Deliberately says nothing about delegation: a person who is not on this
 * chain has no business learning who is covering for whom.
 */
const NOT_THIS_PERSONS_STEP =
  "Only the assigned user for the current step can perform this action.";

class ApprovalService {
  private async createDocumentThreadComment(
    tx: Prisma.TransactionClient,
    documentId: string,
    authorId: string,
    comment: string,
  ) {
    await tx.documentComment.create({
      data: {
        documentId,
        authorId,
        comment: comment.trim(),
      },
    });
  }

  /**
   * A chain of N approvers is N people's judgement, and a delegation must not
   * quietly make it fewer. Chain building already refuses the same person on
   * two steps; a delegation could still hand one person a second step at the
   * moment of signing - the approver who has signed step 1 and is covering for
   * step 2, or who is covering for step 1 and holds step 3 themselves.
   *
   * So nobody decides two steps of one run, whether as themselves or on
   * somebody's behalf, and a delegate who has their own step on the memo
   * cannot stand in for anybody else on it. The run, not the memo: a returned
   * memo starts a new run, and the same people are asked again.
   */
  private async assertOneDecisionPerPerson(
    run: { id: string; chainId: string },
    currentStep: { id: string },
    actorId: string,
    onBehalfOfId: string | null,
  ) {
    const [decidedAlready, ownStepElsewhere] = await Promise.all([
      prisma.approvalAction.findFirst({
        where: { workflowRunId: run.id, actorId },
        select: { id: true },
      }),
      onBehalfOfId === null
        ? Promise.resolve(null)
        : prisma.approvalChainStep.findFirst({
            where: {
              chainId: run.chainId,
              assignedUserId: actorId,
              id: { not: currentStep.id },
            },
            select: { id: true },
          }),
    ]);

    if (decidedAlready) {
      throw errors.forbidden(
        "You have already decided a step on this memo. Somebody else has to decide this one.",
      );
    }

    if (ownStepElsewhere) {
      throw errors.forbidden(
        "You have your own step on this memo, so you cannot also act for somebody else on it. Ask them, or the administrator, to arrange different cover.",
      );
    }
  }

  private async loadAndValidateCurrentStep(
    documentId: string,
    actorId: string
  ): Promise<ValidatedStepContext> {
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      include: {
        currentWorkflowRun: {
          include: {
            documentVersion: true,
            chain: {
              include: {
                steps: {
                  orderBy: { stepOrder: "asc" },
                },
              },
            },
          },
        },
      },
    });

    if (!document) {
      throw errors.notFound("Document not found.");
    }

    if (actorId === document.preparerId) {
      throw errors.forbidden(
        "The document preparer cannot approve, reject, or request revision."
      );
    }
    
    if (document.status !== "PENDING_REVIEW") {
      throw errors.badRequest(
        "Document is not pending review and cannot be acted on."
      );
    }

    const run = document.currentWorkflowRun;

    if (!run || run.status !== "IN_PROGRESS") {
      throw errors.badRequest("No active workflow run for this document.");
    }

    const steps = run.chain.steps;
    const currentStep = steps.find(
      (step) => step.stepOrder === run.currentStepOrder
    );

    if (!currentStep) {
      throw errors.internal("Current workflow step not found.");
    }

    // The assigned approver, or somebody holding an active delegation from
    // them. Nothing else, and the preparer not even then - that refusal is
    // above this one and applies to a delegate exactly as it does to anybody
    // else, so a preparer cannot approve their own memo by being handed the
    // approver's authority.
    // A cover limited to some kinds of memo signs only those.
    const authority = await delegationsService.authorityOver(
      currentStep.assignedUserId,
      actorId,
      new Date(),
      document.memoType
    );

    if (!authority.allowed) {
      throw errors.forbidden(NOT_THIS_PERSONS_STEP);
    }

    const existingAction = await prisma.approvalAction.findFirst({
      where: {
        workflowRunId: run.id,
        chainStepId: currentStep.id,
      },
    });

    if (existingAction) {
      throw errors.badRequest("This workflow step has already been acted on.");
    }

    await this.assertOneDecisionPerPerson(
      run,
      currentStep,
      actorId,
      authority.onBehalfOfId,
    );

    return {
      document: {
        id: document.id,
        preparerId: document.preparerId,
        title: document.title,
      } as ValidatedStepContext["document"],
      run,
      currentStep,
      version: run.documentVersion,
      steps,
      onBehalfOfId: authority.onBehalfOfId,
    };
  }

  /** Lighter validation for revision — skips loading the full approval chain. */
  private async loadAndValidateCurrentStepLite(
    documentId: string,
    actorId: string,
  ): Promise<ValidatedStepContext> {
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        preparerId: true,
        title: true,
        status: true,
        memoType: true,
        currentWorkflowRun: {
          select: {
            id: true,
            documentId: true,
            documentVersionId: true,
            status: true,
            currentStepOrder: true,
            chainId: true,
            startedAt: true,
            currentStepStartedAt: true,
            breachNotifiedAt: true,
            escalatedAt: true,
            endedAt: true,
            policyFrozenAt: true,
            policySlaDefaultDays: true,
            policyAllowStepSkip: true,
            policySealApprovedMemos: true,
            documentVersion: true,
          },
        },
      },
    });

    if (!document) {
      throw errors.notFound("Document not found.");
    }

    if (actorId === document.preparerId) {
      throw errors.forbidden(
        "The document preparer cannot approve, reject, or request revision.",
      );
    }

    if (document.status !== "PENDING_REVIEW") {
      throw errors.badRequest(
        "Document is not pending review and cannot be acted on.",
      );
    }

    const run = document.currentWorkflowRun;

    if (!run || run.status !== "IN_PROGRESS") {
      throw errors.badRequest("No active workflow run for this document.");
    }

    const [currentStep, existingAction] = await Promise.all([
      prisma.approvalChainStep.findUnique({
        where: {
          chainId_stepOrder: {
            chainId: run.chainId,
            stepOrder: run.currentStepOrder,
          },
        },
      }),
      prisma.approvalAction.findFirst({
        where: {
          workflowRunId: run.id,
          chainStep: {
            chainId: run.chainId,
            stepOrder: run.currentStepOrder,
          },
        },
      }),
    ]);

    if (!currentStep) {
      throw errors.internal("Current workflow step not found.");
    }

    // A cover limited to some kinds of memo signs only those.
    const authority = await delegationsService.authorityOver(
      currentStep.assignedUserId,
      actorId,
      new Date(),
      document.memoType
    );

    if (!authority.allowed) {
      throw errors.forbidden(NOT_THIS_PERSONS_STEP);
    }

    if (existingAction) {
      throw errors.badRequest("This workflow step has already been acted on.");
    }

    await this.assertOneDecisionPerPerson(
      run,
      currentStep,
      actorId,
      authority.onBehalfOfId,
    );

    const { documentVersion, ...runData } = run;

    return {
      document: {
        id: document.id,
        preparerId: document.preparerId,
        title: document.title,
      } as ValidatedStepContext["document"],
      run: runData,
      currentStep,
      version: documentVersion,
      onBehalfOfId: authority.onBehalfOfId,
      steps: [currentStep],
    };
  }

  /**
   * The document as it stands: the version as submitted, plus every signature
   * already applied in this run. The next approver signs this, not the
   * original — a chain of five ends with one page carrying five marks.
   *
   * Falls back to the version's own file, which is both the first approver's
   * case and the answer for any document approved before signatures were kept
   * separately.
   */
  private async currentSignedPath(
    workflowRunId: string,
    versionStoragePath: string
  ): Promise<string> {
    const latest = await prisma.approvalAction.findFirst({
      where: {
        workflowRunId,
        action: "APPROVE",
        signedPdfStoragePath: { not: null },
      },
      orderBy: { createdAt: "desc" },
      select: { signedPdfStoragePath: true },
    });

    return latest?.signedPdfStoragePath ?? versionStoragePath;
  }

  /**
   * Take the current step, or lose the race for it.
   *
   * Every decision path here reads the run, does its work, and then writes -
   * and between that read and that write another request can decide the same
   * step. A double click is enough. `approve` spends several hundred
   * milliseconds fetching, stamping and storing a PDF before it opens its
   * transaction, and five clicks fired into that window all passed validation
   * and all committed: the step was decided once, but the permanent record
   * carried three approvals, the next approver was emailed three times, and
   * the ledger sealed every bit of it. What saved the workflow itself was an
   * accident - `currentStepOrder + 1` is computed from the stale read, so
   * three writers all set the same value rather than advancing three steps.
   *
   * So the run's own state becomes the thing competed for. This update names
   * the status and step order it expects to find; under READ COMMITTED the
   * loser re-evaluates that predicate against the winner's committed row,
   * matches nothing, and reports zero rows changed.
   *
   * It has to be the first write in the transaction. Losing then rolls back
   * the action row, the notifications and the audit entry along with it,
   * which is the whole point - those are the things that were being
   * duplicated.
   */
  private async claimCurrentStep(
    tx: Prisma.TransactionClient,
    run: { id: string; currentStepOrder: number },
    data: Prisma.WorkflowRunUpdateManyMutationInput
  ): Promise<void> {
    const claimed = await tx.workflowRun.updateMany({
      where: {
        id: run.id,
        status: "IN_PROGRESS",
        currentStepOrder: run.currentStepOrder,
      },
      data,
    });

    if (claimed.count === 0) {
      throw errors.conflict(
        "This step has already been decided. Reload the document to see where it stands."
      );
    }
  }

  private buildUplineRecipientIds(
    preparerId: string,
    steps: ApprovalChainStep[],
    currentStepOrder: number,
  ) {
    const recipientIds = new Set<string>([preparerId]);

    for (const step of steps) {
      if (step.stepOrder <= currentStepOrder) {
        recipientIds.add(step.assignedUserId);
      }
    }

    return recipientIds;
  }

  private buildActionResponse(
    message: string,
    documentStatus: string,
    workflowStatus: string,
    currentStepOrder: number,
    action: { id: string; action: string; createdAt: Date }
  ) {
    return {
      message,
      documentStatus,
      workflowStatus,
      currentStepOrder,
      action,
    };
  }

  async approve(
    documentId: string,
    actorId: string,
    input: ApproveDocumentInput,
    ipAddress?: string,
    attestation?: SigningAttestation
  ) {
    const { document, run, currentStep, steps, onBehalfOfId } =
      await this.loadAndValidateCurrentStep(documentId, actorId);

    const version = await prisma.documentVersion.findUnique({
      where: { id: run.documentVersionId },
    });

    if (!version) {
      throw errors.internal("Workflow document version not found.");
    }

    // Sign the document as it stands - the original plus every signature
    // already on it - and write the result to a path of its own.
    const sourcePath = await this.currentSignedPath(run.id, version.storagePath);
    const artefactPath = signedArtefactPath(
      documentId,
      version.versionNumber,
      run.currentStepOrder,
      currentStep.id,
      randomUUID()
    );

    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: {
        firstName: true,
        lastName: true,
        designation: true,
        department: { select: { name: true } },
      },
    });
    const actorName = actor
      ? `${actor.firstName} ${actor.lastName}`.trim()
      : undefined;

    // Only looked up when somebody is standing in for the approver, which is
    // rare - and then the page has to name them, because the chain names them
    // and the two have to agree.
    const onBehalfOf = onBehalfOfId
      ? await prisma.user.findUnique({
          where: { id: onBehalfOfId },
          select: { firstName: true, lastName: true },
        })
      : null;
    const onBehalfOfName = onBehalfOf
      ? `${onBehalfOf.firstName} ${onBehalfOf.lastName}`.trim()
      : null;

    // The moment of approval, taken once and used twice: it is drawn on the
    // page and written on the action row below. Reading the clock twice lets
    // an approval made either side of midnight print a date its own audit row
    // contradicts, and the page is what somebody quotes.
    const signedAt = new Date();

    // What the signature says in words. Built before the box is fitted,
    // because the block hangs below the image and the two are fitted to the
    // page together.
    /*
     * This approver's own column on the memo's printed signature strip.
     *
     * A typed memo prints a ruled line per signatory, in chain order, with
     * their name and title beneath it. Signing on that line is what the strip
     * is for - so nothing is drawn under the image at all (the strip names the
     * signatory, and the capacity and date are the ledger's), and the box is
     * snapped to the line rather than left wherever it was dragged.
     *
     * An uploaded memo has no strip the portal drew, but it is a memo written
     * in Word, and it prints its own signatories' names and titles under the
     * lines they sign on. So the approver's signature goes on alone there too:
     * a block drawn under it lands on top of the names the page already
     * carries. A delegate is the exception, as on a typed memo: their mark
     * sits over somebody else's printed name, so their block says who they
     * are and whose approval it was.
     *
     * A signature made under a delegation takes no slot. The strip printed
     * the approver's name, and the delegate's block has to carry their own
     * name and whose approval it was - which is exactly what the slot's
     * reduced block leaves out.
     */
    const mySlot = onBehalfOfName
      ? null
      : findSignatureSlot(version.signatureSlots, actorId);

    /*
     * Nobody signs on somebody else's line.
     *
     * The coordinates arrive from the client, and until this existed they
     * were used as sent whenever they fell outside the signer's own slot -
     * which includes falling *inside* another signatory's slot. An approver
     * at step two could post the coordinates of the final approver's line and
     * have their mark stamped there, on an artefact that is write-once and
     * already sealed into the ledger by the time anyone reads it.
     *
     * Hiding the coordinates would not have helped: the strip is printed on
     * the page, so where every line sits is public to anyone who may open the
     * memo. Only the write can be restricted, and it has to be restricted
     * here, in the service, rather than by the screen that normally sends the
     * right box.
     *
     * Refused rather than quietly moved onto their own line: a request aimed
     * at another person's signature block is not a near-miss to be corrected,
     * and silently filing it as valid would leave nothing behind saying it
     * happened. A delegate is held to the same rule and may target no line at
     * all, because the strip names the approver and the delegate's block has
     * to carry a name the strip never printed.
     */
    const targetedOwner = slotOwnerAt(version.signatureSlots, input);
    const mayTarget = onBehalfOfName ? null : actorId;

    if (targetedOwner !== null && targetedOwner !== mayTarget) {
      throw errors.forbidden(
        "That signature was placed on a line the document prints for somebody " +
          "else. Sign on your own line, or somewhere clear of the signature block."
      );
    }

    /*
     * With the line now guaranteed to be theirs, holding a slot *is* signing
     * on it. The box is snapped to the printed line rather than used as sent,
     * so one column of the strip cannot end up a different width from the
     * next on a document that is filed for years.
     */
    const onTypedMemo = isTypedMemoSlots(version.signatureSlots);
    const onOwnLine = mySlot !== null || (!onTypedMemo && !onBehalfOfName);

    const signoff: SignoffDetails | undefined =
      actor && actorName
        ? {
            name: actorName,
            designation: actor.designation,
            department: actor.department.name,
            capacity: currentStep.approvalType,
            signedAt,
            onBehalfOf: onBehalfOfName,
            onOwnLine,
            // A typed memo prints its strip from the chain; its versions
            // carry the slots, an uploaded file's never do.
            onTypedMemo,
          }
        : undefined;

    const pdfBuffer = await storageService.downloadDocument(sourcePath);
    const signatureBuffer = input.useSavedSignature
      ? (await usersService.getSignature(actorId)).buffer
      : decodeSignatureImage(input.signatureImage!);
    const placement = await fitPlacementToPage(
      pdfBuffer,
      mySlot ? placementForSlot(mySlot) : input,
      signoff,
      {
        unreadablePdf:
          "This document's PDF could not be read, so it cannot be signed. Ask the preparer to resubmit it.",
      }
    );
    const stampedPdfBuffer = await stampSignature(
      pdfBuffer,
      signatureBuffer,
      placement,
      signoff
    );

    const isFinalStep =
      currentStep.approvalType === ApprovalType.FINAL_APPROVER;

    /*
     * The last signature makes the approved file, and the approved file ends
     * with its signature certificate: every signer, when, from where, and how
     * they proved it was them. Added here, before the file is written and
     * fingerprinted, so the fingerprint recorded below - and in the ledger -
     * is that of the file people download, certificate and all.
     */
    // An administrator may switch the seal off (Workflow policy); the memo is
    // then certified as before, just not sealed.
    const seal =
      isFinalStep && policyOf(run).sealApprovedMemos ? configuredSeal() : null;
    const certifiedPdfBuffer = isFinalStep
      ? await appendSignatureCertificate(
          stampedPdfBuffer,
          await certificateFor({
            documentId,
            workflowRunId: run.id,
            version,
            approvedAt: signedAt,
            sealedBy: seal?.signerName ?? null,
            current: {
              name: actorName ?? "Unknown signer",
              designation: actor?.designation ?? null,
              role: CAPACITY_LABEL[currentStep.approvalType],
              signedAt,
              ipAddress: ipAddress ?? null,
              method: signatureMethod(input),
              identityConfirmedAt: attestation?.identityConfirmedAt ?? null,
              identityConfirmedBy: attestation?.identityConfirmedBy ?? null,
              agreedToStatement: Boolean(attestation?.consented),
              onBehalfOf: onBehalfOfName,
            },
          })
        )
      : stampedPdfBuffer;

    /*
     * And sealed: the organisation's digital signature over the whole file,
     * which any PDF reader checks on opening. Last of all, so it covers the
     * certificate page too, and before the fingerprint below, so the ledger
     * records the sealed file. Not configured, the memo is still approved;
     * the start-up log has said so.
     */
    const signedPdfBuffer = seal
      ? await sealPdf(
          certifiedPdfBuffer,
          seal,
          {
            reason: `Fully approved in Ideas Flow${document.referenceNumber ? ` (${document.referenceNumber})` : ""}`,
            location: process.env.SEAL_LOCATION?.trim() || "Ideas Flow",
            contactInfo: process.env.APP_URL?.trim() || "",
          },
          signedAt
        )
      : certifiedPdfBuffer;

    // A new object every time, never a write over an existing one. Each
    // approver's `signedPdfStoragePath` then names the exact bytes THEY
    // signed, for as long as the document exists - which is the only way an
    // approval can be evidenced afterwards, and the reason the document as
    // uploaded still exists at all.
    await storageService.uploadFile(artefactPath, signedPdfBuffer, "application/pdf");

    // Digested here, from the buffer that was written, and stored on the same
    // row as the path. Approving is the moment the bytes become evidence, so
    // it is the moment worth writing down what they were.
    const signedPdfChecksum = sha256(signedPdfBuffer);
    const nextStep = steps.find(
      (step) => step.stepOrder === run.currentStepOrder + 1
    );

    const uplineRecipientIds = this.buildUplineRecipientIds(
      document.preparerId,
      steps,
      run.currentStepOrder,
    );
    uplineRecipientIds.delete(actorId);

    const notificationJobs: NotificationData[] = [];

    const progressMessage = isFinalStep
      ? `Document "${document.title}" has been fully approved.`
      : `"${document.title}" was approved by ${actorName ?? "an approver"}. The document is advancing to the next step.`;

    for (const recipientId of uplineRecipientIds) {
      notificationJobs.push({
        recipientId,
        type: "APPROVED",
        title: isFinalStep ? "Document Approved" : "Approval Progress",
        message: progressMessage,
        // The same distinction the title draws, carried into the subject so
        // it survives the inbox list. Without it a preparer reads "Approved:
        // MEMO-2026-0001" over a memo two approvers still have to sign, and
        // the notice that it is genuinely finished arrives looking identical.
        subjectVerb: isFinalStep ? "Approved" : "Approval progress",
        documentId,
        workflowRunId: run.id,
      });
    }

    if (!isFinalStep && nextStep) {
      notificationJobs.push(
        ...(await notificationsService.approvalNeeded({
          recipientId: nextStep.assignedUserId,
          type: "APPROVAL_NEEDED",
          title: "Approval Needed",
          message: `Document "${document.title}" requires your review and approval.`,
          documentId,
          workflowRunId: run.id,
        }))
      );
    }

    const runTransaction = () => prisma.$transaction(async (tx) => {
      // Before anything is written down. See `claimCurrentStep`.
      await this.claimCurrentStep(
        tx,
        run,
        isFinalStep
          ? { status: "APPROVED", endedAt: new Date() }
          : {
              currentStepOrder: run.currentStepOrder + 1,
              // The next approver's deadline runs from now, not from whenever
              // the memo was first submitted - and they start un-chased.
              currentStepStartedAt: new Date(),
              breachNotifiedAt: null,
              escalatedAt: null,
            }
      );

      const action = await tx.approvalAction.create({
        data: {
          workflowRunId: run.id,
          chainStepId: currentStep.id,
          documentVersionId: version.id,
          actorId,
          approvalType: currentStep.approvalType,
          action: "APPROVE",
          // The fitted box, not what was asked for: this row is the record of
          // where the signature is on the page, and anyone reading it back
          // against the PDF has to find the mark where the row says it is.
          signaturePage: placement.signaturePage,
          signatureX: placement.signatureX,
          signatureY: placement.signatureY,
          signatureWidth: placement.signatureWidth,
          signatureHeight: placement.signatureHeight,
          signedPdfStoragePath: artefactPath,
          signedPdfChecksum,
          onBehalfOfId,
          ipAddress: ipAddress ?? null,
          // The same instant that is printed under the signature. Left to the
          // database default, the row would carry the commit time and the page
          // the signing time - close together, but not the same date at
          // midnight, and the page cannot be corrected afterwards.
          createdAt: signedAt,
        },
      });

      if (isFinalStep) {
        await tx.document.update({
          where: { id: documentId },
          data: {
            status: "APPROVED",
            approvedAt: new Date(),
            // The approved version, named once and never recomputed. This is
            // the file HR prints and the one the audit trail cites; leaving it
            // to be derived would mean the answer could change later.
            finalSignedStoragePath: artefactPath,
            finalSignedChecksum: signedPdfChecksum,
            // Whose seal it carries, or null: shown on the memo, so nobody
            // has to open the file to find out.
            sealedBy: seal?.signerName ?? null,
          },
        });

        await auditService.createAuditLog({
          actorId,
          action: "WORKFLOW_COMPLETED",
          entityType: "Document",
          entityId: documentId,
          oldValue: { status: "PENDING_REVIEW" },
          newValue: { status: "APPROVED" },
          ipAddress,
          tx,
        });
      } else {
        await auditService.createAuditLog({
          actorId,
          action: "WORKFLOW_APPROVED",
          entityType: "Document",
          entityId: documentId,
          newValue: {
            stepOrder: run.currentStepOrder,
            nextStepOrder: run.currentStepOrder + 1,
          },
          ipAddress,
          tx,
        });
      }

      // This signature, as its own ledger entry, whichever step it was.
      await auditService.createAuditLog({
        actorId,
        action: "DOCUMENT_SIGNED",
        entityType: "Document",
        entityId: documentId,
        newValue: signedRecord({
          capacity: currentStep.approvalType,
          versionNumber: version.versionNumber,
          stepOrder: run.currentStepOrder,
          method: signatureMethod(input),
          signaturePage: placement.signaturePage,
          signedPdfChecksum,
          signatureImageChecksum: sha256(signatureBuffer),
          onBehalfOfId,
          attestation,
          // On the final approval: whose seal the approved file carries, or
          // null when it was not sealed - so the record says, memo by memo.
          ...(isFinalStep ? { sealedBy: seal?.signerName ?? null } : {}),
        }),
        ipAddress,
        tx,
      });

      await notificationsService.createNotifications(notificationJobs, tx);

      return action;
    });

    let result;
    try {
      result = await runTransaction();
    } catch (error) {
      // The signed file was written before the transaction opened, so a
      // failure here would leave an artefact with no approval action to
      // explain it — and the next attempt would then find the path taken and
      // refuse to write. Nothing was overwritten, so cleaning up is a delete
      // rather than a restore: the document as it stood is untouched either
      // way, which is the point of writing to a new path at all.
      await storageService.deleteDocument(artefactPath).catch((cleanupError) => {
        logger.error("approval.artefact.cleanup_failed", {
          artefactPath,
          err: cleanupError,
        });
      });
      throw error;
    }

    return this.buildActionResponse(
      isFinalStep
        ? "Document approved and workflow completed."
        : "Document approved. Workflow advanced to the next step.",
      isFinalStep ? "APPROVED" : "PENDING_REVIEW",
      isFinalStep ? "APPROVED" : "IN_PROGRESS",
      isFinalStep ? run.currentStepOrder : run.currentStepOrder + 1,
      {
        id: result.id,
        action: result.action,
        createdAt: result.createdAt,
      }
    );
  }

  async reject(
    documentId: string,
    actorId: string,
    input: RejectDocumentInput,
    ipAddress?: string,
    /** When the person confirmed it was them, for the audit row. */
    identityConfirmedAt?: Date
  ) {
    const { document, run, currentStep, version, steps, onBehalfOfId } =
      await this.loadAndValidateCurrentStep(documentId, actorId);

    const uplineRecipientIds = this.buildUplineRecipientIds(
      document.preparerId,
      steps,
      run.currentStepOrder,
    );
    // The preparer and everybody earlier in the chain - not the person who
    // rejected it, who knows.
    uplineRecipientIds.delete(actorId);

    const notificationJobs: NotificationData[] = [];

    const result = await prisma.$transaction(async (tx) => {
      // A reject and an approve fired at the same step would otherwise both
      // land, and the memo's fate would be whichever committed last.
      await this.claimCurrentStep(tx, run, {
        status: "REJECTED",
        endedAt: new Date(),
      });

      const action = await tx.approvalAction.create({
        data: {
          workflowRunId: run.id,
          chainStepId: currentStep.id,
          documentVersionId: version.id,
          actorId,
          onBehalfOfId,
          approvalType: currentStep.approvalType,
          action: "REJECT",
          comment: input.comment ?? null,
          ipAddress: ipAddress ?? null,
        },
      });

      await tx.document.update({
        where: { id: documentId },
        data: {
          status: "REJECTED",
          rejectedAt: new Date(),
        },
      });

      if (input.comment?.trim()) {
        await this.createDocumentThreadComment(
          tx,
          documentId,
          actorId,
          `Document rejected: ${input.comment.trim()}`,
        );
      }

      for (const recipientId of uplineRecipientIds) {
        notificationJobs.push({
          recipientId,
          type: "REJECTED",
          title: "Document Rejected",
          message: `Document "${document.title}" has been rejected.`,
          documentId,
          workflowRunId: run.id,
        });
      }

      await notificationsService.createNotifications(notificationJobs, tx);

      await auditService.createAuditLog({
        actorId,
        action: "WORKFLOW_REJECTED",
        entityType: "Document",
        entityId: documentId,
        oldValue: { status: "PENDING_REVIEW" },
        newValue: {
          status: "REJECTED",
          ...(identityConfirmedAt
            ? { identityConfirmedAt: identityConfirmedAt.toISOString() }
            : {}),
        },
        ipAddress,
        tx,
      });

      return action;
    });

    return this.buildActionResponse(
      "Document rejected. Workflow has ended.",
      "REJECTED",
      "REJECTED",
      run.currentStepOrder,
      {
        id: result.id,
        action: result.action,
        createdAt: result.createdAt,
      }
    );
  }

  async requestRevision(
    documentId: string,
    actorId: string,
    input: RequestRevisionInput,
    ipAddress?: string,
    /** When the person confirmed it was them, for the audit row. */
    identityConfirmedAt?: Date
  ) {
    const { document, run, currentStep, version, onBehalfOfId } =
      await this.loadAndValidateCurrentStepLite(documentId, actorId);

    const result = await prisma.$transaction(async (tx) => {
      // Sending it back and approving it are the same race as any other.
      await this.claimCurrentStep(tx, run, {
        status: "SUPERSEDED",
        endedAt: new Date(),
      });

      const action = await tx.approvalAction.create({
        data: {
          workflowRunId: run.id,
          chainStepId: currentStep.id,
          documentVersionId: version.id,
          actorId,
          onBehalfOfId,
          approvalType: currentStep.approvalType,
          action: "REQUEST_REVISION",
          comment: input.comment,
          ipAddress: ipAddress ?? null,
        },
      });

      await tx.document.update({
        where: { id: documentId },
        data: {
          status: "REVISION_REQUESTED",
          revisionRequestedByActionId: action.id,
        },
      });

      await this.createDocumentThreadComment(
        tx,
        documentId,
        actorId,
        `Revision requested: ${input.comment.trim()}`,
      );

      /*
       * The preparer, who has the work to do, and the approvers who already
       * signed this cycle: their signatures are on a version that is now
       * being changed, and they will be asked again.
       */
      const signed = await tx.approvalAction.findMany({
        where: { workflowRunId: run.id, action: "APPROVE" },
        select: { actorId: true },
      });
      const signers = [...new Set(signed.map((row) => row.actorId))].filter(
        (id) => id !== actorId && id !== document.preparerId
      );

      await notificationsService.createNotifications(
        [
          {
            recipientId: document.preparerId,
            type: "REVISION_REQUESTED",
            title: "Revision Requested",
            message: `Revision requested for "${document.title}": ${input.comment}`,
            documentId,
            workflowRunId: run.id,
          },
          ...signers.map((recipientId) => ({
            recipientId,
            type: "REVISION_REQUESTED" as const,
            title: "Sent back for revision",
            message: `"${document.title}", which you signed, was sent back to its preparer: ${input.comment}. You will be asked to sign the revised version.`,
            documentId,
            workflowRunId: run.id,
          })),
        ],
        tx
      );

      await auditService.createAuditLog({
        actorId,
        action: "WORKFLOW_REVISION_REQUESTED",
        entityType: "Document",
        entityId: documentId,
        oldValue: { status: "PENDING_REVIEW" },
        newValue: {
          status: "REVISION_REQUESTED",
          comment: input.comment,
          ...(identityConfirmedAt
            ? { identityConfirmedAt: identityConfirmedAt.toISOString() }
            : {}),
        },
        ipAddress,
        tx,
      });

      return action;
    });

    return this.buildActionResponse(
      "Revision requested. The preparer has been notified.",
      "REVISION_REQUESTED",
      // The run above was ended as SUPERSEDED; reporting IN_PROGRESS here told
      // an API consumer the opposite of what was written.
      "SUPERSEDED",
      run.currentStepOrder,
      {
        id: result.id,
        action: result.action,
        createdAt: result.createdAt,
      }
    );
  }

  /**
   * Hand the step a memo is sitting on to a different approver.
   *
   * The hole this fills: a memo stops at whoever is assigned to it, and until
   * now nothing could move it if that person could not act. They left. They
   * are away and recorded no cover. They should never have been asked in the
   * first place. The two exits that existed are both wrong for that:
   *
   * - skipping is off unless a deployment switches it on, is the preparer's
   *   alone, and drops the approval entirely - the memo finishes with a step
   *   nobody signed, which is not what anybody wanted;
   * - a delegation recorded after the fact says something untrue, that the
   *   approver arranged cover, when what happened is that the organisation
   *   moved the work over their head.
   *
   * So this is its own action, and it is an administrator's. Deliberately not
   * the preparer's, even though the preparer chose the chain at submission:
   * choosing the approvers up front, in the open, is a different act from
   * swapping one out after watching them sit on it, and a preparer who can do
   * the second can shop for a signature. What the preparer has for "it is
   * simply slow" is the reminder.
   *
   * It moves who must sign. It never signs: an administrator with no step on
   * the chain still cannot approve anything, here or anywhere else.
   */
  async reassignStep(
    documentId: string,
    actorId: string,
    input: ReassignStepInput,
    ipAddress?: string,
  ) {
    const [document, actor] = await Promise.all([
      prisma.document.findUnique({
        where: { id: documentId },
        select: {
          id: true,
          title: true,
          referenceNumber: true,
          status: true,
          preparerId: true,
          rejectionClosedAt: true,
          currentWorkflowRun: {
            select: {
              id: true,
              status: true,
              currentStepOrder: true,
              chain: {
                select: {
                  steps: {
                    orderBy: { stepOrder: "asc" },
                    select: {
                      id: true,
                      stepOrder: true,
                      assignedUserId: true,
                      assignedUser: {
                        select: { id: true, firstName: true, lastName: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      prisma.user.findUnique({
        where: { id: actorId },
        select: { id: true, firstName: true, lastName: true, ...ACCESS_SELECT },
      }),
    ]);

    if (!document) {
      throw errors.notFound("Document not found.");
    }

    if (!actor) {
      throw errors.unauthorized("Sign in again.");
    }

    if (!capabilitiesOf(actor).includes("approvals.reassign")) {
      throw errors.forbidden(
        "Only an administrator can move a step to a different approver.",
      );
    }

    const run = document.currentWorkflowRun;

    /*
     * Back with its preparer - sent back, or rejected - the memo is between
     * cycles: the next one starts at step 1 over this same chain, so every
     * step is still ahead of it. A step held by somebody who has since left
     * has to be movable here, or the memo can never be resubmitted: the
     * resubmission refuses a chain that names a switched-off account, and
     * tells the preparer to ask an administrator to do exactly this.
     *
     * Not a rejected memo its preparer has left as rejected: that one has no
     * next cycle.
     */
    const betweenCycles =
      (document.status === "REVISION_REQUESTED" ||
        (document.status === "REJECTED" && document.rejectionClosedAt === null)) &&
      run !== null &&
      run.status !== "IN_PROGRESS";

    if (
      !betweenCycles &&
      (document.status !== "PENDING_REVIEW" || !run || run.status !== "IN_PROGRESS")
    ) {
      throw errors.badRequest(
        "This memo is not waiting on anybody, so there is no step to move.",
      );
    }

    if (!run) {
      throw errors.internal("Workflow run missing.");
    }

    const steps = run.chain.steps;
    const currentStep = betweenCycles
      ? undefined
      : steps.find((step) => step.stepOrder === run.currentStepOrder);

    if (!betweenCycles && !currentStep) {
      throw errors.internal("Current workflow step not found.");
    }

    if (betweenCycles && input.stepOrder === undefined) {
      throw errors.badRequest(
        "This memo is back with its preparer, so say which step to move.",
      );
    }

    /*
     * Which step is moving. No `stepOrder` means the one the memo is sitting
     * on, which is what this could do to begin with.
     *
     * A memo stops just as completely at an approver three steps down who
     * cannot act - the difference is only that the organisation can see that
     * one coming and had no way to use the warning. So a step still ahead of
     * the memo can be moved too. A step the memo has already passed cannot:
     * that one carries a signature or a recorded skip, and rewriting whose
     * name stands against it would make the chain disagree with the actions
     * taken on it.
     */
    const targetStep =
      input.stepOrder === undefined
        ? currentStep
        : steps.find((step) => step.stepOrder === input.stepOrder);

    if (!targetStep) {
      throw errors.badRequest("That step is not on this memo.");
    }

    if (!betweenCycles && targetStep.stepOrder < run.currentStepOrder) {
      throw errors.badRequest(
        `Step ${targetStep.stepOrder} has already been decided, so it cannot be moved. Only the step the memo is on and the ones ahead of it can.`,
      );
    }

    /*
     * The two halves of this action that genuinely differ. A step the memo is
     * sitting on changes who must sign NOW: a deadline starts, an approval is
     * requested, and whoever is covering for either person is in it. A step
     * still ahead changes who WILL be asked: nothing is due, nobody is
     * chased, and a delegation that happens to be running today says nothing
     * about who will be covering by the time the memo arrives.
     */
    const isCurrentStep = !betweenCycles && targetStep.stepOrder === run.currentStepOrder;

    const replacement = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, firstName: true, lastName: true, deactivatedAt: true },
    });

    if (!replacement) {
      throw errors.badRequest("That person does not have an account here.");
    }

    /*
     * The whole point of moving a step is to put it with somebody who can
     * act. An account that has been switched off cannot sign in, so handing
     * it there moves the memo from one dead end to another - and this control
     * is reached precisely when somebody has left, which is when the name of
     * the next person who left is nearest to hand.
     */
    if (replacement.deactivatedAt) {
      throw errors.badRequest(
        `${replacement.firstName}'s account has been switched off, so they cannot approve this. Choose somebody else.`
      );
    }

    /*
     * Moving a step is how an administrator unblocks a memo, never how they
     * get to sign it. Handed to themselves, it would be both at once: the
     * person deciding who must approve would pick the one approver nobody
     * else chose, and the signature that followed would carry an authority
     * the chain never gave them.
     */
    if (replacement.id === actor.id) {
      throw errors.badRequest(
        "You cannot move a step to yourself. Choose the person who should approve it.",
      );
    }

    if (replacement.id === targetStep.assignedUserId) {
      throw errors.badRequest(
        isCurrentStep
          ? `This step is already with ${replacement.firstName}. Choose somebody else.`
          : `Step ${targetStep.stepOrder} is already ${replacement.firstName}'s. Choose somebody else.`,
      );
    }

    /*
     * Two of the rules in `findApprovalChainIssues` can be broken by a
     * reassignment, and only two: a duplicate approver, and the preparer
     * landing on their own chain. The others are about the shape of the chain
     * - exactly one final approver, and it last - and this changes neither
     * the order of the steps nor their types, so it cannot reach them.
     *
     * They are checked by name rather than by running the whole set, because
     * the message a person reads here is about one person they just picked,
     * not about a chain they are building.
     */
    if (replacement.id === document.preparerId) {
      throw errors.badRequest(PREPARER_IN_CHAIN_MESSAGE);
    }

    const elsewhereOnChain = steps.some(
      (step) =>
        step.stepOrder !== targetStep.stepOrder &&
        step.assignedUserId === replacement.id,
    );

    if (elsewhereOnChain) {
      throw errors.badRequest(
        `${replacement.firstName} already has a step on this memo. One person cannot hold two.`,
      );
    }

    const holder = targetStep.assignedUser;
    const holderName = `${holder.firstName} ${holder.lastName}`.trim();
    const replacementName = `${replacement.firstName} ${replacement.lastName}`.trim();
    const movedBy = `${actor.firstName} ${actor.lastName}`.trim();
    const reason = input.reason.trim();
    const memo = document.referenceNumber
      ? `${document.referenceNumber} — "${document.title}"`
      : `"${document.title}"`;

    await prisma.$transaction(
      async (tx) => {
        /*
         * Before anything moves, and for the same reason every other action
         * here claims first: the approver whose step this is may be signing
         * it at this moment. Whichever transaction commits second finds the
         * run no longer where it left it and is refused, so a step cannot be
         * moved out from under a signature that has already been given.
         */
        if (betweenCycles) {
          // No step is open to claim. The memo itself is, so a resubmission
          // landing at the same moment cannot pass this move by unseen.
          const claimed = await tx.document.updateMany({
            where: { id: documentId, status: document.status },
            data: { updatedAt: new Date() },
          });
          if (claimed.count !== 1) {
            throw errors.conflict(
              "This memo changed while the step was being moved. Reload it and try again.",
            );
          }
        } else await this.claimCurrentStep(
          tx,
          run,
          isCurrentStep
            ? {
                // The new approver starts their own clock. Inheriting a
                // deadline that has already run out would have them chased
                // for time they were never given.
                currentStepStartedAt: new Date(),
                breachNotifiedAt: null,
                escalatedAt: null,
              }
            : // A step still ahead has no clock to start - it begins when the
              // memo reaches it. The run is written back as it was found
              // purely so the same conditional update still runs: the point
              // of it here is the WHERE, which refuses if the memo has moved
              // on since it was read.
              { currentStepOrder: run.currentStepOrder },
        );

        await tx.approvalChainStep.update({
          where: { id: targetStep.id },
          data: { assignedUserId: replacement.id },
        });

        await this.createDocumentThreadComment(
          tx,
          documentId,
          actorId,
          `Step ${targetStep.stepOrder} moved from ${holderName} to ${replacementName}: ${reason}`,
        );

        await auditService.createAuditLog({
          actorId,
          action: "WORKFLOW_STEP_REASSIGNED",
          entityType: "Document",
          entityId: documentId,
          oldValue: {
            stepOrder: targetStep.stepOrder,
            assignedUserId: targetStep.assignedUserId,
          },
          newValue: {
            stepOrder: targetStep.stepOrder,
            assignedUserId: replacement.id,
            reason,
            // Whether the memo was actually sitting on it. Without this the
            // trail cannot tell a memo that was unstuck from one that was
            // rerouted before it ever got there, and those are different
            // events to anybody reading it back.
            wasWaitingOnIt: isCurrentStep,
          },
          ipAddress,
          tx,
        });

        /*
         * The person it was taken from.
         *
         * No `documentId`, which is the one place this notice differs from
         * every other. They are off the chain as of a line above, and a memo
         * is visible to its preparer and to the chain - so the link every
         * other notice carries would, for this one, lead to "Access denied".
         * The memo is named in the sentence instead.
         */
        const takenFrom: NotificationData = {
          recipientId: targetStep.assignedUserId,
          type: "STEP_REASSIGNED",
          title: isCurrentStep
            ? "A memo moved to another approver"
            : "You were taken off a memo's approval chain",
          message: isCurrentStep
            ? `Step ${targetStep.stepOrder} of ${memo} has been moved to ${replacementName} by ${movedBy}, and is no longer assigned to you. Reason: ${reason}`
            : `Step ${targetStep.stepOrder} of ${memo}, which you were going to be asked to approve, has been moved to ${replacementName} by ${movedBy}. Reason: ${reason}`,
          // Named for the mail, which has no documentId to look it up from.
          // Without this the subject line is the bare word "Reassigned".
          documentTitle: document.title,
          documentReference: document.referenceNumber,
          workflowRunId: run.id,
        };

        /*
         * And the person it went to. Only a step the memo is actually sitting
         * on is a request for a signature; a step still ahead is news about a
         * chain, and APPROVAL_NEEDED would put a memo in their queue that is
         * not theirs to act on yet - the same mistake STEP_SKIPPED exists to
         * avoid at the other end.
         *
         * This one DOES carry the link: they are on the chain now, so the
         * memo is theirs to read, and reading it is most of what somebody
         * newly added to a chain wants to do.
         */
        const movedTo: NotificationData = isCurrentStep
          ? {
              recipientId: replacement.id,
              type: "APPROVAL_NEEDED",
              title: "Approval Needed",
              message: `Document "${document.title}" requires your review and approval. ${movedBy} moved this step to you from ${holderName}: ${reason}`,
              documentId,
              workflowRunId: run.id,
            }
          : {
              recipientId: replacement.id,
              type: "STEP_REASSIGNED",
              title: "You were added to a memo's approval chain",
              message: betweenCycles
                ? `${movedBy} put you on step ${targetStep.stepOrder} of "${document.title}" in place of ${holderName}. You will be asked to approve it when the memo is resubmitted and reaches you. Reason: ${reason}`
                : `${movedBy} put you on step ${targetStep.stepOrder} of "${document.title}" in place of ${holderName}. You will be asked to approve it when the memo reaches you. Reason: ${reason}`,
              documentId,
              workflowRunId: run.id,
            };

        /*
         * Whoever is covering for either of them, but only for the step the
         * memo is on. A delegation is an arrangement about who signs while
         * somebody is away, and a step still ahead is not being signed by
         * anybody today - so today's cover says nothing about it, and copying
         * it in would be telling a person about work that is neither theirs
         * nor due.
         */
        const recipients: NotificationData[] = isCurrentStep
          ? [
              ...(await notificationsService.andTheirDelegate(takenFrom)),
              ...(await notificationsService.approvalNeeded(movedTo)),
            ]
          : [takenFrom, movedTo];

        /*
         * And the preparer, who is waiting on it. Not when they did it
         * themselves - an administrator can prepare a memo like anybody else,
         * and a notice telling somebody what they have just done is noise.
         * The preparer is never on the chain, so they are never one of the
         * two above.
         */
        if (document.preparerId !== actorId) {
          recipients.push({
            recipientId: document.preparerId,
            type: "STEP_REASSIGNED",
            title: isCurrentStep
              ? "Your memo moved to another approver"
              : "An approver ahead on your memo changed",
            message: `Step ${targetStep.stepOrder} of "${document.title}" moved from ${holderName} to ${replacementName}. Reason: ${reason}`,
            documentId,
            workflowRunId: run.id,
          });
        }

        await notificationsService.createNotifications(recipients, tx);
      },
      { timeout: 15_000 },
    );

    return {
      message: isCurrentStep
        ? `Step ${targetStep.stepOrder} moved to ${replacementName}, who has been asked to approve it.`
        : betweenCycles
          ? `Step ${targetStep.stepOrder} moved to ${replacementName}. The memo can be resubmitted now.`
          : `Step ${targetStep.stepOrder} moved to ${replacementName}, who will be asked when the memo reaches them.`,
      documentStatus: betweenCycles ? document.status : "PENDING_REVIEW",
      workflowStatus: betweenCycles ? run.status : "IN_PROGRESS",
      // Where the memo is, which a step moved from ahead of it does not
      // change. `stepOrder` beside it is the step that actually moved; for
      // the step the memo is sitting on the two are the same number, which is
      // why this one kept its meaning rather than being repurposed.
      currentStepOrder: run.currentStepOrder,
      stepOrder: targetStep.stepOrder,
      movedFrom: { id: holder.id, firstName: holder.firstName, lastName: holder.lastName },
      movedTo: {
        id: replacement.id,
        firstName: replacement.firstName,
        lastName: replacement.lastName,
      },
    };
  }

  async skipWorkflowStep(
    documentId: string,
    preparerId: string,
    input: SkipWorkflowStepInput,
    ipAddress?: string,
  ) {
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        title: true,
        preparerId: true,
        status: true,
        currentWorkflowRun: {
          select: {
            id: true,
            status: true,
            currentStepOrder: true,
            documentVersionId: true,
            policyFrozenAt: true,
            policySlaDefaultDays: true,
            policyAllowStepSkip: true,
            policySealApprovedMemos: true,
            chain: {
              select: {
                steps: {
                  orderBy: { stepOrder: "asc" },
                },
              },
            },
          },
        },
      },
    });

    if (!document) {
      throw errors.notFound("Document not found.");
    }

    if (document.preparerId !== preparerId) {
      throw errors.forbidden("Only the document preparer can skip a workflow step.");
    }

    if (document.status !== "PENDING_REVIEW") {
      throw errors.badRequest(
        "Workflow steps can only be skipped while the document is pending review.",
      );
    }

    const run = document.currentWorkflowRun;

    if (!run || run.status !== "IN_PROGRESS") {
      throw errors.badRequest("No active workflow run for this document.");
    }

    // Off unless it was switched on when this memo's approval cycle started:
    // the memo keeps the rules it began under (lib/runPolicy). Checked before
    // any state can move.
    if (!policyOf(run).allowStepSkip) {
      throw errors.forbidden(
        "Skipping an approver is switched off for this memo. Every approver on the chain has to act on it themselves.",
        "STEP_SKIP_DISABLED",
      );
    }

    const steps = run.chain.steps;
    const currentStep = steps.find(
      (step) => step.stepOrder === run.currentStepOrder,
    );

    if (!currentStep) {
      throw errors.internal("Current workflow step not found.");
    }

    const nextStep = steps.find(
      (step) => step.stepOrder === run.currentStepOrder + 1,
    );

    if (!nextStep) {
      throw errors.badRequest("Cannot skip the final approval step.");
    }

    const existingAction = await prisma.approvalAction.findFirst({
      where: {
        workflowRunId: run.id,
        chainStepId: currentStep.id,
      },
    });

    if (existingAction) {
      throw errors.badRequest("The current workflow step has already been acted on.");
    }

    const skippedUser = await prisma.user.findUnique({
      where: { id: currentStep.assignedUserId },
      select: { firstName: true, lastName: true },
    });
    const skippedUserName = skippedUser
      ? `${skippedUser.firstName} ${skippedUser.lastName}`.trim()
      : "the assigned reviewer";

    const threadComment = `Preparer skipped ${skippedUserName} (Step ${currentStep.stepOrder}): ${input.reason.trim()}`;

    const result = await prisma.$transaction(
      async (tx) => {
        // The `existingAction` read above is a courtesy - it names the reason
        // in words. This is the guard: two skips, or a skip racing the
        // approval it is trying to get past, are decided here.
        await this.claimCurrentStep(tx, run, {
          currentStepOrder: run.currentStepOrder + 1,
          currentStepStartedAt: new Date(),
          breachNotifiedAt: null,
          escalatedAt: null,
        });

        const action = await tx.approvalAction.create({
          data: {
            workflowRunId: run.id,
            chainStepId: currentStep.id,
            documentVersionId: run.documentVersionId,
            actorId: preparerId,
            approvalType: currentStep.approvalType,
            action: "SKIP",
            comment: input.reason.trim(),
            ipAddress: ipAddress ?? null,
          },
        });

        // The thread comment, the audit row and the notifications all belong
        // to this state change. Written outside the transaction, a failure
        // here left the step advanced with no trace of who advanced it or why.
        await this.createDocumentThreadComment(
          tx,
          documentId,
          preparerId,
          threadComment,
        );

        await auditService.createAuditLog({
          actorId: preparerId,
          action: "WORKFLOW_STEP_SKIPPED",
          entityType: "Document",
          entityId: documentId,
          oldValue: {
            stepOrder: currentStep.stepOrder,
            assignedUserId: currentStep.assignedUserId,
          },
          newValue: {
            stepOrder: nextStep.stepOrder,
            assignedUserId: nextStep.assignedUserId,
            reason: input.reason.trim(),
          },
          ipAddress,
          tx,
        });

        await notificationsService.createNotifications(
          [
            {
              /*
               * The person who was passed over. News, not a request - there
               * is nothing left for them to do on this memo, and calling it
               * APPROVAL_NEEDED said the opposite in three places at once:
               * a mail headed "Approval needed", a row in "Needs you", and a
               * button reading "Open to sign" on a memo they cannot sign.
               */
              recipientId: currentStep.assignedUserId,
              type: "STEP_SKIPPED",
              title: "Your approval was skipped",
              message: `Your approval on "${document.title}" was skipped and the memo has moved on without it. Reason: ${input.reason.trim()}`,
              documentId,
              workflowRunId: run.id,
            },
            ...(await notificationsService.approvalNeeded({
              recipientId: nextStep.assignedUserId,
              type: "APPROVAL_NEEDED",
              title: "Approval Needed",
              message: `Document "${document.title}" requires your review and approval.`,
              documentId,
              workflowRunId: run.id,
            })),
          ],
          tx,
        );

        return action;
      },
      { timeout: 15_000 },
    );

    return this.buildActionResponse(
      `Skipped ${skippedUserName}. Workflow advanced to the next step.`,
      "PENDING_REVIEW",
      "IN_PROGRESS",
      run.currentStepOrder + 1,
      {
        id: result.id,
        action: result.action,
        createdAt: result.createdAt,
      },
    );
  }
}

export const approvalService = new ApprovalService();
