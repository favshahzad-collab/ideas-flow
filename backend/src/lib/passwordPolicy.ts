import { z } from "zod";
import { errors } from "./errors";

/**
 * What a new password has to be. One rule, used everywhere a password is set:
 * an administrator adding or editing a person, the spreadsheet import,
 * sign-up, and somebody changing their own.
 *
 * It was six characters, written out separately in five places that had
 * already drifted apart. Six characters is minutes of offline guessing, and a
 * password is what stands between an approver's signature and anybody who
 * wants to put it on a memo.
 *
 * Shaped after NIST SP 800-63B rather than the older composition rules: length
 * is what makes a password hard to guess, and "one capital, one digit, one
 * symbol" mostly produces "Password1!". So:
 *
 *   - at least 12 characters, and a generous maximum so a password manager's
 *     output is never refused;
 *   - not one of the passwords every guessing list starts with;
 *   - not the person's own name or the start of their email address, which is
 *     the first thing somebody who knows them would try.
 *
 * Nothing here applies to signing in. A password stored before this rule
 * keeps working until it is changed; refusing it at the door would lock out
 * exactly the people who have done nothing wrong.
 */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

/*
 * Lowercased. Only entries of the minimum length or more can ever match, so
 * this is the long end of the common-password lists - the ones a 12-character
 * minimum alone lets through.
 */
const COMMON = new Set([
  "123456789012",
  "1234567890123",
  "12345678901234",
  "123123123123",
  "111111111111",
  "000000000000",
  "121212121212",
  "abcdefghijkl",
  "qwertyuiopas",
  "qwertyuiop12",
  "qwertyuiop123",
  "1q2w3e4r5t6y",
  "1qaz2wsx3edc",
  "zaq12wsxcde3",
  "asdfghjklzxc",
  "password1234",
  "password12345",
  "password123!",
  "passwordpassword",
  "p@ssword1234",
  "p@ssw0rd1234",
  "iloveyou1234",
  "welcome12345",
  "welcome@1234",
  "letmein12345",
  "administrator",
  "administrator1",
  "changeme1234",
  "changemenow1",
  "trustno1trustno1",
  "football1234",
  "baseball1234",
  "superman1234",
  "monkey123456",
  "sunshine1234",
  "princess1234",
  "pakistan1234",
  "pakistan@123",
  "pakistan123!",
  "karachi12345",
  "lahore123456",
  "islamabad123",
  "ideas1234567",
  "ideaspvtltd1",
  "ideasflow123",
]);

type Person = {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

/** Why this password is refused, in words somebody can act on, or null if it is fine. */
export function passwordProblem(password: string, person: Person = {}): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters. A short phrase of three or four words is easy to remember and hard to guess.`;
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Use ${PASSWORD_MAX_LENGTH} characters or fewer.`;
  }

  const lower = password.toLowerCase();

  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) {
    return "That password is on the lists people try first. Choose one nobody would guess.";
  }

  const personal = [
    person.email?.split("@")[0],
    person.firstName,
    person.lastName,
  ]
    .map((part) => part?.trim().toLowerCase() ?? "")
    .filter((part) => part.length >= 4);

  if (personal.some((part) => lower.includes(part))) {
    return "Do not build the password from the person's name or email address. It is the first thing somebody who knows them would try.";
  }

  return null;
}

/**
 * Refuse, in the same words, at the point a password is about to be stored.
 * The request schemas check the password alone; this is where the person it
 * belongs to is known, and it sits beside every `hashPassword` of a new one
 * so a caller that skips the schema cannot skip the rule.
 */
export function assertAcceptablePassword(password: string, person: Person = {}): void {
  const problem = passwordProblem(password, person);
  if (problem) throw errors.badRequest(problem);
}

/**
 * The same rule as a zod field, for request schemas. It sees the password
 * alone; the name and email half is checked where those are known, with
 * `passwordProblem`.
 */
export const newPasswordField = (label = "Password") =>
  z.string().superRefine((value, ctx) => {
    if (value.length === 0) {
      ctx.addIssue({ code: "custom", message: `${label} is required` });
      return;
    }
    const problem = passwordProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });
