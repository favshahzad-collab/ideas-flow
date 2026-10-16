import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  makeUser,
  missingId,
  resubmitDocument,
  signature,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { adminService } from "./admin.service";
import { auditService } from "./audit.service";
import { approvalService } from "./approval.service";
import { authService } from "./auth.service";
import { delegationsService } from "./delegations.service";
import { documentsService } from "./documents.service";
import { usersService } from "./users.service";
import { workflowService } from "./workflow.service";

/**
 * Switching an account off when somebody leaves.
 *
 * The hole this closed is a security one rather than an inconvenience. The
 * old delete refused the moment a person had prepared, approved or commented
 * on anything - which is everybody worth removing - so a person who left kept
 * a working password for as long as the organisation used the system, and
 * nothing inside the application could take it away. Deleting is gone now;
 * switching off is the one way to remove somebody.
 *
 * So the tests that matter most are the doors: password sign-in, the sessions
 * already open, and single sign-on, which is a separate door and would
 * otherwise walk straight past the one that was closed. After that, the
 * pickers - offering somebody who cannot sign in is offering a step that will
 * never be signed - and then what it must NOT do, which is touch anything
 * they have already signed.
 */

useCleanDatabase();

const PASSWORD = "correct horse battery";

let cast: Awaited<ReturnType<typeof makeCast>>;
let admin: Awaited<ReturnType<typeof makeUser>>;
let leaver: Awaited<ReturnType<typeof adminService.createUser>>;

beforeEach(async () => {
  cast = await makeCast();
  admin = await makeUser({
    firstName: "Admin",
    departmentId: cast.department.id,
    loginRole: "ADMINISTRATOR",
  });
  leaver = await adminService.createUser(
    {
      firstName: "Kazim",
      lastName: "Zaidi",
      email: "kazim@example.com",
      password: PASSWORD,
      departmentId: cast.department.id,
      loginRole: "USER",
    },
    admin.id,
  );
});

const switchOff = (userId = leaver.id, actorId = admin.id) =>
  adminService.setUserActive(userId, false, actorId);

const switchOn = (userId = leaver.id, actorId = admin.id) =>
  adminService.setUserActive(userId, true, actorId);

const signIn = (email = "kazim@example.com") =>
  authService.login({ email, password: PASSWORD });

describe("the doors it closes", () => {
  it("refuses the password that worked yesterday", async () => {
    await expect(signIn()).resolves.toBeDefined();

    await switchOff();

    await expect(signIn()).rejects.toMatchObject({ statusCode: 403 });
  });

  it("says why, but only to somebody who knew the password", async () => {
    /*
     * The message names the account, which the "incorrect email or password"
     * above it deliberately never does. That is safe here and only here:
     * anybody reaching this line has typed the right password for this
     * address, so they are told nothing they did not already know - and a
     * person who has just left deserves a reason rather than a password that
     * silently stopped working.
     */
    await switchOff();

    const refused = await signIn().catch((error: unknown) => error as Error);
    expect((refused as Error).message).toContain("switched off");

    const wrongPassword = await authService
      .login({ email: "kazim@example.com", password: "not the password" })
      .catch((error: unknown) => error as Error);
    expect(wrongPassword).toMatchObject({
      statusCode: 401,
      message: "Incorrect email or password",
    });
  });

  it("ends the sessions they already hold, not just the next sign-in", async () => {
    /*
     * The half that would otherwise be missed. Stopping the next sign-in does
     * nothing about the browser tab that is already open: whoever is signed
     * in stays signed in for as long as it lives. `sessionsValidFrom` is the
     * only thing that reaches an access token, because the token is in the
     * client and is never presented here until it is used.
     */
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: leaver.id },
      select: { sessionsValidFrom: true },
    });

    await switchOff();

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: leaver.id },
      select: { sessionsValidFrom: true },
    });
    expect(after.sessionsValidFrom.getTime()).toBeGreaterThan(
      before.sessionsValidFrom.getTime(),
    );
    expect(
      await prisma.refreshSession.count({
        where: { userId: leaver.id, revokedAt: null },
      }),
    ).toBe(0);
  });

  it("refuses before asking for a second factor", async () => {
    // Otherwise an account that cannot sign in at all is asked for a code
    // first, and can spend one of its recovery codes proving it.
    await prisma.user.update({
      where: { id: leaver.id },
      data: { totpActivatedAt: new Date(), totpSecret: "whatever" },
    });

    await switchOff();

    await expect(signIn()).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("what it takes them out of", () => {
  it("the approver picker, which would otherwise offer a step nobody can sign", async () => {
    const before = await usersService.listAssignableUsers({ q: "Kazim" });
    expect(before.users.map((user) => user.id)).toContain(leaver.id);

    await switchOff();

    const after = await usersService.listAssignableUsers({ q: "Kazim" });
    expect(after.users.map((user) => user.id)).not.toContain(leaver.id);
  });

  it("but never out of a chain that already names them", async () => {
    /*
     * Resolving by id has to keep working. A memo already routed to somebody
     * who has since been switched off must still print their name against the
     * step - a gap there would make the chain read as broken rather than as
     * stopped, which is a different problem with a different fix.
     */
    await switchOff();

    const resolved = await usersService.listAssignableUsers({ ids: [leaver.id] });

    expect(resolved.users.map((user) => user.id)).toContain(leaver.id);
  });

  it("a new approval chain, which would be dead on arrival", async () => {
    await switchOff();

    await expect(
      submitDocument({
        preparerId: cast.preparer.id,
        approvalChain: chainOf(leaver),
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("and names them, rather than saying 'one or more'", async () => {
    await switchOff();

    const refused = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, leaver),
    }).catch((error: unknown) => error as Error);

    expect((refused as Error).message).toContain("Kazim Zaidi");
  });

  it("being handed somebody's approvals", async () => {
    await switchOff();

    await expect(
      delegationsService.create(
        { delegateId: leaver.id },
        { id: cast.reviewer.id, isAdministrator: false },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("and having their own handed on, which should be a reassignment instead", async () => {
    // Arranging cover for somebody who has left reads like the right thing to
    // do and is not: their steps should be MOVED, with a reason on the memo,
    // rather than quietly signed by a stand-in under a name that has gone.
    await switchOff();

    await expect(
      delegationsService.create(
        { delegatorId: leaver.id, delegateId: cast.bystander.id },
        { id: admin.id, isAdministrator: true },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("being the person a stopped step is moved to", async () => {
    // This control is reached precisely when somebody has left, which is when
    // the name of the next person who left is nearest to hand.
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });
    await switchOff();

    await expect(
      approvalService.reassignStep(document.id, admin.id, {
        userId: leaver.id,
        reason: "Ayesha has left.",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("what it must not touch", () => {
  it("the approvals they already gave", async () => {
    const { useSavedSignature: _saved, ...placement } = signature();
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(leaver, cast.finalApprover),
    });
    await approvalService.approve(document.id, leaver.id, {
      ...placement,
      useSavedSignature: false,
    });

    await switchOff();

    const run = await prisma.workflowRun.findFirstOrThrow({
      where: { documentId: document.id },
      select: { id: true },
    });
    const actions = await prisma.approvalAction.findMany({
      where: { workflowRunId: run.id },
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.actorId).toBe(leaver.id);
  });

  it("their row, which is still listed so nobody creates them twice", async () => {
    await switchOff();

    const listed = await adminService.listUsers({ q: "Kazim" });

    expect(listed.users.map((user) => user.id)).toContain(leaver.id);
    expect(listed.users[0]?.deactivatedAt).toBeInstanceOf(Date);
  });
});

describe("the refusals", () => {
  it("nobody switches off their own account", async () => {
    // The one mistake that locks the person making it out of the fix.
    await expect(switchOff(admin.id, admin.id)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("not the last administrator, counted among those still in use", async () => {
    /*
     * The same door demoting locks, and the likelier of the two to be opened
     * by accident because switching off reads as the
     * reversible one. Two administrators with one already switched off is one
     * administrator.
     */
    const second = await makeUser({
      firstName: "Second",
      departmentId: cast.department.id,
      loginRole: "ADMINISTRATOR",
    });
    await switchOff(second.id, admin.id);

    await expect(switchOff(admin.id, second.id)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("not somebody who is already switched off", async () => {
    await switchOff();

    await expect(switchOff()).rejects.toMatchObject({ statusCode: 409 });
  });

  it("not somebody who is not there", async () => {
    await expect(switchOff(missingId())).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("switching it back on", () => {
  it("lets them sign in again", async () => {
    await switchOff();
    await switchOn();

    await expect(signIn()).resolves.toBeDefined();
  });

  it("puts them back in the picker", async () => {
    await switchOff();
    await switchOn();

    const found = await usersService.listAssignableUsers({ q: "Kazim" });
    expect(found.users.map((user) => user.id)).toContain(leaver.id);
  });

  it("refuses somebody whose account was never off", async () => {
    await expect(switchOn()).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("what it leaves behind", () => {
  it("a row saying the account was switched off, and by whom", async () => {
    /*
     * Its own action rather than a USER_UPDATED carrying a changed field,
     * because the administration trail is read to answer "who can still get
     * in" - and a row reading "user updated" answers that only to somebody
     * who opens the payload.
     */
    await switchOff();

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: "USER_DEACTIVATED", entityId: leaver.id },
    });

    expect(row.actorId).toBe(admin.id);
    expect(row.entityType).toBe("User");
    expect(row.newValue).toMatchObject({ email: "kazim@example.com" });
  });

  it("and a different row when it goes back on", async () => {
    await switchOff();
    await switchOn();

    expect(
      await prisma.auditLog.count({
        where: { action: "USER_REACTIVATED", entityId: leaver.id },
      }),
    ).toBe(1);
  });

  it("both readable on the administration trail, under People", async () => {
    await switchOff();

    const { entries } = await auditService.getAdministrationActivity({ limit: 200 });
    const row = entries.find((entry) => entry.action === "USER_DEACTIVATED");

    expect(row?.area).toBe("People");
    expect(row?.actor?.id).toBe(admin.id);
  });
});

describe("handing their approvals to a successor", () => {
  /*
   * Agreed after the fit-gap review: somebody leaving must not leave memos
   * blocked until an administrator notices. Whoever still has steps on open
   * memos is switched off with a successor, and every step goes to them.
   */
  const handTo = (successorId: string, userId = leaver.id, actorId = admin.id) =>
    adminService.setUserActive(userId, false, actorId, undefined, successorId);

  const stepOf = async (documentId: string, stepOrder: number) =>
    (
      await prisma.approvalChainStep.findFirstOrThrow({
        where: { chain: { documentId }, stepOrder },
        select: { assignedUserId: true },
      })
    ).assignedUserId;

  it("asks who takes over while they still have steps, and leaves the account on until told", async () => {
    await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(leaver, cast.finalApprover),
    });

    await expect(switchOff()).rejects.toMatchObject({ code: "SUCCESSOR_REQUIRED" });

    const still = await prisma.user.findUniqueOrThrow({ where: { id: leaver.id } });
    expect(still.deactivatedAt).toBeNull();
  });

  it("moves the step a memo is waiting on, and the ones still ahead, to the successor", async () => {
    const holding = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(leaver, cast.finalApprover),
    });
    const ahead = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, leaver, cast.finalApprover),
    });

    const result = await handTo(cast.bystander.id);

    expect(await stepOf(holding.id, 1)).toBe(cast.bystander.id);
    expect(await stepOf(ahead.id, 2)).toBe(cast.bystander.id);
    expect(result.message).toMatch(/2 approval steps were handed to their successor/);

    const held = await documentsService.getMemosHeldBy(leaver.id);
    expect(held.holdingNow).toHaveLength(0);
    expect(held.ahead).toHaveLength(0);

    // The new holder is asked, through the same reassignment as by hand.
    const moved = await prisma.auditLog.findMany({
      where: { action: "WORKFLOW_STEP_REASSIGNED" },
    });
    expect(moved).toHaveLength(2);
  });

  it("sends a memo back with its preparer to the successor next time round", async () => {
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, leaver, cast.finalApprover),
    });
    await approvalService.requestRevision(document.id, cast.reviewer.id, {
      comment: "Add the quotes.",
    });

    await handTo(cast.bystander.id);

    expect(await stepOf(document.id, 2)).toBe(cast.bystander.id);
    // And the resubmission is not refused for naming somebody who has gone.
    await expect(
      resubmitDocument({ documentId: document.id, preparerId: cast.preparer.id })
    ).resolves.toBeTruthy();
  });

  it("keeps the leaver's name against a decision they made in a cycle that ended", async () => {
    const { useSavedSignature: _saved, ...placement } = signature();
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(leaver, cast.finalApprover),
    });
    await approvalService.approve(document.id, leaver.id, { ...placement, useSavedSignature: false });
    await approvalService.reject(document.id, cast.finalApprover.id, { comment: "Over budget." });

    await handTo(cast.bystander.id);

    expect(await stepOf(document.id, 1)).toBe(cast.bystander.id);
    const shown = await workflowService.getWorkflow(document.id, cast.preparer.id);
    expect(shown.workflow?.[0]?.assignedUser.id).toBe(leaver.id);
  });

  it("refuses a successor already on a memo's chain, naming the memo, and moves nothing", async () => {
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(leaver, cast.finalApprover),
    });

    await expect(handTo(cast.finalApprover.id)).rejects.toThrow(document.referenceNumber!);

    expect(await stepOf(document.id, 1)).toBe(leaver.id);
    const still = await prisma.user.findUniqueOrThrow({ where: { id: leaver.id } });
    expect(still.deactivatedAt).toBeNull();
  });

  it("refuses the administrator as successor, as moving a step by hand does", async () => {
    await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(leaver, cast.finalApprover),
    });

    await expect(handTo(admin.id)).rejects.toThrow(/cannot take over their approvals yourself/);
  });

  it("ends cover given to them, so the person they covered is not left without anyone", async () => {
    await delegationsService.create(
      { delegatorId: cast.reviewer.id, delegateId: leaver.id },
      { id: admin.id, isAdministrator: true },
    );

    await switchOff();

    expect(await prisma.delegation.count({ where: { revokedAt: null } })).toBe(0);
  });

  it("ends cover they gave, so nobody goes on signing in the name of somebody who has gone", async () => {
    await delegationsService.create(
      { delegatorId: leaver.id, delegateId: cast.bystander.id },
      { id: admin.id, isAdministrator: true },
    );

    await switchOff();

    expect(await prisma.delegation.count({ where: { revokedAt: null } })).toBe(0);
  });

  it("needs no successor from somebody with nothing open", async () => {
    const result = await switchOff();
    expect(result.deactivatedAt).toBeInstanceOf(Date);
  });
});
