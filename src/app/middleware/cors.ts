import cors, { type CorsOptions } from "cors";
import type { RequestHandler } from "express";

// Shared with error-handler.ts so both sides reference one literal.
export const CORS_REJECTION_MESSAGE = "Not allowed by CORS";

// Allowlist ownership lives in env.utils. This middleware only compares.
export function createCorsMiddleware(allowedOrigins: readonly string[]): RequestHandler {
  const options: CorsOptions = {
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(CORS_REJECTION_MESSAGE));
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  };
  return cors(options);
}
