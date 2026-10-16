import { describe, expect, it } from "vitest";

import {
  MEMO_NOTE_LIMITS,
  memoNotesSchema,
  usableNotes,
} from "./memoNotes.schema";

/**
 * What the server will accept as a note.
 *
 * These are coordinates and lengths a request supplies and the renderer then
 * draws with, onto a document that is filed, hashed and cannot be corrected.
 * Every bound here exists because the unbounded version is a way to make the
 * server draw for a very long time, or to file a note nobody will ever see.
 */

const note = (over: Record<string, unknown> = {}) => ({
  page: 1,
  x: 100,
  y: 200,
  width: 170,
  height: 56,
  text: "Checked against the register.",
  ...over,
});

const accepts = (value: unknown) => memoNotesSchema.safeParse(value).success;

describe("a note the server will draw", () => {
  it("accepts one placed on the page", () => {
    expect(accepts([note()])).toBe(true);
  });

  it("accepts a memo with no notes at all", () => {
    expect(accepts([])).toBe(true);
  });

  it("accepts an empty note, which the service drops rather than refuses", () => {
    // An empty box is one somebody placed and thought better of. Refusing the
    // whole submission over it would be an error message about a box they
    // have already forgotten placing.
    expect(accepts([note({ text: "" })])).toBe(true);
  });
});

describe("what it refuses", () => {
  it("refuses a note on no page", () => {
    expect(accepts([note({ page: 0 })])).toBe(false);
    expect(accepts([note({ page: 1.5 })])).toBe(false);
  });

  it("refuses one placed off the page", () => {
    expect(accepts([note({ x: -1 })])).toBe(false);
    expect(accepts([note({ y: -1 })])).toBe(false);
    expect(accepts([note({ x: MEMO_NOTE_LIMITS.maxX + 1 })])).toBe(false);
    expect(accepts([note({ y: MEMO_NOTE_LIMITS.maxY + 1 })])).toBe(false);
  });

  it("refuses one too small to hold a word", () => {
    expect(accepts([note({ width: 1 })])).toBe(false);
    expect(accepts([note({ height: 1 })])).toBe(false);
  });

  it("refuses one larger than the page", () => {
    expect(accepts([note({ width: MEMO_NOTE_LIMITS.maxSize + 1 })])).toBe(false);
  });

  it("refuses text longer than a note", () => {
    // Past this it is not a note, it is the memo - and the memo has its own
    // field, its own limits and its own place on the page.
    expect(accepts([note({ text: "x".repeat(MEMO_NOTE_LIMITS.chars + 1) })])).toBe(
      false
    );
  });

  it("refuses more notes than a page could carry", () => {
    const many = Array.from({ length: MEMO_NOTE_LIMITS.count + 1 }, () => note());
    expect(accepts(many)).toBe(false);
  });

  it("refuses a field nobody asked for", () => {
    // Strict, so a client that starts sending something new is told rather
    // than having it silently dropped on a document it cannot get back.
    expect(accepts([{ ...note(), colour: "red" }])).toBe(false);
  });
});

describe("which notes are worth filing", () => {
  it("keeps one with something written in it", () => {
    expect(usableNotes([note()])).toHaveLength(1);
  });

  it("drops an empty one", () => {
    expect(usableNotes([note({ text: "" })])).toEqual([]);
  });

  it("drops one holding only spaces", () => {
    expect(usableNotes([note({ text: "   \n  " })])).toEqual([]);
  });

  it("trims what it keeps, so the box is not padded by accident", () => {
    expect(usableNotes([note({ text: "  Checked.  " })])[0].text).toBe(
      "Checked."
    );
  });

  it("answers for a memo that has no notes at all", () => {
    expect(usableNotes(undefined)).toEqual([]);
    expect(usableNotes([])).toEqual([]);
  });
});
