import { beforeEach, describe, expect, it } from "vitest";
import { LoginRole } from "../generated/prisma/client";
import { hashPassword } from "../lib/password";
import { verifyToken } from "../lib/tokens";
import { prisma } from "../prisma";
import { loginSchema, signUpSchema } from "../schemas/auth.schema";
import {
  makeDepartment,
  makeUser,
  missingId,
  rejection,
  tamperWithLedger,
  useCleanDatabase,
} from "../test/db";
import { useStoredWorkflowPolicy } from "../lib/workflowPolicy";
import { authService, wantsSecondFactor } from "./auth.service";

/**
 * Sign-in. Most of what matters here is what the service declines to say: an
 * unknown address and a wrong password have to be indistinguishable, and a
 * token issued for one purpose must not work for the other.
 */

useCleanDatabase();

const PASSWORD = "correct horse battery";

let departmentId: string;
let userId: string;
const EMAIL = "ayesha@example.com";

beforeEach(async () => {
  departmentId = (await makeDepartment()).id;
  const user = await prisma.user.create({
    data: {
      firstName: "Ayesha",
      lastName: "Khan",
      email: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      departmentId,
      loginRole: LoginRole.USER,
    },
  });
  userId = user.id;
});

/**
 * A sign-in that is expected to produce a session.
 *
 * `login` can now answer with a second-factor challenge instead, and none of
 * the accounts here has one. Narrowed in one place so the tests below read the
 * way they did - and so that if an account ever does grow a factor, this
 * throws with a name rather than each assertion failing on an undefined token.
 */
async function signIn(input: { email: string; password: string }) {
  const result = await authService.login(input);

  if (wantsSecondFactor(result)) {
    throw new Error("this account unexpectedly asked for a second factor");
  }

  return result;
}

describe("login", () => {
  it("issues a pair of tokens for the right password", async () => {
    const result = await signIn({ email: EMAIL, password: PASSWORD });

    expect(result.user).toEqual({
      id: userId,
      email: EMAIL,
      role: LoginRole.USER,
    });
    expect(await verifyToken(result.accessToken, "access")).toMatchObject({ id: userId });
    expect(await verifyToken(result.refreshToken, "refresh")).toMatchObject({ id: userId });
  });

  it("accepts the address in any case", async () => {
    // Nobody types their own address the same way twice, and the column is
    // stored lower-case.
    const result = await signIn({
      email: "Ayesha@Example.COM",
      password: PASSWORD,
    });

    expect(result.user.id).toBe(userId);
  });

  it("gives the same answer to a wrong password and an unknown address", async () => {
    // Different messages here turn the login form into a way of asking
    // whether somebody works here.
    const wrongPassword = await rejection(
      authService.login({ email: EMAIL, password: "not the password" })
    );
    const unknownAddress = await rejection(
      authService.login({ email: "nobody@example.com", password: PASSWORD })
    );

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownAddress.statusCode).toBe(401);
    expect(wrongPassword.message).toBe(unknownAddress.message);
    expect(wrongPassword.message).toBe("Incorrect email or password");
  });

  it("refuses an account that has no password set", async () => {
    // Accounts can exist before anyone has chosen a password - an
    // administrator creating a user, or a bulk import. None of them is a way in.
    const noPassword = await makeUser({ departmentId });

    await expect(
      authService.login({ email: noPassword.email, password: PASSWORD })
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("does not hand back the password hash", async () => {
    const result = await authService.login({ email: EMAIL, password: PASSWORD });

    expect(JSON.stringify(result)).not.toContain("scrypt$");
  });
});

describe("tokens", () => {
  it("will not let a refresh token stand in for an access token", async () => {
    // Both are signed with the same secret; only the `typ` claim separates
    // them, so a long-lived refresh token being accepted as a session would
    // turn a thirty-day credential into a bearer token for the API.
    const { refreshToken } = await signIn({
      email: EMAIL,
      password: PASSWORD,
    });

    expect(await verifyToken(refreshToken, "access")).toBeNull();
  });

  it("will not let an access token be exchanged for a new pair", async () => {
    const { accessToken } = await signIn({
      email: EMAIL,
      password: PASSWORD,
    });

    await expect(
      authService.refresh({ refreshToken: accessToken })
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("exchanges a refresh token for a working pair", async () => {
    const first = await signIn({ email: EMAIL, password: PASSWORD });
    const second = await authService.refresh({ refreshToken: first.refreshToken });

    expect(await verifyToken(second.accessToken, "access")).toMatchObject({ id: userId });
    expect(await verifyToken(second.refreshToken, "refresh")).toMatchObject({ id: userId });
  });

  it("refuses a refresh token whose account has since gone", async () => {
    // The token is still perfectly valid and still verifies; the account it
    // names does not exist any more, which is the question that matters.
    const { refreshToken } = await signIn({
      email: EMAIL,
      password: PASSWORD,
    });
    // The sign-in above is in the audit ledger, and deleting the account
    // would blank its name there, which the database refuses - accounts are
    // switched off, not deleted. The case is still worth holding: a partial
    // restore can leave a token naming an account the database no longer has.
    await tamperWithLedger(() => prisma.user.delete({ where: { id: userId } }));

    expect(await verifyToken(refreshToken, "refresh")).toMatchObject({ id: userId });
    await expect(
      authService.refresh({ refreshToken })
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("refuses a token that is not one of ours", async () => {
    await expect(
      authService.refresh({ refreshToken: "not.a.token" })
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("signUp", () => {
  const signUp = (overrides: Record<string, unknown> = {}) =>
    authService.signUp({
      email: "new.person@example.com",
      password: PASSWORD,
      firstName: "New",
      lastName: "Person",
      departmentId,
      ...overrides,
    });

  it("creates an ordinary user, never an administrator", async () => {
    const { user } = await signUp();

    expect(user.loginRole).toBe(LoginRole.USER);
    expect(user.department.id).toBe(departmentId);
  });

  it("records who created the account, as every other way of creating one does", async () => {
    const admin = await makeUser({ firstName: "Ada", departmentId, loginRole: LoginRole.ADMINISTRATOR });

    const { user } = await authService.signUp(
      {
        email: "recorded@example.com",
        password: PASSWORD,
        firstName: "Rec",
        lastName: "Orded",
        departmentId,
      },
      admin.id,
      "10.0.0.7"
    );

    const entry = await prisma.auditLog.findFirst({
      where: { action: "USER_CREATED", entityId: user.id },
    });
    expect(entry).toMatchObject({ actorId: admin.id, ipAddress: "10.0.0.7" });
    // That there is a password, never the password.
    expect(JSON.stringify(entry?.newValue)).not.toContain(PASSWORD);
  });

  it("stores the address lower-cased", async () => {
    const { user } = await signUp({ email: "Mixed.Case@Example.COM" });

    expect(user.email).toBe("mixed.case@example.com");
  });

  it("stores a hash, not the password", async () => {
    const { user } = await signUp();
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });

    expect(stored.passwordHash).not.toBe(PASSWORD);
    expect(stored.passwordHash).toMatch(/^scrypt\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);
  });

  it("lets the new account sign in", async () => {
    const { user } = await signUp();

    const result = await signIn({
      email: "new.person@example.com",
      password: PASSWORD,
    });

    expect(result.user.id).toBe(user.id);
  });

  it("refuses an address that is already taken", async () => {
    await expect(signUp({ email: EMAIL })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("refuses an address already taken in a different case", async () => {
    await expect(signUp({ email: EMAIL.toUpperCase() })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("refuses a department that does not exist", async () => {
    await expect(
      signUp({ departmentId: missingId() })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("describes the new account with a designation nobody has set yet", async () => {
    // Sign-up asks for no title, but the People screen renders the account
    // from this answer: leave the field out and the new row is the only one
    // whose title reads as unknown rather than as not yet recorded.
    const { user } = await signUp();

    expect(user).toHaveProperty("designation", null);
  });
});

describe("getMe", () => {
  it("returns the profile without the password hash", async () => {
    const me = await authService.getMe(userId);

    expect(me).toMatchObject({
      id: userId,
      email: EMAIL,
      firstName: "Ayesha",
      loginRole: LoginRole.USER,
    });
    expect(me).not.toHaveProperty("passwordHash");
    expect(me.department.id).toBe(departmentId);
  });

  it("says whether this deployment lets a preparer skip an approver", async () => {
    /*
     * Here rather than compiled into the bundle, and this test is the fix for
     * a defect nothing else would have caught.
     *
     * Skipping used to be an environment variable, so the client could carry a
     * build-time flag and the two agreed by being set together. It became a
     * row an administrator edits from the Workflow policy screen - at which
     * point the switch turned the endpoint on and the button stayed hidden,
     * because nothing in a compiled bundle can follow a database row. The
     * screen was offering a control that did nothing.
     */
    const off = await authService.getMe(userId);
    expect(off.workflowPolicy).toEqual({
      allowStepSkip: false,
      preparerSignsOnSubmit: true,
    });

    useStoredWorkflowPolicy({
      slaDefaultDays: null,
      allowStepSkip: true,
      preparerSignsOnSubmit: true,
      sealApprovedMemos: true,
    });

    const on = await authService.getMe(userId);
    expect(on.workflowPolicy).toEqual({
      allowStepSkip: true,
      preparerSignsOnSubmit: true,
    });
  });

  it("returns the designation this person's signature is signed under", async () => {
    // Both `/api/auth/me` and `/api/users/me` answer from here, and this is
    // where the signing screen learns the title it will show the approver
    // before they commit a signature to a memo.
    await prisma.user.update({
      where: { id: userId },
      data: { designation: "Director of Finance" },
    });

    const me = await authService.getMe(userId);

    expect(me.designation).toBe("Director of Finance");
  });

  it("reports an unrecorded designation as null rather than omitting it", async () => {
    const me = await authService.getMe(userId);

    // An absent key reads as a profile that failed to load its title; a null
    // reads as a title an administrator has not filled in yet.
    expect(me).toHaveProperty("designation", null);
  });

  it("reports a missing account as not found", async () => {
    await expect(authService.getMe(missingId())).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

/*
 * The sign-up request shape. It writes the same `users` row the admin screen
 * writes, so it is held to the same rules: a name that is only whitespace
 * passes a bare minimum check and is then blank in the approver picker, in the
 * audit export beside a real approval, and in every notification naming that
 * person - with nothing in the product able to repair it but an admin edit.
 */
describe("the sign-up request shape", () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    email: "new.person@example.com",
    password: PASSWORD,
    firstName: "New",
    lastName: "Person",
    departmentId,
    ...overrides,
  });

  const parseSignUp = (overrides: Record<string, unknown> = {}) =>
    signUpSchema.safeParse({ body: body(overrides), params: {}, query: {} });

  it("refuses a first or last name that is only whitespace", () => {
    expect(parseSignUp({ firstName: "   " }).success).toBe(false);
    expect(parseSignUp({ lastName: "\t" }).success).toBe(false);
  });

  it("stores the trimmed name, so nobody is created padded", async () => {
    const parsed = signUpSchema.parse({
      body: body({ firstName: "  Nadia ", lastName: " Rahman  " }),
      params: {},
      query: {},
    });

    const { user } = await authService.signUp(parsed.body);

    expect(`${user.firstName} ${user.lastName}`).toBe("Nadia Rahman");
  });

  it("refuses a name or address longer than the column holds", () => {
    // VarChar(100)/VarChar(255): Postgres refuses these anyway, but as an
    // unmapped Prisma error, which reaches the admin as a 500 with no field.
    expect(parseSignUp({ firstName: "a".repeat(101) }).success).toBe(false);
    expect(
      parseSignUp({ email: `${"a".repeat(250)}@example.com` }).success
    ).toBe(false);
  });

  it("refuses a department id that is not a uuid", () => {
    expect(parseSignUp({ departmentId: "finance" }).success).toBe(false);
  });

  it("caps the password at a length worth hashing", () => {
    // Not a security limit - a work limit. Every login re-derives the hash
    // from whatever was stored, so an unbounded password is unbounded scrypt
    // work on a public endpoint for the life of the account.
    expect(parseSignUp({ password: "ab".repeat(100) }).success).toBe(true);
    expect(parseSignUp({ password: "ab".repeat(100) + "c" }).success).toBe(false);
  });
});

/*
 * Sign-up caps the password; the login form deliberately does not, and that
 * asymmetry is the point. Accounts predate the cap - a password manager's
 * three-hundred-character string is already hashed in the column - and a cap
 * at the door would lock those people out of an account they can still prove
 * they own, with no way back in but an admin reset.
 */
describe("the login request shape", () => {
  it("still admits a password longer than sign-up would now accept", async () => {
    const long = "p".repeat(300);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(long) },
    });

    expect(
      loginSchema.safeParse({
        body: { email: EMAIL, password: long },
        params: {},
        query: {},
      }).success
    ).toBe(true);

    const result = await signIn({ email: EMAIL, password: long });

    expect(result.user.id).toBe(userId);
  });
});
