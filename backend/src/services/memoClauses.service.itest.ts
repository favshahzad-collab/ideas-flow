import { beforeEach, describe, expect, it } from "vitest";

import { makeCast, missingId, useCleanDatabase } from "../test/db";
import { memoClausesService } from "./memoClauses.service";

/**
 * Standard wording, as the service keeps it.
 *
 * The property that matters is the one nothing here can see: a memo takes a
 * COPY of a clause, so the service may edit and archive freely. What is
 * tested is the list a preparer is shown, the list an administrator is
 * shown, and that archiving is a state a clause can come back from.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;

beforeEach(async () => {
  cast = await makeCast();
});

const wording = (text: string) => ({
  type: "doc" as const,
  content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }],
});

const create = (title: string, text = `${title} wording.`) =>
  memoClausesService.create({ title, body: wording(text) }, cast.preparer.id);

describe("the wording on offer", () => {
  it("lists what was created, by title", async () => {
    await create("Recommendation");
    await create("Approval condition");

    const titles = (await memoClausesService.list()).map((clause) => clause.title);

    expect(titles).toEqual(["Approval condition", "Recommendation"]);
  });

  it("keeps the words exactly as they were given", async () => {
    const created = await create("Opening", "It is submitted for kind consideration that");

    const [listed] = await memoClausesService.list();

    expect(listed?.body).toEqual(wording("It is submitted for kind consideration that"));
    expect(listed?.id).toBe(created.id);
  });

  it("says who last changed it", async () => {
    const created = await create("Recommendation");

    expect(created.updatedBy).toEqual({
      firstName: cast.preparer.firstName,
      lastName: cast.preparer.lastName,
    });
  });
});

describe("changing wording", () => {
  it("changes the title and the words", async () => {
    const created = await create("Draft");

    const { before, after } = await memoClausesService.update(
      created.id,
      { title: "Final", body: wording("Final words.") },
      cast.approver.id
    );

    expect(before.title).toBe("Draft");
    expect(after.title).toBe("Final");
    expect(after.body).toEqual(wording("Final words."));
    expect(after.updatedBy?.firstName).toBe(cast.approver.firstName);
  });

  it("refuses wording that does not exist", async () => {
    await expect(
      memoClausesService.update(missingId(), { title: "x" }, cast.preparer.id)
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("archiving", () => {
  it("takes a clause off the preparer's list and keeps it on the administrator's", async () => {
    const kept = await create("Kept");
    const gone = await create("Gone");

    await memoClausesService.update(gone.id, { archived: true }, cast.preparer.id);

    expect((await memoClausesService.list()).map((clause) => clause.id)).toEqual([kept.id]);

    const all = await memoClausesService.list({ includeArchived: true });
    expect(all.map((clause) => clause.title)).toEqual(["Kept", "Gone"]);
    expect(all[1]?.archivedAt).toBeInstanceOf(Date);
  });

  it("puts it back", async () => {
    const clause = await create("Back");
    await memoClausesService.update(clause.id, { archived: true }, cast.preparer.id);

    const { after } = await memoClausesService.update(
      clause.id,
      { archived: false },
      cast.preparer.id
    );

    expect(after.archivedAt).toBeNull();
    expect((await memoClausesService.list()).map((entry) => entry.id)).toEqual([clause.id]);
  });

  it("keeps the date it went when archived twice", async () => {
    const clause = await create("Twice");
    const first = await memoClausesService.update(clause.id, { archived: true }, cast.preparer.id);
    const second = await memoClausesService.update(clause.id, { archived: true }, cast.preparer.id);

    expect(second.after.archivedAt).toEqual(first.after.archivedAt);
  });
});
