import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import {
  deleteNotificationSchema,
  markNotificationReadSchema,
} from "../schemas/notifications.schema";
import { makeDepartment, makeUser, missingId, useCleanDatabase } from "../test/db";
import { notificationsService } from "./notifications.service";

/**
 * The inbox.
 *
 * Every row here is addressed to one person, and nothing about a notification
 * id says whose it is - so the only thing standing between one user's inbox
 * and another's is the recipient check on read, mark and delete.
 */

useCleanDatabase();

let ayesha: string;
let bilal: string;

beforeEach(async () => {
  const departmentId = (await makeDepartment()).id;
  ayesha = (await makeUser({ firstName: "Ayesha", departmentId })).id;
  bilal = (await makeUser({ firstName: "Bilal", departmentId })).id;
});

const notify = (recipientId: string, title = "Approval Required") =>
  notificationsService.createNotification({
    recipientId,
    type: "APPROVAL_NEEDED",
    title,
    message: `${title}: something needs you.`,
  });

describe("creating", () => {
  it("addresses a notification to one person", async () => {
    const created = await notify(ayesha);

    expect(created.recipientId).toBe(ayesha);
    expect(created.isRead).toBe(false);
    expect(created.readAt).toBeNull();
  });

  it("writes a batch in one statement", async () => {
    await notificationsService.createNotifications([
      { recipientId: ayesha, type: "APPROVAL_NEEDED", title: "One", message: "1" },
      { recipientId: bilal, type: "REJECTED", title: "Two", message: "2" },
    ]);

    expect(await prisma.notification.count()).toBe(2);
  });

  it("does nothing at all for an empty batch", async () => {
    // The approval paths build this list conditionally and can end up with
    // none; a createMany with an empty array is a round trip for nothing.
    await expect(
      notificationsService.createNotifications([])
    ).resolves.toBeUndefined();

    expect(await prisma.notification.count()).toBe(0);
  });

  it("commits with the transaction it was given", async () => {
    // Inbox rows are written inside the transaction that makes the change
    // they describe, so a rolled-back approval does not leave the approver
    // told about something that did not happen.
    await prisma
      .$transaction(async (tx) => {
        await notificationsService.createNotification({
          recipientId: ayesha,
          type: "APPROVAL_NEEDED",
          title: "Never happened",
          message: "rolled back",
          tx,
        });
        throw new Error("the change this described failed");
      })
      .catch(() => null);

    expect(await prisma.notification.count()).toBe(0);
  });
});

describe("reading", () => {
  it("returns only the caller's own, newest first", async () => {
    await notify(ayesha, "First");
    await notify(bilal, "Not yours");
    await notify(ayesha, "Second");

    const inbox = await notificationsService.getNotifications(ayesha);

    expect(inbox.map((row) => row.title)).toEqual(["Second", "First"]);
  });

  it("filters by read state when asked", async () => {
    const first = await notify(ayesha, "Read me");
    await notify(ayesha, "Still unread");
    await notificationsService.markAsRead(first.id, ayesha);

    expect(
      (await notificationsService.getNotifications(ayesha, false)).map(
        (row) => row.title
      )
    ).toEqual(["Still unread"]);
    expect(
      (await notificationsService.getNotifications(ayesha, true)).map(
        (row) => row.title
      )
    ).toEqual(["Read me"]);
  });

  it("returns an empty inbox rather than failing", async () => {
    expect(await notificationsService.getNotifications(missingId())).toEqual([]);
  });
});

describe("marking as read", () => {
  it("stamps the time it was read", async () => {
    const created = await notify(ayesha);

    const updated = await notificationsService.markAsRead(created.id, ayesha);

    expect(updated.isRead).toBe(true);
    expect(updated.readAt).not.toBeNull();
  });

  it("leaves the original timestamp alone on a second call", async () => {
    // The client marks on render, so this is called again on every revisit.
    const created = await notify(ayesha);
    const first = await notificationsService.markAsRead(created.id, ayesha);
    const second = await notificationsService.markAsRead(created.id, ayesha);

    expect(second.readAt).toEqual(first.readAt);
  });

  it("refuses somebody else's notification", async () => {
    const theirs = await notify(bilal);

    await expect(
      notificationsService.markAsRead(theirs.id, ayesha)
    ).rejects.toMatchObject({ statusCode: 403 });

    const untouched = await prisma.notification.findUniqueOrThrow({
      where: { id: theirs.id },
    });
    expect(untouched.isRead).toBe(false);
  });

  it("reports one that does not exist as not found", async () => {
    await expect(
      notificationsService.markAsRead(missingId(), ayesha)
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("deleting", () => {
  it("removes one of the caller's own", async () => {
    const created = await notify(ayesha);

    await notificationsService.deleteNotification(created.id, ayesha);

    expect(await prisma.notification.count()).toBe(0);
  });

  it("refuses somebody else's", async () => {
    const theirs = await notify(bilal);

    await expect(
      notificationsService.deleteNotification(theirs.id, ayesha)
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(await prisma.notification.count()).toBe(1);
  });

  it("reports one that does not exist as not found", async () => {
    await expect(
      notificationsService.deleteNotification(missingId(), ayesha)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("clears the caller's inbox and nobody else's", async () => {
    await notify(ayesha, "Mine");
    await notify(ayesha, "Also mine");
    await notify(bilal, "Theirs");

    const result = await notificationsService.deleteAllNotifications(ayesha);

    expect(result.deletedCount).toBe(2);
    const left = await prisma.notification.findMany();
    expect(left.map((row) => row.recipientId)).toEqual([bilal]);
  });

  it("reports zero for an inbox that was already empty", async () => {
    expect(
      await notificationsService.deleteAllNotifications(ayesha)
    ).toMatchObject({ deletedCount: 0 });
  });
});

describe("the unread count behind the badge", () => {
  it("counts only what is still unread", async () => {
    await notify(ayesha, "One");
    const second = await notify(ayesha, "Two");
    await notificationsService.markAsRead(second.id, ayesha);

    expect(await notificationsService.getUnreadCount(ayesha)).toEqual({ count: 1 });
  });

  it("counts only the caller's inbox", async () => {
    // The badge is the one number a person checks without opening anything.
    // Counting somebody else's unread rows into it would send them looking
    // for work that was never theirs.
    await notify(bilal, "Theirs");
    await notify(bilal, "Also theirs");
    await notify(ayesha, "Mine");

    expect(await notificationsService.getUnreadCount(ayesha)).toEqual({ count: 1 });
  });

  it("says zero for an empty inbox rather than failing", async () => {
    expect(await notificationsService.getUnreadCount(ayesha)).toEqual({ count: 0 });
  });

  it("agrees with the unread list it replaced", async () => {
    // The badge used to be `unreadList.length`. If the two ever disagree, one
    // of them is lying to the same person on the same screen.
    await notify(ayesha, "One");
    await notify(ayesha, "Two");
    await notify(bilal, "Theirs");

    const list = await notificationsService.getNotifications(ayesha, false);
    const { count } = await notificationsService.getUnreadCount(ayesha);

    expect(count).toBe(list.length);
  });
});

describe("marking the whole inbox read", () => {
  it("marks every unread row the caller has", async () => {
    await notify(ayesha, "One");
    await notify(ayesha, "Two");

    const result = await notificationsService.markAllAsRead(ayesha);

    expect(result.updatedCount).toBe(2);
    expect(await notificationsService.getUnreadCount(ayesha)).toEqual({ count: 0 });
  });

  it("leaves everybody else's inbox alone", async () => {
    // There is no row to load and compare an owner against here, so the
    // where clause is the only thing between this button and another
    // person's inbox.
    await notify(ayesha, "Mine");
    await notify(bilal, "Theirs");

    await notificationsService.markAllAsRead(ayesha);

    expect(await notificationsService.getUnreadCount(bilal)).toEqual({ count: 1 });
  });

  it("stamps readAt on the rows it changed", async () => {
    await notify(ayesha, "One");

    await notificationsService.markAllAsRead(ayesha);

    const row = await prisma.notification.findFirstOrThrow({
      where: { recipientId: ayesha },
    });
    expect(row.isRead).toBe(true);
    expect(row.readAt).not.toBeNull();
  });

  it("does not restamp one that was already read", async () => {
    // Re-reading the whole inbox would otherwise move an old notification to
    // the top of anything ordered by readAt, and rewrite when it was seen.
    const first = await notify(ayesha, "One");
    await notificationsService.markAsRead(first.id, ayesha);
    const readAt = (
      await prisma.notification.findUniqueOrThrow({ where: { id: first.id } })
    ).readAt;

    await notify(ayesha, "Two");
    const result = await notificationsService.markAllAsRead(ayesha);

    expect(result.updatedCount).toBe(1);
    expect(
      (await prisma.notification.findUniqueOrThrow({ where: { id: first.id } }))
        .readAt
    ).toEqual(readAt);
  });

  it("reports zero for an inbox with nothing unread", async () => {
    expect(await notificationsService.markAllAsRead(ayesha)).toMatchObject({
      updatedCount: 0,
    });
  });
});

describe("a notification id that is not a uuid", () => {
  /*
   * These ids go straight into a uuid column. Without the check the driver
   * raises an error the handler cannot recognise, so a stale link or one that
   * lost a character tells the reader the system broke rather than that the
   * notification is gone.
   */
  it.each([
    ["mark as read", markNotificationReadSchema],
    ["delete", deleteNotificationSchema],
  ])("is refused before it reaches the database on %s", (_name, schema) => {
    expect(schema.safeParse({ params: { id: "not-a-uuid" } }).success).toBe(false);
    expect(schema.safeParse({ params: { id: missingId() } }).success).toBe(true);
  });
});
