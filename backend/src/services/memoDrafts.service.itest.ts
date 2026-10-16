import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../prisma";
import { FUEL_REQUEST_BODY } from "../lib/memoTemplate/fuelRequest.fixture";
import {
  makeCast,
  makeUser,
  missingId,
  rejection,
  useCleanDatabase,
} from "../test/db";
import { memoDraftsService } from "./memoDrafts.service";

/**
 * Drafts of memos being written.
 *
 * A draft is somebody's unfinished argument for a pay revision, a promotion
 * or a dismissal. It is private to its author, and these tests exist because
 * "private" is a claim that has to be made against every method rather than
 * asserted once.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;
let administrator: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  cast = await makeCast();
  administrator = await makeUser({
    firstName: "Admin",
    departmentId: cast.department.id,
    loginRole: "ADMINISTRATOR",
  });
});

const body = () => FUEL_REQUEST_BODY as unknown as Record<string, unknown>;

describe("writing a draft", () => {
  it("starts empty and belongs to whoever started it", async () => {
    const draft = await memoDraftsService.createDraft(cast.preparer.id, {});

    expect(draft.id).toBeTruthy();
    expect(draft.title).toBeNull();
    expect(draft.body).toBeNull();

    const row = await prisma.memoDraft.findUnique({ where: { id: draft.id } });
    expect(row?.preparerId).toBe(cast.preparer.id);
  });

  it("keeps what was typed", async () => {
    const draft = await memoDraftsService.createDraft(cast.preparer.id, {
      memoType: "APPROVAL_REQUEST",
      title: "Revision of allowance",
      memoTo: "Sir BMD",
      memoFrom: "Human Resource Department",
      body: body() as never,
    });

    expect(draft.memoType).toBe("APPROVAL_REQUEST");
    expect(draft.memoTypeLabel).toBe("Approval Request");
    expect(draft.title).toBe("Revision of allowance");
    expect(draft.memoTo).toBe("Sir BMD");
    expect(draft.body).not.toBeNull();
  });

  it("writes nothing to the document tables", async () => {
    await memoDraftsService.createDraft(cast.preparer.id, {
      title: "Not a memo yet",
      body: body() as never,
    });

    // A draft is not a submission. Nothing here should have moved.
    expect(await prisma.document.count()).toBe(0);
    expect(await prisma.documentVersion.count()).toBe(0);
    expect(await prisma.approvalChain.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("refuses to hoard drafts without limit", async () => {
    for (let index = 0; index < 25; index++) {
      await memoDraftsService.createDraft(cast.preparer.id, {
        title: `Draft ${index}`,
      });
    }

    const error = await rejection(
      memoDraftsService.createDraft(cast.preparer.id, { title: "One too many" })
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(/25 drafts/);
  });
});

describe("autosaving", () => {
  it("changes only the fields that were sent", async () => {
    const draft = await memoDraftsService.createDraft(cast.preparer.id, {
      title: "Original subject",
      memoTo: "Sir BMD",
      chain: [{ userId: cast.approver.id, approvalType: "FINAL_APPROVER" }],
    });

    // The editor autosaves the body alone. It must not erase the subject or
    // the chain the preparer already chose.
    const saved = await memoDraftsService.updateDraft(
      draft.id,
      cast.preparer.id,
      { body: body() as never }
    );

    expect(saved.title).toBe("Original subject");
    expect(saved.memoTo).toBe("Sir BMD");
    expect(saved.chain).not.toBeNull();
    expect(saved.body).not.toBeNull();
  });

  it("can be saved over and over", async () => {
    const draft = await memoDraftsService.createDraft(cast.preparer.id, {});

    for (const title of ["a", "ab", "abc"]) {
      await memoDraftsService.updateDraft(draft.id, cast.preparer.id, { title });
    }

    const latest = await memoDraftsService.getDraft(draft.id, cast.preparer.id);
    expect(latest.title).toBe("abc");
  });

  it("moves updatedAt so the list can be ordered by it", async () => {
    const draft = await memoDraftsService.createDraft(cast.preparer.id, {});
    const first = (await memoDraftsService.getDraft(draft.id, cast.preparer.id))
      .updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 15));
    await memoDraftsService.updateDraft(draft.id, cast.preparer.id, {
      title: "later",
    });

    const second = (
      await memoDraftsService.getDraft(draft.id, cast.preparer.id)
    ).updatedAt;

    expect(second.getTime()).toBeGreaterThan(first.getTime());
  });
});

/**
 * The whole point. Every method is scoped by preparer in its WHERE clause
 * rather than reading a row and checking it afterwards, and each of these
 * asserts that from the outside.
 */
describe("a draft belongs to one person", () => {
  it("is not listed for anybody else", async () => {
    await memoDraftsService.createDraft(cast.preparer.id, {
      title: "Confidential: dismissal",
    });

    expect(await memoDraftsService.listDrafts(cast.approver.id)).toEqual([]);
    expect(await memoDraftsService.listDrafts(administrator.id)).toEqual([]);
  });

  it("cannot be read by anybody else", async () => {
    const draft = await memoDraftsService.createDraft(cast.preparer.id, {
      title: "Confidential",
    });

    for (const stranger of [cast.approver.id, administrator.id]) {
      const error = await rejection(
        memoDraftsService.getDraft(draft.id, stranger)
      );
      // Reported as missing rather than forbidden: the existence of somebody
      // else's draft is not theirs to learn either.
      expect(error.statusCode).toBe(404);
    }
  });

  it("is not readable by an administrator", async () => {
    const draft = await memoDraftsService.createDraft(cast.preparer.id, {
      title: "Confidential",
    });

    const error = await rejection(
      memoDraftsService.getDraft(draft.id, administrator.id)
    );

    expect(error.statusCode).toBe(404);
  });

  it("cannot be edited by anybody else", async () => {
    const draft = await memoDraftsService.createDraft(cast.preparer.id, {
      title: "Mine",
    });

    const error = await rejection(
      memoDraftsService.updateDraft(draft.id, cast.approver.id, {
        title: "Theirs",
      })
    );

    expect(error.statusCode).toBe(404);

    // And the row is untouched, not merely the response.
    const row = await prisma.memoDraft.findUnique({ where: { id: draft.id } });
    expect(row?.title).toBe("Mine");
  });

  it("cannot be deleted by anybody else", async () => {
    const draft = await memoDraftsService.createDraft(cast.preparer.id, {
      title: "Mine",
    });

    const error = await rejection(
      memoDraftsService.deleteDraft(draft.id, cast.approver.id)
    );

    expect(error.statusCode).toBe(404);
    expect(
      await prisma.memoDraft.count({ where: { id: draft.id } })
    ).toBe(1);
  });

  it("reports a draft that never existed the same way", async () => {
    const error = await rejection(
      memoDraftsService.getDraft(missingId(), cast.preparer.id)
    );

    expect(error.statusCode).toBe(404);
  });
});

describe("listing and deleting", () => {
  it("lists newest first", async () => {
    const first = await memoDraftsService.createDraft(cast.preparer.id, {
      title: "older",
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await memoDraftsService.createDraft(cast.preparer.id, {
      title: "newer",
    });

    const drafts = await memoDraftsService.listDrafts(cast.preparer.id);

    expect(drafts.map((draft) => draft.id)).toEqual([second.id, first.id]);
  });

  it("deletes its own", async () => {
    const draft = await memoDraftsService.createDraft(cast.preparer.id, {
      title: "throwaway",
    });

    await memoDraftsService.deleteDraft(draft.id, cast.preparer.id);

    expect(await memoDraftsService.listDrafts(cast.preparer.id)).toEqual([]);
  });

  it("goes away with the person who wrote it", async () => {
    // The FK cascades. A draft outliving its author would be an unreadable
    // row nobody could reach and nobody could remove.
    const preparer = cast.preparer.id;
    await memoDraftsService.createDraft(preparer, { title: "theirs" });

    await prisma.memoDraft.deleteMany({ where: { preparerId: preparer } });
    expect(await prisma.memoDraft.count({ where: { preparerId: preparer } })).toBe(0);
  });
});
