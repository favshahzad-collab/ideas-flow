import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import app from "../app";
import { LoginRole } from "../generated/prisma/client";
import { hashPassword, verifyPassword } from "../lib/password";
import { encryptSecret } from "../lib/secretBox";
import { issueStepUpToken } from "../lib/tokens";
import { prisma } from "../prisma";
import {
  ADMIN_USERS_DEFAULT_LIMIT,
  ADMIN_USERS_MAX_LIMIT,
  createAdminUserSchema,
  getAdminUserSchema,
  listAdminUsersSchema,
  updateAdminUserSchema,
  bulkImportUsersSchema,
} from "../schemas/admin.schema";
import { buildCsv } from "../utils/csv";
import { MAX_IMPORT_ROWS } from "../utils/spreadsheet";
import {
  chainOf,
  makeCast,
  makeDepartment,
  makeUser,
  missingId,
  signature,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { adminService } from "./admin.service";
import { approvalService } from "./approval.service";

/**
 * User administration. Three things here are worth a database: the directory
 * listing, which is the one screen certain to meet the whole organisation and
 * so has to search and page in SQL rather than in the browser; the bulk
 * import, which has to keep going after a bad row and say exactly which one
 * failed and why; and the delete guards, which are the only thing standing
 * between an administrator and an audit trail with a hole in it.
 */

useCleanDatabase();

const PASSWORD = "correct horse battery";

let financeId: string;
let financeName: string;

beforeEach(async () => {
  const finance = await makeDepartment("Finance");
  financeId = finance.id;
  financeName = finance.name;
});

/**
 * People in bulk. Paging needs more accounts than inserting one at a time is
 * worth, and `createMany` stamps every row with the same `createdAt` - which
 * is precisely the case a page order has to survive.
 */
async function makePeople(count: number, prefix = "Person") {
  await prisma.user.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      firstName: `${prefix}${index}`,
      lastName: "Bulk",
      email: `${prefix.toLowerCase()}-${index}@example.com`,
      departmentId: financeId,
    })),
  });
}

const spreadsheet = (rows: string[][], headers = [
  "First Name",
  "Last Name",
  "Email",
  "Password",
  "Department",
  "Role",
]) => ({
  buffer: Buffer.from(buildCsv(headers, rows), "utf8"),
  originalname: "users.csv",
});

describe("how many approvals each person is holding", () => {
  /*
   * The queue length on the people screen, and the number an administrator
   * looks at before handing somebody's approvals to a colleague. It has to be
   * the memos actually waiting on that person: not the chains they appear on,
   * not the ones they have already signed, and not the ones whose document is
   * no longer out for review.
   */
  it("counts the memos sitting on a person's desk", async () => {
    const cast = await makeCast();
    await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });

    const { users } = await adminService.listUsers();
    const byId = new Map(users.map((user) => [user.id, user.openApprovals]));

    expect(byId.get(cast.reviewer.id)).toBe(1);
    // On the chain, but the memo has not reached them: not their queue yet.
    expect(byId.get(cast.finalApprover.id)).toBe(0);
    expect(byId.get(cast.preparer.id)).toBe(0);
  });

  it("moves the count on when the memo does", async () => {
    const cast = await makeCast();
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });

    const { useSavedSignature: _saved, ...placement } = signature();
    await approvalService.approve(document.id, cast.reviewer.id, {
      ...placement,
      useSavedSignature: false,
    });

    const { users } = await adminService.listUsers();
    const byId = new Map(users.map((user) => [user.id, user.openApprovals]));

    expect(byId.get(cast.reviewer.id)).toBe(0);
    expect(byId.get(cast.finalApprover.id)).toBe(1);
  });

  it("is zero for everybody when nothing is out for review", async () => {
    await makePeople(2);

    const { users } = await adminService.listUsers();

    expect(users.every((user) => user.openApprovals === 0)).toBe(true);
  });
});

describe("listUsers", () => {
  it("answers with the page, how many matched and how many came back", async () => {
    await makePeople(3);

    const result = await adminService.listUsers();

    expect(result.users).toHaveLength(3);
    expect(result).toMatchObject({ total: 3, returned: 3 });
  });

  it("finds a person by every word of the search, not by one column at a time", async () => {
    await makeUser({ firstName: "Maria", lastName: "Chen", departmentId: financeId });
    await makeUser({ firstName: "Maria", lastName: "Okafor", departmentId: financeId });
    await makeUser({ firstName: "David", lastName: "Chen", departmentId: financeId });

    const result = await adminService.listUsers({ q: "maria chen" });

    // No column holds both names, so matching the whole string against one
    // field at a time finds nobody - and the administrator is told the person
    // they are looking at in the same table does not exist.
    expect(result.total).toBe(1);
    expect(result.users.map((user) => `${user.firstName} ${user.lastName}`)).toEqual([
      "Maria Chen",
    ]);
  });

  it("searches the email address and the department name too", async () => {
    const engineering = await makeDepartment("Engineering");
    const engineer = await makeUser({ departmentId: engineering.id });
    await makePeople(2);

    const byDepartment = await adminService.listUsers({ q: engineering.name });
    const byEmail = await adminService.listUsers({ q: engineer.email });

    expect(byDepartment.users.map((user) => user.id)).toEqual([engineer.id]);
    expect(byEmail.users.map((user) => user.id)).toEqual([engineer.id]);
  });

  it("counts everybody who matched, not everybody who fitted on the page", async () => {
    await makePeople(ADMIN_USERS_MAX_LIMIT + 5);

    const result = await adminService.listUsers({ limit: 10_000 });

    // The cap is what keeps one oversized directory from becoming one
    // oversized response; `total` is the only way the screen can learn there
    // is more than it is holding, so a header reading "N people" stays true.
    expect(result.returned).toBe(ADMIN_USERS_MAX_LIMIT);
    expect(result.total).toBe(ADMIN_USERS_MAX_LIMIT + 5);
  });

  it("returns a first page, not the whole directory, when asked for nothing", async () => {
    await makePeople(ADMIN_USERS_DEFAULT_LIMIT + 5);

    const result = await adminService.listUsers();

    expect(result.returned).toBe(ADMIN_USERS_DEFAULT_LIMIT);
    expect(result.total).toBe(ADMIN_USERS_DEFAULT_LIMIT + 5);
  });

  it("pages through accounts created in the same instant without repeating or losing one", async () => {
    // A bulk import stamps every account it creates with one timestamp.
    // Ordering on that alone leaves those rows in no fixed order, so the
    // administrator sees somebody twice and never sees somebody else at all.
    await makePeople(7);

    const seen: string[] = [];
    for (let offset = 0; offset < 7; offset += 2) {
      const page = await adminService.listUsers({ limit: 2, offset });
      seen.push(...page.users.map((user) => user.id));
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("answers an empty page past the end without claiming nobody matched", async () => {
    await makePeople(3);

    const result = await adminService.listUsers({ limit: 2, offset: 10 });

    expect(result.returned).toBe(0);
    expect(result.total).toBe(3);
  });

  it("keeps the newest account first, as the People table has always shown it", async () => {
    const older = await makeUser({ departmentId: financeId });
    const newer = await makeUser({ departmentId: financeId });

    const result = await adminService.listUsers();

    expect(result.users.map((user) => user.id)).toEqual([newer.id, older.id]);
  });

  it("still carries the department id the edit form reads", async () => {
    await makeUser({ departmentId: financeId });

    const result = await adminService.listUsers();

    // Dropping it would leave the edit modal with no department selected and
    // no way to tell that one was ever set.
    expect(result.users[0].department).toEqual({ id: financeId, name: financeName });
  });

  it("carries the designation that gets printed under a signature", async () => {
    const user = await makeUser({ departmentId: financeId });
    await prisma.user.update({
      where: { id: user.id },
      data: { designation: "Director of Finance" },
    });

    const result = await adminService.listUsers();

    // The People table is where an administrator notices a title is missing
    // or wrong. Left out of the select, a recorded title is invisible until
    // it is already printed on somebody's approved memo.
    expect(result.users[0].designation).toBe("Director of Finance");
  });
});

describe("createUser", () => {
  const create = (overrides: Record<string, unknown> = {}) =>
    adminService.createUser({
      email: "new.person@example.com",
      password: PASSWORD,
      firstName: "New",
      lastName: "Person",
      departmentId: financeId,
      loginRole: LoginRole.USER,
      ...overrides,
    });

  it("creates the account and hashes the password", async () => {
    const user = await create();
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });

    expect(user.email).toBe("new.person@example.com");
    expect(stored.passwordHash).not.toBe(PASSWORD);
    expect(await verifyPassword(PASSWORD, stored.passwordHash)).toBe(true);
  });

  it("can create an administrator, unlike sign-up", async () => {
    const user = await create({ loginRole: LoginRole.ADMINISTRATOR });
    expect(user.loginRole).toBe(LoginRole.ADMINISTRATOR);
  });

  it("refuses a department that does not exist", async () => {
    await expect(create({ departmentId: missingId() })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("refuses an address already in use, whatever the case", async () => {
    await create();

    await expect(create()).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      create({ email: "NEW.PERSON@EXAMPLE.COM" })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("records the designation it was given and hands it straight back", async () => {
    const user = await create({ designation: "Head of Human Resources" });

    expect(user.designation).toBe("Head of Human Resources");
    // Read back from the row, not just from the response: a title only the
    // response carries is one the memo cannot print at approval time.
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.designation).toBe("Head of Human Resources");
  });

  it("creates an account with no designation rather than refusing one", async () => {
    // Nobody's title is on file the day the column arrives. Making it
    // required would stop administrators creating accounts at all.
    const user = await create();

    expect(user.designation).toBeNull();
  });

  it("stores an empty designation as no title, not as a blank one", async () => {
    // The edit form cannot send undefined, so a cleared box arrives as "".
    // Kept as "", it is a title that exists and is empty - which the memo
    // would draw as a blank line under a signature.
    const user = await create({ designation: "" });

    expect(user.designation).toBeNull();
  });
});

describe("getUser", () => {
  it("returns the designation the edit form has to show", async () => {
    const created = await adminService.createUser({
      email: "detail.person@example.com",
      password: PASSWORD,
      firstName: "Detail",
      lastName: "Person",
      designation: "Chief Financial Officer",
      departmentId: financeId,
      loginRole: LoginRole.USER,
    });

    const user = await adminService.getUser(created.id);

    // Missing here, the edit form opens with an empty title box, and saving
    // any other change would look like the administrator meant to clear it.
    expect(user.designation).toBe("Chief Financial Officer");
  });
});

/**
 * Administering a person, and whether anything records it.
 *
 * `USER_CREATED` and `USER_UPDATED` have been in the AuditAction enum since
 * the beginning and NOTHING has ever written one. Departments are audited;
 * the people are not. So an administrator could change another person's
 * password, change their email address, or make them an administrator, and
 * the trail held no row saying so - on a product whose distinguishing claim
 * is a tamper-evident record of who did what.
 *
 * The only trace was a SESSIONS_ENDED_EVERYWHERE row, written because the
 * change ends that person's sessions. It does not say what changed.
 *
 * With two administrators rather than one, this stops being theoretical:
 * either can now alter the other, and nothing would say which of them did.
 */
describe("what administering a person leaves behind", () => {
  const person = () => makeUser({ departmentId: financeId });

  async function admin() {
    const user = await makeUser({ departmentId: financeId });
    return prisma.user.update({
      where: { id: user.id },
      // A Super Administrator: these tests are about what administering a
      // person records, not about which tier may do it (admin-tiers.itest.ts).
      data: { loginRole: LoginRole.ADMINISTRATOR, isSuperAdmin: true },
    });
  }

  /** The trail as "action | who it was about", newest last. */
  async function trail(): Promise<string[]> {
    const rows = await prisma.auditLog.findMany({
      where: { entityType: "User" },
      orderBy: { writeSeq: "asc" },
      select: { action: true, entityId: true },
    });

    return rows.map((row) => `${row.action} | ${row.entityId}`);
  }

  it("records that a password was changed, and never the password", async () => {
    const actor = await admin();
    const target = await person();

    await adminService.updateUser(
      target.id,
      { password: "a-brand-new-password" },
      actor.id
    );

    expect(await trail()).toContain(`USER_UPDATED | ${target.id}`);

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: "USER_UPDATED" },
    });

    expect(row.actorId).toBe(actor.id);
    // The trail is exported. A credential must not leave in it.
    const asText = JSON.stringify({ old: row.oldValue, new: row.newValue });
    expect(asText).not.toContain("a-brand-new-password");
    expect(asText).toContain("password");
  });

  it("records a change of role, which is a change of who can administer", async () => {
    const actor = await admin();
    const target = await person();

    await adminService.updateUser(
      target.id,
      { loginRole: LoginRole.ADMINISTRATOR },
      actor.id
    );

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: "USER_UPDATED" },
    });

    expect(JSON.stringify(row.oldValue)).toContain("USER");
    expect(JSON.stringify(row.newValue)).toContain("ADMINISTRATOR");
  });

  it("records a new account, including what it was allowed to do", async () => {
    const actor = await admin();

    const created = await adminService.createUser(
      {
        email: "new.person@example.com",
        password: "copper kettle morning rain",
        firstName: "New",
        lastName: "Person",
        departmentId: financeId,
        loginRole: LoginRole.ADMINISTRATOR,
      },
      actor.id
    );

    expect(await trail()).toContain(`USER_CREATED | ${created.id}`);
  });

  it("tells the person when an administrator changes their password", async () => {
    const actor = await admin();
    const target = await person();

    await adminService.updateUser(
      target.id,
      { password: "a-brand-new-password" },
      actor.id
    );

    const notice = await prisma.notification.findFirstOrThrow({
      where: { recipientId: target.id, type: "SECURITY_ALERT" },
    });

    expect(notice.message.toLowerCase()).toContain("administrator");
    expect(notice.message.toLowerCase()).toContain("password");
  });

  it("tells the person when their email address is changed", async () => {
    // The address is where every notice goes, and where a sign-in is matched
    // from. Changing it quietly moves somebody's account out from under them.
    const actor = await admin();
    const target = await person();

    await adminService.updateUser(
      target.id,
      { email: "somewhere.else@example.com" },
      actor.id
    );

    const notice = await prisma.notification.findFirstOrThrow({
      where: { recipientId: target.id, type: "SECURITY_ALERT" },
    });

    expect(notice.message.toLowerCase()).toContain("email");
  });

  it("says nothing to them about a change that is not theirs to worry about", async () => {
    // A corrected job title is not a security event, and a notice for every
    // edit is how the ones that matter get ignored.
    const actor = await admin();
    const target = await person();

    await adminService.updateUser(
      target.id,
      { designation: "Deputy Director" },
      actor.id
    );

    expect(
      await prisma.notification.count({ where: { recipientId: target.id } })
    ).toBe(0);
  });

  it("does not write to the administrator changing their own password", async () => {
    const actor = await admin();

    await adminService.updateUser(
      actor.id,
      { password: "my-own-new-password" },
      actor.id
    );

    expect(
      await prisma.notification.count({ where: { recipientId: actor.id } })
    ).toBe(0);
  });
});

describe("updateUser", () => {
  const person = async (designation: string | null = null) => {
    const user = await makeUser({ departmentId: financeId });
    return prisma.user.update({ where: { id: user.id }, data: { designation } });
  };

  it("records a designation for somebody who never had one", async () => {
    const user = await person();

    const updated = await adminService.updateUser(user.id, {
      designation: "Deputy Director",
    });

    expect(updated.designation).toBe("Deputy Director");
  });

  it("clears the designation when the field is emptied", async () => {
    // Somebody who has moved on from a role keeps that title printed under
    // their signature on every memo until an administrator can take it off.
    const user = await person("Deputy Director");

    const updated = await adminService.updateUser(user.id, { designation: "" });

    expect(updated.designation).toBeNull();
  });

  it("leaves the designation alone when the edit does not mention it", async () => {
    // A name correction or a department move must not quietly strip a title
    // the administrator never opened the box to change.
    const user = await person("Deputy Director");

    const updated = await adminService.updateUser(user.id, { lastName: "Rahman" });

    expect(updated).toMatchObject({
      lastName: "Rahman",
      designation: "Deputy Director",
    });
  });
});

describe("bulkCreateUsers", () => {
  const row = (
    firstName: string,
    lastName: string,
    email: string,
    password = PASSWORD,
    department = financeName,
    role = "USER"
  ) => [firstName, lastName, email, password, department, role];

  it("creates every valid row", async () => {
    const result = await adminService.bulkCreateUsers(
      spreadsheet([
        row("Ayesha", "Khan", "ayesha@example.com"),
        row("Bilal", "Ahmed", "bilal@example.com", PASSWORD, financeName, "ADMINISTRATOR"),
      ])
    );

    expect(result).toEqual({ created: 2, failed: [] });

    const users = await prisma.user.findMany({ orderBy: { email: "asc" } });
    expect(users.map((user) => [user.email, user.loginRole])).toEqual([
      ["ayesha@example.com", LoginRole.USER],
      ["bilal@example.com", LoginRole.ADMINISTRATOR],
    ]);
  });

  /**
   * A staff list from HR has no password column, and should not be made to
   * grow one.
   *
   * This deployment signs people in with Microsoft. An account with no
   * password is exactly right for that: SSO never looks at `passwordHash`,
   * and password sign-in refuses a null one, so the account has precisely one
   * way in - the tenant's.
   *
   * Requiring a password on every row forced the opposite. To onboard a
   * hundred people an administrator had to invent a hundred passwords, put
   * them in a spreadsheet, and thereby create both a plaintext credential
   * file and a second way into every account that bypasses whatever
   * conditional access the tenant enforces.
   */
  describe("a staff list with no passwords in it", () => {
    const noPassword = [
      "First Name",
      "Last Name",
      "Email",
      "Department",
      "Role",
    ];

    async function offerMicrosoftSignIn() {
      await prisma.ssoSetting.create({
        data: {
          id: "singleton",
          enabled: true,
          tenantId: "a-tenant",
          clientId: "a-client",
          clientSecretCipher: encryptSecret("a-secret"),
          redirectUri: "https://flow.example.com/api/auth/sso/callback",
        },
      });
    }

    it("creates the accounts, with no password on them", async () => {
      await offerMicrosoftSignIn();

      const result = await adminService.bulkCreateUsers(
        spreadsheet(
          [
            ["Ayesha", "Khan", "ayesha@example.com", financeName, "USER"],
            ["Bilal", "Ahmed", "bilal@example.com", financeName, "USER"],
          ],
          noPassword
        )
      );

      expect(result).toEqual({ created: 2, failed: [] });

      const users = await prisma.user.findMany({ orderBy: { email: "asc" } });
      expect(users.map((user) => [user.email, user.passwordHash])).toEqual([
        ["ayesha@example.com", null],
        ["bilal@example.com", null],
      ]);
    });

    it("still takes a password where a row carries one", async () => {
      // Mixed files are normal: a contractor who is not in the directory
      // alongside staff who are.
      await offerMicrosoftSignIn();

      const result = await adminService.bulkCreateUsers(
        spreadsheet([
          row("Ayesha", "Khan", "ayesha@example.com"),
          row("Bilal", "Ahmed", "bilal@example.com", ""),
        ])
      );

      expect(result).toEqual({ created: 2, failed: [] });

      const users = await prisma.user.findMany({ orderBy: { email: "asc" } });
      expect(users.map((user) => user.passwordHash === null)).toEqual([
        false,
        true,
      ]);
    });

    it("refuses a blank password when Microsoft sign-in is NOT switched on", async () => {
      /*
       * Without it, an account with no password has no way in at all. Letting
       * the row through would report "created" for somebody who cannot sign
       * in, which is worse than refusing it - the administrator would find
       * out one confused phone call at a time.
       */
      const result = await adminService.bulkCreateUsers(
        spreadsheet(
          [["Ayesha", "Khan", "ayesha@example.com", financeName, "USER"]],
          noPassword
        )
      );

      expect(result.created).toBe(0);
      expect(result.failed).toEqual([
        {
          row: 2,
          email: "ayesha@example.com",
          error:
            "Password is required, because signing in with a Microsoft work account is not switched on.",
        },
      ]);
    });
  });

  it("keeps going after a bad row and says which one", async () => {
    // An import that stops at the first bad row makes the administrator fix
    // one mistake per upload. The row number is the spreadsheet's own, header
    // included, so it matches what they are looking at.
    const result = await adminService.bulkCreateUsers(
      spreadsheet([
        row("Ayesha", "Khan", "ayesha@example.com"),
        row("Bilal", "Ahmed", "not-an-email"),
        row("Chandni", "Rao", "chandni@example.com"),
      ])
    );

    expect(result.created).toBe(2);
    expect(result.failed).toEqual([
      { row: 3, email: "not-an-email", error: "Enter a valid email address" },
    ]);
    expect(await prisma.user.count()).toBe(2);
  });

  it("reports the field that is missing, not just that the row failed", async () => {
    const result = await adminService.bulkCreateUsers(
      spreadsheet([
        row("", "Khan", "a@example.com"),
        row("Bilal", "", "b@example.com"),
        row("Chandni", "Rao", ""),
        row("Dawood", "Iqbal", "d@example.com", "short"),
      ])
    );

    expect(result.created).toBe(0);
    expect(result.failed.map((failure) => failure.error)).toEqual([
      "First name is required",
      "Last name is required",
      "Email is required",
      "Use at least 12 characters. A short phrase of three or four words is easy to remember and hard to guess.",
    ]);
  });

  it("refuses a department name that does not match one that exists", async () => {
    const result = await adminService.bulkCreateUsers(
      spreadsheet([row("Ayesha", "Khan", "a@example.com", PASSWORD, "Marketing")])
    );

    expect(result.created).toBe(0);
    expect(result.failed[0].error).toContain('Department "Marketing" was not found');
  });

  it("matches the department name without regard to case", async () => {
    const result = await adminService.bulkCreateUsers(
      spreadsheet([
        row("Ayesha", "Khan", "a@example.com", PASSWORD, financeName.toUpperCase()),
      ])
    );

    expect(result).toEqual({ created: 1, failed: [] });
  });

  it("catches a duplicate address inside the file itself", async () => {
    // The first one is created, so the second is a conflict with a row the
    // administrator can see rather than with the database.
    const result = await adminService.bulkCreateUsers(
      spreadsheet([
        row("Ayesha", "Khan", "same@example.com"),
        row("Bilal", "Ahmed", "SAME@example.com"),
      ])
    );

    expect(result.created).toBe(1);
    expect(result.failed[0].error).toContain("already exists in this file");
  });

  it("catches an address that already exists in the database", async () => {
    await makeUser({ departmentId: financeId });
    const existing = await prisma.user.findFirstOrThrow();

    const result = await adminService.bulkCreateUsers(
      spreadsheet([row("Ayesha", "Khan", existing.email)])
    );

    expect(result.created).toBe(0);
    expect(result.failed[0].error).toContain("already exists");
  });

  it("reads headers however they were typed", async () => {
    // Excel adds a BOM, people use underscores, and nobody agrees on case.
    const result = await adminService.bulkCreateUsers(
      spreadsheet(
        [row("Ayesha", "Khan", "a@example.com")],
        [
          "first_name",
          "LAST NAME",
          "E-Mail",
          "password",
          "Department Name",
          "loginRole",
        ]
      )
    );

    expect(result).toEqual({ created: 1, failed: [] });
  });

  describe("the designation column", () => {
    const titled = [
      "First Name",
      "Last Name",
      "Email",
      "Password",
      "Department",
      "Role",
      "Job Title",
    ];

    it("imports the job title beside each person", async () => {
      // The alternative to reading it here is an administrator opening each
      // imported account to retype a title the file already had.
      const result = await adminService.bulkCreateUsers(
        spreadsheet(
          [
            [...row("Ayesha", "Khan", "a@example.com"), "Director of Finance"],
            [...row("Bilal", "Ahmed", "b@example.com"), ""],
          ],
          titled
        )
      );

      expect(result).toEqual({ created: 2, failed: [] });

      const users = await prisma.user.findMany({ orderBy: { email: "asc" } });
      expect(users.map((user) => [user.email, user.designation])).toEqual([
        ["a@example.com", "Director of Finance"],
        // No title in the file is no title on the account, not a failed row.
        ["b@example.com", null],
      ]);
    });

    it("reads the column under either heading people use for it", async () => {
      const result = await adminService.bulkCreateUsers(
        spreadsheet(
          [[...row("Ayesha", "Khan", "a@example.com"), "Head of HR"]],
          [...titled.slice(0, 6), "Designation"]
        )
      );

      expect(result).toEqual({ created: 1, failed: [] });
      const user = await prisma.user.findUniqueOrThrow({
        where: { email: "a@example.com" },
      });
      expect(user.designation).toBe("Head of HR");
    });

    it("names the designation when it is too long for the column", async () => {
      // Postgres refuses the row either way; only this message tells the
      // administrator which cell of which row to shorten.
      const result = await adminService.bulkCreateUsers(
        spreadsheet(
          [[...row("Ayesha", "Khan", "a@example.com"), "A".repeat(121)]],
          titled
        )
      );

      expect(result.created).toBe(0);
      expect(result.failed[0].error).toBe(
        "Designation must be 120 characters or fewer"
      );
    });

    it("does not read a bare Title column as a job title", async () => {
      // An HR export's "Title" column is a salutation. Read as a designation,
      // every imported memo is signed "Mr" where "Director of Finance"
      // belongs - and nothing in the file or the report says so, because the
      // import succeeded.
      const result = await adminService.bulkCreateUsers(
        spreadsheet(
          [[...row("Ayesha", "Khan", "a@example.com"), "Mr"]],
          [...titled.slice(0, 6), "Title"]
        )
      );

      expect(result).toEqual({ created: 1, failed: [] });
      const user = await prisma.user.findUniqueOrThrow({
        where: { email: "a@example.com" },
      });
      expect(user.designation).toBeNull();
    });

    it("reports a row carrying nothing but a job title", async () => {
      // Skipped as blank, a row where somebody filled in only the title
      // disappears from the report, and the person is never imported at all.
      const result = await adminService.bulkCreateUsers(
        spreadsheet(
          [
            [...row("Ayesha", "Khan", "a@example.com"), "Director"],
            ["", "", "", "", "", "", "Head of HR"],
          ],
          titled
        )
      );

      expect(result.created).toBe(1);
      expect(result.failed).toEqual([
        { row: 3, email: undefined, error: "First name is required" },
      ]);
    });
  });

  it("skips an entirely blank row rather than reporting it", async () => {
    const result = await adminService.bulkCreateUsers(
      spreadsheet([
        row("Ayesha", "Khan", "a@example.com"),
        ["", "", "", "", "", ""],
        row("Bilal", "Ahmed", "b@example.com"),
      ])
    );

    expect(result).toEqual({ created: 2, failed: [] });
  });

  it("refuses a role that is neither USER nor ADMINISTRATOR", async () => {
    const result = await adminService.bulkCreateUsers(
      spreadsheet([
        row("Ayesha", "Khan", "a@example.com", PASSWORD, financeName, "Approver"),
      ])
    );

    expect(result.failed[0].error).toBe("Role must be USER or ADMINISTRATOR");
  });

  it("refuses a CSV above the row cap rather than hashing its way through it", async () => {
    // The cap used to sit inside the parser's .xlsx branch, which a .csv
    // returns before reaching, so a file of any size was accepted. Every row
    // is a scrypt derivation on the request thread: an import that big never
    // finishes, and nobody else can log in while it runs.
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, index) =>
      row("Ayesha", "Khan", `person-${index}@example.com`)
    );

    await expect(
      adminService.bulkCreateUsers(spreadsheet(rows))
    ).rejects.toMatchObject({ statusCode: 400 });

    // Refused whole, before the first insert - not half-imported.
    expect(await prisma.user.count()).toBe(0);
  });

  it("names the field that is too long instead of failing the row without a reason", async () => {
    const result = await adminService.bulkCreateUsers(
      spreadsheet([row("A".repeat(101), "Khan", "a@example.com")])
    );

    expect(result.created).toBe(0);
    // Postgres refuses this row either way. Only the message says which cell
    // of which row the administrator has to shorten; without it the report
    // reads "Failed to create user" and the file has to be bisected by hand.
    expect(result.failed[0].error).toBe("First name must be 100 characters or fewer");
  });

  it("refuses a file with no rows at all", async () => {
    await expect(
      adminService.bulkCreateUsers(spreadsheet([]))
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("lets the imported accounts sign in", async () => {
    await adminService.bulkCreateUsers(
      spreadsheet([row("Ayesha", "Khan", "ayesha@example.com")])
    );

    const created = await prisma.user.findUniqueOrThrow({
      where: { email: "ayesha@example.com" },
      select: { passwordHash: true },
    });

    expect(await verifyPassword(PASSWORD, created.passwordHash)).toBe(true);
  });
});

describe("the last administrator", () => {
  it("refuses to demote the last administrator", async () => {
    /*
     * Losing the last administrator means nobody can create a user, manage a
     * department or hand the role back, and the only way in is a database
     * console - the "manual intervention outside the application" this
     * product exists to remove.
     */
    const onlyAdmin = await makeUser({
      departmentId: financeId,
      loginRole: LoginRole.ADMINISTRATOR,
    });

    await expect(
      adminService.updateUser(onlyAdmin.id, { loginRole: "USER" })
    ).rejects.toMatchObject({ statusCode: 400 });

    const unchanged = await prisma.user.findUniqueOrThrow({
      where: { id: onlyAdmin.id },
    });
    expect(unchanged.loginRole).toBe(LoginRole.ADMINISTRATOR);
  });

  it("allows the demotion once somebody else holds the role", async () => {
    const first = await makeUser({
      departmentId: financeId,
      loginRole: LoginRole.ADMINISTRATOR,
    });
    await makeUser({
      departmentId: financeId,
      loginRole: LoginRole.ADMINISTRATOR,
    });

    const updated = await adminService.updateUser(first.id, {
      loginRole: "USER",
    });

    expect(updated.loginRole).toBe(LoginRole.USER);
  });

  it("does not stop an administrator being edited in every other way", async () => {
    // The guard is about the role, not about the person. Renaming the only
    // administrator, or moving their department, must still work.
    const onlyAdmin = await makeUser({
      departmentId: financeId,
      loginRole: LoginRole.ADMINISTRATOR,
    });

    const updated = await adminService.updateUser(onlyAdmin.id, {
      firstName: "Renamed",
      loginRole: "ADMINISTRATOR",
    });

    expect(updated.firstName).toBe("Renamed");
    expect(updated.loginRole).toBe(LoginRole.ADMINISTRATOR);
  });
});

/**
 * The request schemas, checked without a database: every one of these refusals
 * is a 400 with a sentence in it, and the alternative in each case is a 500
 * from Postgres or Prisma that names nothing the administrator can act on.
 */
describe("admin request schemas", () => {
  /** The messages a schema refuses with, so a test can name the one it means. */
  const refusals = (schema: z.ZodType, input: unknown): string[] => {
    const result = schema.safeParse(input);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };

  const request = (
    part: "body" | "params" | "query",
    value: Record<string, unknown>
  ) => ({ body: {}, params: {}, query: {}, [part]: value });

  const newUser = (overrides: Record<string, unknown> = {}) =>
    request("body", {
      email: "new.person@example.com",
      password: PASSWORD,
      firstName: "New",
      lastName: "Person",
      departmentId: missingId(),
      loginRole: "USER",
      ...overrides,
    });

  it("accepts a name that exactly fills the column", () => {
    expect(refusals(createAdminUserSchema, newUser({ firstName: "A".repeat(100) }))).toEqual([]);
  });

  it("refuses a first name one character past the column, naming the field", () => {
    // The People form attaches an error to an input by looking for the field's
    // words in the message, so "First name" has to survive into the text.
    expect(
      refusals(createAdminUserSchema, newUser({ firstName: "A".repeat(101) }))
    ).toContain("First name must be 100 characters or fewer");
  });

  it("refuses a last name past the column, naming the field", () => {
    expect(
      refusals(createAdminUserSchema, newUser({ lastName: "A".repeat(101) }))
    ).toContain("Last name must be 100 characters or fewer");
  });

  it("refuses an address past the column, naming the field", () => {
    expect(
      refusals(createAdminUserSchema, newUser({ email: `${"a".repeat(250)}@example.com` }))
    ).toContain("Email must be 255 characters or fewer");
  });

  it("takes a new account with no designation at all", () => {
    // Required, this would block every account created before anybody has
    // collected the titles - which is all of them today.
    expect(refusals(createAdminUserSchema, newUser())).toEqual([]);
  });

  it("accepts a designation that exactly fills the column", () => {
    expect(
      refusals(createAdminUserSchema, newUser({ designation: "A".repeat(120) }))
    ).toEqual([]);
  });

  it("refuses a designation one character past the column, naming the field", () => {
    // The People form finds the input to mark by the field's words in the
    // message, so "Designation" has to survive into the text.
    expect(
      refusals(createAdminUserSchema, newUser({ designation: "A".repeat(121) }))
    ).toContain("Designation must be 120 characters or fewer");
  });

  it("trims the designation, so nobody is titled with padding", () => {
    // Untrimmed, the leading space is drawn into the memo beneath the name.
    const parsed = createAdminUserSchema.parse(
      newUser({ designation: "  Director of Finance  " })
    );

    expect(parsed.body.designation).toBe("Director of Finance");
  });

  it("lets an edit clear the designation with an empty string", () => {
    // The edit form has no way to send undefined, so refusing "" would leave
    // a title on the account that its holder no longer has.
    const edit = {
      ...request("body", { designation: "" }),
      params: { id: missingId() },
    };

    expect(refusals(updateAdminUserSchema, edit)).toEqual([]);
  });

  it("caps the designation on an edit as well as on a create", () => {
    const edit = {
      ...request("body", { designation: "A".repeat(121) }),
      params: { id: missingId() },
    };

    expect(refusals(updateAdminUserSchema, edit)).toContain(
      "Designation must be 120 characters or fewer"
    );
  });

  it("refuses a password long enough to make hashing it the request's cost", () => {
    expect(
      refusals(createAdminUserSchema, newUser({ password: "a".repeat(201) }))
    ).toContain("Use 200 characters or fewer.");
  });

  it("applies the same caps when an existing account is edited", () => {
    // An edit writes to the same columns as a create, so a cap on one and not
    // the other just moves the 500 to the other screen.
    const edit = {
      ...request("body", { firstName: "A".repeat(101) }),
      params: { id: missingId() },
    };

    expect(refusals(updateAdminUserSchema, edit)).toContain(
      "First name must be 100 characters or fewer"
    );
  });

  it("refuses a path id that is not a uuid, on every route that takes one", () => {
    // Unchecked, this reaches a uuid column and comes back as "Internal server
    // error" - so a stale bookmark reads as an outage rather than a gone user.
    const badId = request("params", { id: "not-a-uuid" });

    expect(refusals(getAdminUserSchema, badId)).toHaveLength(1);
    expect(
      refusals(updateAdminUserSchema, {
        ...badId,
        body: { firstName: "New" },
      })
    ).toHaveLength(1);
  });

  it("reads the paging query as numbers and refuses a page above the cap", () => {
    const parsed = listAdminUsersSchema.parse(
      request("query", { q: " Maria ", limit: "25", offset: "50" })
    );

    expect(parsed.query).toEqual({ q: "Maria", limit: 25, offset: 50 });
    expect(refusals(listAdminUsersSchema, request("query", { limit: "5000" }))).toHaveLength(1);
    expect(refusals(listAdminUsersSchema, request("query", { offset: "-1" }))).toHaveLength(1);
  });

  it("takes the list with no parameters at all, as every caller sends it today", () => {
    expect(refusals(listAdminUsersSchema, request("query", {}))).toEqual([]);
  });

  it("tells an importer that a field beside the file is not read", () => {
    // The import takes its people from the spreadsheet only. Accepting a
    // stray form field would let somebody believe a department or role they
    // typed applied to the whole file, when nothing on the server reads it.
    expect(refusals(bulkImportUsersSchema, request("body", {}))).toEqual([]);
    expect(
      refusals(bulkImportUsersSchema, request("body", { loginRole: "ADMINISTRATOR" }))
    ).toHaveLength(1);
  });
});

/**
 * The wiring, over real HTTP.
 *
 * The service tests above prove the answers. What is only visible here is
 * whether the query string reaches the service at all, and whether a mistyped
 * link or an over-long name comes back as a sentence somebody can act on
 * rather than as "Internal server error".
 */
describe("the admin user routes", () => {
  let server: Server;
  let base: string;
  let token: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      // `listen`'s callback is typed as taking an error, so passing `resolve`
      // straight in does not type-check even though it works.
      server = app.listen(0, () => {
        resolve();
      });
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  const ADMIN_EMAIL = "route.admin@example.com";

  beforeEach(async () => {
    await prisma.user.create({
      data: {
        firstName: "Route",
        lastName: "Admin",
        email: ADMIN_EMAIL,
        passwordHash: await hashPassword(PASSWORD),
        departmentId: financeId,
        loginRole: LoginRole.ADMINISTRATOR,
        isSuperAdmin: true,
      },
    });

    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
    });

    token = ((await response.json()) as { accessToken: string }).accessToken;
  });

  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("answers a request with no parameters, as every caller sends it today", async () => {
    const response = await call("GET", "/api/admin/users");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 1, returned: 1 });
  });

  it("carries the search and the page through from the query string", async () => {
    await makeUser({ firstName: "Maria", lastName: "Chen", departmentId: financeId });
    await makePeople(4);

    const searched = await (await call("GET", "/api/admin/users?q=maria%20chen")).json();
    const paged = await (await call("GET", "/api/admin/users?limit=2&offset=1")).json();

    // limit and offset arrive as strings; read as text they would page by
    // nothing at all and the screen would show the same first rows forever.
    expect(searched).toMatchObject({ total: 1, returned: 1 });
    expect(paged).toMatchObject({ total: 6, returned: 2 });
  });

  it("offers no way to delete a person, only to switch them off", async () => {
    /*
     * A deleted row cleared the actor on every sealed audit record that person
     * wrote, and the ledger then failed its own check. The route is gone, so
     * nothing a stale browser tab or a hand-made call sends can do it.
     */
    const person = await makeUser({ firstName: "Stays", departmentId: financeId });

    const response = await call("DELETE", `/api/admin/users/${person.id}`);

    expect(response.status).toBe(404);
    expect(await prisma.user.count({ where: { id: person.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "USER_DELETED" } })).toBe(0);

    // Switching off is still there, and is the way to remove somebody - after
    // confirming it is them, since it hands everything the person holds on.
    const unconfirmed = await call("POST", `/api/admin/users/${person.id}/active`, { active: false });
    expect(unconfirmed.status).toBe(403);
    expect(await unconfirmed.json()).toMatchObject({ error: { code: "STEP_UP_REQUIRED" } });

    const admin = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } });
    const off = await fetch(`${base}/api/admin/users/${person.id}/active`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-step-up": await issueStepUpToken(admin.id),
      },
      body: JSON.stringify({ active: false }),
    });
    expect(off.status).toBe(200);

    // Back on moves nothing, and does not ask.
    const on = await call("POST", `/api/admin/users/${person.id}/active`, { active: true });
    expect(on.status).toBe(200);
  });

  it("refuses a page size above the cap rather than quietly serving one", async () => {
    const response = await call("GET", "/api/admin/users?limit=5000");

    expect(response.status).toBe(400);
  });

  it("answers a mistyped user link with a sentence, not a server error", async () => {
    // Unchecked, the id reaches a uuid column and the reader is told the
    // system broke when the truth is that there is no such person.
    const got = await call("GET", "/api/admin/users/not-a-uuid");
    expect(got.status).toBe(400);

    const patched = await call("PATCH", "/api/admin/users/not-a-uuid", {
      firstName: "New",
    });

    expect(patched.status).toBe(400);
  });

  it("refuses a name longer than the column with the field named", async () => {
    const response = await call("POST", "/api/admin/users", {
      email: "long.name@example.com",
      password: PASSWORD,
      firstName: "A".repeat(101),
      lastName: "Person",
      departmentId: financeId,
      loginRole: "USER",
    });

    // Without the cap this is a Postgres over-length error, which arrives as
    // 500 with no field in it - and the form cannot mark the input at fault.
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "First name must be 100 characters or fewer" },
    });
  });

  it("takes a designation on the way in and gives it back on the detail", async () => {
    const created = await call("POST", "/api/admin/users", {
      email: "titled.person@example.com",
      password: PASSWORD,
      firstName: "Titled",
      lastName: "Person",
      designation: "Director of Finance",
      departmentId: financeId,
      loginRole: "USER",
    });

    // Dropped by the schema on the way in, the field is unreachable from the
    // People form no matter what the service and the column can do.
    expect(created.status).toBe(201);
    const user = (await created.json()) as { id: string; designation: string | null };
    expect(user.designation).toBe("Director of Finance");

    const detail = await (await call("GET", `/api/admin/users/${user.id}`)).json();

    expect(detail).toMatchObject({ designation: "Director of Finance" });
  });

  /**
   * The edit is the half of this that matters after the first day: a title is
   * wrong or out of date far more often than it is missing, and the only way
   * to take a stale one off a signature is this request. Create is proved
   * above; nothing but this shows the field surviving the PATCH wiring - the
   * schema, the middleware that writes the parsed body back, and the service.
   */
  it("changes a designation over PATCH, padding trimmed, and clears it again", async () => {
    const created = await call("POST", "/api/admin/users", {
      email: "edited.person@example.com",
      password: PASSWORD,
      firstName: "Edited",
      lastName: "Person",
      designation: "Deputy Director",
      departmentId: financeId,
      loginRole: "USER",
    });
    const { id } = (await created.json()) as { id: string };

    const renamed = await call("PATCH", `/api/admin/users/${id}`, {
      designation: "  Director of Finance  ",
    });

    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      designation: "Director of Finance",
    });
    // Read from the row, not the response: this is what the memo prints.
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id } })).designation
    ).toBe("Director of Finance");

    const cleared = await call("PATCH", `/api/admin/users/${id}`, {
      designation: "",
    });

    // Somebody who has left the role keeps that title under their signature
    // on every memo until this request goes through.
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ designation: null });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id } })).designation
    ).toBeNull();
  });

  it("refuses an over-long designation on PATCH without touching the recorded one", async () => {
    const created = await call("POST", "/api/admin/users", {
      email: "long.title@example.com",
      password: PASSWORD,
      firstName: "Long",
      lastName: "Title",
      designation: "Deputy Director",
      departmentId: financeId,
      loginRole: "USER",
    });
    const { id } = (await created.json()) as { id: string };

    const refused = await call("PATCH", `/api/admin/users/${id}`, {
      designation: "A".repeat(121),
    });

    // A refusal with the field named is a form the administrator can correct.
    // Without the cap this is a Postgres error the handler cannot read, and
    // the only thing on screen is "Internal server error".
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: { message: "Designation must be 120 characters or fewer" },
    });
    // And the refusal is a dead end only if it also lost the old title.
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id } })).designation
    ).toBe("Deputy Director");

    const shortened = await call("PATCH", `/api/admin/users/${id}`, {
      designation: "Director of Finance",
    });

    expect(shortened.status).toBe(200);
  });
});


describe("managing departments", () => {
  /**
   * Until this existed, reading the list was the only thing the product could
   * do with a department. They came from the seed script or a database prompt
   * and from nowhere else - and since `departmentId` is required on a user,
   * onboarding somebody into a new team was blocked on an engineer with access
   * to the server. That is exactly the "manual intervention outside the
   * application" the requirement rules out.
   */

  describe("creating one", () => {
    it("adds it, and it is immediately assignable", async () => {
      const created = await adminService.createDepartment({ name: "Internal Audit" });

      expect(created).toMatchObject({ name: "Internal Audit", isActive: true, userCount: 0 });

      const offered = await adminService.listDepartments();
      expect(offered.map((d) => d.name)).toContain("Internal Audit");
    });

    it("trims what somebody typed", async () => {
      // A department called " Finance " sorts oddly, matches nothing typed
      // normally, and reads as a different department to the eye.
      const created = await adminService.createDepartment({ name: "  Finance  " });
      expect(created.name).toBe("Finance");
    });

    it("refuses a name that already exists", async () => {
      await adminService.createDepartment({ name: "Procurement" });

      await expect(
        adminService.createDepartment({ name: "Procurement" })
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("refuses one that differs only by case", async () => {
      /*
       * Not fussiness. The bulk user import maps a spreadsheet cell to a
       * department by lowercased name, so "Finance" and "finance" collapse to
       * one key and the map keeps whichever came last - importing people into
       * a department nobody chose. The database now holds a unique index on
       * lower(name); this is the sentence that goes with it.
       */
      await adminService.createDepartment({ name: "Finance" });

      await expect(
        adminService.createDepartment({ name: "finance" })
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("says the clash is switched off rather than just refusing", async () => {
      // Otherwise an administrator gets "already exists" about a department
      // they cannot see anywhere on the screen.
      const existing = await adminService.createDepartment({ name: "Legal" });
      await adminService.updateDepartment(existing.id, { isActive: false });

      await expect(
        adminService.createDepartment({ name: "Legal" })
      ).rejects.toThrow(/switched off/i);
    });

    it("writes it to the audit trail", async () => {
      const actor = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });

      const created = await adminService.createDepartment(
        { name: "Corporate Affairs" },
        actor.id
      );

      const audit = await prisma.auditLog.findFirst({
        where: { action: "DEPARTMENT_CREATED", entityId: created.id },
      });
      expect(audit?.actorId).toBe(actor.id);
      expect(audit?.entityType).toBe("Department");
    });
  });

  describe("renaming and switching off", () => {
    it("renames it, and everybody in it comes with it", async () => {
      const department = await makeDepartment();
      const person = await makeUser({ departmentId: department.id });

      await adminService.updateDepartment(department.id, { name: "Group Finance" });

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: person.id },
        select: { department: { select: { name: true } } },
      });
      expect(after.department.name).toBe("Group Finance");
    });

    it("lets a department keep its own name", async () => {
      // Renaming "Finance" to "Finance" is a no-op, not a clash with itself.
      const department = await adminService.createDepartment({ name: "Finance" });

      await expect(
        adminService.updateDepartment(department.id, { name: "Finance" })
      ).resolves.toMatchObject({ name: "Finance" });
    });

    it("refuses a rename onto another department's name", async () => {
      await adminService.createDepartment({ name: "Finance" });
      const other = await adminService.createDepartment({ name: "Legal" });

      await expect(
        adminService.updateDepartment(other.id, { name: "FINANCE" })
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("stops offering a department that was switched off", async () => {
      const department = await adminService.createDepartment({ name: "Dissolved Unit" });

      await adminService.updateDepartment(department.id, { isActive: false });

      const offered = await adminService.listDepartments();
      expect(offered.map((d) => d.name)).not.toContain("Dissolved Unit");
    });

    it("keeps showing it to the screen that manages them", async () => {
      // A department nobody can see is a department nobody can turn back on.
      const department = await adminService.createDepartment({ name: "Dissolved Unit" });
      await adminService.updateDepartment(department.id, { isActive: false });

      const all = await adminService.listDepartments({ includeInactive: true });
      expect(all.map((d) => d.name)).toContain("Dissolved Unit");
      expect(all.find((d) => d.id === department.id)?.isActive).toBe(false);
    });

    it("leaves the people in it exactly where they were", async () => {
      /*
       * Switching off is what "delete" means for a department with people in
       * it. It stops being offered for anything new; it does not reach into
       * the accounts that already point at it, and every memo those people
       * approved still names it.
       */
      const department = await makeDepartment();
      const person = await makeUser({ departmentId: department.id });

      await adminService.updateDepartment(department.id, { isActive: false });

      const after = await prisma.user.findUniqueOrThrow({ where: { id: person.id } });
      expect(after.departmentId).toBe(department.id);
    });

    it("can be turned back on", async () => {
      const department = await adminService.createDepartment({ name: "Seasonal Unit" });
      await adminService.updateDepartment(department.id, { isActive: false });

      await adminService.updateDepartment(department.id, { isActive: true });

      const offered = await adminService.listDepartments();
      expect(offered.map((d) => d.name)).toContain("Seasonal Unit");
    });

    it("records what it was and what it became", async () => {
      const actor = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });
      const department = await adminService.createDepartment({ name: "Old Name" });

      await adminService.updateDepartment(
        department.id,
        { name: "New Name" },
        actor.id
      );

      const audit = await prisma.auditLog.findFirst({
        where: { action: "DEPARTMENT_UPDATED", entityId: department.id },
        orderBy: { createdAt: "desc" },
      });
      expect(audit?.oldValue).toMatchObject({ name: "Old Name" });
      expect(audit?.newValue).toMatchObject({ name: "New Name" });
    });

    it("refuses one that is not there", async () => {
      await expect(
        adminService.updateDepartment(missingId(), { name: "Anything" })
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("deleting one", () => {
    it("removes an empty department outright", async () => {
      const department = await adminService.createDepartment({ name: "Never Used" });

      await adminService.deleteDepartment(department.id);

      expect(
        await prisma.department.findUnique({ where: { id: department.id } })
      ).toBeNull();
    });

    it("refuses while anybody is still in it, and says how many", async () => {
      /*
       * `departmentId` is required on a user, so deleting a department with
       * people in it means orphaning or deleting them - neither of which a
       * management screen should do quietly. The database would refuse it in
       * Latin; this refuses it in a sentence, with the number and the way out.
       */
      const department = await makeDepartment();
      await makeUser({ departmentId: department.id });
      await makeUser({ departmentId: department.id });

      await expect(
        adminService.deleteDepartment(department.id)
      ).rejects.toThrow(/2 people/);

      expect(
        await prisma.department.findUnique({ where: { id: department.id } })
      ).not.toBeNull();
    });

    it("counts one person as a person", async () => {
      const department = await makeDepartment();
      await makeUser({ departmentId: department.id });

      await expect(
        adminService.deleteDepartment(department.id)
      ).rejects.toThrow(/1 person\b/);
    });

    it("points at switching it off instead", async () => {
      const department = await makeDepartment();
      await makeUser({ departmentId: department.id });

      await expect(
        adminService.deleteDepartment(department.id)
      ).rejects.toThrow(/switch the department off/i);
    });

    it("writes it to the audit trail, which outlives the row", async () => {
      // The department is gone; the record that it existed and who removed it
      // is the only thing left saying so.
      const actor = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });
      const department = await adminService.createDepartment({ name: "Wound Up" });

      await adminService.deleteDepartment(department.id, actor.id);

      const audit = await prisma.auditLog.findFirst({
        where: { action: "DEPARTMENT_DELETED", entityId: department.id },
      });
      expect(audit?.actorId).toBe(actor.id);
      expect(audit?.oldValue).toMatchObject({ name: "Wound Up" });
    });

    it("refuses one that is not there", async () => {
      await expect(
        adminService.deleteDepartment(missingId())
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("the headcount the screen reads", () => {
    it("counts the people in each", async () => {
      const department = await makeDepartment();
      await makeUser({ departmentId: department.id });
      await makeUser({ departmentId: department.id });

      const listed = await adminService.listDepartments();
      expect(listed.find((d) => d.id === department.id)?.userCount).toBe(2);
    });

    it("is zero for a new one, which is what makes it deletable", async () => {
      const created = await adminService.createDepartment({ name: "Brand New" });

      const listed = await adminService.listDepartments();
      expect(listed.find((d) => d.id === created.id)?.userCount).toBe(0);
    });
  });
})

