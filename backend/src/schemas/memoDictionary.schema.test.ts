import { describe, expect, it } from "vitest";

import { addDictionaryWordSchema } from "./memoDictionary.schema";

/**
 * What may be added to the organisation's dictionary: one word, as a memo
 * would carry it, in any script.
 */

const parse = (word: unknown) => addDictionaryWordSchema.safeParse({ body: { word } });

describe("a dictionary word", () => {
  it.each(["Somrow", "Bahria", "PKR", "Eid-ul-Fitr", "O'Brien", "e.g.", "COVID-19", "کراچی"])(
    "accepts %s",
    (word) => {
      expect(parse(word).success).toBe(true);
    }
  );

  it("trims what was typed around it", () => {
    const result = parse("  Somrow  ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.body.word).toBe("Somrow");
  });

  it.each(["", "   ", "two words", "hello!", "a,b", "-lead", "x".repeat(81)])(
    "refuses %j",
    (word) => {
      expect(parse(word).success).toBe(false);
    }
  );

  it("says how a word is spelled when it refuses one", () => {
    const result = parse("two words");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("One word at a time");
    }
  });
});
