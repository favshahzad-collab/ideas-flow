import { promises as fs } from "node:fs";
import { logger } from "./logger";
import path from "node:path";
import { env } from "./env";
import { errors } from "./errors";

/**
 * Local filesystem storage, replacing Supabase Storage.
 *
 * Keeps the exact interface the services already call, so nothing upstream
 * changes. Objects live under STORAGE_DIR in one directory per bucket, and
 * the object path is reproduced as a directory tree beneath it.
 */

const DOCUMENTS_BUCKET = "documents";
const SIGNATURES_BUCKET = "signatures";

const ROOT = path.resolve(env.STORAGE_DIR);

/**
 * Resolve an object path inside its bucket, refusing anything that escapes
 * the bucket root. Object paths are built from ids, but this is the boundary
 * between a database value and the filesystem, so it is checked.
 */
function resolveObject(bucket: string, objectPath: string): string {
  const bucketRoot = path.join(ROOT, bucket);
  const full = path.resolve(bucketRoot, objectPath);
  const rel = path.relative(bucketRoot, full);

  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw errors.badRequest("Invalid storage path");
  }
  return full;
}

/** Does the object already exist? Any error other than "no" propagates. */
async function objectExists(fullPath: string): Promise<boolean> {
  try {
    await fs.access(fullPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function writeObject(
  bucket: string,
  objectPath: string,
  data: Buffer,
  { overwrite }: { overwrite: boolean }
): Promise<string> {
  const full = resolveObject(bucket, objectPath);
  await fs.mkdir(path.dirname(full), { recursive: true });

  if (!overwrite && (await objectExists(full))) {
    throw errors.conflict("Object already exists");
  }

  await fs.writeFile(full, data);
  return objectPath;
}

async function readObject(bucket: string, objectPath: string): Promise<Buffer> {
  // Resolved outside the try: its refusal is a bad request from the caller,
  // not a storage failure, and must not be relabelled as one.
  const full = resolveObject(bucket, objectPath);

  try {
    return await fs.readFile(full);
  } catch {
    throw errors.internal("Failed to read stored file");
  }
}

async function removeObject(bucket: string, objectPath: string): Promise<void> {
  const full = resolveObject(bucket, objectPath);

  try {
    await fs.unlink(full);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.error("storage.delete.failed", { objectPath, bucket, err });
    }
  }
}

class StorageService {
  async uploadDocument(
    objectPath: string,
    file: Express.Multer.File
  ): Promise<string> {
    return writeObject(DOCUMENTS_BUCKET, objectPath, file.buffer, {
      overwrite: false,
    });
  }

  async uploadFile(
    objectPath: string,
    buffer: Buffer,
    _contentType: string
  ): Promise<string> {
    return writeObject(DOCUMENTS_BUCKET, objectPath, buffer, {
      overwrite: false,
    });
  }

  async downloadDocument(objectPath: string): Promise<Buffer> {
    return readObject(DOCUMENTS_BUCKET, objectPath);
  }

  async overwriteDocument(objectPath: string, buffer: Buffer): Promise<string> {
    return writeObject(DOCUMENTS_BUCKET, objectPath, buffer, {
      overwrite: true,
    });
  }

  async deleteDocument(objectPath: string): Promise<void> {
    return removeObject(DOCUMENTS_BUCKET, objectPath);
  }

  async uploadSignature(
    objectPath: string,
    buffer: Buffer,
    _contentType: string
  ): Promise<string> {
    return writeObject(SIGNATURES_BUCKET, objectPath, buffer, {
      overwrite: true,
    });
  }

  async downloadSignature(objectPath: string): Promise<Buffer> {
    return readObject(SIGNATURES_BUCKET, objectPath);
  }

  async deleteSignature(objectPath: string): Promise<void> {
    return removeObject(SIGNATURES_BUCKET, objectPath);
  }

  getSignatureContentType(objectPath: string): string {
    return objectPath.endsWith(".jpg") || objectPath.endsWith(".jpeg")
      ? "image/jpeg"
      : "image/png";
  }
}

export const storageService = new StorageService();
