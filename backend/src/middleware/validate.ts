import { Request, Response, NextFunction } from "express";
import { ZodError, ZodSchema } from "zod";
import { errors } from "../lib/errors";

export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse({
        body: req.body ?? {},
        query: req.query,
        params: req.params,
      }) as { body?: unknown; query?: unknown; params?: unknown };

      if (parsed.body !== undefined) {
        req.body = parsed.body;
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const messages = [...new Set(error.issues.map((issue) => issue.message))];
        next(errors.badRequest(messages.join(". "), "VALIDATION_ERROR"));
      } else {
        next(error);
      }
    }
  };
}
