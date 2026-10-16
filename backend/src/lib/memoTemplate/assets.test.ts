import { describe, expect, it } from "vitest";

import {
  allFontKeys,
  fontKey,
  readDefaultLogo,
  readFontBytes,
  supportedCodePoints,
} from "./assets";

describe("the template's assets", () => {
  it("reads every font it claims to have", () => {
    for (const key of allFontKeys()) {
      const bytes = readFontBytes(key);
      // 0x00010000 is the TrueType version tag. A file that is not a font -
      // an HTML error page saved by a proxy, say - fails here rather than
      // deep inside pdf-lib with something unreadable.
      expect(bytes.readUInt32BE(0), `${key} is not TrueType`).toBe(0x00010000);
      expect(bytes.length).toBeGreaterThan(10_000);
    }
  });

  it("reads the letterhead", () => {
    const logo = readDefaultLogo();
    expect(logo.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  });
});

/**
 * These pin the coverage check against a rendered proof sheet rather than
 * against the measurement API, which is the whole point of the check: pdf-lib
 * will measure Urdu quite happily and then draw a row of empty boxes.
 */
describe("which characters the family can actually draw", () => {
  const regular = supportedCodePoints(fontKey("regular", "upright"));

  it("covers what a memo is written in", () => {
    for (const char of "ABCXYZabcxyz0123456789 .,:;()/-&%") {
      expect(regular.has(char.codePointAt(0)!), `missing ${char}`).toBe(true);
    }
  });

  it("covers the punctuation a word processor produces", () => {
    // Every one of these is in the sample memo, pasted out of Word.
    expect(regular.has(0x2013)).toBe(true); // en dash
    expect(regular.has(0x2014)).toBe(true); // em dash
    expect(regular.has(0x2019)).toBe(true); // right single quote
    expect(regular.has(0x201c)).toBe(true); // left double quote
    expect(regular.has(0x2022)).toBe(true); // bullet
    expect(regular.has(0x00a0)).toBe(true); // non-breaking space
  });

  it("covers the rupee sign, on a memo about allowances in rupees", () => {
    expect(regular.has(0x20a8)).toBe(true);
  });

  it("knows it cannot draw Arabic script", () => {
    // Not a wish - an observation. The rendered proof showed six identical
    // tofu boxes for this string. The renderer refuses such a memo instead
    // of sealing a page of boxes into an immutable artefact.
    expect(regular.has(0x0627)).toBe(false);
  });

  it("knows it cannot draw CJK or emoji", () => {
    expect(regular.has(0x4e2d)).toBe(false);
    expect(regular.has(0x1f600)).toBe(false);
  });

  it("reports a real repertoire for every face, not an empty set", () => {
    // A cmap reader that silently returns nothing would pass every assertion
    // above about absence, and block every memo in production.
    for (const key of allFontKeys()) {
      expect(supportedCodePoints(key).size, key).toBeGreaterThan(200);
    }
  });
});
