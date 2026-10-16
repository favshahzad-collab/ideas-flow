import { beforeEach, describe, expect, it } from "vitest";
import { LoginRole } from "../generated/prisma/client";
import {
  DEFAULT_ADMIN_POWERS,
  GRANTABLE_POWERS,
  capabilitiesOf,
  viewOnlyOf,
} from "../lib/capabilities";
import { prisma } from "../prisma";
import { makeDepartment, makeUser, useCleanDatabase } from "../test/db";
import { adminService } from "./admin.service";

/**
 * Two tiers of administrator, agreed after the fit-gap review.
 *
 * A Super Administrator holds every power and alone manages administrators.
 * Any other administrator holds only what a Super Administrator gave them.
 * The route guard is tested against every route in routes.itest.ts; this is
 * the account side: who may make, change and remove administrators, and the
 * safeguards around it.
 */

useCleanDatabase();

let departmentId: string;
let superAdmin: Awaited<ReturnType<typeof makeUser>>;
let limited: Awaited<ReturnType<typeof makeUser>>;
let colleague: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  departmentId = (await makeDepartment()).id;
  superAdmin = await makeUser({ firstName: "Sana", departmentId, loginRole: LoginRole.ADMINISTRATOR });
  limited = await makeUser({
    firstName: "Lina",
    departmentId,
    loginRole: LoginRole.ADMINISTRATOR,
    superAdmin: false,
    adminPowers: ["users.manage"],
  });
  colleague = await makeUser({ firstName: "Omar", departmentId });
});

const accountOf = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });

describe("what each tier holds", () => {
  it("gives a Super Administrator every power, and a limited one only what was given", async () => {
    const all = capabilitiesOf(await accountOf(superAdmin.id));
    const some = capabilitiesOf(await accountOf(limited.id));

    expect(all).toContain("admins.manage");
    expect(all).toContain("sso.configure");
    expect(some).toContain("users.manage");
    expect(some).not.toContain("workflows.policy");
  });

  it("never gives a limited administrator a Super Administrator's power, whatever the column says", async () => {
    await prisma.user.update({
      where: { id: limited.id },
      data: { adminPowers: ["admins.manage", "sso.configure", "mail.configure"] },
    });

    const held = capabilitiesOf(await accountOf(limited.id));
    expect(held).not.toContain("admins.manage");
    expect(held).not.toContain("sso.configure");
    expect(held).not.toContain("mail.configure");
  });
});

describe("making somebody an administrator", () => {
  it("is a Super Administrator's to do, and starts them limited, with the default powers", async () => {
    await adminService.updateUser(colleague.id, { loginRole: "ADMINISTRATOR" }, superAdmin.id);

    const promoted = await accountOf(colleague.id);
    expect(promoted.loginRole).toBe("ADMINISTRATOR");
    expect(promoted.isSuperAdmin).toBe(false);
    expect(promoted.adminPowers).toEqual([...DEFAULT_ADMIN_POWERS]);
  });

  it("is refused to a limited administrator, even one who manages people", async () => {
    await expect(
      adminService.updateUser(colleague.id, { loginRole: "ADMINISTRATOR" }, limited.id)
    ).rejects.toMatchObject({ code: "POWER_REQUIRED" });

    await expect(
      adminService.createUser(
        {
          firstName: "New",
          lastName: "Admin",
          email: "new.admin@example.com",
          password: "a long enough passphrase 2026",
          departmentId,
          loginRole: "ADMINISTRATOR",
        },
        limited.id
      )
    ).rejects.toMatchObject({ code: "POWER_REQUIRED" });
  });
});

describe("an administrator's account", () => {
  it("cannot be changed, switched off or reset by a limited administrator", async () => {
    // Otherwise a password reset would let them sign in as the Super
    // Administrator and take every power.
    await expect(
      adminService.updateUser(superAdmin.id, { password: "another long passphrase 2026" }, limited.id)
    ).rejects.toMatchObject({ code: "POWER_REQUIRED" });
    await expect(adminService.setUserActive(superAdmin.id, false, limited.id)).rejects.toMatchObject({
      code: "POWER_REQUIRED",
    });
    await expect(adminService.assertMayActOnAccount(limited.id, superAdmin.id)).rejects.toMatchObject({
      code: "POWER_REQUIRED",
    });
  });

  it("still lets a limited administrator who manages people look after ordinary accounts", async () => {
    await expect(
      adminService.updateUser(colleague.id, { firstName: "Omer" }, limited.id)
    ).resolves.toBeTruthy();
    await expect(adminService.assertMayActOnAccount(limited.id, colleague.id)).resolves.toBeUndefined();
  });
});

describe("setting powers", () => {
  it("gives and takes powers, recorded with what they were", async () => {
    await adminService.setAdminPowers(
      limited.id,
      { isSuperAdmin: false, powers: ["workflows.policy", "users.manage"] },
      superAdmin.id
    );

    const after = await accountOf(limited.id);
    expect(after.adminPowers).toEqual(["users.manage", "workflows.policy"]);

    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: "ADMIN_POWERS_CHANGED" } });
    expect(row.oldValue).toMatchObject({ adminPowers: ["users.manage"] });
    expect(row.newValue).toMatchObject({ adminPowers: ["users.manage", "workflows.policy"] });
  });

  it("refuses a Super Administrator's own powers by name", async () => {
    await expect(
      adminService.setAdminPowers(limited.id, { isSuperAdmin: false, powers: ["admins.manage"] }, superAdmin.id)
    ).rejects.toThrow(/cannot be given to an administrator/);
  });

  it("is refused to anybody who is not a Super Administrator", async () => {
    const other = await makeUser({ departmentId, loginRole: LoginRole.ADMINISTRATOR, superAdmin: false });

    await expect(
      adminService.setAdminPowers(other.id, { isSuperAdmin: true, powers: [] }, limited.id)
    ).rejects.toMatchObject({ code: "POWER_REQUIRED" });
  });

  it("never lets anybody change their own powers", async () => {
    await expect(
      adminService.setAdminPowers(superAdmin.id, { isSuperAdmin: false, powers: [] }, superAdmin.id)
    ).rejects.toThrow(/cannot change your own powers/);
  });

  it("never makes a second Super Administrator - the role is transferred instead", async () => {
    await expect(
      adminService.setAdminPowers(limited.id, { isSuperAdmin: true, powers: [] }, superAdmin.id)
    ).rejects.toThrow(/one Super Administrator at a time/);
    expect((await accountOf(limited.id)).isSuperAdmin).toBe(false);
  });

  it("can make a Super Administrator left over from before limited", async () => {
    await prisma.user.update({ where: { id: limited.id }, data: { isSuperAdmin: true } });

    await adminService.setAdminPowers(
      limited.id,
      { isSuperAdmin: false, powers: ["departments.manage"] },
      superAdmin.id
    );

    const after = await accountOf(limited.id);
    expect(after.isSuperAdmin).toBe(false);
    expect(after.adminPowers).toEqual(["departments.manage"]);
  });
});

describe("seeing an area without changing it", () => {
  it("gives the seeing half alone, and drops it when the whole power is given", async () => {
    await adminService.setAdminPowers(
      limited.id,
      { isSuperAdmin: false, powers: ["users.manage:view", "departments.manage:view", "departments.manage"] },
      superAdmin.id
    );

    const after = await accountOf(limited.id);
    expect(after.adminPowers).toEqual(["departments.manage", "users.manage:view"]);
    expect(capabilitiesOf(after)).not.toContain("users.manage");
    expect(viewOnlyOf(after)).toEqual(["users.manage"]);
  });

  it("is only offered for an area that has something to see and something to change", async () => {
    // The oversight queue is only reading; re-verifying the chain is only an
    // action; exporting the ledger is a read that hands over everything.
    for (const power of ["approvals.oversee:view", "audit.verify:view", "audit.export:view", "admins.manage:view"]) {
      await expect(
        adminService.setAdminPowers(limited.id, { isSuperAdmin: false, powers: [power] }, superAdmin.id)
      ).rejects.toThrow(/cannot be given/);
    }
  });
});

describe("handing the Super Administrator role over", () => {
  it("makes the new one the only Super Administrator, and leaves the old one every power that can be given", async () => {
    const result = await adminService.transferSuperAdmin(limited.id, superAdmin.id);

    const incoming = await accountOf(limited.id);
    const outgoing = await accountOf(superAdmin.id);
    expect(incoming.isSuperAdmin).toBe(true);
    expect(incoming.adminPowers).toEqual([]);
    expect(outgoing.isSuperAdmin).toBe(false);
    expect(outgoing.loginRole).toBe("ADMINISTRATOR");
    expect(outgoing.adminPowers).toEqual([...GRANTABLE_POWERS].sort());
    expect(capabilitiesOf(outgoing)).not.toContain("admins.manage");
    expect(result.madeLimited).toEqual([superAdmin.id]);

    expect(await prisma.user.count({ where: { isSuperAdmin: true } })).toBe(1);
    const entry = await prisma.auditLog.findFirst({
      where: { action: "SUPER_ADMIN_TRANSFERRED", entityId: limited.id },
    });
    expect(entry?.actorId).toBe(superAdmin.id);
  });

  it("can go to somebody who is Staff, who becomes an administrator", async () => {
    await adminService.transferSuperAdmin(colleague.id, superAdmin.id);

    const incoming = await accountOf(colleague.id);
    expect(incoming.loginRole).toBe("ADMINISTRATOR");
    expect(incoming.isSuperAdmin).toBe(true);
  });

  it("brings an install with several down to one", async () => {
    const extra = await makeUser({ firstName: "Xena", departmentId, loginRole: LoginRole.ADMINISTRATOR });

    await adminService.transferSuperAdmin(colleague.id, superAdmin.id);

    expect((await accountOf(extra.id)).isSuperAdmin).toBe(false);
    expect(await prisma.user.count({ where: { isSuperAdmin: true } })).toBe(1);
  });

  it("can be done by the server itself when the Super Administrator cannot act, and says so", async () => {
    // The recovery script: no actor, because nobody signed in did it.
    await adminService.transferSuperAdmin(colleague.id, undefined, undefined, "server recovery script");

    expect((await accountOf(colleague.id)).isSuperAdmin).toBe(true);
    expect((await accountOf(superAdmin.id)).isSuperAdmin).toBe(false);
    const entry = await prisma.auditLog.findFirst({
      where: { action: "SUPER_ADMIN_TRANSFERRED", entityId: colleague.id },
    });
    expect(entry?.actorId).toBeNull();
    expect(entry?.newValue).toMatchObject({ via: "server recovery script" });
  });

  it("is refused to anybody but a Super Administrator, to oneself, and to a switched-off account", async () => {
    await expect(adminService.transferSuperAdmin(colleague.id, limited.id)).rejects.toMatchObject({
      code: "POWER_REQUIRED",
    });
    await expect(adminService.transferSuperAdmin(superAdmin.id, superAdmin.id)).rejects.toThrow(
      /already the Super Administrator/
    );

    await prisma.user.update({ where: { id: colleague.id }, data: { deactivatedAt: new Date() } });
    await expect(adminService.transferSuperAdmin(colleague.id, superAdmin.id)).rejects.toThrow(
      /switched off/
    );
    expect((await accountOf(superAdmin.id)).isSuperAdmin).toBe(true);
  });
});

describe("there is always a Super Administrator", () => {
  /*
   * Between two people the rule is already kept - a Super Administrator acting
   * on another leaves themselves, and nobody may act on their own account. It
   * is the safeguard for everything else that can change an account: a script,
   * an import, a future screen.
   */
  it("refuses to demote the only one", async () => {
    await expect(
      adminService.updateUser(superAdmin.id, { loginRole: "USER" })
    ).rejects.toThrow(/last Super Administrator/);
    expect((await accountOf(superAdmin.id)).isSuperAdmin).toBe(true);
  });

  it("lets nobody but a Super Administrator switch one off", async () => {
    await expect(adminService.setUserActive(superAdmin.id, false, colleague.id)).rejects.toMatchObject({
      code: "POWER_REQUIRED",
    });
  });
});
