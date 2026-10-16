import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  makeDepartment,
  makeUser,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { adminService } from "./admin.service";
import { auditService } from "./audit.service";
import { delegationsService } from "./delegations.service";

/**
 * The administration trail, against a real database.
 *
 * Every row this reads was already being written and sealed into the ledger,
 * and none of it could be read anywhere: the document trail filters to
 * `entityType: "Document"`, and the ledger endpoint answers with counts and a
 * digest. So "who made this account", "who changed that role", "who saved the
 * mail credentials" all had answers that existed and were reachable only from
 * a database console.
 *
 * What these hold is the two halves of being useful: that nothing
 * administrative is missing from it, and that nothing it prints was written
 * to be kept out of sight.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;
let admin: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  cast = await makeCast();
  admin = await makeUser({
    firstName: "Admin",
    departmentId: cast.department.id,
    loginRole: "ADMINISTRATOR",
  });
});

const activity = (options?: Parameters<typeof auditService.getAdministrationActivity>[0]) =>
  auditService.getAdministrationActivity(options);

const rowsFor = async (action: string) => {
  const { entries } = await activity({ limit: 200 });
  return entries.filter((entry) => entry.action === action);
};

const makeAccount = (email: string, loginRole: "USER" | "ADMINISTRATOR" = "USER") =>
  adminService.createUser(
    {
      firstName: "New",
      lastName: "Person",
      email,
      password: "correct horse battery",
      departmentId: cast.department.id,
      loginRole,
    },
    admin.id,
  );

describe("what reaches it", () => {
  it("an account being created, with who made it", async () => {
    await makeAccount("created@example.com");

    const [row] = await rowsFor("USER_CREATED");

    expect(row?.actor?.id).toBe(admin.id);
    expect(row?.area).toBe("People");
    expect(row?.subject).toBe("created@example.com");
  });

  it("a department being created, with who made it", async () => {
    /*
     * The actor is asserted here and not only on the account rows because
     * `createDepartment` used to take it INSIDE its input while every
     * neighbour took it as a second argument - so passing it the way the
     * neighbours are passed it put the actor where nothing was reading it,
     * and the row read "No longer a user". That is what happened while this
     * test checked only the area and the name.
     *
     * The signature matches its neighbours now, which turns the same mistake
     * into a compile error rather than a screen somebody has to notice. The
     * assertion stays because it is what caught it.
     */
    await adminService.createDepartment({ name: "Legal Affairs" }, admin.id);

    const [row] = await rowsFor("DEPARTMENT_CREATED");

    expect(row?.actor?.id).toBe(admin.id);
    expect(row?.area).toBe("Departments");
    expect(row?.subject).toBe("Legal Affairs");
  });

  it("somebody's approvals being handed over", async () => {
    await delegationsService.create(
      { delegateId: cast.bystander.id },
      { id: cast.reviewer.id, isAdministrator: false },
    );

    const [row] = await rowsFor("DELEGATION_CREATED");

    expect(row?.area).toBe("Delegations");
  });

  it("but never a memo, which has a trail of its own", async () => {
    // The whole reason this screen exists is that these two sets never met:
    // the memo rows were readable and these were not. Mixing them now would
    // bury one in the other - a week of approvals against one role change.
    await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });

    const { entries } = await activity({ limit: 200 });

    expect(entries.every((entry) => entry.entityType !== "Document")).toBe(true);
    expect(entries.map((entry) => entry.action)).not.toContain("DOCUMENT_SUBMITTED");
  });
});

describe("what each row says", () => {
  it("names the field that changed, and what it changed from", async () => {
    // A role change is the one an administrator is most often asked about
    // afterwards, and "loginRole changed" without the two values is half an
    // answer.
    const person = await makeAccount("promoted@example.com");

    await adminService.updateUser(
      person.id,
      { loginRole: "ADMINISTRATOR" },
      admin.id,
    );
    const [row] = await rowsFor("USER_UPDATED");

    expect(row?.changes).toContainEqual({
      field: "loginRole",
      from: "USER",
      to: "ADMINISTRATOR",
    });
  });

  it("reports only the fields the request touched, where the row says which", async () => {
    /*
     * `updateUser` writes a `changed` list of its own alongside the values,
     * and that list is better than a diff: it knows the difference between a
     * field the request set and one that merely reads the same on both sides.
     *
     * The list is also bookkeeping ABOUT the row, so it must not be reported
     * as a field of the person. Printed as one, it read "changed changed" on
     * the screen, beside the role change it was describing.
     */
    const person = await makeAccount("touched@example.com");

    await adminService.updateUser(
      person.id,
      { loginRole: "ADMINISTRATOR" },
      admin.id,
    );
    const [row] = await rowsFor("USER_UPDATED");

    expect(row?.changes.map((change) => change.field)).toEqual(["loginRole"]);
  });

  it("leaves a field's values out when they are not ours to print", async () => {
    /*
     * The second fence. The settings rows are already shaped to keep secrets
     * out of the trail - "whether, never what" - and this makes sure a key
     * nobody has thought about cannot reach a screen simply by being added to
     * an audit payload later. It is still reported as having changed; only
     * its contents are withheld.
     */
    await prisma.auditLog.create({
      data: {
        actorId: admin.id,
        action: "MAIL_SETTINGS_UPDATED",
        entityType: "MailSetting",
        entityId: "11111111-1111-4111-8111-111111111111",
        oldValue: { provider: "smtp", somethingNobodyVetted: "old secret" },
        newValue: { provider: "graph", somethingNobodyVetted: "new secret" },
      },
    });

    const [row] = await rowsFor("MAIL_SETTINGS_UPDATED");

    expect(row?.changes).toContainEqual({
      field: "provider",
      from: "smtp",
      to: "graph",
    });
    expect(row?.changes).toContainEqual({
      field: "somethingNobodyVetted",
      from: null,
      to: null,
    });
    expect(JSON.stringify(row)).not.toContain("secret");
  });

  it("prints a number or a flag, which cannot be a credential", async () => {
    /*
     * The allowlist guards STRINGS, which is where a secret could hide. A
     * count or a switch carries no such risk, and withholding them turned
     * useful rows into noise: a template creation read "edgeCount changed ·
     * nodeCount changed", which is five words to say nothing.
     */
    await prisma.auditLog.create({
      data: {
        actorId: admin.id,
        action: "WORKFLOW_TEMPLATE_CREATED",
        entityType: "WorkflowTemplate",
        entityId: "22222222-2222-4222-8222-222222222222",
        newValue: { name: "Leave request", nodeCount: 4, isActive: true },
      },
    });

    const [row] = await rowsFor("WORKFLOW_TEMPLATE_CREATED");

    expect(row?.changes).toContainEqual({ field: "nodeCount", from: null, to: "4" });
    expect(row?.changes).toContainEqual({ field: "isActive", from: null, to: "true" });
  });

  it("reports a creation as arrivals rather than changes from nothing", async () => {
    await adminService.createDepartment({ name: "Estates" }, admin.id);

    const [row] = await rowsFor("DEPARTMENT_CREATED");
    const name = row?.changes.find((change) => change.field === "name");

    expect(name?.from).toBeNull();
    expect(name?.to).toBe("Estates");
  });
});

describe("finding one row among many", () => {
  it("narrows to an area", async () => {
    await makeAccount("person@example.com");
    await adminService.createDepartment({ name: "Estates" }, admin.id);

    const { entries } = await activity({ area: "Departments", limit: 200 });

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.area === "Departments")).toBe(true);
  });

  it("narrows to nothing for an area nobody recognises", async () => {
    // Not to everything, which is the wrong way round for a screen somebody
    // is using to look for one particular change.
    await makeAccount("person@example.com");

    expect((await activity({ area: "Nonsense" })).total).toBe(0);
  });

  it("offers the areas it knows, so a filter can be drawn from the answer", async () => {
    expect((await activity()).areas).toEqual(
      expect.arrayContaining(["People", "Departments", "Workflows"]),
    );
  });

  it("counts everything that matched, not everything it returned", async () => {
    // A screen showing 2 of 9 rows cannot tell whether it is looking at a
    // page or at everything there is.
    await makeDepartment();
    for (const name of ["A", "B", "C"]) {
      await adminService.createDepartment({ name: `Dept ${name}` }, admin.id);
    }

    const page = await activity({ limit: 2 });

    expect(page.returned).toBe(2);
    expect(page.total).toBeGreaterThan(2);
  });

  it("pages without repeating or dropping a row written in the same instant", async () => {
    /*
     * `createdAt` is the transaction's start time, identical to the
     * microsecond for rows written together, so ordering on it alone leaves
     * ties - and a page boundary landing on a tie repeats one row and loses
     * another. `writeSeq` settles them.
     */
    for (const name of ["A", "B", "C", "D", "E", "F"]) {
      await adminService.createDepartment({ name: `Dept ${name}` }, admin.id);
    }

    const first = await activity({ limit: 3, offset: 0 });
    const second = await activity({ limit: 3, offset: 3 });
    const ids = [...first.entries, ...second.entries].map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is newest first, because that is what somebody opens it for", async () => {
    await adminService.createDepartment({ name: "First" }, admin.id);
    await adminService.createDepartment({ name: "Second" }, admin.id);

    const { entries } = await activity({ limit: 200 });
    const departments = entries.filter((entry) => entry.area === "Departments");

    expect(departments[0]?.subject).toBe("Second");
  });
});
