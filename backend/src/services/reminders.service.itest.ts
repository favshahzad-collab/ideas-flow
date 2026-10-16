import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  makeUser,
  submitDocument,
  tamperWithLedger,
  useCleanDatabase,
} from "../test/db";
import { auditService } from "./audit.service";
import { delegationsService } from "./delegations.service";
import { remindersService, COOLDOWN_HOURS } from "./reminders.service";

/**
 * Asking somebody to look at a memo, against a real database.
 *
 * The feature is one notice, so what the tests are really about is who may
 * send it and how often. A reminder anybody can send, to anybody, as many
 * times as they like, is not a reminder - it is a way to pester a colleague
 * with the company's own mail server, and the first person to receive three
 * of them filters the lot, including the one that mattered.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;

beforeEach(async () => {
  cast = await makeCast();
});

const submit = () =>
  submitDocument({
    preparerId: cast.preparer.id,
    approvalChain: chainOf(cast.reviewer, cast.approver),
  });

const remindersFor = (recipientId: string) =>
  prisma.notification.findMany({
    where: { recipientId, type: "APPROVAL_REMINDER" },
    orderBy: { createdAt: "asc" },
  });

const trail = (documentId: string) =>
  prisma.auditLog.findMany({
    where: { entityId: documentId, action: "APPROVAL_REMINDER_SENT" },
  });

/** Wind the last reminder back, as though it had been sent hours ago. */
async function remindedHoursAgo(documentId: string, hours: number) {
  const when = new Date(Date.now() - hours * 60 * 60 * 1000);

  // The only way to make time pass for a row the database will not let
  // anybody change: with its append-only guard switched off for the moment.
  await tamperWithLedger(() => prisma.$executeRaw`
    UPDATE audit_logs SET created_at = ${when}
    WHERE entity_id = ${documentId}::uuid AND action = 'APPROVAL_REMINDER_SENT'`);
}

describe("who may send one", () => {
  it("the preparer, who is the person waiting", async () => {
    const { id } = await submit();

    const result = await remindersService.remind(id, cast.preparer.id);

    expect(result.remindedUserId).toBe(cast.reviewer.id);
    expect(await remindersFor(cast.reviewer.id)).toHaveLength(1);
  });

  it("an administrator, who watches the whole organisation", async () => {
    // The control room shows a memo that has stopped moving and has, until
    // now, had nothing whatever to do about it.
    const admin = await makeUser({
      firstName: "Admin",
      departmentId: cast.department.id,
      loginRole: "ADMINISTRATOR",
    });
    const { id } = await submit();

    await remindersService.remind(id, admin.id);

    expect(await remindersFor(cast.reviewer.id)).toHaveLength(1);
  });

  it("not a later approver on the same chain", async () => {
    /*
     * They can see the memo - they are on its chain - and they have no stake
     * in it yet. A reminder from somebody who is not waiting is the thing
     * that turns a useful notice into noise.
     */
    const { id } = await submit();

    await expect(remindersService.remind(id, cast.approver.id)).rejects.toThrow(
      /Only the person who prepared this memo, or an administrator/
    );
    expect(await remindersFor(cast.reviewer.id)).toHaveLength(0);
  });

  it("not somebody with nothing to do with it", async () => {
    const { id } = await submit();

    await expect(remindersService.remind(id, cast.bystander.id)).rejects.toThrow(
      /Only the person who prepared this memo/
    );
  });

  it("not the person holding it, who would be reminding themselves", async () => {
    // Reachable: an administrator can be an approver on somebody else's memo.
    const admin = await makeUser({
      firstName: "Admin",
      departmentId: cast.department.id,
      loginRole: "ADMINISTRATOR",
    });
    const { id } = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(admin, cast.approver),
    });

    await expect(remindersService.remind(id, admin.id)).rejects.toThrow(
      /waiting on you, so there is nobody to remind/
    );
  });
});

describe("how often", () => {
  it("refuses a second one inside the cooldown, and says how long to wait", async () => {
    const { id } = await submit();
    await remindersService.remind(id, cast.preparer.id);

    await expect(remindersService.remind(id, cast.preparer.id)).rejects.toThrow(
      new RegExp(`less than ${COOLDOWN_HOURS} hours ago. You can send another in`)
    );
    expect(await remindersFor(cast.reviewer.id)).toHaveLength(1);
  });

  it("counts the cooldown from the trail, not from a client's memory", async () => {
    // Which is what makes it hold across a reload, another browser, and a
    // second administrator who never saw the first reminder go out.
    const { id } = await submit();
    await remindersService.remind(id, cast.preparer.id);
    await remindedHoursAgo(id, COOLDOWN_HOURS + 1);

    await remindersService.remind(id, cast.preparer.id);

    expect(await remindersFor(cast.reviewer.id)).toHaveLength(2);
    expect(await trail(id)).toHaveLength(2);
  });

  it("is per memo, so one reminder does not silence another memo", async () => {
    const first = await submit();
    const second = await submit();

    await remindersService.remind(first.id, cast.preparer.id);
    await remindersService.remind(second.id, cast.preparer.id);

    expect(await remindersFor(cast.reviewer.id)).toHaveLength(2);
  });
});

describe("who hears about it", () => {
  it("the approver whose step it is", async () => {
    const { id } = await submit();

    await remindersService.remind(id, cast.preparer.id);
    const [notice] = await remindersFor(cast.reviewer.id);

    expect(notice.message).toContain("It is at your step");
    expect(notice.documentId).toBe(id);
  });

  it("and the colleague covering for them, who is the one who can sign it", async () => {
    const { id } = await submit();
    await delegationsService.create(
      { delegateId: cast.bystander.id },
      { id: cast.reviewer.id, isAdministrator: false }
    );

    const result = await remindersService.remind(id, cast.preparer.id);

    expect(result.recipients).toBe(2);
    const [covering] = await remindersFor(cast.bystander.id);
    expect(covering.message).toContain("you are covering for them");
  });

  it("nobody twice, when the person covering is the one asking", async () => {
    /*
     * An administrator covering for the approver, chasing the memo from the
     * control room. Telling them that they are waiting on themselves is the
     * kind of thing that makes a person stop reading the notices.
     */
    const admin = await makeUser({
      firstName: "Admin",
      departmentId: cast.department.id,
      loginRole: "ADMINISTRATOR",
    });
    const { id } = await submit();
    await delegationsService.create(
      { delegateId: admin.id },
      { id: cast.reviewer.id, isAdministrator: false }
    );

    const result = await remindersService.remind(id, admin.id);

    expect(result.recipients).toBe(1);
    expect(await remindersFor(admin.id)).toHaveLength(0);
  });
});

describe("when there is nothing to remind anybody about", () => {
  it("refuses on a memo that is not with anybody", async () => {
    const { id } = await submit();

    // Straight to the database: what matters is the refusal, not how a memo
    // came to be finished.
    await prisma.document.update({ where: { id }, data: { status: "APPROVED" } });

    await expect(remindersService.remind(id, cast.preparer.id)).rejects.toThrow(
      /not waiting on anybody/
    );
  });

  it("refuses on a memo that does not exist", async () => {
    await expect(
      remindersService.remind(
        "00000000-0000-4000-8000-000000000000",
        cast.preparer.id
      )
    ).rejects.toThrow(/not found/i);
  });
});

describe("the trail", () => {
  it("shows on the memo's own ledger, in the capacity it was sent in", async () => {
    /*
     * A memo that sat for six weeks should not read as though nobody ever
     * did anything about it. The row existed from the start; the ledger is
     * built from the approval actions plus a named list of audit actions,
     * and a reminder writes no approval action, so it fell between them.
     *
     * "Preparer" or "Administrator" is written into the row when it is sent
     * rather than worked out when it is read: the two are different facts
     * about how a memo came to move, and somebody's role can change later.
     */
    const admin = await makeUser({
      firstName: "Admin",
      departmentId: cast.department.id,
      loginRole: "ADMINISTRATOR",
    });
    const { id } = await submit();

    await remindersService.remind(id, cast.preparer.id);
    const mine = await auditService.getDocumentAuditHistory(id, cast.preparer.id);
    expect(
      mine.find((entry) => entry.action === "APPROVAL_REMINDER_SENT")?.role,
    ).toBe("Preparer");

    const second = await submit();
    await remindersService.remind(second.id, admin.id);
    const theirs = await auditService.getDocumentAuditHistory(second.id, admin.id);
    expect(
      theirs.find((entry) => entry.action === "APPROVAL_REMINDER_SENT")?.role,
    ).toBe("Administrator");
  });

  it("records who asked, whose step it was, and who else was told", async () => {
    const { id } = await submit();

    await remindersService.remind(id, cast.preparer.id, "203.0.113.7");
    const [entry] = await trail(id);

    expect(entry.actorId).toBe(cast.preparer.id);
    expect(entry.ipAddress).toBe("203.0.113.7");
    expect(entry.newValue).toMatchObject({
      assignedUserId: cast.reviewer.id,
      alsoTold: null,
    });
  });
});
