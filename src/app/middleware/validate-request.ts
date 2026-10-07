import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { AppError } from "../shared/errors/app-error";

export interface ValidateRequestSchemas {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
}

const SECTIONS: ReadonlyArray<keyof ValidateRequestSchemas> = ["params", "query", "body"];

export function validateRequest(schemas: ValidateRequestSchemas): RequestHandler {
  return (req, _res, next) => {
    for (const key of SECTIONS) {
      const schema = schemas[key];
      if (!schema) continue;

      const result = schema.safeParse(req[key]);
      if (!result.success) {
        return next(AppError.badRequest("Invalid request", "VALIDATION_ERROR"));
      }
      req[key] = result.data;
    }
    next();
  };
}
