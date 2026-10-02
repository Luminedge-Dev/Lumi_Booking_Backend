import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { AppError } from "../shared/errors/app-error";

// Minimal validation foundation only — no legacy or domain route is wired to
// this yet. Validates synchronous request *shape* only (types, formats,
// ranges, coercion); asynchronous/DB-dependent business validation belongs
// in services, not in these request schemas.
export interface ValidateRequestSchemas {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
}

const SECTIONS: ReadonlyArray<keyof ValidateRequestSchemas> = ["params", "query", "body"];

// Checks params -> query -> body, in that order, failing on the first
// invalid section. On success, writes each section's parsed/coerced value
// back onto req[key] (safe on Express 4, where req.query/req.params are
// plain writable properties — revisit if this project ever moves to
// Express 5, where req.query becomes a getter-only property).
export function validateRequest(schemas: ValidateRequestSchemas): RequestHandler {
  return (req, _res, next) => {
    for (const key of SECTIONS) {
      const schema = schemas[key];
      if (!schema) continue;

      const result = schema.safeParse(req[key]);
      if (!result.success) {
        // Stable public message — never expose raw Zod issue text/structure
        // before the first real consumer's contract is designed.
        return next(AppError.badRequest("Invalid request", "VALIDATION_ERROR"));
      }
      req[key] = result.data;
    }
    next();
  };
}
