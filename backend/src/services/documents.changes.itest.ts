import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  missingId,
  resubmitDocument,
  signature,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { approvalService } from "./approval.service";
import { brandingService } from "./branding.service";
import { documentsService } from "./documents.service";

/**
 * What an approver is shown when a memo comes round a second time.
 *
 * The comparison itself is tested on fixtures in `lib/memoDiff.test.ts`. What
 * lives here is everything around it: which two versions are compared, that
 * the superseded one can still be read, who may ask, and that a memo with no
 * text on one side says so rather than pretending.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;

beforeEach(async () => {
  cast = await makeCast();
  brandingService.forget();
});

const body = (...texts: string[]) => ({
  type: "doc",
  content: texts.map((text) => ({
    type: "paragraph",
    content: [{ type: "text", text }],
  })),
});

const FIRST = body(
  "BACKGROUND.",
  "The allowance is PKR 10,000 per month.",
  "Approval is sought."
);
const SECOND = body(
  "BACKGROUND.",
  "The allowance is PKR 12,000 per month.",
  "Approval is sought."
);

const submitTyped = async () => {
  const { document } = await documentsService.createDocument(
    {
      title: "Approval for Revision of Fuel Allowance",
      memoType: "APPROVAL_REQUEST",
      memoTo: "Sir BMD",
      memoFrom: "Human Resource Department",
      body: FIRST,
      approvalChain: chainOf(cast.approver, cast.finalApprover),
      signature: signature(),
    } as never,
    null,
    cast.preparer.id
  );
  return document;
};

/** Submitted, sent back by the first approver, and rewritten into v2. */
const rewritten = async (extra: Record<string, unknown> = {}) => {
  const document = await submitTyped();
  await approvalService.requestRevision(document.id, cast.approver.id, {
    comment: "The figure is out of date.",
  });
  await documentsService.updateDocument(
    document.id,
    { body: SECOND, signature: signature(), ...extra } as never,
    undefined,
    cast.preparer.id
  );
  return document;
};

describe("a first version", () => {
  it("has nothing before it to compare with", async () => {
    const document = await submitTyped();

    const changes = await documentsService.getVersionChanges(
      document.id,
      cast.preparer.id
    );

    expect(changes.current).toMatchObject({ versionNumber: 1, typed: true });
    expect(changes.previous).toBeNull();
    expect(changes.changes).toBeNull();
    expect(changes.returned).toBeNull();
  });
});

describe("a memo rewritten after it came back", () => {
  it("compares v2 with v1 and names the paragraph that changed", async () => {
    const document = await rewritten();

    const changes = await documentsService.getVersionChanges(
      document.id,
      cast.approver.id
    );

    expect(changes.current).toMatchObject({ versionNumber: 2, typed: true });
    expect(changes.previous).toMatchObject({ versionNumber: 1, typed: true });
    expect(changes.changes?.blocks.map((block) => block.kind)).toEqual([
      "same",
      "changed",
      "same",
    ]);

    const changed = changes.changes?.blocks[1];
    if (changed?.kind !== "changed" || changed.type !== "text") {
      throw new Error("expected the middle paragraph to be a changed text block");
    }
    expect(changed.runs).toEqual([
      { kind: "same", text: "The allowance is PKR " },
      { kind: "removed", text: "10,000" },
      { kind: "added", text: "12,000" },
      { kind: "same", text: " per month." },
    ]);
  });

  it("reads v1 although the revision superseded it", async () => {
    /*
     * The premise first: a revision marks the old version deleted, and the
     * detail endpoint filters it out. The comparison must not, because the
     * superseded version is exactly the one being compared against.
     */
    const document = await rewritten();
    const v1 = await prisma.documentVersion.findFirstOrThrow({
      where: { documentId: document.id, versionNumber: 1 },
    });
    expect(v1.isDeleted).toBe(true);

    const changes = await documentsService.getVersionChanges(
      document.id,
      cast.preparer.id
    );

    expect(changes.previous?.versionNumber).toBe(1);
    expect(changes.changes?.identical).toBe(false);
  });

  it("says who sent it back and what they said", async () => {
    const document = await rewritten();

    const changes = await documentsService.getVersionChanges(
      document.id,
      cast.preparer.id
    );

    expect(changes.returned).toMatchObject({
      by: `${cast.approver.firstName} ${cast.approver.lastName}`,
      comment: "The figure is out of date.",
    });
    expect(changes.returned?.at).toBeInstanceOf(Date);
  });

  it("compares the notes placed on the page as well", async () => {
    const document = await rewritten({
      notes: [
        { page: 1, x: 60, y: 600, width: 220, height: 40, text: "Please treat as urgent." },
      ],
    });

    const changes = await documentsService.getVersionChanges(
      document.id,
      cast.preparer.id
    );

    expect(changes.notes).toEqual({
      added: ["Please treat as urgent."],
      removed: [],
      moved: 0,
    });
  });
});

describe("who may ask", () => {
  it("answers whoever can open the document", async () => {
    const document = await rewritten();

    // The preparer, and the approver the new run is sitting with.
    await expect(
      documentsService.getVersionChanges(document.id, cast.preparer.id)
    ).resolves.toBeTruthy();
    await expect(
      documentsService.getVersionChanges(document.id, cast.approver.id)
    ).resolves.toBeTruthy();
  });

  it("refuses somebody the document has not reached", async () => {
    const document = await rewritten();

    // In the department, not on the chain.
    await expect(
      documentsService.getVersionChanges(document.id, cast.bystander.id)
    ).rejects.toMatchObject({ statusCode: 403 });
    // On the chain, at a step the memo has never reached.
    await expect(
      documentsService.getVersionChanges(document.id, cast.finalApprover.id)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("answers a document that does not exist with 404", async () => {
    await expect(
      documentsService.getVersionChanges(missingId(), cast.preparer.id)
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("a memo that was uploaded", () => {
  it("has no text to compare, and says so rather than guessing", async () => {
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.approver, cast.finalApprover),
    });
    await approvalService.requestRevision(document.id, cast.approver.id, {
      comment: "Wrong file attached.",
    });
    await resubmitDocument({
      documentId: document.id,
      preparerId: cast.preparer.id,
    });

    const changes = await documentsService.getVersionChanges(
      document.id,
      cast.preparer.id
    );

    expect(changes.current).toMatchObject({ versionNumber: 2, typed: false });
    expect(changes.previous).toMatchObject({ versionNumber: 1, typed: false });
    expect(changes.changes).toBeNull();
    // The reason it came back is still worth showing.
    expect(changes.returned?.comment).toBe("Wrong file attached.");
  });
});
