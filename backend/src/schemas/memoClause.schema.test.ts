import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createMemoClauseSchema, updateMemoClauseSchema } from "./memoClause.schema";

/**
 * What may be saved as standard wording.
 *
 * The refusals are what matter: a clause that could not be drawn would make
 * a memo unsubmittable at the moment of signing, and it is the administrator
 * who should hear that, not the preparer weeks later.
 */

const paragraph = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const wrap = (body: unknown, params: unknown = {}) => ({ body, query: {}, params });

const messages = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.message);

describe("saving standard wording", () => {
  it("accepts a title and a memo body", () => {
    const result = createMemoClauseSchema.safeParse(
      wrap({
        title: "Recommendation",
        body: { type: "doc", content: [paragraph("Approval is solicited.")] },
      })
    );

    expect(result.success).toBe(true);
  });

  it("trims the title and refuses an empty one", () => {
    const trimmed = createMemoClauseSchema.safeParse(
      wrap({ title: "  Recommendation  ", body: { type: "doc", content: [paragraph("x")] } })
    );
    expect(trimmed.success && trimmed.data.body.title).toBe("Recommendation");

    const empty = createMemoClauseSchema.safeParse(
      wrap({ title: "   ", body: { type: "doc", content: [paragraph("x")] } })
    );
    expect(messages(empty)).toContain(
      "Give the wording a title, so a preparer can pick it out of the list."
    );
  });

  it("refuses wording with nothing written in it", () => {
    const result = createMemoClauseSchema.safeParse(
      wrap({ title: "Blank", body: { type: "doc", content: [{ type: "paragraph" }] } })
    );

    expect(messages(result)).toContain("Write the wording before saving it.");
  });

  it("refuses a node the memo could not draw", () => {
    const result = createMemoClauseSchema.safeParse(
      wrap({ title: "Picture", body: { type: "doc", content: [{ type: "image", src: "x" }] } })
    );

    expect(result.success).toBe(false);
  });

  it("refuses a field it does not know, rather than dropping it", () => {
    const result = createMemoClauseSchema.safeParse(
      wrap({ title: "T", body: { type: "doc", content: [paragraph("x")] }, colour: "red" })
    );

    expect(result.success).toBe(false);
  });
});

describe("changing standard wording", () => {
  it("accepts any one of a title, a body or the archived flag", () => {
    for (const body of [
      { title: "Renamed" },
      { body: { type: "doc", content: [paragraph("New words.")] } },
      { archived: true },
    ]) {
      expect(updateMemoClauseSchema.safeParse(wrap(body, { id: randomUUID() })).success).toBe(
        true
      );
    }
  });

  it("refuses a change that changes nothing", () => {
    const result = updateMemoClauseSchema.safeParse(wrap({}, { id: randomUUID() }));

    expect(messages(result)).toContain("Nothing to change.");
  });

  it("refuses an id that is not one", () => {
    const result = updateMemoClauseSchema.safeParse(wrap({ archived: true }, { id: "nope" }));

    expect(messages(result)).toContain(
      "That wording link is not valid. Open it from the list."
    );
  });
});
