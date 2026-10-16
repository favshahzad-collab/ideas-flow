import { prisma } from "../prisma";
import {
  DEFAULT_ADMIN_POWERS,
  GRANTABLE_POWERS,
  VIEWABLE_POWERS,
  isGrantablePower,
  viewPower,
} from "../lib/capabilities";
import { AppError, errors } from "../lib/errors";
import { hashPassword } from "../lib/password";
import { assertAcceptablePassword, passwordProblem } from "../lib/passwordPolicy";
import { auditService } from "./audit.service";
import { sessionsService } from "./sessions.service";
import { ssoSettingsService } from "./ssoSettings.service";
import { logger } from "../lib/logger";
import { notificationsService } from "./notifications.service";
import { leaverHandoverService } from "./leaverHandover.service";
import { MAX_IMPORT_ROWS, parseSpreadsheet } from "../utils/spreadsheet";
import {
  ADMIN_USERS_DEFAULT_LIMIT,
  ADMIN_USERS_MAX_LIMIT,
  USER_DESIGNATION_MAX_LENGTH,
  USER_EMAIL_MAX_LENGTH,
  USER_NAME_MAX_LENGTH,
  type UpdateAdminUserInput,
  type CreateAdminUserInput,
} from "../schemas/admin.schema";
import { Prisma, type LoginRole } from "../generated/prisma/client";

async function assertEmailAvailable(email: string, excludeUserId?: string) {
  const existing = await prisma.user.findFirst({
    where: {
      email: { equals: email, mode: "insensitive" },
      ...(excludeUserId ? { NOT: { id: excludeUserId } } : {}),
    },
    select: { id: true },
  });

  if (existing) {
    throw errors.conflict("A user with this email already exists");
  }
}

/**
 * The one test behind demoting and switching off an administrator:
 * afterwards, somebody who can still sign in must hold the role. Losing the
 * last one locks everybody out of user administration with no way back except
 * a database console.
 *
 * It counts the OTHER administrators still in use, rather than all of them.
 * Counting every administrator let one active administrator be demoted while
 * a switched-off one still existed - two on paper, none able to
 * sign in. And it asks about everybody except `userId`, so the same question
 * is right whether that person is in use or already switched off.
 */
async function assertAnotherActiveAdministrator(userId: string, refusal: string) {
  const others = await prisma.user.count({
    where: {
      loginRole: "ADMINISTRATOR",
      deactivatedAt: null,
      id: { not: userId },
    },
  });

  if (others === 0) {
    throw errors.badRequest(refusal);
  }
}

/**
 * Whether this account is a Super Administrator.
 *
 * No actor means the system itself - the seed, a migration script - which is
 * not an administrator being limited.
 */
async function isSuperAdministrator(actorId?: string): Promise<boolean> {
  if (!actorId) return true;
  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { loginRole: true, isSuperAdmin: true },
  });
  return actor?.loginRole === "ADMINISTRATOR" && actor.isSuperAdmin;
}

/**
 * Administrators' accounts are a Super Administrator's to change.
 *
 * Without this, an administrator given only the power to manage people could
 * reset another administrator's password or second factor and sign in as
 * them - taking every power that person holds, the Super Administrator's
 * included. So making somebody an administrator, and anything done to an
 * administrator's account, needs a Super Administrator.
 */
async function assertMayManageAdministrators(actorId: string | undefined, refusal: string) {
  if (!(await isSuperAdministrator(actorId))) {
    throw errors.forbidden(refusal, "POWER_REQUIRED");
  }
}

/** There is always a Super Administrator, or nobody can manage administrators again. */
async function assertAnotherActiveSuperAdministrator(userId: string, refusal: string) {
  const others = await prisma.user.count({
    where: {
      loginRole: "ADMINISTRATOR",
      isSuperAdmin: true,
      deactivatedAt: null,
      id: { not: userId },
    },
  });

  if (others === 0) {
    throw errors.badRequest(refusal);
  }
}

type BulkUserImportFailure = {
  row: number;
  email?: string;
  error: string;
};

type SpreadsheetUpload = {
  buffer: Buffer;
  originalname: string;
};

function normalizeHeader(key: string): string {
  return key.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function cell(row: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return "";
}

/**
 * One representation for "no title recorded", so the memo drawing code has one
 * case to handle rather than two. A cleared field arrives as "" from a form
 * that cannot send undefined, and a blank line under a signature is not the
 * same thing as a signature with no line under it.
 */
function toStoredDesignation(value: string | undefined): string | null {
  return value ? value : null;
}

function parseLoginRole(value: string): LoginRole | null {
  const normalized = value.trim().toUpperCase();
  if (normalized === "USER" || normalized === "ADMINISTRATOR") {
    return normalized;
  }
  return null;
}

class AdminService {
  /**
   * The People screen's directory, searched and paged server-side.
   *
   * This used to return every row in the user table, which the screen then
   * filtered per keystroke in the browser. That is fine at seed size and is
   * the one screen certain to meet the whole organisation, so the search and
   * the page belong here - `total` is what lets the screen say how many people
   * matched rather than how many it happens to be holding.
   */
  async listUsers(
    options: { q?: string; limit?: number; offset?: number } = {}
  ) {
    const term = options.q?.trim();

    const take = Math.min(
      Math.max(options.limit ?? ADMIN_USERS_DEFAULT_LIMIT, 1),
      ADMIN_USERS_MAX_LIMIT
    );
    const skip = Math.max(options.offset ?? 0, 0);

    // Match every word somewhere, rather than the whole string in one field -
    // otherwise "Maria Chen" finds nobody, because no single column contains
    // both names, which is exactly what an administrator types when they are
    // looking for a person.
    const tokens = term ? term.split(/\s+/).filter(Boolean).slice(0, 5) : [];

    const where =
      tokens.length > 0
        ? {
            AND: tokens.map((token) => ({
              OR: [
                { firstName: { contains: token, mode: "insensitive" as const } },
                { lastName: { contains: token, mode: "insensitive" as const } },
                { email: { contains: token, mode: "insensitive" as const } },
                {
                  department: {
                    name: { contains: token, mode: "insensitive" as const },
                  },
                },
              ],
            })),
          }
        : {};

    const [users, total, openApprovals] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          designation: true,
          lineManagerId: true,
          loginRole: true,
          isSuperAdmin: true,
          adminPowers: true,
          department: {
            select: {
              id: true,
              name: true,
            },
          },
          createdAt: true,
          updatedAt: true,
          /*
           * Whether this person has two-step sign-in on, so the row can offer
           * to lift it. The timestamp itself is not sent - the screen only
           * needs to know whether there is anything to turn off, and a date
           * would be one more thing on a row that already carries five.
           */
          totpActivatedAt: true,
          /*
           * Null while the account is in use. On the row rather than behind a
           * filter, because a people list that quietly hid switched-off
           * accounts would answer "is Kazim still set up here?" with silence -
           * and silence reads as "no such person", which is a different fact
           * and the one that gets an account recreated.
           */
          deactivatedAt: true,
        },
        // Newest first, as before. The id breaks the tie because a bulk import
        // stamps every row it creates with the same instant: without it those
        // accounts have no fixed order, so paging through an import can show
        // one person twice and skip another.
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take,
        skip,
      }),
      prisma.user.count({ where }),
      this.openApprovalCounts(),
    ]);

    // Who is covering for whom, for the people actually on this page.
    const coveredBy = await this.activeDelegates(users.map((user) => user.id));

    return {
      users: users.map(({ totpActivatedAt, ...user }) => ({
        ...user,
        // A boolean rather than the date: what the screen does with it is
        // decide whether to draw one menu item.
        twoFactorEnabled: Boolean(totpActivatedAt),
        // Null for almost everybody. When it is set, the Availability column
        // can say who is signing in their place instead of asserting that
        // everybody is at their desk.
        coveredBy: coveredBy.get(user.id) ?? null,
        // How many memos are sitting on this person's desk right now. Counted
        // over every document rather than the ones the caller can see - the
        // people screen is administrators only, and a queue length that reads
        // low because of somebody else's permission boundary is exactly the
        // number a manager would reassign work on.
        openApprovals: openApprovals.get(user.id) ?? 0,
      })),
      total,
      returned: users.length,
    };
  }

  /** The delegate covering each of these people right now, where there is one. */
  private async activeDelegates(userIds: string[]) {
    if (userIds.length === 0) {
      return new Map<
        string,
        { id: string; firstName: string; lastName: string; endsAt: Date | null }
      >();
    }

    const now = new Date();
    const active = await prisma.delegation.findMany({
      where: {
        delegatorId: { in: userIds },
        revokedAt: null,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gte: now } }],
      },
      select: {
        delegatorId: true,
        endsAt: true,
        delegate: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { startsAt: "desc" },
    });

    return new Map(
      active.map((row) => [
        row.delegatorId,
        { ...row.delegate, endsAt: row.endsAt },
      ])
    );
  }

  /**
   * Open approvals per person: the step a live run is actually sitting on,
   * for a document that is still out for review, that nobody has acted on.
   *
   * One grouped read rather than a count per row - a hundred people on the
   * page would otherwise be a hundred queries.
   */
  private async openApprovalCounts(): Promise<Map<string, number>> {
    const rows = await prisma.$queryRaw<
      { assigned_user_id: string; open: bigint }[]
    >`
      SELECT s.assigned_user_id, COUNT(*) AS open
      FROM approval_chain_steps s
      JOIN approval_chains c ON c.id = s.chain_id
      JOIN workflow_runs r
        ON r.chain_id = c.id
       AND r.current_step_order = s.step_order
       AND r.status = 'IN_PROGRESS'
      JOIN documents d
        ON d.id = r.document_id
       AND d.status = 'PENDING_REVIEW'
      LEFT JOIN approval_actions a
        ON a.workflow_run_id = r.id
       AND a.chain_step_id = s.id
      WHERE a.id IS NULL
      GROUP BY s.assigned_user_id
    `;

    return new Map(rows.map((row) => [row.assigned_user_id, Number(row.open)]));
  }

  /**
   * The departments, and how many people are in each.
   *
   * Active only by default, and that default is load-bearing: every caller
   * that existed before this - the user form, the approver dialog on the
   * submission screen - is asking "what may I assign somebody to", and a
   * deactivated department is precisely the answer they must not get. The
   * management screen asks for all of them explicitly.
   *
   * `userCount` is what stops somebody deactivating the department forty
   * people are in without being told first.
   */
  async listDepartments(options: { includeInactive?: boolean } = {}) {
    const departments = await prisma.department.findMany({
      where: options.includeInactive ? undefined : { isActive: true },
      select: {
        id: true,
        name: true,
        isActive: true,
        _count: { select: { users: true } },
      },
      orderBy: { name: "asc" },
    });

    return departments.map(({ _count, ...department }) => ({
      ...department,
      userCount: _count.users,
    }));
  }

  /**
   * Refuse a name that already exists in any casing.
   *
   * The column is unique and the database now holds a unique index on
   * `lower(name)` as well, so this is not the guarantee - it is the sentence.
   * A raw constraint violation would tell an administrator "Unique constraint
   * failed on the fields: (`name`)", and the useful thing to say is which
   * department already has that name, including when the difference is only
   * that somebody typed it in lower case.
   */
  private async assertDepartmentNameFree(name: string, exceptId?: string) {
    const clash = await prisma.department.findFirst({
      where: {
        name: { equals: name.trim(), mode: "insensitive" },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { name: true, isActive: true },
    });

    if (clash) {
      throw errors.conflict(
        clash.isActive
          ? `A department called "${clash.name}" already exists.`
          : `A department called "${clash.name}" already exists but is switched off. Turn it back on rather than making a second one.`
      );
    }
  }

  /**
   * `actorId` is the second argument, as it is on every other write here.
   *
   * It used to live inside the input object, alone among its neighbours, and
   * the cost of that was not style: calling it the way the neighbours are
   * called put the actor where no parameter was reading it, so it vanished
   * without a word and the change history rendered the row as "No longer a
   * user". TypeScript could not object - an extra property on an object
   * literal typed as a wider shape is not an error - so the first thing to
   * notice was a screen.
   */
  async createDepartment(input: { name: string }, actorId?: string) {
    const name = input.name.trim();
    await this.assertDepartmentNameFree(name);

    try {
      const department = await prisma.department.create({
        data: { name },
        select: { id: true, name: true, isActive: true },
      });

      await auditService.createAuditLog({
        actorId,
        action: "DEPARTMENT_CREATED",
        entityType: "Department",
        entityId: department.id,
        newValue: { name: department.name },
      });

      return { ...department, userCount: 0 };
    } catch (error) {
      // The check above is not atomic; the index is. Two administrators
      // creating the same department at once is unlikely and survivable, and
      // the second one should still get a sentence rather than a stack.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw errors.conflict(`A department called "${name}" already exists.`);
      }
      throw error;
    }
  }

  /**
   * Rename a department, or switch it off and on.
   *
   * Switching off is the answer to "delete" for a department that has people
   * in it: the users keep pointing at it, every memo they ever approved still
   * names it, and it simply stops being offered for anything new.
   */
  async updateDepartment(
    id: string,
    input: { name?: string; isActive?: boolean },
    /** Who made the change. Second argument, as on every neighbour here. */
    actorId?: string
  ) {
    const before = await prisma.department.findUnique({
      where: { id },
      select: { id: true, name: true, isActive: true },
    });

    if (!before) {
      throw errors.notFound("Department not found");
    }

    const name = input.name?.trim();
    if (name && name.toLowerCase() !== before.name.toLowerCase()) {
      await this.assertDepartmentNameFree(name, id);
    }

    const department = await prisma.department.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      },
      select: {
        id: true,
        name: true,
        isActive: true,
        _count: { select: { users: true } },
      },
    });

    await auditService.createAuditLog({
      actorId,
      action: "DEPARTMENT_UPDATED",
      entityType: "Department",
      entityId: id,
      oldValue: { name: before.name, isActive: before.isActive },
      newValue: { name: department.name, isActive: department.isActive },
    });

    const { _count, ...rest } = department;
    return { ...rest, userCount: _count.users };
  }

  /**
   * Remove a department outright, which is only ever safe when it is empty.
   *
   * `users.departmentId` is a required column, so a department with people in
   * it cannot be deleted without either orphaning them or deleting them, and
   * neither is a thing a management screen should do quietly. The database
   * would refuse it anyway - this refuses it in words, with the number, and
   * names the alternative.
   */
  async deleteDepartment(id: string, actorId?: string) {
    const department = await prisma.department.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        isActive: true,
        _count: { select: { users: true } },
      },
    });

    if (!department) {
      throw errors.notFound("Department not found");
    }

    if (department._count.users > 0) {
      const people = department._count.users;
      throw errors.conflict(
        `${department.name} still has ${people} ${people === 1 ? "person" : "people"} in it. Move them first, or switch the department off to stop it being offered for anything new.`
      );
    }

    await prisma.department.delete({ where: { id } });

    await auditService.createAuditLog({
      actorId,
      action: "DEPARTMENT_DELETED",
      entityType: "Department",
      entityId: id,
      oldValue: { name: department.name, isActive: department.isActive },
    });

    return { id: department.id, name: department.name };
  }

  /**
   * `input.password` may be absent, and that is a real state rather than an
   * oversight: an account with no password signs in through Microsoft only.
   * `sso.service` never looks at `passwordHash`, and password sign-in refuses
   * a null one, so such an account has exactly one way in - the tenant's.
   *
   * The single-user create route still requires one in its schema, so nothing
   * about that endpoint changes. This is for the bulk import, where a staff
   * list from HR has no password column and should not be made to grow one.
   */
  async createUser(
    // `Omit` then re-add, not an intersection: `CreateAdminUserInput &
    // { password?: string }` leaves the field REQUIRED, because `string &
    // (string | undefined)` is `string`. An intersection cannot relax a
    // member, only narrow one.
    input: Omit<CreateAdminUserInput, "password"> & { password?: string },
    /** Who created the account. Optional so the importer can pass its own. */
    actorId?: string
  ) {
    const department = await prisma.department.findUnique({
      where: {
        id: input.departmentId,
      },
    });

    if (!department) {
      throw errors.badRequest("Department not found");
    }

    await assertEmailAvailable(input.email);
    await assertValidLineManager(input.lineManagerId);

    if (input.loginRole === "ADMINISTRATOR") {
      await assertMayManageAdministrators(
        actorId,
        "Only a Super Administrator can make somebody an administrator."
      );
    }

    if (input.password) {
      assertAcceptablePassword(input.password, input);
    }

    try {
      const created = await prisma.user.create({
        data: {
          email: input.email.toLowerCase(),
          passwordHash: input.password
            ? await hashPassword(input.password)
            : null,
          firstName: input.firstName,
          lastName: input.lastName,
          designation: toStoredDesignation(input.designation),
          lineManagerId: input.lineManagerId ?? null,
          departmentId: input.departmentId,
          loginRole: input.loginRole,
          // A new administrator is a limited one, with only the default
          // powers; a Super Administrator gives them more.
          ...(input.loginRole === "ADMINISTRATOR"
            ? { isSuperAdmin: false, adminPowers: [...DEFAULT_ADMIN_POWERS] }
            : {}),
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          designation: true,
          lineManagerId: true,
          loginRole: true,
          department: {
            select: {
              id: true,
              name: true,
            },
          },
          createdAt: true,
          updatedAt: true,
        },
      });

      /*
       * Who was added, and what they were allowed to do. `loginRole` is the
       * part worth having: an account created as ADMINISTRATOR is somebody
       * gaining the run of the system, and that had no row at all.
       */
      await auditService.createAuditLog({
        actorId,
        action: "USER_CREATED",
        entityType: "User",
        entityId: created.id,
        newValue: {
          email: created.email,
          loginRole: created.loginRole,
          departmentId: input.departmentId,
          hasPassword: Boolean(input.password),
        },
      });

      return created;
    } catch (error) {
      // Nothing to unwind: the account is a single row, so a failed insert
      // leaves no orphaned auth record behind.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw errors.conflict("A user with this email already exists");
      }

      throw error;
    }
  }

  async bulkCreateUsers(file: SpreadsheetUpload, actorId?: string) {
    const rows = await parseSpreadsheet(file.buffer, file.originalname);

    // The cap lives here rather than in the parser because the parser applies
    // it to .xlsx only - a .csv needs no unpacking, so it hands its rows back
    // before that check and arrived with no bound at all. A 2 MB CSV is around
    // 70,000 accounts, and every one of them is a scrypt derivation on the
    // request: the import never finishes and nobody can log in while it runs.
    if (rows.length > MAX_IMPORT_ROWS) {
      throw errors.badRequest(
        `That file has more than ${MAX_IMPORT_ROWS.toLocaleString()} rows. Split it into smaller files.`
      );
    }

    if (rows.length === 0) {
      throw errors.badRequest("The spreadsheet contains no user rows");
    }

    const departments = await prisma.department.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
    });
    const departmentsByName = new Map(
      departments.map((department) => [department.name.trim().toLowerCase(), department])
    );

    /*
     * Asked once, not per row: whether a row may omit its password depends on
     * the deployment, not on the row. If Microsoft sign-in is not switched on,
     * an account with no password has no way in at all, and reporting it as
     * "created" would hand the administrator a list of people who cannot sign
     * in - discovered one confused phone call at a time.
     */
    const { enabled, configured } = await ssoSettingsService.get();
    const microsoftSignInAvailable = enabled && configured;

    const seenEmails = new Set<string>();
    const failed: BulkUserImportFailure[] = [];
    let created = 0;

    for (let index = 0; index < rows.length; index += 1) {
      const rowNumber = index + 2;
      const raw = rows[index];
      const normalized: Record<string, string> = {};

      for (const [key, value] of Object.entries(raw)) {
        normalized[normalizeHeader(key)] = value.trim();
      }

      const firstName = cell(normalized, "firstname");
      const lastName = cell(normalized, "lastname");
      const email = cell(normalized, "email");
      const password = cell(normalized, "password");
      const departmentName = cell(normalized, "department", "departmentname");
      const roleValue = cell(normalized, "role", "loginrole");
      // Not "title": a spreadsheet exported from HR often carries a salutation
      // under that heading, and Mr printed under a signature where Director
      // belongs is worse than nothing printed at all.
      const designation = cell(normalized, "designation", "jobtitle");

      if (
        !firstName &&
        !lastName &&
        !email &&
        !password &&
        !departmentName &&
        !roleValue &&
        !designation
      ) {
        continue;
      }

      try {
        // The length checks say which field is too long. Without them the row
        // reaches Postgres, which refuses it with an error this loop cannot
        // read, and the administrator is handed "Failed to create user" with
        // no way to tell that one cell is a few characters over.
        if (!firstName) {
          throw errors.badRequest("First name is required");
        }
        if (firstName.length > USER_NAME_MAX_LENGTH) {
          throw errors.badRequest(
            `First name must be ${USER_NAME_MAX_LENGTH} characters or fewer`
          );
        }
        if (!lastName) {
          throw errors.badRequest("Last name is required");
        }
        if (lastName.length > USER_NAME_MAX_LENGTH) {
          throw errors.badRequest(
            `Last name must be ${USER_NAME_MAX_LENGTH} characters or fewer`
          );
        }
        if (!email) {
          throw errors.badRequest("Email is required");
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw errors.badRequest("Enter a valid email address");
        }
        if (email.length > USER_EMAIL_MAX_LENGTH) {
          throw errors.badRequest(
            `Email must be ${USER_EMAIL_MAX_LENGTH} characters or fewer`
          );
        }
        if (!password && !microsoftSignInAvailable) {
          throw errors.badRequest(
            "Password is required, because signing in with a Microsoft work account is not switched on."
          );
        }
        const refused = password
          ? passwordProblem(password, { email, firstName, lastName })
          : null;
        if (refused) {
          throw errors.badRequest(refused);
        }
        // Length only, no presence check: a file listing people without their
        // titles is a normal import, and refusing it would make an optional
        // column mandatory the moment somebody added it to the template.
        if (designation.length > USER_DESIGNATION_MAX_LENGTH) {
          throw errors.badRequest(
            `Designation must be ${USER_DESIGNATION_MAX_LENGTH} characters or fewer`
          );
        }
        if (!departmentName) {
          throw errors.badRequest("Department is required");
        }
        if (!roleValue) {
          throw errors.badRequest("Role is required");
        }

        const emailKey = email.toLowerCase();
        if (seenEmails.has(emailKey)) {
          throw errors.conflict("A user with this email already exists in this file");
        }
        seenEmails.add(emailKey);

        const loginRole = parseLoginRole(roleValue);
        if (!loginRole) {
          throw errors.badRequest("Role must be USER or ADMINISTRATOR");
        }

        const department = departmentsByName.get(departmentName.toLowerCase());
        if (!department) {
          throw errors.badRequest(
            `Department "${departmentName}" was not found. Names must match an existing department.`
          );
        }

        await this.createUser({
          email,
          // Empty means "no password on this account" - it signs in with
          // Microsoft. `createUser` stores null rather than a hash of "".
          password: password || undefined,
          firstName,
          lastName,
          designation,
          departmentId: department.id,
          loginRole,
        }, actorId);
        created += 1;
      } catch (error) {
        failed.push({
          row: rowNumber,
          email: email || undefined,
          error: error instanceof AppError ? error.message : "Failed to create user",
        });
      }
    }

    if (created === 0 && failed.length === 0) {
      throw errors.badRequest("The spreadsheet contains no user rows");
    }

    return { created, failed };
  }

  async getUser(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        designation: true,
        lineManagerId: true,
        loginRole: true,
        isSuperAdmin: true,
        adminPowers: true,
        department: {
          select: {
            id: true,
            name: true,
          },
        },
        createdAt: true,
        updatedAt: true,
        deactivatedAt: true,
      },
    });

    if (!user) {
      throw errors.notFound("User not found");
    }

    return user;
  }

  /**
   * Would this edit set a password, move the address a password reset goes
   * to, or change what the person may do? The edit form sends every field
   * every time, so this compares with what is stored rather than asking
   * which fields are present.
   */
  async isSensitiveEdit(userId: string, input: UpdateAdminUserInput): Promise<boolean> {
    if (input.password) return true;

    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, loginRole: true },
    });
    if (!existing) return false;

    return (
      (input.email !== undefined && input.email.toLowerCase() !== existing.email.toLowerCase()) ||
      (input.loginRole !== undefined && input.loginRole !== existing.loginRole)
    );
  }

  async updateUser(
    userId: string,
    input: UpdateAdminUserInput,
    /** Who made the change, for the audit row when this ends their sessions. */
    actorId?: string
  ) {
    const existing = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!existing) {
      throw errors.notFound("User not found");
    }

    if (input.departmentId) {
      const department = await prisma.department.findUnique({
        where: { id: input.departmentId },
      });

      if (!department) {
        throw errors.badRequest("Department not found");
      }
    }

    if (input.email) {
      await assertEmailAvailable(input.email, userId);
    }

    await assertValidLineManager(input.lineManagerId, userId);

    const changesRole = input.loginRole !== undefined && input.loginRole !== existing.loginRole;

    if (existing.loginRole === "ADMINISTRATOR" || input.loginRole === "ADMINISTRATOR") {
      await assertMayManageAdministrators(
        actorId,
        existing.loginRole === "ADMINISTRATOR"
          ? "Only a Super Administrator can change an administrator's account."
          : "Only a Super Administrator can make somebody an administrator."
      );
    }

    if (changesRole && userId === actorId) {
      throw errors.badRequest("You cannot change your own role. Ask another Super Administrator.");
    }

    if (changesRole && existing.loginRole === "ADMINISTRATOR" && existing.isSuperAdmin) {
      await assertAnotherActiveSuperAdministrator(
        userId,
        "Cannot remove the last Super Administrator. Make somebody else one first."
      );
    }

    /*
     * Demoting the last administrator locks everybody out of user
     * administration with no way back except a database console, and it is
     * an easy accident, because changing a role reads like a small act.
     *
     * Checked only when the role is actually changing away from
     * ADMINISTRATOR, so saving an administrator's name or department does not
     * pay for a count.
     */
    if (
      input.loginRole === "USER" &&
      existing.loginRole === "ADMINISTRATOR"
    ) {
      await assertAnotherActiveAdministrator(
        userId,
        "Cannot remove the last administrator. Give somebody else the role first."
      );
    }

    if (input.password) {
      assertAcceptablePassword(input.password, {
        email: input.email ?? existing.email,
        firstName: input.firstName ?? existing.firstName,
        lastName: input.lastName ?? existing.lastName,
      });
    }

    const passwordHash = input.password
      ? await hashPassword(input.password)
      : undefined;

    try {
      const updated = await prisma.user.update({
        where: { id: userId },
        data: {
          ...(input.email ? { email: input.email.toLowerCase() } : {}),
          ...(passwordHash ? { passwordHash } : {}),
          ...(input.firstName ? { firstName: input.firstName } : {}),
          ...(input.lastName ? { lastName: input.lastName } : {}),
          // Tested for presence rather than for truth, unlike its neighbours:
          // "" is how the edit form says "this person has no title after all",
          // and a truthiness check would silently keep the old one on screen.
          ...(input.designation !== undefined
            ? { designation: toStoredDesignation(input.designation) }
            : {}),
          ...(input.departmentId ? { departmentId: input.departmentId } : {}),
          // Presence again: null is "nobody recorded".
          ...(input.lineManagerId !== undefined
            ? { lineManagerId: input.lineManagerId }
            : {}),
          ...(input.loginRole ? { loginRole: input.loginRole } : {}),
          // Becoming an administrator starts limited, with the default powers;
          // ceasing to be one takes every power away.
          ...(changesRole && input.loginRole === "ADMINISTRATOR"
            ? { isSuperAdmin: false, adminPowers: [...DEFAULT_ADMIN_POWERS] }
            : {}),
          ...(changesRole && input.loginRole === "USER"
            ? { isSuperAdmin: false, adminPowers: [] }
            : {}),
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          designation: true,
          lineManagerId: true,
          loginRole: true,
          department: {
            select: {
              id: true,
              name: true,
            },
          },
          createdAt: true,
          updatedAt: true,
        },
      });

      /*
       * A new password ends every session the old one opened.
       *
       * This is most of the point of being able to change one. Somebody whose
       * password was written on a note in a shared office changes it and
       * expects that to be the end of it - and without this the tokens issued
       * against the old password go on working for thirty days, which makes
       * the change a gesture. The same applies to a demotion: an account that
       * has just stopped being an administrator must not keep an
       * administrator's open session.
       */
      if (passwordHash || input.loginRole) {
        await sessionsService.endAll(userId, { actorId });
      }

      /*
       * What changed, named - and the password never carried, only the fact
       * that there is a new one. The trail is exported; a credential must not
       * leave in it. `mailSettings` records `hasPassword` for the same reason.
       */
      const changed = {
        ...(input.email && input.email.toLowerCase() !== existing.email
          ? { email: true }
          : {}),
        ...(passwordHash ? { password: true } : {}),
        ...(input.loginRole && input.loginRole !== existing.loginRole
          ? { loginRole: true }
          : {}),
      };

      await auditService.createAuditLog({
        actorId,
        action: "USER_UPDATED",
        entityType: "User",
        entityId: userId,
        oldValue: {
          email: existing.email,
          loginRole: existing.loginRole,
          hasPassword: Boolean(existing.passwordHash),
        },
        newValue: {
          email: updated.email,
          loginRole: updated.loginRole,
          hasPassword: Boolean(passwordHash) || Boolean(existing.passwordHash),
          changed: Object.keys(changed),
        },
      });

      /*
       * Tell the person, but only about the three things that change how
       * their account is reached: its password, its address, and what it is
       * allowed to do. A corrected job title is not a security event, and a
       * notice for every edit is how the ones that matter get ignored.
       *
       * Never to somebody about their own action - an administrator changing
       * their own password already knows.
       */
      if (Object.keys(changed).length > 0 && userId !== actorId) {
        const what = [
          changed.password ? "password" : null,
          changed.email ? "email address" : null,
          changed.loginRole ? `role, which is now ${updated.loginRole}` : null,
        ].filter(Boolean) as string[];

        await this.tellTheAccountHolder(
          userId,
          "An administrator changed your account",
          `An administrator changed your ${what.join(", ")} on Ideas Flow.` +
            (changed.password || changed.loginRole
              ? " Every device signed in as you has been signed out."
              : "") +
            " If you did not ask for this, raise it now."
        );
      }

      return updated;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw errors.conflict("A user with this email already exists");
      }
      throw error;
    }
  }

  /**
   * Tell somebody their account was administered.
   *
   * Never allowed to fail the change it describes: the account is already
   * altered, and refusing here would report a failure for something that
   * fully happened. Logged and carried on; the trail still holds the event.
   */
  private async tellTheAccountHolder(
    userId: string,
    title: string,
    message: string
  ) {
    try {
      await notificationsService.createNotification({
        recipientId: userId,
        type: "SECURITY_ALERT",
        title,
        message,
      });
    } catch (error) {
      logger.error("security.notice.failed", {
        userId,
        title,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  /**
   * Switch an account off, or back on.
   *
   * What the product had for somebody leaving was deletion, and deletion is
   * refused the moment a person has prepared, approved or commented on
   * anything - which is everybody worth removing. So a person who left kept a
   * working password, and there was nothing an administrator could do about
   * it inside the application. That is the hole this closes, and it is a
   * security hole rather than an inconvenience: the account of somebody who
   * has gone is the account nobody is watching.
   *
   * It stops sign-in and it ends every session they hold, including the
   * access token in a browser that is still open - `endAll` moves
   * `sessionsValidFrom`, which is the only thing that reaches one.
   *
   * It changes nothing that has happened. Their signatures stand and their
   * name stays on every memo they approved.
   *
   * What was still to come moves, in the same act (agreed after the fit-gap
   * review: a leaver must not leave memos blocked). Whoever still has steps
   * on open memos has to be given a successor, and every one of those steps
   * goes to them, with their delegations ended - `leaverHandoverService`.
   * Before the account goes off, so a refused handover leaves it on and
   * nothing half-done.
   */
  /**
   * Refuses anything done to an administrator's account unless a Super
   * Administrator does it. For routes that act on an account without going
   * through the edit form: resetting a second factor, signing somebody out.
   */
  async assertMayActOnAccount(actorId: string, targetId: string) {
    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { loginRole: true },
    });
    if (target?.loginRole === "ADMINISTRATOR") {
      await assertMayManageAdministrators(
        actorId,
        "Only a Super Administrator can do this to an administrator's account."
      );
    }
  }

  /**
   * Make an administrator a Super Administrator or a limited one, and choose
   * the limited one's powers. Super Administrators only (the route needs
   * `admins.manage`, which is never given to anybody else).
   *
   * Never one's own: nobody changes what they themselves may do. Only powers
   * a Super Administrator may give (`GRANTABLE_POWERS`, or the seeing half of
   * one, `<power>:view`) are accepted, so the Super-Administrator-only ones
   * cannot be handed out by name. Recorded, with what it was before.
   *
   * There is one Super Administrator at a time, so this never makes another:
   * the role is handed over with `transferSuperAdmin`. It can still make an
   * extra one limited - an install upgraded from when every administrator
   * was a Super Administrator has several until somebody does.
   */
  async setAdminPowers(
    userId: string,
    input: { isSuperAdmin: boolean; powers: string[] },
    actorId: string,
    ipAddress?: string
  ) {
    if (userId === actorId) {
      throw errors.badRequest("You cannot change your own powers. Ask another Super Administrator.");
    }

    await assertMayManageAdministrators(actorId, "This needs a Super Administrator.");

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        loginRole: true,
        isSuperAdmin: true,
        adminPowers: true,
        deactivatedAt: true,
      },
    });

    if (!user) {
      throw errors.notFound("User not found");
    }

    if (user.loginRole !== "ADMINISTRATOR") {
      throw errors.badRequest(
        `${user.firstName} is not an administrator. Change their role first.`
      );
    }

    if (input.isSuperAdmin && !user.isSuperAdmin) {
      throw errors.badRequest(
        "There is one Super Administrator at a time. Hand the role over with Transfer instead."
      );
    }

    const unknown = input.powers.filter((power) => !isGrantablePower(power));
    if (unknown.length > 0) {
      throw errors.badRequest(
        `These cannot be given to an administrator: ${unknown.join(", ")}. Some powers are a Super Administrator's alone.`
      );
    }

    if (user.isSuperAdmin && !input.isSuperAdmin) {
      await assertAnotherActiveSuperAdministrator(
        userId,
        "Cannot remove the last Super Administrator. Make somebody else one first."
      );
    }

    // Changing an area includes seeing it, so a view beside the full power
    // is dropped rather than stored twice.
    const given = new Set(input.powers);
    const powers = input.isSuperAdmin
      ? []
      : [...given]
          .filter((power) => !VIEWABLE_POWERS.some((id) => power === viewPower(id) && given.has(id)))
          .sort();

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { isSuperAdmin: input.isSuperAdmin, adminPowers: powers },
      select: { id: true, isSuperAdmin: true, adminPowers: true },
    });

    await auditService.createAuditLog({
      actorId,
      action: "ADMIN_POWERS_CHANGED",
      entityType: "User",
      entityId: userId,
      oldValue: { isSuperAdmin: user.isSuperAdmin, adminPowers: user.adminPowers },
      newValue: { isSuperAdmin: updated.isSuperAdmin, adminPowers: updated.adminPowers },
      ipAddress,
    });

    // What they could do a moment ago may be more than they can now, and a
    // token in an open tab still carries the old answer to nothing - powers
    // are read on every request - so nothing more is needed to make it take
    // effect at once.
    return updated;
  }

  /**
   * Hand the Super Administrator role to somebody else.
   *
   * There is one at a time. The new one holds every power; the one handing
   * it over stays an administrator with every power a Super Administrator
   * can give - they keep doing their job - but no longer manages
   * administrators, sign-on or mail. Any other Super Administrator left over
   * from before there was one at a time is made the same, so this is also
   * how an install gets down to one.
   *
   * The new one must be an active account; somebody who is Staff becomes an
   * administrator. All in one transaction, so there is never a moment with
   * none. Asked for by the current Super Administrator only, confirmed like
   * every change made in somebody's name, and recorded.
   *
   * With no actor it is the server recovery script (`npm run admin:recover`),
   * run by whoever controls the server when the Super Administrator cannot
   * act - and recorded as exactly that.
   */
  async transferSuperAdmin(
    targetId: string,
    actorId: string | undefined,
    ipAddress?: string,
    via?: string
  ) {
    if (targetId === actorId) {
      throw errors.badRequest("You are already the Super Administrator.");
    }

    await assertMayManageAdministrators(actorId, "This needs the Super Administrator.");

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        loginRole: true,
        isSuperAdmin: true,
        adminPowers: true,
        deactivatedAt: true,
      },
    });

    if (!target) {
      throw errors.notFound("User not found");
    }
    if (target.deactivatedAt) {
      throw errors.badRequest(
        `${target.firstName}'s account is switched off. Switch it back on first.`
      );
    }

    const handedOn = [...GRANTABLE_POWERS].sort();

    const formerIds = await prisma.$transaction(async (tx) => {
      const former = await tx.user.findMany({
        where: { isSuperAdmin: true, id: { not: targetId } },
        select: { id: true },
      });
      await tx.user.updateMany({
        where: { id: { in: former.map((user) => user.id) } },
        data: { isSuperAdmin: false, adminPowers: handedOn },
      });
      await tx.user.update({
        where: { id: targetId },
        data: { loginRole: "ADMINISTRATOR", isSuperAdmin: true, adminPowers: [] },
      });
      return former.map((user) => user.id);
    });

    await auditService.createAuditLog({
      actorId,
      action: "SUPER_ADMIN_TRANSFERRED",
      entityType: "User",
      entityId: targetId,
      oldValue: {
        loginRole: target.loginRole,
        isSuperAdmin: target.isSuperAdmin,
        adminPowers: target.adminPowers,
        superAdministrators: formerIds,
      },
      newValue: {
        loginRole: "ADMINISTRATOR",
        isSuperAdmin: true,
        formerKeep: handedOn,
        ...(via ? { via } : {}),
      },
      ipAddress,
    });

    return {
      superAdministrator: { id: target.id, firstName: target.firstName, lastName: target.lastName },
      madeLimited: formerIds,
    };
  }

  async setUserActive(
    userId: string,
    active: boolean,
    actorId: string,
    ipAddress?: string,
    /** Who takes over their approvals. Required while they still have any. */
    successorId?: string
  ) {
    if (userId === actorId && !active) {
      throw errors.badRequest("You cannot switch off your own account.");
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        loginRole: true,
        isSuperAdmin: true,
        deactivatedAt: true,
      },
    });

    if (!user) {
      throw errors.notFound("User not found");
    }

    const alreadyOff = user.deactivatedAt !== null;

    if (alreadyOff === !active) {
      throw errors.conflict(
        active
          ? `${user.firstName}'s account is already in use.`
          : `${user.firstName}'s account is already switched off.`
      );
    }

    /*
     * The same door `updateUser` locks. Switching off the last administrator
     * locks everybody out of user administration with no way back except a
     * database console - and this is the likelier of the two to be done by
     * accident, because it reads as the reversible one.
     *
     * Counted among accounts still IN USE, not among all administrators: two
     * administrators, one of them already switched off, is one administrator.
     */
    if (user.loginRole === "ADMINISTRATOR") {
      await assertMayManageAdministrators(
        actorId,
        "Only a Super Administrator can switch an administrator's account off or on."
      );
    }

    if (!active && user.loginRole === "ADMINISTRATOR" && user.isSuperAdmin) {
      await assertAnotherActiveSuperAdministrator(
        userId,
        "Cannot switch off the last Super Administrator. Make somebody else one first."
      );
    }

    if (!active && user.loginRole === "ADMINISTRATOR") {
      await assertAnotherActiveAdministrator(
        userId,
        "Cannot switch off the last administrator. Give somebody else the role first."
      );
    }

    let handover: { successorId: string; stepsMoved: number; delegationsEnded: number } | null =
      null;

    if (!active) {
      const work = await leaverHandoverService.openWork(userId);
      const steps = work.inFlight.length + work.nextCycle.length;

      if (steps > 0 && !successorId) {
        throw errors.badRequest(
          `${user.firstName} is still an approver on ${steps} open ${steps === 1 ? "memo" : "memos"}. Choose who takes over their approvals.`,
          "SUCCESSOR_REQUIRED"
        );
      }

      if (successorId) {
        const successor = await leaverHandoverService.assertSuccessor(
          userId,
          successorId,
          actorId,
          work
        );
        const leaver = await prisma.user.findUniqueOrThrow({
          where: { id: userId },
          select: { id: true, firstName: true, lastName: true },
        });
        const moved = await leaverHandoverService.handOver(
          leaver,
          successor,
          actorId,
          work,
          ipAddress
        );
        handover = { successorId: successor.id, ...moved };
      } else {
        // No steps to move, but cover in either direction still ends.
        await leaverHandoverService.endDelegations(work.delegationIds, actorId, ipAddress);
      }
    }

    const deactivatedAt = active ? null : new Date();

    await prisma.user.update({
      where: { id: userId },
      data: { deactivatedAt },
    });

    /*
     * Every session they hold, and the access token in any browser still
     * open. Without this, switching an account off stops the next sign-in and
     * nothing else: whoever is already signed in stays signed in for as long
     * as the tab lives.
     *
     * After the column, not before: a session ended against an account that
     * then failed to switch off would sign somebody out for nothing.
     */
    if (!active) {
      await sessionsService.endAll(userId, { actorId });
    }

    await auditService.createAuditLog({
      actorId,
      action: active ? "USER_REACTIVATED" : "USER_DEACTIVATED",
      entityType: "User",
      entityId: userId,
      oldValue: { email: user.email, deactivatedAt: user.deactivatedAt },
      newValue: { email: user.email, deactivatedAt, ...(handover ?? {}) },
      ipAddress,
    });

    const handedOver =
      handover && handover.stepsMoved > 0
        ? ` ${handover.stepsMoved} approval ${handover.stepsMoved === 1 ? "step was" : "steps were"} handed to their successor.`
        : "";

    return {
      id: user.id,
      email: user.email,
      deactivatedAt,
      message: active
        ? `${user.firstName}'s account is back in use.`
        : `${user.firstName}'s account is switched off and every session they held has ended.${handedOver}`,
    };
  }

  /*
   * There is no deleteUser, deliberately. A person is switched off with
   * `setUserActive`, which ends their sessions and keeps their row.
   *
   * Deleting a row broke the audit ledger. Every audit record carries the
   * actor's id inside its sealed digest, and the foreign key from audit_logs
   * clears that id when the user goes - so removing anybody who had ever
   * acted (uploaded a signature, turned on two-step sign-in, opened a memo)
   * rewrote sealed records and `ledgerService.verify()` then failed. The old
   * guard counted memos, approvals and comments, not audit rows, so it let
   * exactly those deletions through. Nothing a deletion offered is not
   * offered by switching off: the person cannot sign in, holds no sessions,
   * and drops out of every picker, while everything they did still names
   * them.
   */
}

/**
 * A line manager must be somebody else, still in use. Told when a memo has
 * waited on this person two working days past its deadline, so a switched-off
 * account or the person themselves would mean nobody is told.
 */
async function assertValidLineManager(
  lineManagerId: string | null | undefined,
  userId?: string
): Promise<void> {
  if (!lineManagerId) return;
  if (lineManagerId === userId) {
    throw errors.badRequest("A person cannot be their own line manager.");
  }
  const manager = await prisma.user.findUnique({
    where: { id: lineManagerId },
    select: { deactivatedAt: true },
  });
  if (!manager || manager.deactivatedAt) {
    throw errors.badRequest("That line manager is not a person in use here. Choose another.");
  }
}

export const adminService = new AdminService();
