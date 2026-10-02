import cors, { type CorsOptions } from "cors";
import type { RequestHandler } from "express";

const DEFAULT_ORIGINS = ["https://luminedge.io", "https://crm.luminedge.io", "http://localhost:3000"];

// Shared with error-handler.ts so both sides of the CORS-rejection contract
// reference one literal instead of two independently-maintained strings.
export const CORS_REJECTION_MESSAGE = "Not allowed by CORS";

export function resolveAllowedOrigins(rawCorsOrigins?: string): string[] {
  return rawCorsOrigins
    ? rawCorsOrigins.split(",").map((o) => o.trim()).filter(Boolean)
    : DEFAULT_ORIGINS;
}

export function createCorsMiddleware(rawCorsOrigins?: string): RequestHandler {
  const allowedOrigins = resolveAllowedOrigins(rawCorsOrigins);
  const options: CorsOptions = {
    origin(origin, cb) {
      // Allow non-browser clients (no Origin header) and any allowlisted origin.
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(CORS_REJECTION_MESSAGE));
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  };
  return cors(options);
}
