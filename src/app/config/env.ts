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
}

let cached: AppConfig | undefined;

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
  };
  return cached;
}
