import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApprovalType, LoginRole } from "../generated/prisma/client";
import { sha256 } from "../lib/checksum";
import { preparerMustSign } from "../lib/preparerSigning";
import { env } from "../lib/env";
import { prisma } from "../prisma";
import {
  formatMemoReference,
  MEMO_REFERENCE_PATTERN,
  memoReferenceYearPrefix,
} from "../schemas/documents.schema";
import {
  chainOf,
  currentPosition,
  makeCast,
  makeUpload,
  makeUser,
  missingId,
  resubmitDocument,
  signature,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { approvalService } from "./approval.service";
import { documentsService } from "./documents.service";
import { notificationsService } from "./notifications.service";

/**
 * Submitting a document writes eight kinds of row and a file, in a
 * transaction, in an order that matters. These tests run the real service
 * against a real database, because the interesting failures - a chain that is
 * rejected after the PDF has already been uploaded, an approver who can see a
 * document before the workflow reaches them - are all failures of how the
 * pieces are ordered against each other.
 */

useCleanDatabase();

const storedBytes = async (documentId: string) => {
  const version = await prisma.documentVersion.findFirstOrThrow({
    where: { documentId },
    orderBy: { versionNumber: "desc" },
  });
  return fs.readFile(
    path.join(path.resolve(env.STORAGE_DIR), "documents", version.storagePath)
  );
};

/**
 * Every file under the storage root, sorted. The database is truncated
 * between tests and the temp directory is not, so the only honest question
 * about an orphaned upload is whether THIS call added a file.
 */
const storageTree = async (): Promise<string[]> => {
  const entries = await fs
    .readdir(path.resolve(env.STORAGE_DIR), { recursive: true })
    .catch(() => [] as string[]);
  return entries.map(String).sort();
};

/**
 * A memo carried all the way to APPROVED, through the real approval service.
 *
 * Everything the finished state is made of - the signed artefacts, the
 * approved version fixed against the document - is written by that service,
 * so a hand-built approved row would be a state the application cannot
 * actually reach, and the print gate reads exactly those fields.
 */
const approvedMemo = async () => {
  const cast = await makeCast();
  const document = await submitDocument({
    preparerId: cast.preparer.id,
    approvalChain: chainOf(cast.reviewer, cast.finalApprover),
  });

  const { useSavedSignature: _saved, ...placement } = signature();
  const input = { ...placement, useSavedSignature: false } as Parameters<
    typeof approvalService.approve
  >[2];

  await approvalService.approve(document.id, cast.reviewer.id, input);
  await approvalService.approve(document.id, cast.finalApprover.id, input);

  return { ...cast, document, documentId: document.id };
};

describe("createDocument", () => {
  it("submits the document straight into the chain", async () => {
    const { preparer, reviewer, approver, finalApprover } = await makeCast();

    const result = await submitDocument({
      preparerId: preparer.id,
      approvalChain: chainOf(reviewer, approver, finalApprover),
      title: "Q3 capital request",
    });

    const document = await prisma.document.findUniqueOrThrow({
      where: { id: result.id },
      include: {
        versions: true,
        approvalChain: { include: { steps: { orderBy: { stepOrder: "asc" } } } },
        workflowRuns: true,
      },
    });

    // A document is never a draft here: it is signed and submitted in one
    // call, so there is no state in which it exists but nobody has been asked.
    expect(document.status).toBe("PENDING_REVIEW");
    expect(document.currentVersionNumber).toBe(1);
    expect(document.versions).toHaveLength(1);
    expect(document.versions[0].versionNumber).toBe(1);

    expect(document.approvalChain?.steps.map((step) => step.stepOrder)).toEqual([
      1, 2, 3,
    ]);
    expect(
      document.approvalChain?.steps.map((step) => step.assignedUserId)
    ).toEqual([reviewer.id, approver.id, finalApprover.id]);
    expect(
      document.approvalChain?.steps.map((step) => step.approvalType)
    ).toEqual([
      ApprovalType.REVIEWER,
      ApprovalType.APPROVER,
      ApprovalType.FINAL_APPROVER,
    ]);

    expect(document.workflowRuns).toHaveLength(1);
    expect(await currentPosition(result.id)).toMatchObject({
      status: "PENDING_REVIEW",
      runStatus: "IN_PROGRESS",
      stepOrder: 1,
      assignedTo: reviewer.id,
    });
  });

  it("stores the preparer's signature burned into the pdf", async () => {
    const { preparer, finalApprover } = await makeCast();
    const upload = await makeUpload();

    const { document } = await documentsService.createDocument(
      {
        title: "Signed on submission",
        approvalChain: chainOf(finalApprover),
        signature: signature(),
      },
      upload,
      preparer.id
    );

    const stored = await storedBytes(document.id);

    // The file on disk is not the file that was uploaded: the signature is
    // part of the document, not an annotation the viewer can decline to draw.
    expect(stored.equals(upload.buffer)).toBe(false);
    expect(stored.subarray(0, 5).toString()).toBe("%PDF-");
    expect(stored.length).toBeGreaterThan(upload.buffer.length);
  });

  it("records who prepared it and when it was submitted", async () => {
    const { preparer, finalApprover } = await makeCast();

    const result = await submitDocument({
      preparerId: preparer.id,
      approvalChain: chainOf(finalApprover),
    });

    const document = await prisma.document.findUniqueOrThrow({
      where: { id: result.id },
    });

    expect(document.preparerId).toBe(preparer.id);
    expect(document.deletedAt).toBeNull();
    expect(document.approvedAt).toBeNull();
    expect(document.rejectedAt).toBeNull();
  });

  it("writes an audit row for the submission", async () => {
    const { preparer, finalApprover } = await makeCast();

    const result = await submitDocument({
      preparerId: preparer.id,
      approvalChain: chainOf(finalApprover),
    });

    const audit = await prisma.auditLog.findMany({
      where: { entityId: result.id },
    });

    expect(audit.map((row) => row.action)).toContain("DOCUMENT_SUBMITTED");
    expect(audit[0].actorId).toBe(preparer.id);
  });

  it("notifies the first approver and nobody further down the chain", async () => {
    const { preparer, reviewer, approver, finalApprover } = await makeCast();

    await submitDocument({
      preparerId: preparer.id,
      approvalChain: chainOf(reviewer, approver, finalApprover),
    });

    const notified = await prisma.notification.findMany({
      // The preparer's own receipt aside.
      where: { type: { not: "SUBMITTED" } },
      select: { recipientId: true },
    });

    // Telling all three at once turns the queue into a list of things that
    // are not yet anyone's problem.
    expect(notified.map((row) => row.recipientId)).toEqual([reviewer.id]);
  });

  describe("refusals", () => {
    const refusal = async (promise: Promise<unknown>) => {
      const error = await promise.then(
        () => null,
        (e: unknown) => e as { statusCode?: number; message?: string }
      );
      expect(error, "expected the submission to be refused").not.toBeNull();
      return error!;
    };

    it("refuses a chain that includes the preparer", async () => {
      const { preparer, finalApprover } = await makeCast();

      const error = await refusal(
        submitDocument({
          preparerId: preparer.id,
          approvalChain: chainOf(preparer, finalApprover),
        })
      );

      expect(error.statusCode).toBe(400);
      expect(error.message).toContain("preparer cannot be an approver");
    });

    it("refuses a chain with no final approver", async () => {
      const { preparer, reviewer, approver } = await makeCast();

      const error = await refusal(
        submitDocument({
          preparerId: preparer.id,
          approvalChain: [
            { userId: reviewer.id, approvalType: ApprovalType.REVIEWER },
            { userId: approver.id, approvalType: ApprovalType.APPROVER },
          ],
        })
      );

      expect(error.statusCode).toBe(400);
      expect(error.message).toContain("Final Approver");
    });

    it("refuses a chain naming a user who does not exist", async () => {
      const { preparer, finalApprover } = await makeCast();

      const error = await refusal(
        submitDocument({
          preparerId: preparer.id,
          approvalChain: [
            { userId: missingId(), approvalType: ApprovalType.REVIEWER },
            { userId: finalApprover.id, approvalType: ApprovalType.FINAL_APPROVER },
          ],
        })
      );

      expect(error.statusCode).toBe(400);
      expect(error.message).toContain("do not exist");
    });

    it("writes nothing at all when the chain is refused", async () => {
      // Every rejection runs before a byte is uploaded. This used to throw
      // after the PDF was already in storage and before the rollback handler
      // was reachable, so the file stayed there with no row to explain it.
      const { preparer } = await makeCast();
      const before = await storageTree();

      await refusal(
        submitDocument({
          preparerId: preparer.id,
          approvalChain: chainOf(preparer),
        })
      );

      expect(await prisma.document.count()).toBe(0);
      expect(await prisma.documentVersion.count()).toBe(0);
      expect(await prisma.approvalChain.count()).toBe(0);
      expect(await prisma.workflowRun.count()).toBe(0);

      expect(await storageTree()).toEqual(before);
    });

    it("refuses a template that is not active", async () => {
      const { preparer } = await makeCast();
      const template = await prisma.workflowTemplate.create({
        data: {
          name: "Retired route",
          isActive: false,
          graph: { nodes: [], edges: [] },
          createdById: preparer.id,
        },
      });

      const error = await refusal(
        submitDocument({ preparerId: preparer.id, templateId: template.id })
      );

      expect(error.statusCode).toBe(400);
      expect(error.message).toContain("not available");
    });
  });
});

describe("submitting through a workflow template", () => {
  const node = (
    id: string,
    type: "start" | "approval" | "decision" | "end",
    data: Record<string, unknown> = {}
  ) => ({ id, type, position: { x: 0, y: 0 }, data });

  const edge = (
    source: string,
    target: string,
    branch?: "yes" | "no" | "default"
  ) => ({
    id: `${source}->${target}${branch ? `:${branch}` : ""}`,
    source,
    target,
    ...(branch ? { branch } : {}),
  });

  const makeTemplate = (
    createdById: string,
    nodes: unknown[],
    edges: unknown[],
    isActive = true
  ) =>
    prisma.workflowTemplate.create({
      data: {
        name: `Route ${Math.random().toString(36).slice(2, 8)}`,
        isActive,
        graph: { nodes, edges } as never,
        createdById,
      },
    });

  it("compiles the template into the document's chain", async () => {
    const { preparer, reviewer, finalApprover } = await makeCast();
    const template = await makeTemplate(
      preparer.id,
      [
        node("start", "start"),
        node("a", "approval", {
          approverId: reviewer.id,
          approvalType: ApprovalType.REVIEWER,
        }),
        node("b", "approval", {
          approverId: finalApprover.id,
          approvalType: ApprovalType.FINAL_APPROVER,
        }),
        node("end", "end"),
      ],
      [edge("start", "a"), edge("a", "b"), edge("b", "end")]
    );

    const result = await submitDocument({
      preparerId: preparer.id,
      templateId: template.id,
    });

    const document = await prisma.document.findUniqueOrThrow({
      where: { id: result.id },
      include: {
        approvalChain: { include: { steps: { orderBy: { stepOrder: "asc" } } } },
      },
    });

    // The template is recorded on the document, so a chain that turns out to
    // be wrong can be traced back to the graph that produced it.
    expect(document.templateId).toBe(template.id);
    expect(
      document.approvalChain?.steps.map((step) => step.assignedUserId)
    ).toEqual([reviewer.id, finalApprover.id]);

    expect(await currentPosition(result.id)).toMatchObject({
      stepOrder: 1,
      assignedTo: reviewer.id,
    });
  });

  it("refuses a template that compiles to no approvers", async () => {
    const { preparer } = await makeCast();
    const template = await makeTemplate(
      preparer.id,
      [node("start", "start"), node("end", "end")],
      [edge("start", "end")]
    );

    await expect(
      submitDocument({ preparerId: preparer.id, templateId: template.id })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("did not produce any approval steps"),
    });
  });

  it("routes a diamond in the order it was drawn", async () => {
    // Drawn as "reviewer and approver, then the final approver". This used to
    // be refused: the compiler was depth-first, so the join landed second and
    // the chain came out with its final step in the middle, and the person
    // reading "Final Approver must be the last step" had drawn a graph in
    // which it plainly was. See workflow-templates.service.test.ts.
    const { preparer, reviewer, approver, finalApprover } = await makeCast();
    const template = await makeTemplate(
      preparer.id,
      [
        node("start", "start"),
        node("left", "approval", {
          approverId: reviewer.id,
          approvalType: ApprovalType.REVIEWER,
        }),
        node("right", "approval", {
          approverId: approver.id,
          approvalType: ApprovalType.APPROVER,
        }),
        node("join", "approval", {
          approverId: finalApprover.id,
          approvalType: ApprovalType.FINAL_APPROVER,
        }),
      ],
      [
        edge("start", "left"),
        edge("start", "right"),
        edge("left", "join"),
        edge("right", "join"),
      ]
    );

    const result = await submitDocument({
      preparerId: preparer.id,
      templateId: template.id,
    });

    const document = await prisma.document.findUniqueOrThrow({
      where: { id: result.id },
      include: { approvalChain: { include: { steps: true } } },
    });

    expect(
      document.approvalChain?.steps.map((step) => step.assignedUserId)
    ).toEqual([reviewer.id, approver.id, finalApprover.id]);
  });

  it("refuses a template routing to a user who no longer exists", async () => {
    const { preparer, finalApprover } = await makeCast();
    const template = await makeTemplate(
      preparer.id,
      [
        node("start", "start"),
        node("gone", "approval", {
          approverId: missingId(),
          approvalType: ApprovalType.REVIEWER,
        }),
        node("b", "approval", {
          approverId: finalApprover.id,
          approvalType: ApprovalType.FINAL_APPROVER,
        }),
      ],
      [edge("start", "gone"), edge("gone", "b")]
    );

    await expect(
      submitDocument({ preparerId: preparer.id, templateId: template.id })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("do not exist"),
    });
  });

  it("refuses to submit through a template with an unfinished approval step", async () => {
    // `makeTemplate` writes straight to the database, which is the only way
    // this shape exists: the save-time schema refuses it. It used to compile
    // to a chain with the step missing, so the document was routed past
    // somebody the graph included with nothing recording it. Now the
    // submission is refused, while there is a person present who can go and
    // finish the template.
    const { preparer, finalApprover } = await makeCast();
    const template = await makeTemplate(
      preparer.id,
      [
        node("start", "start"),
        node("unfinished", "approval", {
          label: "Finance review",
          approvalType: ApprovalType.REVIEWER,
        }),
        node("b", "approval", {
          approverId: finalApprover.id,
          approvalType: ApprovalType.FINAL_APPROVER,
        }),
      ],
      [edge("start", "unfinished"), edge("unfinished", "b")]
    );

    await expect(
      submitDocument({ preparerId: preparer.id, templateId: template.id })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("Finance review"),
    });
  });

  it("refuses to route a document down a branch its condition did not pick", async () => {
    // A decision with only a Yes branch. The document does not match, so
    // there is nowhere for it to go and the chain comes out empty — which
    // documents.service refuses. Before, the compiler fell through to
    // `outgoing[0]`, which IS the Yes edge: a document that failed the
    // condition was routed through approvers it was never meant to reach.
    const { preparer, finalApprover } = await makeCast();
    const template = await makeTemplate(
      preparer.id,
      [
        node("start", "start"),
        node("d", "decision", {
          condition: { field: "title", operator: "contains", value: "capital" },
        }),
        node("yes", "approval", {
          approverId: finalApprover.id,
          approvalType: ApprovalType.FINAL_APPROVER,
        }),
      ],
      [edge("start", "d"), edge("d", "yes", "yes")]
    );

    await expect(
      submitDocument({
        preparerId: preparer.id,
        templateId: template.id,
        title: "Stationery order",
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("did not produce any approval steps"),
    });
  });
});

describe("who can see a document", () => {
  const setup = async () => {
    const cast = await makeCast();
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.approver, cast.finalApprover),
    });
    return { ...cast, documentId: document.id };
  };

  it("shows it to the preparer", async () => {
    const { preparer, documentId } = await setup();

    const { documents } = await documentsService.getDocuments(preparer.id);
    expect(documents.map((doc) => doc.id)).toContain(documentId);
  });

  it("shows it to the approver it is sitting with", async () => {
    const { reviewer, documentId } = await setup();

    const { documents } = await documentsService.getDocuments(reviewer.id);
    expect(documents.map((doc) => doc.id)).toContain(documentId);
  });

  it("hides it from an approver the workflow has not reached", async () => {
    // Step 3 is in the chain, but nobody has asked them anything yet. A queue
    // that shows work that is not yours yet is a queue people stop reading.
    const { finalApprover, documentId } = await setup();

    const { documents } = await documentsService.getDocuments(finalApprover.id);
    expect(documents.map((doc) => doc.id)).not.toContain(documentId);
  });

  it("hides it from someone who is not in the chain at all", async () => {
    const { bystander } = await setup();

    const { documents } = await documentsService.getDocuments(bystander.id);
    expect(documents).toEqual([]);
  });

  it("refuses a bystander who asks for it by id", async () => {
    const { bystander, documentId } = await setup();

    await expect(
      documentsService.getDocumentById(documentId, bystander.id)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses a bystander who asks for the file", async () => {
    const { bystander, documentId } = await setup();

    await expect(
      documentsService.getDocumentFile(documentId, bystander.id)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("gives the stored pdf to someone with access", async () => {
    const { reviewer, documentId } = await setup();

    const file = await documentsService.getDocumentFile(documentId, reviewer.id);

    expect(file.buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(file.fileName).toBe(`document-${documentId.slice(0, 8)}-v1.pdf`);
  });

  it("reports not-found for a document id that does not exist", async () => {
    const user = await makeUser();

    await expect(
      documentsService.getDocumentById(missingId(), user.id)
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("the pending count", () => {
  it("counts only the documents waiting on this user right now", async () => {
    const { preparer, reviewer, approver, finalApprover } = await makeCast();
    const chain = chainOf(reviewer, approver, finalApprover);

    await submitDocument({ preparerId: preparer.id, approvalChain: chain });
    await submitDocument({ preparerId: preparer.id, approvalChain: chain });

    expect(await documentsService.getPendingApprovalCount(reviewer.id)).toEqual({
      count: 2,
    });
    expect(await documentsService.getPendingApprovalCount(approver.id)).toEqual({
      count: 0,
    });
    expect(await documentsService.getPendingApprovalCount(preparer.id)).toEqual({
      count: 0,
    });
  });
});

describe("deleteDocument", () => {
  const setup = async () => {
    const cast = await makeCast();
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });
    return { ...cast, documentId: document.id };
  };

  it("withdraws, ending the run and keeping every version on record", async () => {
    const { preparer, documentId } = await setup();
    const before = await storedBytes(documentId);

    await documentsService.withdrawDocument(documentId, preparer.id, "No longer needed");

    const document = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      include: { currentWorkflowRun: true, versions: true },
    });

    expect(document.status).toBe("DELETED");
    expect(document.deletedAt).not.toBeNull();
    expect(document.currentWorkflowRun?.status).toBe("SUPERSEDED");
    // On record, not hidden: a withdrawn memo can still be opened and read.
    expect(document.versions.some((version) => !version.isDeleted)).toBe(true);

    // The bytes stay: every approval action still names the file it produced,
    // and an audit trail pointing at files that are gone is not a trail.
    expect(await storedBytes(documentId)).toEqual(before);
  });

  it("refuses anyone but the preparer", async () => {
    const { reviewer, documentId } = await setup();

    await expect(
      documentsService.withdrawDocument(documentId, reviewer.id, "No longer needed")
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses a second delete", async () => {
    const { preparer, documentId } = await setup();
    await documentsService.withdrawDocument(documentId, preparer.id, "No longer needed");

    await expect(
      documentsService.withdrawDocument(documentId, preparer.id, "No longer needed")
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("tells the approvers, but not the preparer who did it", async () => {
    const { preparer, reviewer, documentId } = await setup();
    await prisma.notification.deleteMany();

    await documentsService.withdrawDocument(documentId, preparer.id, "No longer needed");

    const notified = await prisma.notification.findMany();
    expect(notified.map((row) => row.recipientId)).toContain(reviewer.id);
    expect(notified.map((row) => row.recipientId)).not.toContain(preparer.id);
  });

  it("still serves the file once it is withdrawn, because it is on record", async () => {
    const { preparer, documentId } = await setup();
    await documentsService.withdrawDocument(documentId, preparer.id, "No longer needed");

    const { buffer } = await documentsService.getDocumentFile(documentId, preparer.id);
    expect(buffer.length).toBeGreaterThan(0);
  });

  describe("once the document has been approved", () => {
    /*
     * Deleting is for retracting something still in flight. An approved
     * document is a finished record: its final version carries the approvers'
     * signatures and the audit trail cites that file. The preparer alone
     * could retract it, and a resubmit afterwards writes over the signed PDF
     * the trail points at - so the record the ledger refers to could be
     * replaced by one nobody signed, by one person, with no approval.
     */
    // Moved to the top of the file when printing needed the same state: the
    // print gate and the delete refusal are both about a finished record, and
    // two fixtures for it would let them drift into testing different things.
    const approved = approvedMemo;

    it("refuses to delete it", async () => {
      const { preparer, documentId } = await approved();

      await expect(
        documentsService.withdrawDocument(documentId, preparer.id, "No longer needed")
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("says why, in terms of the record rather than of a rule", async () => {
      const { preparer, documentId } = await approved();

      await expect(
        documentsService.withdrawDocument(documentId, preparer.id, "No longer needed")
      ).rejects.toMatchObject({
        message: expect.stringContaining("audit ledger"),
      });
    });

    it("leaves the document and its signed file exactly as they were", async () => {
      const { preparer, documentId } = await approved();
      await expect(
        documentsService.withdrawDocument(documentId, preparer.id, "No longer needed")
      ).rejects.toThrow();

      const document = await prisma.document.findUniqueOrThrow({
        where: { id: documentId },
        include: { versions: true },
      });

      expect(document.status).toBe("APPROVED");
      expect(document.deletedAt).toBeNull();
      expect(document.versions.some((version) => version.isDeleted)).toBe(false);
    });

    it("keeps a filed memo's PDF when something after filing fails, and says it was filed", async () => {
      // The first approver's notice is sent after the memo's transaction has
      // committed. A failure there used to run the clean-up meant for a failed
      // transaction, and deleted the PDF of a memo that exists.
      const cast = await makeCast();
      const spy = vi
        .spyOn(notificationsService, "createNotifications")
        .mockRejectedValueOnce(new Error("mail queue unavailable"));

      let refused: unknown;
      try {
        await submitDocument({
          preparerId: cast.preparer.id,
          approvalChain: chainOf(cast.reviewer, cast.finalApprover),
        });
      } catch (error) {
        refused = error;
      } finally {
        spy.mockRestore();
      }

      expect(refused).toMatchObject({ code: "SUBMITTED_WITH_ERRORS" });
      const filed = await prisma.document.findFirstOrThrow({
        where: { preparerId: cast.preparer.id },
      });
      expect((refused as Error).message).toContain(filed.referenceNumber!);
      expect((await storedBytes(filed.id)).length).toBeGreaterThan(0);
    });

    it("does not overwrite a final approval that lands while it is deleting", async () => {
      // The delete reads the memo, then prepares its notices, then writes. A
      // final approval committing in that gap used to be overwritten, and an
      // approved memo was marked deleted. The approval is made to land in
      // exactly that gap: while the delete is preparing its first notice.
      const cast = await makeCast();
      const document = await submitDocument({
        preparerId: cast.preparer.id,
        approvalChain: chainOf(cast.reviewer, cast.finalApprover),
      });
      await approvalService.approve(document.id, cast.reviewer.id, signature());

      const original = notificationsService.andTheirDelegate.bind(notificationsService);
      const spy = vi
        .spyOn(notificationsService, "andTheirDelegate")
        .mockImplementationOnce(async (notice) => {
          await approvalService.approve(document.id, cast.finalApprover.id, signature());
          return original(notice);
        });

      try {
        await expect(
          documentsService.withdrawDocument(document.id, cast.preparer.id, "No longer needed")
        ).rejects.toThrow(/changed while it was being withdrawn/);
      } finally {
        spy.mockRestore();
      }

      const after = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
      expect(after.status).toBe("APPROVED");
      expect(after.deletedAt).toBeNull();
    });

    it("refuses to delete a rejected document, which is a closed record", async () => {
      // Deleting it and uploading over the deleted memo used to revive it
      // with the rejection cleared. Resubmitting it is the way back now.
      const cast = await makeCast();
      const document = await submitDocument({
        preparerId: cast.preparer.id,
        approvalChain: chainOf(cast.reviewer, cast.finalApprover),
      });
      await approvalService.reject(document.id, cast.reviewer.id, {
        comment: "The lease term is wrong.",
      });

      await expect(
        documentsService.withdrawDocument(document.id, cast.preparer.id, "No longer needed")
      ).rejects.toThrow(/rejected document cannot be withdrawn/);
    });
  });
});

describe("a resubmission racing an administrator's cancel", () => {
  it("never reopens a memo the administrator has just cancelled", async () => {
    const cast = await makeCast();
    const admin = await makeUser({ firstName: "Ada", loginRole: LoginRole.ADMINISTRATOR });
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });
    await approvalService.requestRevision(document.id, cast.reviewer.id, {
      comment: "Fix the dates.",
    });

    await Promise.allSettled([
      resubmitDocument({ documentId: document.id, preparerId: cast.preparer.id }),
      documentsService.cancelDocument(document.id, admin.id, "Abandoned"),
    ]);

    // Whichever landed first, the other did not land on top of it: a
    // cancelled memo has no new version, and a resubmitted one is not
    // cancelled.
    const after = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    if (after.status === "DELETED") {
      expect(after.currentVersionNumber).toBe(1);
    } else {
      expect(after.status).toBe("PENDING_REVIEW");
      expect(after.currentVersionNumber).toBe(2);
    }
  });
});

describe("what the memo page is told about resubmitting", () => {
  it("says whether a resubmission must be signed, by the same rule the resubmission is held to", async () => {
    const cast = await makeCast();
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer),
    });

    const detail = await documentsService.getDocumentById(document.id, cast.preparer.id);

    expect(detail.resubmissionSigned).toBe(preparerMustSign(null));
  });
});

describe("resubmitting after a rejection", () => {
  const rejected = async () => {
    const cast = await makeCast();
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });
    await approvalService.approve(document.id, cast.reviewer.id, signature());
    await approvalService.reject(document.id, cast.finalApprover.id, {
      comment: "The lease term is wrong.",
    });
    const before = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    return { cast, document, rejectedRunId: before.currentWorkflowRunId! };
  };

  it("starts a new cycle from the first step, as a new version, under the same reference", async () => {
    const { cast, document } = await rejected();

    await resubmitDocument({ documentId: document.id, preparerId: cast.preparer.id });

    const after = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(after.status).toBe("PENDING_REVIEW");
    expect(after.currentVersionNumber).toBe(2);
    expect(after.referenceNumber).toBe(document.referenceNumber);

    expect(await currentPosition(document.id)).toMatchObject({
      runStatus: "IN_PROGRESS",
      stepOrder: 1,
      assignedTo: cast.reviewer.id,
    });
  });

  it("lets only one of two resubmissions sent together land, and keeps the winner's file", async () => {
    // Both compute v2. The loser used to clean up by deleting the file the
    // winner had just filed under the same name.
    const { cast, document } = await rejected();

    const outcomes = await Promise.allSettled([
      resubmitDocument({ documentId: document.id, preparerId: cast.preparer.id }),
      resubmitDocument({ documentId: document.id, preparerId: cast.preparer.id }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const versions = await prisma.documentVersion.findMany({
      where: { documentId: document.id },
      orderBy: { versionNumber: "asc" },
    });
    expect(versions.map((version) => version.versionNumber)).toEqual([1, 2]);

    // The winner's file is there and is the file its checksum describes.
    const file = await fs.readFile(
      path.join(path.resolve(env.STORAGE_DIR), "documents", versions[1].storagePath)
    );
    expect(file.length).toBeGreaterThan(0);
    expect(sha256(file)).toBe(versions[1].storageChecksum);
  });

  it("keeps the rejected cycle exactly as it ended", async () => {
    const { cast, document, rejectedRunId } = await rejected();

    await resubmitDocument({ documentId: document.id, preparerId: cast.preparer.id });

    const rejectedRun = await prisma.workflowRun.findUniqueOrThrow({ where: { id: rejectedRunId } });
    expect(rejectedRun.status).toBe("REJECTED");

    const actions = await prisma.approvalAction.findMany({
      where: { workflowRunId: rejectedRunId },
      orderBy: { createdAt: "asc" },
    });
    expect(actions.map((row) => row.action)).toEqual(["APPROVE", "REJECT"]);

    const v1 = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId: document.id, versionNumber: 1 },
    });
    expect(v1.storagePath).toBeTruthy();
  });

  it("does not let the preparer change the approvers", async () => {
    const { cast, document } = await rejected();
    const someoneElse = await makeUser({ firstName: "Nadia" });

    await expect(
      resubmitDocument({
        documentId: document.id,
        preparerId: cast.preparer.id,
        approvalChain: chainOf(someoneElse, cast.finalApprover),
      })
    ).rejects.toThrow(/cannot be changed once an approver has acted/);
  });

  it("refuses while an approver on the chain has left, naming them", async () => {
    const { cast, document } = await rejected();
    await prisma.user.update({
      where: { id: cast.finalApprover.id },
      data: { deactivatedAt: new Date() },
    });

    await expect(
      resubmitDocument({ documentId: document.id, preparerId: cast.preparer.id })
    ).rejects.toThrow(/no longer has an account here/);
  });

  it("is only for the preparer", async () => {
    const { cast, document } = await rejected();

    await expect(
      resubmitDocument({ documentId: document.id, preparerId: cast.reviewer.id })
    ).rejects.toThrow(/Only the document preparer/);
  });
});

describe("listing documents", () => {
  /**
   * `updatedAt` carries `@updatedAt`, so Prisma rewrites it on every write and
   * a test cannot say through the client that a document was last touched in
   * March. This says it once, in SQL, and it stays said.
   */
  const dateDocument = (
    documentId: string,
    submittedAt: string,
    updatedAt: string
  ) =>
    prisma.$executeRaw`
      UPDATE documents
      SET submitted_at = ${new Date(submittedAt)},
          updated_at = ${new Date(updatedAt)}
      WHERE id = ${documentId}::uuid
    `;

  /**
   * Three documents from one preparer. Submission order and last-touched
   * order are deliberately different, so a sort that quietly fell back to
   * updatedAt cannot pass a test that asked for newest-submitted.
   */
  const setup = async () => {
    const cast = await makeCast();
    const approvalChain = chainOf(cast.reviewer, cast.finalApprover);

    const budget = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain,
      title: "Q3 budget",
      description: "Quarterly spending plan",
    });
    const policy = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain,
      title: "Travel policy",
      description: "Mileage and hotel limits",
    });
    const contract = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain,
      title: "Vendor contract",
      description: "Acme renewal, three years",
    });

    // Submitted, oldest first: budget, policy, contract.
    // Touched, oldest first:   contract, budget, policy.
    await dateDocument(budget.id, "2026-01-05T09:00:00Z", "2026-05-02T09:00:00Z");
    await dateDocument(policy.id, "2026-02-05T09:00:00Z", "2026-06-03T09:00:00Z");
    await dateDocument(contract.id, "2026-03-05T09:00:00Z", "2026-04-01T09:00:00Z");

    return { ...cast, budget, policy, contract };
  };

  const titles = (documents: { title: string }[]) =>
    documents.map((document) => document.title);

  describe("when it is asked for nothing", () => {
    it("returns every document the caller can see, with a total beside them", async () => {
      const { preparer } = await setup();

      const result = await documentsService.getDocuments(preparer.id);

      expect(titles(result.documents).sort()).toEqual([
        "Q3 budget",
        "Travel policy",
        "Vendor contract",
      ]);
      // Every screen sends no parameters today and reads this as the whole
      // set - the KPI row and the queue tab counts are computed over it. A
      // default page size here would not paginate them, it would make their
      // numbers wrong.
      expect(result).toMatchObject({ total: 3, returned: 3 });
    });

    it("keeps the order it had before it accepted parameters, last touched first", async () => {
      const { preparer } = await setup();

      const { documents } = await documentsService.getDocuments(preparer.id);

      expect(titles(documents)).toEqual([
        "Travel policy",
        "Q3 budget",
        "Vendor contract",
      ]);
    });
  });

  describe("searching", () => {
    it("finds a document by a word in its title", async () => {
      const { preparer } = await setup();

      const { documents, total } = await documentsService.getDocuments(
        preparer.id,
        { q: "budget" }
      );

      expect(titles(documents)).toEqual(["Q3 budget"]);
      // total counts the matches, not the corpus - it is what a pager divides.
      expect(total).toBe(1);
    });

    it("finds a document by a word in its description", async () => {
      const { preparer } = await setup();

      const { documents } = await documentsService.getDocuments(preparer.id, {
        q: "mileage",
      });

      expect(titles(documents)).toEqual(["Travel policy"]);
    });

    it("ignores case, because nobody types a title back exactly", async () => {
      const { preparer } = await setup();

      const { documents } = await documentsService.getDocuments(preparer.id, {
        q: "VENDOR",
      });

      expect(titles(documents)).toEqual(["Vendor contract"]);
    });

    it("finds a document by the reference printed on its file cover", async () => {
      const { preparer, budget } = await setup();

      const { documents } = await documentsService.getDocuments(preparer.id, {
        q: budget.referenceNumber!,
      });

      // The reference is the one handle that leaves the system on paper. A
      // person holding the file and typing it back in is the whole reason for
      // giving the memo a reference at all.
      expect(titles(documents)).toEqual(["Q3 budget"]);
    });

    it("matches every word somewhere rather than the whole phrase in one column", async () => {
      const { reviewer, finalApprover } = await setup();
      const maria = await makeUser({ firstName: "Maria", lastName: "Chen" });
      const hers = await submitDocument({
        preparerId: maria.id,
        approvalChain: chainOf(reviewer, finalApprover),
        title: "Server refresh",
      });

      // "Maria Chen" sits in no single column, so a whole-string LIKE finds
      // nobody - and a person hunting for somebody else's paper types exactly
      // that. Reversed here as well, because word order is not a filter.
      const { documents, total } = await documentsService.getDocuments(
        reviewer.id,
        { q: "chen maria" }
      );

      expect(documents.map((document) => document.id)).toEqual([hers.id]);
      expect(total).toBe(1);
    });

    it("does not let a search reach a document the searcher cannot open", async () => {
      // Filtering narrows what a person already sees. If the term were applied
      // instead of the access rule, searching would become a way to read
      // anything by name.
      const { bystander } = await setup();

      const result = await documentsService.getDocuments(bystander.id, {
        q: "budget",
      });

      expect(result).toMatchObject({ documents: [], total: 0, returned: 0 });
    });
  });

  describe("filtering by status", () => {
    it("returns only the documents in that state", async () => {
      const { preparer, reviewer, budget } = await setup();
      await approvalService.reject(budget.id, reviewer.id, {
        comment: "The lease term is wrong.",
      });

      const { documents, total } = await documentsService.getDocuments(
        preparer.id,
        { status: ["REJECTED"] }
      );

      expect(titles(documents)).toEqual(["Q3 budget"]);
      expect(total).toBe(1);
    });

    it("treats a list of statuses as any-of", async () => {
      const { preparer, reviewer, budget } = await setup();
      await approvalService.reject(budget.id, reviewer.id, {
        comment: "The lease term is wrong.",
      });

      // Two finished states asked for together; the two still in flight must
      // not come back, or the filter is decoration.
      const { documents } = await documentsService.getDocuments(preparer.id, {
        status: ["REJECTED", "APPROVED"],
      });

      expect(titles(documents)).toEqual(["Q3 budget"]);
    });

    it("answers a status nothing is in with an empty list", async () => {
      const { preparer } = await setup();

      const result = await documentsService.getDocuments(preparer.id, {
        status: ["APPROVED"],
      });

      expect(result).toMatchObject({ documents: [], total: 0, returned: 0 });
    });
  });

  describe("sorting", () => {
    it("orders by when documents were submitted", async () => {
      const { preparer } = await setup();

      const newest = await documentsService.getDocuments(preparer.id, {
        sort: "newest",
      });
      const oldest = await documentsService.getDocuments(preparer.id, {
        sort: "oldest",
      });

      expect(titles(newest.documents)).toEqual([
        "Vendor contract",
        "Travel policy",
        "Q3 budget",
      ]);
      expect(titles(oldest.documents)).toEqual([
        "Q3 budget",
        "Travel policy",
        "Vendor contract",
      ]);
    });

    it("orders by when documents were last touched, which is a different order", async () => {
      const { preparer } = await setup();

      const stalest = await documentsService.getDocuments(preparer.id, {
        sort: "least_recently_updated",
      });

      // Not the reverse of "oldest": the fixture's two orders disagree on
      // purpose, so a sort wired to the wrong column shows up here.
      expect(titles(stalest.documents)).toEqual([
        "Vendor contract",
        "Q3 budget",
        "Travel policy",
      ]);
    });

    it("puts a document nobody has submitted last, not first", async () => {
      // A draft has no submission date. Opening an oldest-submitted-first
      // queue with things nobody has submitted answers a different question.
      const { preparer, contract } = await setup();
      await prisma.document.update({
        where: { id: contract.id },
        data: { submittedAt: null },
      });

      const { documents } = await documentsService.getDocuments(preparer.id, {
        sort: "oldest",
      });

      expect(titles(documents).at(-1)).toBe("Vendor contract");
    });
  });

  describe("paging", () => {
    it("returns one page and reports the size of the whole result", async () => {
      const { preparer } = await setup();

      const page = await documentsService.getDocuments(preparer.id, {
        limit: 2,
      });

      expect(page.returned).toBe(2);
      expect(page.documents).toHaveLength(2);
      // total is what the pager counts pages with; if it were the page size,
      // the screen would claim there is nothing after page one.
      expect(page.total).toBe(3);
    });

    it("hands back the rest of the result on the next page", async () => {
      const { preparer } = await setup();

      const first = await documentsService.getDocuments(preparer.id, {
        limit: 2,
        offset: 0,
      });
      const second = await documentsService.getDocuments(preparer.id, {
        limit: 2,
        offset: 2,
      });

      expect(second.returned).toBe(1);
      // Nothing may appear on both pages and nothing may be skipped between
      // them, or turning the page quietly hides somebody's document.
      expect(
        [...titles(first.documents), ...titles(second.documents)].sort()
      ).toEqual(["Q3 budget", "Travel policy", "Vendor contract"]);
    });

    it("answers an offset past the end with an empty page and the real total", async () => {
      const { preparer } = await setup();

      const result = await documentsService.getDocuments(preparer.id, {
        limit: 2,
        offset: 50,
      });

      // An empty page is the honest answer to "show me rows 51 to 52", and
      // the unchanged total is what sends the reader back to page one rather
      // than telling them their documents are gone.
      expect(result).toMatchObject({ documents: [], total: 3, returned: 0 });
    });

    it("counts only the documents this person is allowed to open", async () => {
      // The database filter is coarse - it matches anyone named anywhere in
      // the chain, including an approver the workflow has not reached. Were
      // total a COUNT over that, the final approver would be told three
      // documents were waiting and then shown an empty page.
      const { finalApprover } = await setup();

      const result = await documentsService.getDocuments(finalApprover.id, {
        limit: 2,
      });

      expect(result).toMatchObject({ documents: [], total: 0, returned: 0 });
    });

    it("fills a page from what the caller can see, not from what the query matched", async () => {
      const { reviewer } = await setup();

      const page = await documentsService.getDocuments(reviewer.id, {
        limit: 2,
      });

      // The reviewer holds all three, so a page of two must arrive with two
      // documents on it - a page cut before the access filter would arrive
      // short whenever a row in front of it turned out to be off limits.
      expect(page).toMatchObject({ returned: 2, total: 3 });
    });
  });
});

describe("the memo reference", () => {
  const submit = async () => {
    const cast = await makeCast();
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });
    return { ...cast, document };
  };

  it("gives every submitted memo a reference in this year's series", async () => {
    const { document } = await submit();

    // A uuid is not a reference. This is what gets quoted in a reply, written
    // on the paper file and typed back into search, so it has to be short,
    // shaped the same every time, and dated.
    expect(document.referenceNumber).toMatch(MEMO_REFERENCE_PATTERN);
    expect(document.referenceNumber?.startsWith(
      memoReferenceYearPrefix(new Date().getFullYear())
    )).toBe(true);
  });

  it("counts up from the first memo of the year", async () => {
    const cast = await makeCast();
    const approvalChain = chainOf(cast.reviewer, cast.finalApprover);

    const first = await submitDocument({ preparerId: cast.preparer.id, approvalChain });
    const second = await submitDocument({ preparerId: cast.preparer.id, approvalChain });

    const year = new Date().getFullYear();
    expect(first.referenceNumber).toBe(formatMemoReference(year, 1));
    expect(second.referenceNumber).toBe(formatMemoReference(year, 2));
  });

  it("issues distinct references to memos submitted at the same moment", async () => {
    const cast = await makeCast();
    const approvalChain = chainOf(cast.reviewer, cast.finalApprover);

    // The column is unique, so two submitters who read the same maximum
    // produce one commit and one refusal - and the refusal lands on a person
    // whose memo was fine. Six at once is the shape of a Monday morning.
    const submitted = await Promise.all(
      Array.from({ length: 6 }, () =>
        submitDocument({ preparerId: cast.preparer.id, approvalChain })
      )
    );

    const references = submitted.map((document) => document.referenceNumber);
    expect(new Set(references).size).toBe(6);

    // Contiguous as well as distinct: a gap would mean a reference was minted
    // and then lost, and somebody reading the file would go looking for it.
    const year = new Date().getFullYear();
    expect([...references].sort()).toEqual(
      Array.from({ length: 6 }, (_, index) => formatMemoReference(year, index + 1))
    );
  });

  it("keeps the reference the memo was given when it is resubmitted", async () => {
    const { preparer, reviewer, finalApprover, document } = await submit();
    await documentsService.withdrawDocument(document.id, preparer.id, "No longer needed");

    await resubmitDocument({
      documentId: document.id,
      preparerId: preparer.id,
      approvalChain: chainOf(reviewer, finalApprover),
    });

    const stored = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });

    // The reference is already quoted in a reply and written on the file
    // cover by now. A resubmission is the same memo coming round again, and
    // renumbering it would strand every reference to it that exists on paper.
    expect(stored.referenceNumber).toBe(document.referenceNumber);
  });

  it("hands the reference back on the document, not just into the database", async () => {
    const { preparer, document } = await submit();

    const [detail, listed] = await Promise.all([
      documentsService.getDocumentById(document.id, preparer.id),
      documentsService.getDocuments(preparer.id),
    ]);

    expect(detail.referenceNumber).toBe(document.referenceNumber);
    expect(listed.documents[0]).toMatchObject({
      referenceNumber: document.referenceNumber,
    });
  });
});

describe("downloading the file", () => {
  const downloads = (documentId: string) =>
    prisma.auditLog.findMany({
      where: { entityId: documentId, action: "DOCUMENT_DOWNLOADED" },
    });

  const served = async (documentId: string) =>
    (
      await prisma.auditLog.findMany({
        where: {
          entityId: documentId,
          action: { in: ["DOCUMENT_VIEWED", "DOCUMENT_DOWNLOADED"] },
        },
        orderBy: { createdAt: "asc" },
        select: { action: true },
      })
    ).map((row) => row.action);

  /**
   * The two acts the one route serves.
   *
   * An approver opens a memo to read it before signing: nothing leaves the
   * system. An approver presses Download: a copy does. Both fetch identical
   * bytes from the same url, and only the caller knows which it is - so a
   * trail that cannot tell them apart says every approver who ever read a
   * memo took a copy of it away.
   */
  const serveFor = (documentId: string, userId: string) => ({
    view: () => documentsService.getDocumentFile(documentId, userId, "VIEW"),
    download: () =>
      documentsService.getDocumentFile(documentId, userId, "DOWNLOAD"),
  });

  it("does not record reading a memo as taking a copy of it away", async () => {
    const cast = await makeCast();
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });

    await serveFor(document.id, cast.reviewer.id).view();

    expect(await served(document.id)).toEqual(["DOCUMENT_VIEWED"]);
    expect(await downloads(document.id)).toEqual([]);
  });

  it("still records a copy leaving the system as exactly that", async () => {
    const cast = await makeCast();
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });
    const serve = serveFor(document.id, cast.reviewer.id);

    await serve.view();
    await serve.download();

    expect(await served(document.id)).toEqual([
      "DOCUMENT_VIEWED",
      "DOCUMENT_DOWNLOADED",
    ]);
  });

  it("records a caller that does not say the way it always did", async () => {
    // Absent is not "view". Anything not taught to declare itself keeps the
    // meaning its rows have always had, rather than being quietly downgraded.
    const cast = await makeCast();
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });

    await documentsService.getDocumentFile(document.id, cast.reviewer.id);

    expect(await served(document.id)).toEqual(["DOCUMENT_DOWNLOADED"]);
  });

  it("says as much about a view as it does about a download", async () => {
    // The row is evidence either way: which of the three copies of a memo
    // somebody was shown matters as much as whether they kept it.
    const cast = await makeCast();
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });
    const version = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId: document.id },
    });

    await serveFor(document.id, cast.reviewer.id).view();

    const [row] = await prisma.auditLog.findMany({
      where: { entityId: document.id, action: "DOCUMENT_VIEWED" },
    });

    expect(row.actorId).toBe(cast.reviewer.id);
    expect(row.newValue).toMatchObject({
      storagePath: version.storagePath,
      servedFile: "AS_SUBMITTED",
    });
  });

  it("records who took a copy and which file they were given", async () => {
    const cast = await makeCast();
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });
    const version = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId: document.id },
    });

    await documentsService.getDocumentFile(document.id, cast.reviewer.id);

    const [row, ...rest] = await downloads(document.id);
    expect(rest).toEqual([]);
    expect(row.actorId).toBe(cast.reviewer.id);
    // A memo carries somebody's pay or their conduct. Once a copy is out,
    // "who has one, and which one" is a question the record has to answer -
    // and the same memo has an as-submitted copy and a signed one.
    expect(row.newValue).toMatchObject({
      storagePath: version.storagePath,
      servedFile: "AS_SUBMITTED",
    });
  });

  it("names the approved copy once the memo has one", async () => {
    const { preparer, documentId } = await approvedMemo();
    const stored = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
    });

    await documentsService.getDocumentFile(documentId, preparer.id);

    const [row] = await downloads(documentId);
    expect(row.newValue).toMatchObject({
      storagePath: stored.finalSignedStoragePath,
      servedFile: "APPROVED",
    });
  });

  it("records nothing when the file was refused", async () => {
    const cast = await makeCast();
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });

    await expect(
      documentsService.getDocumentFile(document.id, cast.bystander.id)
    ).rejects.toMatchObject({ statusCode: 403 });

    // A download row for a download that never happened is worse than no row
    // at all: it puts a copy in somebody's hands in the record.
    expect(await downloads(document.id)).toEqual([]);
  });
});

describe("printing the approved memo", () => {
  const prints = (documentId: string) =>
    prisma.auditLog.findMany({
      where: { entityId: documentId, action: "DOCUMENT_PRINTED" },
    });

  it("records the print against the memo and the person who asked for it", async () => {
    const { preparer, documentId } = await approvedMemo();
    const stored = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
    });

    await documentsService.printDocument(documentId, preparer.id);

    const [row, ...rest] = await prints(documentId);
    expect(rest).toEqual([]);
    expect(row.actorId).toBe(preparer.id);
    expect(row.newValue).toMatchObject({
      referenceNumber: stored.referenceNumber,
      storagePath: stored.finalSignedStoragePath,
    });
  });

  it("refuses to print a memo that is still going round the chain", async () => {
    const cast = await makeCast();
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });

    // On paper a part-signed memo and the approved one look the same, and
    // there is nothing on the sheet to say the last approver never signed.
    // Filing that as the record is the failure this gate exists to prevent.
    await expect(
      documentsService.printDocument(document.id, cast.preparer.id)
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await prints(document.id)).toEqual([]);
  });

  it("refuses an approved memo that has no approved copy recorded", async () => {
    const { preparer, documentId } = await approvedMemo();
    await prisma.document.update({
      where: { id: documentId },
      data: { finalSignedStoragePath: null },
    });

    // Approved before the approved version was fixed against the document.
    // The status says yes and there is still nothing to certify as the
    // printed record, so printing would produce a sheet nobody can trace.
    await expect(
      documentsService.printDocument(documentId, preparer.id)
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses somebody who is not allowed to open the memo at all", async () => {
    const { bystander, documentId } = await approvedMemo();

    // Who may print it is not a separate question from who may read it: an
    // approved memo is exactly the copy an outsider would want.
    await expect(
      documentsService.printDocument(documentId, bystander.id)
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(await prints(documentId)).toEqual([]);
  });

  it("reports not-found for a memo that does not exist", async () => {
    const user = await makeUser();

    await expect(
      documentsService.printDocument(missingId(), user.id)
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("what an administrator can see", () => {
  /*
   * The gap this closes, found by running a memo end to end on a real
   * install: after final approval the administrator could not see it
   * anywhere. Not in the documents list - the access rule asked only whether
   * you prepared it or sat on its chain - and not on the oversight screen,
   * which deliberately shows only what is still in flight. The record existed
   * and the one person answerable for the process could not open it.
   *
   * These run through the service rather than the rule, because the rule was
   * only half the fault: the other half was that nothing told the service who
   * was asking.
   */

  it("sees a memo it took no part in, once it is approved", async () => {
    const { document } = await approvedMemo();
    const administrator = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });

    const list = await documentsService.getDocuments(administrator.id);

    expect(list.documents.map((d) => d.id)).toContain(document.id);
    // And can open it, which is the half a list-only fix would have missed.
    await expect(
      documentsService.getDocumentById(document.id, administrator.id)
    ).resolves.toMatchObject({ id: document.id, status: "APPROVED" });
  });

  it("sees one that is still in flight", async () => {
    const cast = await makeCast();
    const administrator = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });

    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.approver, cast.finalApprover),
    });

    const list = await documentsService.getDocuments(administrator.id);

    expect(list.documents.map((d) => d.id)).toContain(document.id);
  });

  it("does not see somebody else's draft", async () => {
    const cast = await makeCast();
    const administrator = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });

    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.approver, cast.finalApprover),
    });
    // Deleting returns it to the preparer's hands; a draft is the same claim.
    await prisma.document.update({
      where: { id: document.id },
      data: { status: "DRAFT" },
    });

    const list = await documentsService.getDocuments(administrator.id);

    expect(list.documents.map((d) => d.id)).not.toContain(document.id);
    await expect(
      documentsService.getDocumentById(document.id, administrator.id)
    ).rejects.toThrow(/Access denied/);
  });

  it("changes nothing for an ordinary bystander", async () => {
    // The widening is the administrator's alone. If this ever passes for a
    // USER, the rule has stopped being a rule.
    const { document, bystander } = await approvedMemo();

    const list = await documentsService.getDocuments(bystander.id);

    expect(list.documents.map((d) => d.id)).not.toContain(document.id);
    await expect(
      documentsService.getDocumentById(document.id, bystander.id)
    ).rejects.toThrow(/Access denied/);
  });
});

describe("when a memo says it was submitted", () => {
  it("stamps the moment, because the dashboard measures from it", async () => {
    /*
     * `createDocument` set the status to PENDING_REVIEW and started the
     * workflow run but left `submittedAt` null, so every memo submitted
     * through the Submit Document screen carried no submission time. Two
     * things broke quietly: "newest first" sorts on it, and the dashboard's
     * median cycle time is measured from it and so could never be computed.
     */
    const cast = await makeCast();
    const before = Date.now();

    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.approver, cast.finalApprover),
    });

    const stored = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
      select: { status: true, submittedAt: true },
    });

    expect(stored.status).toBe("PENDING_REVIEW");
    expect(stored.submittedAt).not.toBeNull();
    expect(stored.submittedAt!.getTime()).toBeGreaterThanOrEqual(before);
  });
});
