import type { ErrorRequestHandler } from "express";
import { StatusCodes } from "http-status-codes";
import { AppError } from "../shared/errors/app-error";
import { CORS_REJECTION_MESSAGE } from "./cors";
import { logger } from "../shared/logger/logger";

// Must keep exactly 4 declared parameters (even though req/next are unused)
// so Express's arity-based error-middleware detection (fn.length === 4)
// still recognizes this as an error handler. Do not "simplify" _req/_next
// away — that would silently stop Express from ever invoking this.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ message: err.message });
    return;
  }
  if (err?.message === CORS_REJECTION_MESSAGE) {
    res.status(StatusCodes.FORBIDDEN).json({ message: "Origin not allowed" });
    return;
  }
  logger.error("http_request_error", {
    errorName: err?.name,
    message: err?.message,
    stack: err?.stack,
  });
  res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ message: "An unexpected error occurred. Please try again later." });
};
