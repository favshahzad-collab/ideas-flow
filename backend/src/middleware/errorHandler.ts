import { Request, Response, NextFunction } from "express";
import { MulterError } from "multer";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { routeOf } from "./requestLog";

/**
 * What multer refuses, said in words the person who chose the file can act
 * on. Its `fileFilter`s already raise AppErrors, but the `limits` it enforces
 * itself throw a MulterError — which is a plain Error, so every one of them
 * used to arrive as 500 "Internal server error". Picking a 25 MB PDF is not a
 * server fault, and telling somebody it is sends them to support instead of
 * back to the file picker.
 */
const MULTER_STATUS: Record<string, { status: number; message: string }> = {
  LIMIT_FILE_SIZE: {
    status: 413,
    message: "That file is too large for this upload.",
  },
  LIMIT_FILE_COUNT: {
    status: 400,
    message: "Too many files were attached.",
  },
  LIMIT_UNEXPECTED_FILE: {
    status: 400,
    message: "A file arrived on a field this upload does not accept.",
  },
  LIMIT_PART_COUNT: { status: 400, message: "The upload has too many parts." },
  LIMIT_FIELD_COUNT: { status: 400, message: "The form has too many fields." },
  LIMIT_FIELD_KEY: { status: 400, message: "A form field name is too long." },
  LIMIT_FIELD_VALUE: { status: 400, message: "A form field value is too long." },
};

export function errorHandler(
  error: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      error: {
        message: error.message,
        code: error.code,
      },
    });
    return;
  }

  if (error instanceof MulterError) {
    const known = MULTER_STATUS[error.code];
    res.status(known?.status ?? 400).json({
      error: {
        message: known?.message ?? "That upload was refused.",
        code: error.code,
      },
    });
    return;
  }

  if ("type" in error && error.type === "entity.too.large") {
    res.status(413).json({
      error: {
        message: "Request payload is too large",
        code: "PAYLOAD_TOO_LARGE",
      },
    });
    return;
  }

  /*
   * The only 500 anyone can act on.
   *
   * This was `console.error("Unhandled error:", error)` - a stack with no
   * request attached, so two people failing in the same minute produced two
   * stacks and no way to tell whose was whose. The request id ties this line
   * to the `http` line the request middleware writes, and to the sentence on
   * the approver's screen.
   *
   * The 4xx cases above are not logged here: `requestLog` already records
   * them at warn, and an expected refusal is not an incident. This one is.
   */
  logger.error("unhandled", {
    requestId: req.requestId,
    method: req.method,
    route: routeOf(req),
    actorId: req.supabaseUserId,
    err: error,
  });

  res.status(500).json({
    error: {
      message: "Internal server error",
      code: "INTERNAL_ERROR",
      /*
       * Additive, and safe to show: a random uuid discloses nothing, and
       * without it the person on the phone has nothing to quote. The frontend
       * reads `message` and `code` and is unaffected by a third field.
       */
      requestId: req.requestId,
    },
  });
}
