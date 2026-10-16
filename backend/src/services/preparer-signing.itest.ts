import { afterEach, describe, expect, it } from "vitest";

import { useStoredWorkflowPolicy } from "../lib/workflowPolicy";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  makeUpload,
  signature,
  useCleanDatabase,
} from "../test/db";
import { documentsService } from "./documents.service";

/**
 * Submitting a document without signing it.
 *
 * Submitting used to mean signing, always, and for a memo somebody writes and
 * recommends in their own name it still does. But an organisation whose
 * submitters lodge documents they did not write has a different shape: they
 * forward it, and the first mark on the page belongs to the first approver.
 *
 * The rule has to hold in both directions to be worth anything. A document
 * that must be signed cannot arrive unsigned, and a document nobody signs at
 * submission cannot arrive carrying a signature - otherwise the second is
 * just a way of putting a mark on a page that prints no line for it.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;

const policy = (preparerSignsOnSubmit: boolean) =>
  useStoredWorkflowPolicy({
    slaDefaultDays: null,
    allowStepSkip: false,
    preparerSignsOnSubmit,
    sealApprovedMemos: true,
  });

afterEach(() => useStoredWorkflowPolicy(null));

const upload = async (overrides: Record<string, unknown> = {}) => {
  cast = cast ?? (await makeCast());
  const { document } = await documentsService.createDocument(
    {
      title: "Lodged, not written",
      approvalChain: chainOf(cast.approver, cast.finalApprover),
      ...overrides,
    },
    await makeUpload(),
    cast.preparer.id
  );
  return document;
};

describe("when the organisation says submitters do not sign", () => {
  it("accepts a document with no signature at all", async () => {
    cast = await makeCast();
    policy(false);

    const document = await upload();

    expect(document.status).toBe("PENDING_REVIEW");
    expect(document.referenceNumber).toMatch(/^MEMO-\d{4}-\d{4}$/);
  });

  it("sends it straight to the first approver", async () => {
    // The whole point of req 1: submitting moves the memo on, it does not
    // record an approval by the person who submitted it.
    cast = await makeCast();
    policy(false);

    const document = await upload();
    const run = await prisma.workflowRun.findFirstOrThrow({
      where: { documentId: document.id },
    });
    const actions = await prisma.approvalAction.findMany({
      where: { workflowRunId: run.id },
    });

    expect(run.currentStepOrder).toBe(1);
    expect(run.status).toBe("IN_PROGRESS");
    expect(actions).toEqual([]);
  });

  it("files both artefacts, exactly as a signed submission does", async () => {
    // Everything downstream reads `storagePath` and `originalStoragePath`.
    // An unsigned submission that wrote only one would be a second shape for
    // every version, checksum, download and rollback path to know about.
    cast = await makeCast();
    policy(false);

    const document = await upload();
    const version = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId: document.id },
    });

    expect(version.storagePath).toBeTruthy();
    expect(version.originalStoragePath).toBeTruthy();
    expect(version.storageChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("says in the trail that nobody signed it", async () => {
    // This used to read `preparerSigned: true` unconditionally, which was
    // true of every document that could exist at the time. A reader asking
    // whose marks are on the page must not be told the preparer's is one.
    cast = await makeCast();
    policy(false);

    const document = await upload();
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: document.id, action: "DOCUMENT_SUBMITTED" },
    });

    const recorded = row.newValue as Record<string, unknown>;
    expect(recorded.preparerSigned).toBe(false);
    expect(recorded).not.toHaveProperty("signaturePage");
  });

  it("refuses a signature offered anyway", async () => {
    // Without this, a client could put the submitter's mark on a document
    // whose strip names only the approvers - a signature on the page that no
    // printed line accounts for and no workflow step ever asked for.
    cast = await makeCast();
    policy(false);

    await expect(upload({ signature: signature() })).rejects.toThrow(
      /not signed by the person submitting it/i
    );
  });
});

describe("when the organisation says submitters do sign", () => {
  it("refuses a submission that arrives without one", async () => {
    cast = await makeCast();
    policy(true);

    await expect(upload()).rejects.toThrow(
      /has to be signed by the person submitting it/i
    );
  });

  it("accepts one that carries a signature", async () => {
    cast = await makeCast();
    policy(true);

    const document = await upload({ signature: signature() });

    expect(document.status).toBe("PENDING_REVIEW");
  });

  it("is what an organisation that has configured nothing gets", async () => {
    // The default that matters most on upgrade. Every document already filed
    // was signed by its preparer, and a deployment that has said nothing has
    // not asked for that to change.
    cast = await makeCast();
    useStoredWorkflowPolicy(null);

    await expect(upload()).rejects.toThrow(
      /has to be signed by the person submitting it/i
    );
  });
});

describe("a memo type that insists, whatever the policy says", () => {
  it("still requires the author's signature with the policy turned off", async () => {
    // An Approval Request is written and recommended by its author in their own
    // name. An organisation turning the default off must not silently take
    // the author's signature off a document that recommends something.
    cast = await makeCast();
    policy(false);

    await expect(
      documentsService.createDocument(
        {
          title: "Approval for Revision of Fuel Allowance",
          memoType: "APPROVAL_REQUEST",
          memoTo: "Sir BMD",
          memoFrom: "Human Resource Department",
          body: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "It is submitted for approval." }],
              },
            ],
          },
          approvalChain: chainOf(cast.approver, cast.finalApprover),
        } as never,
        null,
        cast.preparer.id
      )
    ).rejects.toThrow(/has to be signed by the person submitting it/i);
  });
});
