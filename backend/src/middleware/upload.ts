import type { RequestHandler } from "express";
import multer from "multer";
import { errors } from "../lib/errors";
import { assertSignablePdf, assertSupportingFileContent } from "../lib/fileContent";
import { assertNoMalware } from "../lib/virusScan";

const storage = multer.memoryStorage();

export const SUPPORTING_FILE_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
]);

export const MAX_SUPPORTING_FILES = 5;

const documentUploadFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
  if (file.fieldname === "file") {
    if (file.mimetype !== "application/pdf") {
      return cb(errors.badRequest("Only PDF files are allowed for the main document"));
    }
    return cb(null, true);
  }

  if (file.fieldname === "supportingFiles") {
    if (!SUPPORTING_FILE_MIME_TYPES.has(file.mimetype)) {
      return cb(
        errors.badRequest(
          "Supporting files must be PDF, PNG, JPG, Word, Excel, TXT, or CSV"
        )
      );
    }
    return cb(null, true);
  }

  return cb(errors.badRequest("Unexpected file field"));
};

export const uploadDocument = multer({
  storage,
  fileFilter: documentUploadFilter,
  limits: {
    fileSize: 20 * 1024 * 1024, //20MB
    files: 1 + MAX_SUPPORTING_FILES,
  },
});

/** Main PDF + optional supporting attachments. */
export const uploadDocumentWithSupporting = uploadDocument.fields([
  { name: "file", maxCount: 1 },
  { name: "supportingFiles", maxCount: MAX_SUPPORTING_FILES },
]);

const signatureFileFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
  if (!["image/png", "image/jpeg"].includes(file.mimetype)) {
    return cb(errors.badRequest("Only PNG or JPEG signature images are allowed"));
  }

  cb(null, true);
};

export const uploadSignature = multer({
  storage,
  fileFilter: signatureFileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024,
  },
});

const SPREADSHEET_EXTENSIONS = /\.(csv|xlsx|xls)$/i;
const SPREADSHEET_MIME_TYPES = new Set([
  "text/csv",
  "application/csv",
  "text/plain",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
]);

const spreadsheetFileFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
  const extensionOk = SPREADSHEET_EXTENSIONS.test(file.originalname);
  const mimeOk = !file.mimetype || SPREADSHEET_MIME_TYPES.has(file.mimetype);

  if (!extensionOk || !mimeOk) {
    return cb(errors.badRequest("Upload a .csv or .xlsx file"));
  }

  cb(null, true);
};

export const uploadSpreadsheet = multer({
  storage,
  fileFilter: spreadsheetFileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
  },
});

/**
 * Reads what a document upload actually contains, after multer has buffered
 * it and before any of it is stored. The filters above can only see the
 * labels the client chose; this sees the bytes. See `lib/fileContent.ts` and
 * `lib/virusScan.ts` for what each check is for.
 */
export const checkDocumentUploadContent: RequestHandler = (req, _res, next) => {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const mainFile = files?.file?.[0];
  const supportingFiles = files?.supportingFiles ?? [];

  const check = async () => {
    if (mainFile) await assertSignablePdf(mainFile);
    for (const file of supportingFiles) assertSupportingFileContent(file);

    if (mainFile) await assertNoMalware(mainFile.buffer, "The memo file", req.supabaseUserId);
    for (const file of supportingFiles) {
      await assertNoMalware(file.buffer, `"${file.originalname}"`, req.supabaseUserId);
    }
  };

  check().then(() => next(), next);
};
