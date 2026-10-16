import { describe, expect, it } from "vitest";
import { PASSWORD_MIN_LENGTH, newPasswordField, passwordProblem } from "./passwordPolicy";

/**
 * The rule every new password is held to. It was six characters, in five
 * places that disagreed; these pin the one rule that replaced them.
 */

const PERSON = { email: "ayesha.khan@ideas.com.pk", firstName: "Ayesha", lastName: "Khan" };

describe("passwordProblem", () => {
  it("accepts a long passphrase", () => {
    expect(passwordProblem("copper kettle morning rain", PERSON)).toBeNull();
  });

  it("wants at least twelve characters, and accepts exactly twelve", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(passwordProblem("a".repeat(5) + "bcdefg")).toMatch(/at least 12 characters/);
    expect(passwordProblem("river-stone9")).toBeNull();
  });

  it("refuses the long end of the common-password lists, in any case", () => {
    for (const common of ["password1234", "PASSWORD1234", "123456789012", "qwertyuiopas"]) {
      expect(passwordProblem(common)).toMatch(/lists people try first/);
    }
  });

  it("refuses one character repeated", () => {
    expect(passwordProblem("zzzzzzzzzzzzzz")).toMatch(/lists people try first/);
  });

  it("refuses a password built from the person's name or email", () => {
    for (const personal of ["ayesha-summer-2026", "KhanFamily2026!", "ayesha.khan2026"]) {
      expect(passwordProblem(personal, PERSON)).toMatch(/name or email/);
    }
  });

  it("ignores a name part too short to be a real guess", () => {
    // "Ali" inside "totally-valid" is a coincidence, not a clue.
    expect(
      passwordProblem("totally-valid-phrase", { firstName: "Ali", lastName: "Li" }),
    ).toBeNull();
  });

  it("refuses one longer than the maximum", () => {
    expect(passwordProblem("x".repeat(201) + "y")).toMatch(/200 characters or fewer/);
  });
});

describe("newPasswordField", () => {
  it("says a blank one is required, and gives the rule's own words otherwise", () => {
    const field = newPasswordField("New password");

    expect(field.safeParse("").error?.issues.map((issue) => issue.message)).toEqual([
      "New password is required",
    ]);
    expect(field.safeParse("short").error?.issues[0]?.message).toMatch(/at least 12/);
    expect(field.safeParse("copper kettle morning rain").success).toBe(true);
  });
});
