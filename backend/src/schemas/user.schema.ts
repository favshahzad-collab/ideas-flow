import { z } from "zod";
import {
  newPasswordField,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../lib/passwordPolicy";

export const listAssignableUsersSchema = z.object({
  query: z.object({
    /** Free-text match on name, email or department. */
    q: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    /**
     * Comma-separated ids, for resolving a known set of people — the approvers
     * a workflow template names, which no search term would find.
     *
     * Split and checked here rather than in the route: `users.id` is a uuid
     * column, so one mistyped id used to reach Prisma as-is and come back as
     * 500 "Internal server error" for what is a malformed request. The list
     * itself is not length-checked - the service caps how many it looks up,
     * and refusing the whole call would turn a long template's approver
     * lookup from a partial list into a hard failure.
     */
    ids: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .transform((value) =>
        value === undefined
          ? undefined
          : value
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean)
      )
      .pipe(z.array(z.uuid("Invalid user id")).optional()),
  }),
});

export const updateProfileSchema = z.object({
  body: z.object({
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
  }),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>["body"];

/** The limits of a new password. The rule itself is `lib/passwordPolicy`. */
export const USER_PASSWORD_MIN_LENGTH = PASSWORD_MIN_LENGTH;
export const USER_PASSWORD_MAX_LENGTH = PASSWORD_MAX_LENGTH;

/**
 * Changing your own password.
 *
 * The current one is required even though the request is authenticated: an
 * access token left live on an unattended machine should not be enough to lock
 * its owner out of their own account.
 */
export const changeOwnPasswordSchema = z.object({
  body: z.object({
    currentPassword: z
      .string()
      .min(1, "Enter your current password"),
    newPassword: newPasswordField("New password"),
  }),
});

export type ChangeOwnPasswordInput = z.infer<typeof changeOwnPasswordSchema>["body"];
