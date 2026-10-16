import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AppError } from "./errors";
import { env } from "./env";
import { storageService } from "./storage";

/**
 * Storage is the boundary between a database value and the filesystem, so the
 * tests that matter here are the ones about paths: an object path is built
 * from ids today, but nothing in the type system says it always will be.
 *
 * `vitest.config.ts` points STORAGE_DIR at a temp directory. Without that
 * these tests would read and write the real `backend/storage/`.
 */

const ROOT = path.resolve(env.STORAGE_DIR);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

/** A unique object path per test, so no test depends on another's leftovers. */
let counter = 0;
const objectPath = (name: string) => `case-${++counter}/${name}`;

const multerFile = (buffer: Buffer) =>
  ({ buffer }) as unknown as Express.Multer.File;

const rejection = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("expected the call to reject, and it resolved");
};

describe("reading and writing", () => {
  it("returns exactly the bytes it was given", async () => {
    const target = objectPath("v1.pdf");
    const contents = Buffer.from("%PDF-1.7 not really, but bytes are bytes");

    await storageService.uploadFile(target, contents, "application/pdf");

    expect(await storageService.downloadDocument(target)).toEqual(contents);
  });

  it("creates the directory tree implied by the object path", async () => {
    const target = objectPath("supporting/abc-invoice.pdf");
    await storageService.uploadFile(target, Buffer.from("x"), "application/pdf");

    await expect(
      fs.access(path.join(ROOT, "documents", target))
    ).resolves.toBeUndefined();
  });

  it("refuses to overwrite a document that already exists", async () => {
    // Document versions are addressed by id and version number, so a second
    // write to the same path means two versions have been given one identity.
    // Losing the first silently is the worst available outcome.
    const target = objectPath("v1.pdf");
    const first = Buffer.from("the version that was approved");

    await storageService.uploadDocument(target, multerFile(first));
    const error = await rejection(
      storageService.uploadDocument(target, multerFile(Buffer.from("later")))
    );

    expect(error.statusCode).toBe(409);
    expect(await storageService.downloadDocument(target)).toEqual(first);
  });

  it("replaces the contents when overwriting is the point", async () => {
    // This is how a signed PDF gets written back over the unsigned one.
    const target = objectPath("v1.pdf");
    await storageService.uploadFile(target, Buffer.from("unsigned"), "application/pdf");
    await storageService.overwriteDocument(target, Buffer.from("signed"));

    expect(await storageService.downloadDocument(target)).toEqual(
      Buffer.from("signed")
    );
  });

  it("lets a user replace their saved signature", async () => {
    const target = `case-${++counter}/signature.png`;
    await storageService.uploadSignature(target, Buffer.from("first"), "image/png");
    await storageService.uploadSignature(target, Buffer.from("second"), "image/png");

    expect(await storageService.downloadSignature(target)).toEqual(
      Buffer.from("second")
    );
  });

  it("reports a missing object without leaking the filesystem path", async () => {
    const error = await rejection(
      storageService.downloadDocument(objectPath("never-written.pdf"))
    );

    expect(error.message).toBe("Failed to read stored file");
    expect(error.message).not.toContain(ROOT);
  });

  it("deletes an object that is not there without complaining", async () => {
    // Every upload rollback path calls this on files that may never have been
    // written. If it threw, the rollback would fail on top of the failure it
    // was cleaning up after.
    await expect(
      storageService.deleteDocument(objectPath("never-written.pdf"))
    ).resolves.toBeUndefined();
  });

  it("actually removes the object", async () => {
    const target = objectPath("v1.pdf");
    await storageService.uploadFile(target, Buffer.from("x"), "application/pdf");
    await storageService.deleteDocument(target);

    await rejection(storageService.downloadDocument(target));
  });
});

describe("path containment", () => {
  const escapes = [
    ["climbing out of the bucket", "../escaped.pdf"],
    ["climbing out of the storage root", "../../../escaped.pdf"],
    ["an absolute path", "/etc/passwd"],
    ["a climb hidden mid-path", "documents/../../escaped.pdf"],
  ] as const;

  for (const [description, target] of escapes) {
    it(`refuses ${description} on write`, async () => {
      const error = await rejection(
        storageService.uploadFile(target, Buffer.from("x"), "application/pdf")
      );
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe("Invalid storage path");
    });

    it(`refuses ${description} on read`, async () => {
      const error = await rejection(storageService.downloadDocument(target));
      expect(error.statusCode).toBe(400);
    });

    it(`refuses ${description} on delete`, async () => {
      // Silently returning here would report a refused delete as a completed
      // one, and the caller cleaning up after a failure would believe it.
      const error = await rejection(storageService.deleteDocument(target));
      expect(error.statusCode).toBe(400);
    });
  }

  it("refuses to read across into the signatures bucket", async () => {
    // The two buckets are siblings under the storage root, so this path stays
    // inside ROOT and is caught only because containment is checked against
    // the bucket, not the root. Signatures are the one thing here that is
    // genuinely another person's.
    const error = await rejection(
      storageService.downloadDocument("../signatures/someone-else.png")
    );

    expect(error.statusCode).toBe(400);
  });

  it("allows a nested path that stays inside the bucket", async () => {
    const target = objectPath("supporting/deep/nested.pdf");
    await expect(
      storageService.uploadFile(target, Buffer.from("x"), "application/pdf")
    ).resolves.toBe(target);
  });
});

describe("getSignatureContentType", () => {
  // users.service builds these paths itself, always lower-case, from the
  // uploaded mime type - so only the two extensions it can produce are asked
  // about here.
  it("reads the type off the extension", () => {
    expect(storageService.getSignatureContentType("user.jpg")).toBe("image/jpeg");
    expect(storageService.getSignatureContentType("user.jpeg")).toBe("image/jpeg");
    expect(storageService.getSignatureContentType("user.png")).toBe("image/png");
  });

  it("assumes png for anything else", () => {
    expect(storageService.getSignatureContentType("user")).toBe("image/png");
  });
});
