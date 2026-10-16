import { z } from "zod";

// A path id that reaches Prisma unchecked is not a 404: the driver rejects a
// malformed uuid with an error the handler cannot recognise, so a stale link
// or a URL that lost a character tells the reader the system broke rather than
// that the notification is no longer there.
const notificationIdParams = z.object({
  id: z
    .string()
    .uuid("That notification link is not valid. Open it again from your inbox."),
});

export const listNotificationsSchema = z.object({
  query: z.object({
    isRead: z
      .enum(["true", "false"])
      .optional()
      .transform((value) =>
        value === undefined ? undefined : value === "true"
      ),
  }),
});

export const markNotificationReadSchema = z.object({
  params: notificationIdParams,
});

export const deleteNotificationSchema = z.object({
  params: notificationIdParams,
});
