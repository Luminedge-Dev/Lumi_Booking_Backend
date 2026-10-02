import { config as loadDotenv } from "dotenv";

// Importing this module must be completely inert: no filesystem reads, no
// dotenv.config() call, no environment mutation, no validation, no exception.
// All of that is deferred to getConfig(), called lazily by src/server.ts — this
// is a new, independent validation layer for the new runtime path only. It does
// not replace or need to byte-match index.js's validateEnv() wording: index.js
// keeps running unchanged on its own codepath, and nothing currently calls the
// new lifecycle in production.
export interface AppConfig {
  mongodbUri: string;
  port: number;
  isServerless: boolean;
  corsOrigins: string | undefined;
  skipIndexEnsureOnBoot: boolean;
  slowRequestThresholdMs: number;
  slowDbOperationThresholdMs: number;
}

let cached: AppConfig | undefined;

// Number(x) || default would silently accept a negative value (e.g. -500)
// since a negative number is truthy -- fine for nothing else in this file,
// but not acceptable for a millisecond threshold.
function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getConfig(): AppConfig {
  if (cached) return cached;

  loadDotenv();

  const required = ["MONGODB_URI", "JWT_SECRET", "JWT_RESET_PASS_SECRET"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  cached = {
    mongodbUri: process.env.MONGODB_URI as string,
    port: Number(process.env.PORT) || 5000,
    isServerless: !!process.env.VERCEL,
    corsOrigins: process.env.CORS_ORIGINS,
    skipIndexEnsureOnBoot: process.env.SKIP_INDEX_ENSURE_ON_BOOT === "true",
    slowRequestThresholdMs: parsePositiveNumber(process.env.SLOW_REQUEST_THRESHOLD_MS, 1000),
    slowDbOperationThresholdMs: parsePositiveNumber(process.env.SLOW_DB_OPERATION_THRESHOLD_MS, 250),
  };
  return cached;
}
