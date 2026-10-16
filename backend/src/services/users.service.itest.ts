import { promises as fs } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "../lib/env";
import { prisma } from "../prisma";
import { listAssignableUsersSchema } from "../schemas/user.schema";
import { makeDepartment, makeUser, missingId, useCleanDatabase } from "../test/db";
import { usersService } from "./users.service";
import { hashPassword, verifyPassword } from "../lib/password";

/**
 * Saved signatures and the people picker.
 *
 * The signature is a file and a column that have to agree: the column names
 * the file the approval path will stamp into a PDF, so a stale path is a
 * failed approval and an orphaned file is somebody's signature left on disk
 * after they asked for it to go.
 */

useCleanDatabase();

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
/**
 * A real one, small but well-formed: SOI, a baseline frame header, a start of
 * scan. It used to be the string "not really a jpeg, but the bytes are not
 * read here", which stopped being true when the upload started refusing
 * anything a PDF decoder would choke on.
 */
const JPEG = (() => {
  const frame = Buffer.alloc(11);
  frame[0] = 0xff;
  frame[1] = 0xc0;
  frame.writeUInt16BE(9, 2); // segment length
  frame[4] = 8; // sample precision
  frame.writeUInt16BE(40, 5); // height
  frame.writeUInt16BE(120, 7); // width
  frame[9] = 1; // one component
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    frame,
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
    Buffer.alloc(8),
  ]);
})();

const imageUpload = (buffer: Buffer, mimetype: string) =>
  ({ buffer, mimetype, originalname: "signature" }) as unknown as Express.Multer.File;

const signaturesRoot = () =>
  path.join(path.resolve(env.STORAGE_DIR), "signatures");

const onDisk = async (storagePath: string) =>
  fs
    .access(path.join(signaturesRoot(), storagePath))
    .then(() => true)
    .catch(() => false);

let userId: string;

beforeEach(async () => {
  userId = (await makeUser()).id;
});

describe("uploadSignature", () => {
  it("writes the file and records where it went", async () => {
    const { signatureStoragePath } = await usersService.uploadSignature(
      userId,
      imageUpload(PNG, "image/png")
    );

    expect(signatureStoragePath).toBe(`${userId}.png`);
    expect(await onDisk(signatureStoragePath)).toBe(true);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.signatureStoragePath).toBe(signatureStoragePath);
  });

  it("replaces a signature of the same type in place", async () => {
    await usersService.uploadSignature(userId, imageUpload(PNG, "image/png"));
    const replacement = Buffer.concat([PNG, Buffer.from("v2")]);
    await usersService.uploadSignature(userId, imageUpload(replacement, "image/png"));

    const stored = await usersService.getSignature(userId);
    expect(stored.buffer).toEqual(replacement);
  });

  it("deletes the old file when the type changes", async () => {
    // The path is derived from the mime type, so a PNG replaced by a JPEG
    // leaves a file nothing points at any more. That is somebody's signature.
    await usersService.uploadSignature(userId, imageUpload(PNG, "image/png"));
    expect(await onDisk(`${userId}.png`)).toBe(true);

    await usersService.uploadSignature(userId, imageUpload(JPEG, "image/jpeg"));

    expect(await onDisk(`${userId}.png`)).toBe(false);
    expect(await onDisk(`${userId}.jpg`)).toBe(true);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.signatureStoragePath).toBe(`${userId}.jpg`);
  });

  it("reports a missing account rather than writing a stray file", async () => {
    const stranger = missingId();

    await expect(
      usersService.uploadSignature(stranger, imageUpload(PNG, "image/png"))
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(await onDisk(`${stranger}.png`)).toBe(false);
  });
});

describe("getSignature", () => {
  it("returns the bytes with the type the extension implies", async () => {
    await usersService.uploadSignature(userId, imageUpload(PNG, "image/png"));

    expect(await usersService.getSignature(userId)).toEqual({
      buffer: PNG,
      contentType: "image/png",
    });
  });

  it("reports jpeg for a jpeg", async () => {
    await usersService.uploadSignature(userId, imageUpload(JPEG, "image/jpeg"));

    expect((await usersService.getSignature(userId)).contentType).toBe("image/jpeg");
  });

  it("says there is none rather than failing obscurely", async () => {
    await expect(usersService.getSignature(userId)).rejects.toMatchObject({
      statusCode: 404,
      message: "No saved signature found",
    });
  });
});

describe("deleteSignature", () => {
  it("removes the file and clears the column together", async () => {
    await usersService.uploadSignature(userId, imageUpload(PNG, "image/png"));

    await usersService.deleteSignature(userId);

    expect(await onDisk(`${userId}.png`)).toBe(false);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.signatureStoragePath).toBeNull();
  });

  it("is safe to call when there is nothing saved", async () => {
    await expect(usersService.deleteSignature(userId)).resolves.toMatchObject({
      message: "Signature removed",
    });
  });

  it("reports a missing account as not found", async () => {
    await expect(
      usersService.deleteSignature(missingId())
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("listAssignableUsers", () => {
  let finance: string;

  beforeEach(async () => {
    finance = (await makeDepartment("Finance")).id;
    const marketing = (await makeDepartment("Marketing")).id;

    await prisma.user.createMany({
      data: [
        {
          firstName: "Maria",
          lastName: "Chen",
          email: "maria.chen@example.com",
          departmentId: finance,
        },
        {
          firstName: "Maria",
          lastName: "Okafor",
          email: "maria.okafor@example.com",
          departmentId: marketing,
        },
        {
          firstName: "Bilal",
          lastName: "Ahmed",
          email: "bilal@example.com",
          departmentId: finance,
        },
      ],
    });
  });

  const names = (result: { users: { firstName: string; lastName: string }[] }) =>
    result.users.map((user) => `${user.firstName} ${user.lastName}`);

  it("matches every word somewhere, not the whole string in one column", async () => {
    // "Maria Chen" finds nobody if both words have to be in one field, which
    // is exactly what a person types into a people picker.
    expect(names(await usersService.listAssignableUsers({ q: "Maria Chen" }))).toEqual([
      "Maria Chen",
    ]);
  });

  it("searches the email and the department too", async () => {
    expect(names(await usersService.listAssignableUsers({ q: "okafor" }))).toEqual([
      "Maria Okafor",
    ]);
    expect(
      names(await usersService.listAssignableUsers({ q: "Marketing" }))
    ).toEqual(["Maria Okafor"]);
  });

  it("ignores case", async () => {
    expect(names(await usersService.listAssignableUsers({ q: "mARIA" }))).toHaveLength(2);
  });

  it("reports how many matched, not just how many were returned", async () => {
    const result = await usersService.listAssignableUsers({ q: "maria", limit: 1 });

    expect(result.returned).toBe(1);
    expect(result.total).toBe(2);
  });

  it("resolves a known set of ids ahead of any search", async () => {
    // A template names its approvers by id, and no search term would find
    // exactly those people.
    const chosen = await prisma.user.findMany({
      where: { lastName: { in: ["Chen", "Ahmed"] } },
      select: { id: true },
    });

    const result = await usersService.listAssignableUsers({
      ids: chosen.map((user) => user.id),
      q: "okafor",
    });

    expect(names(result).sort()).toEqual(["Bilal Ahmed", "Maria Chen"]);
  });

  it("returns everyone when nothing is asked for", async () => {
    const result = await usersService.listAssignableUsers();
    expect(result.users.length).toBeGreaterThanOrEqual(3);
  });

  it("will not be talked into an unbounded page", async () => {
    const result = await usersService.listAssignableUsers({ limit: 100000 });
    expect(result.returned).toBeLessThanOrEqual(100);
  });

  it("carries each person's designation, which is what gets signed under", async () => {
    await prisma.user.update({
      where: { email: "maria.chen@example.com" },
      data: { designation: "Director of Finance" },
    });

    const result = await usersService.listAssignableUsers({ q: "maria chen" });

    // Two Marias is exactly the case this picker has to answer, and the title
    // is how the preparer tells which one signs the memo.
    expect(result.users[0].designation).toBe("Director of Finance");
  });

  it("carries the designation when a template's approvers are looked up by id", async () => {
    // The id branch is a separate query with its own select, so a title that
    // is present in a search result can still be missing here - and the
    // template-driven submit screen is the one that shows it most.
    const chosen = await prisma.user.update({
      where: { email: "bilal@example.com" },
      data: { designation: "Head of Human Resources" },
    });

    const result = await usersService.listAssignableUsers({ ids: [chosen.id] });

    expect(result.users[0].designation).toBe("Head of Human Resources");
  });

  it("reports no designation as null rather than leaving the field out", async () => {
    // Same shape for everybody: an absent key reads to the caller as a field
    // that was never loaded, a null reads as a title nobody has recorded.
    const result = await usersService.listAssignableUsers({ q: "okafor" });

    expect(result.users[0]).toHaveProperty("designation", null);
  });
});

/*
 * The query shape for the people picker. `ids` is a comma list on the wire and
 * a uuid column at the far end, so the splitting and the checking live in the
 * schema - the route reads the parsed value rather than the raw string.
 */
describe("the assignable-users query", () => {
  const parseQuery = (query: Record<string, unknown>) =>
    listAssignableUsersSchema.safeParse({ query, params: {}, body: {} });

  it("splits the comma list into ids the lookup can use", () => {
    const first = missingId();
    const second = missingId();

    const result = parseQuery({ ids: `${first}, ${second}` });

    expect(result.success && result.data.query.ids).toEqual([first, second]);
  });

  it("refuses an id that is not a uuid", () => {
    // Straight into a uuid column otherwise, where it answers 500 "Internal
    // server error" for what is a malformed request.
    const result = parseQuery({ ids: `${missingId()},abc` });

    expect(result.success).toBe(false);
  });

  it("still asks for nobody when the parameter is absent", () => {
    const result = parseQuery({ q: "maria" });

    expect(result.success && result.data.query.ids).toBeUndefined();
  });

  it("does not refuse a long list, it lets the service cap it", () => {
    // A template naming more than a page of approvers should come back
    // partially resolved, as it does today, rather than as a hard failure on
    // the submit screen.
    const many = Array.from({ length: 40 }, () => missingId()).join(",");

    expect(parseQuery({ ids: many }).success).toBe(true);
  });
});

describe("changing your own password", () => {
  /**
   * The only route by which anybody but an administrator can.
   *
   * Without it every account keeps the password a spreadsheet import gave it,
   * and the administrator who wrote that spreadsheet permanently knows the
   * credentials of every person whose signature carries approval authority.
   */
  const withPassword = async (password: string) => {
    const user = await makeUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(password) },
    });
    return user;
  };

  it("changes it when the current one is right", async () => {
    const user = await withPassword("old-password");

    await usersService.changeOwnPassword(user.id, {
      currentPassword: "old-password",
      newPassword: "a-new-password",
    });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword("a-new-password", after.passwordHash)).toBe(true);
    expect(await verifyPassword("old-password", after.passwordHash)).toBe(false);
  });

  it("refuses when the current one is wrong", async () => {
    // Being authenticated is not enough: a token left live on an unattended
    // machine must not be enough to lock its owner out of their own account.
    const user = await withPassword("old-password");

    await expect(
      usersService.changeOwnPassword(user.id, {
        currentPassword: "not-the-password",
        newPassword: "a-new-password",
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword("old-password", after.passwordHash)).toBe(true);
  });

  it("refuses an account that has no password set", async () => {
    // `passwordHash` is nullable, and verify answers false for null rather
    // than throwing - so without this the empty string would let anybody in.
    const user = await makeUser();

    await expect(
      usersService.changeOwnPassword(user.id, {
        currentPassword: "",
        newPassword: "a-new-password",
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses to set the same password again", async () => {
    const user = await withPassword("old-password");

    await expect(
      usersService.changeOwnPassword(user.id, {
        currentPassword: "old-password",
        newPassword: "old-password",
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("ends every session the old password opened", async () => {
    /*
     * Most of the point of being able to change one. Somebody whose password
     * was read over their shoulder changes it and expects that to be the end
     * of it; without this the tokens issued against the old one go on working
     * for thirty days and the change is a gesture.
     */
    const user = await withPassword("old-password");
    await prisma.refreshSession.create({
      data: {
        userId: user.id,
        tokenHash: `hash-${user.id}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    await usersService.changeOwnPassword(user.id, {
      currentPassword: "old-password",
      newPassword: "a-new-password",
    });

    const live = await prisma.refreshSession.count({
      where: { userId: user.id, revokedAt: null },
    });
    expect(live).toBe(0);

    // Access tokens are not stored, so the only thing that can refuse one
    // already issued is this moving forward.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.sessionsValidFrom.getTime()).toBeGreaterThan(
      user.createdAt.getTime()
    );
  });

  it("writes an audit row naming the account", async () => {
    const user = await withPassword("old-password");

    await usersService.changeOwnPassword(user.id, {
      currentPassword: "old-password",
      newPassword: "a-new-password",
    });

    const row = await prisma.auditLog.findFirst({
      where: { action: "PASSWORD_RESET", entityId: user.id },
    });
    expect(row).not.toBeNull();
    expect(row?.actorId).toBe(user.id);
  });

  it("refuses for a user who does not exist", async () => {
    await expect(
      usersService.changeOwnPassword(missingId(), {
        currentPassword: "old-password",
        newPassword: "a-new-password",
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("a signature file that is not one", () => {
  it("is refused at upload rather than weeks later at signing", async () => {
    /*
     * The bytes reach pdf-lib's pure-JavaScript decoder on the thread that
     * serves every request, so they are checked before they are stored. The
     * mimetype the browser sent says nothing about them.
     */
    await expect(
      usersService.uploadSignature(
        userId,
        imageUpload(Buffer.from("%PDF-1.7 this is a pdf"), "image/png")
      )
    ).rejects.toMatchObject({ statusCode: 400 });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.signatureStoragePath).toBeNull();
    expect(await onDisk(`${userId}.png`)).toBe(false);
  });

  it("does not throw away the signature already saved", async () => {
    await usersService.uploadSignature(userId, imageUpload(PNG, "image/png"));

    await expect(
      usersService.uploadSignature(
        userId,
        imageUpload(Buffer.from("rubbish"), "image/png")
      )
    ).rejects.toMatchObject({ statusCode: 400 });

    // The old file is deleted on the way to writing the new one, so a refusal
    // that happened after that point would leave the person with none.
    expect((await usersService.getSignature(userId)).buffer).toEqual(PNG);
  });
});
