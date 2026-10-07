import { config as loadDotenv } from "dotenv";

// Importing this module is inert: all reads/validation happen lazily in getConfig().
export interface AppConfig {
  mongodbUri: string;
  port: number;
  isServerless: boolean;
  corsOrigins: string | undefined;
  skipIndexEnsureOnBoot: boolean;
  slowRequestThresholdMs: number;
  slowDbOperationThresholdMs: number;
  jwtSecret: string;
  jwtResetPasswordSecret: string;
  jwtExpiresIn: string;
  jwtResetPasswordTokenExpiresIn: string;
  resetPasswordLink: string | undefined;
  isProduction: boolean;
}

let cached: AppConfig | undefined;

// Negative values are truthy, so Number(x) || default cannot guard millisecond thresholds.
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
    jwtSecret: process.env.JWT_SECRET as string,
    jwtResetPasswordSecret: process.env.JWT_RESET_PASS_SECRET as string,
    jwtExpiresIn: process.env.EXPIRES_IN || "7d",
    jwtResetPasswordTokenExpiresIn: process.env.JWT_RESET_PASS_TOKEN_EXPIRES_IN || "15m",
    resetPasswordLink: process.env.RESET_PASS_LINK,
    isProduction: process.env.NODE_ENV === "production",
  };
  return cached;
}
