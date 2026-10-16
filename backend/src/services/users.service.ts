import { prisma } from "../prisma";
import { errors } from "../lib/errors";
import { assertEmbeddableImage } from "../lib/imageBytes";
import { storageService } from "../lib/storage";
import { hashPassword, verifyPassword } from "../lib/password";
import { assertAcceptablePassword } from "../lib/passwordPolicy";
import { sessionsService } from "./sessions.service";
import { auditService } from "./audit.service";
import { logger } from "../lib/logger";
import { sha256 } from "../lib/checksum";
import { notificationsService } from "./notifications.service";

/** Keeps one oversized directory from becoming one oversized response. */
const ASSIGNABLE_DEFAULT_LIMIT = 25;
const ASSIGNABLE_MAX_LIMIT = 100;

class UsersService {
  /**
   * Change your own password.
   *
   * Until this existed the only way to change a password was for an
   * administrator to set it through `PATCH /api/admin/users/:id`. At the
   * scale this product is deployed at that is not an inconvenience, it is a
   * policy: every account is imported from a spreadsheet with a password
   * somebody else chose, nobody can change it afterwards, and so the
   * administrator permanently knows the credentials of every person whose
   * signature carries approval authority.
   *
   * The current password is required even though the caller is already
   * authenticated. An access token left live on an unattended machine
   * should not be enough to lock its owner out of their own account.
   */
  async changeOwnPassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
    context: { ipAddress?: string } = {}
  ) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true, email: true, firstName: true, lastName: true },
    });

    if (!user) {
      throw errors.notFound("User not found");
    }

    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      // Deliberately not "that is not your password": the same sentence
      // whether the account has no password set or the one given is wrong.
      throw errors.badRequest("Your current password is not correct.");
    }

    if (input.currentPassword === input.newPassword) {
      throw errors.badRequest(
        "The new password is the same as the current one."
      );
    }

    assertAcceptablePassword(input.newPassword, user);

    const passwordHash = await hashPassword(input.newPassword);

    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    /*
     * Every session the old password opened, including this one.
     *
     * Somebody changing their password because it was seen over their
     * shoulder expects that to be the end of it, and tokens issued against
     * the old one otherwise go on working for thirty days. Signing the
     * caller out too is the honest consequence, and the interface says so
     * before asking.
     */
    await sessionsService.endAll(userId, {
      actorId: userId,
      ipAddress: context.ipAddress,
    });

    await auditService.createAuditLog({
      actorId: userId,
      action: "PASSWORD_RESET",
      entityType: "User",
      entityId: userId,
      ipAddress: context.ipAddress,
    });

    /*
     * One notice for the whole action, raised here rather than inside
     * `endAll`. The password change and the sessions ending are one event to
     * the person it happened to; two mails saying nearly the same thing is
     * how the first one gets filtered.
     *
     * `endAll` stays silent for a second reason: it is a mechanism with
     * several callers - an administrator deactivating an account, a sign-out
     * during login - and a notice inside it would fire on all of them.
     *
     * Never allowed to fail the change. The password is already changed and
     * the sessions are already gone; refusing here would report a failure for
     * something that fully happened.
     */
    try {
      await notificationsService.createNotification({
        recipientId: userId,
        type: "SECURITY_ALERT",
        title: "Your password was changed",
        message:
          "The password on your Ideas Flow account was changed, and every " +
          "device signed in with the old one has been signed out. If that " +
          "was not you, tell your administrator now.",
      });
    } catch (error) {
      logger.error("security.notice.failed", {
        userId,
        title: "Your password was changed",
        message: error instanceof Error ? error.message : "unknown",
      });
    }

    return { message: "Your password has been changed. Sign in again." };
  }

  /**
   * Assignable approvers, searched server-side.
   *
   * This used to return the entire user table with no paging, which the submit
   * screen rendered into a single flat select. That is fine at seed size and
   * unusable at organisational size, so the filtering belongs here rather than
   * in the browser.
   */
  async listAssignableUsers(
    options: { q?: string; limit?: number; ids?: string[] } = {}
  ) {
    const term = options.q?.trim();
    const ids = options.ids?.filter(Boolean).slice(0, ASSIGNABLE_MAX_LIMIT);

    // Resolving a known set takes priority: a template names its approvers by
    // id, and no search term would find exactly those people.
    if (ids && ids.length > 0) {
      /*
       * Resolved whether or not the account is still in use. A memo already
       * routed to somebody who has since been switched off has to print their
       * name against the step; answering with a gap would make the chain read
       * as broken rather than as stopped. `deactivatedAt` comes back with
       * them so the caller can say which it is.
       */
      const users = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          designation: true,
          loginRole: true,
          deactivatedAt: true,
          department: { select: { name: true } },
        },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      });
      return { users, total: users.length, returned: users.length };
    }

    const take = Math.min(
      Math.max(options.limit ?? ASSIGNABLE_DEFAULT_LIMIT, 1),
      ASSIGNABLE_MAX_LIMIT
    );

    // Match every word somewhere, rather than the whole string in one field —
    // otherwise "Maria Chen" finds nobody, because no single column contains
    // both names, which is exactly what a person types into a people picker.
    const tokens = term ? term.split(/\s+/).filter(Boolean).slice(0, 5) : [];

    /*
     * Searching offers only accounts still in use. Somebody who has been
     * switched off cannot sign in, so offering them as an approver is
     * offering a step that will never be signed - and the preparer would find
     * that out weeks later, when the memo stopped there.
     */
    const inUse = { deactivatedAt: null } as const;

    const where =
      tokens.length > 0
        ? {
            ...inUse,
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
        : inUse;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          designation: true,
          loginRole: true,
          department: {
            select: {
              name: true,
            },
          },
        },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
        take,
      }),
      prisma.user.count({ where }),
    ]);

    return { users, total, returned: users.length };
  }

  private signaturePathForUser(userId: string, mimetype: string) {
    const extension = mimetype === "image/jpeg" ? "jpg" : "png";
    return `${userId}.${extension}`;
  }

  /*
   * Changing a saved signature is confirmed (the route asks for the password
   * or a code) and recorded, with the image's fingerprint. It used to be
   * neither: anybody at a signed-in desk could put a different image on every
   * memo that person signed from then on, and nothing would show it changed.
   */
  async uploadSignature(
    userId: string,
    file: Express.Multer.File,
    context: { ipAddress?: string } = {}
  ) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { signatureStoragePath: true, signatureChecksum: true },
    });

    if (!user) {
      throw errors.notFound("User not found");
    }

    /*
     * Refused here as well as at the moment of signing.
     *
     * The stamping path guards itself, so nothing malformed can reach the
     * decoder either way - but a file rejected only at signing time is
     * rejected in the middle of approving a memo, weeks after it was
     * uploaded, by somebody who no longer has the original to hand. The
     * mimetype the browser sent says nothing about the bytes.
     */
    assertEmbeddableImage(
      file.buffer,
      "That signature file",
      "Save it again as a PNG or JPEG."
    );

    const nextPath = this.signaturePathForUser(userId, file.mimetype);

    if (user.signatureStoragePath && user.signatureStoragePath !== nextPath) {
      await storageService.deleteSignature(user.signatureStoragePath);
    }

    await storageService.uploadSignature(nextPath, file.buffer, file.mimetype);

    const checksum = sha256(file.buffer);

    await prisma.user.update({
      where: { id: userId },
      data: { signatureStoragePath: nextPath, signatureChecksum: checksum },
    });

    await auditService.createAuditLog({
      actorId: userId,
      action: "SIGNATURE_SAVED",
      entityType: "User",
      entityId: userId,
      oldValue: user.signatureStoragePath
        ? { signatureChecksum: user.signatureChecksum }
        : undefined,
      newValue: { signatureChecksum: checksum, replaced: Boolean(user.signatureStoragePath) },
      ipAddress: context.ipAddress,
    });

    return { signatureStoragePath: nextPath };
  }

  async getSignature(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { signatureStoragePath: true },
    });

    if (!user?.signatureStoragePath) {
      throw errors.notFound("No saved signature found");
    }

    const buffer = await storageService.downloadSignature(user.signatureStoragePath);

    return {
      buffer,
      contentType: storageService.getSignatureContentType(user.signatureStoragePath),
    };
  }

  async deleteSignature(userId: string, context: { ipAddress?: string } = {}) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { signatureStoragePath: true, signatureChecksum: true },
    });

    if (!user) {
      throw errors.notFound("User not found");
    }

    if (user.signatureStoragePath) {
      await storageService.deleteSignature(user.signatureStoragePath);
    }

    await prisma.user.update({
      where: { id: userId },
      data: { signatureStoragePath: null, signatureChecksum: null },
    });

    if (user.signatureStoragePath) {
      await auditService.createAuditLog({
        actorId: userId,
        action: "SIGNATURE_REMOVED",
        entityType: "User",
        entityId: userId,
        oldValue: { signatureChecksum: user.signatureChecksum },
        ipAddress: context.ipAddress,
      });
    }

    return { message: "Signature removed" };
  }
}

export const usersService = new UsersService();
