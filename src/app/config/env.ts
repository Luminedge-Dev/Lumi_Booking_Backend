import { config as loadDotenv } from "dotenv";
import { getOptionalEnv, getRequiredEnv, parseCorsOriginsEnv, resolveTrustProxyHops } from "./env.utils";

// Importing this module is inert. Mongo bootstrap uses getEnvVars()/getConfig()
// and does not require NEON_DB_URL. Prisma uses getPostgresEnv().

export interface AppConfig {
  mongodbUri: string;
  port: number;
  isServerless: boolean;
  corsOrigins: string[];
  trustProxyHops: number;
  skipIndexEnsureOnBoot: boolean;
  slowRequestThresholdMs: number;
  slowDbOperationThresholdMs: number;
  jwtSecret: string;
  jwtResetPasswordSecret: string;
  jwtExpiresIn: string;
  jwtResetPasswordTokenExpiresIn: string;
  resetPasswordLink: string | undefined;
  isProduction: boolean;
  nodeEnv: string | undefined;
  smtpHost: string | undefined;
  smtpPort: number;
  smtpSecure: boolean;
  email: string | undefined;
  appPass: string | undefined;
  emailFrom: string | undefined;
  cronSecret: string | undefined;
}

export interface PostgresEnv {
  databaseUrl: string;
}

let cached: AppConfig | undefined;
let cachedPostgres: PostgresEnv | undefined;

function legacyPositive(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function buildEnvVars(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const missing = ["MONGODB_URI", "JWT_SECRET", "JWT_RESET_PASS_SECRET", "CORS_ORIGINS"].filter(
    (key) => getOptionalEnv(env, key) === undefined
  );
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  return {
    mongodbUri: getRequiredEnv(env, "MONGODB_URI"),
    port: legacyPositive(getOptionalEnv(env, "PORT"), 5000),
    isServerless: getOptionalEnv(env, "VERCEL") !== undefined,
    corsOrigins: parseCorsOriginsEnv(getRequiredEnv(env, "CORS_ORIGINS")),
    trustProxyHops: resolveTrustProxyHops(env),
    skipIndexEnsureOnBoot: getOptionalEnv(env, "SKIP_INDEX_ENSURE_ON_BOOT") === "true",
    slowRequestThresholdMs: legacyPositive(getOptionalEnv(env, "SLOW_REQUEST_THRESHOLD_MS"), 1000),
    slowDbOperationThresholdMs: legacyPositive(getOptionalEnv(env, "SLOW_DB_OPERATION_THRESHOLD_MS"), 250),
    jwtSecret: getRequiredEnv(env, "JWT_SECRET"),
    jwtResetPasswordSecret: getRequiredEnv(env, "JWT_RESET_PASS_SECRET"),
    jwtExpiresIn: getOptionalEnv(env, "EXPIRES_IN") ?? "7d",
    jwtResetPasswordTokenExpiresIn: getOptionalEnv(env, "JWT_RESET_PASS_TOKEN_EXPIRES_IN") ?? "15m",
    resetPasswordLink: getOptionalEnv(env, "RESET_PASS_LINK"),
    isProduction: getOptionalEnv(env, "NODE_ENV") === "production",
    nodeEnv: getOptionalEnv(env, "NODE_ENV"),
    smtpHost: getOptionalEnv(env, "SMTP_HOST"),
    smtpPort: Number(getOptionalEnv(env, "SMTP_PORT") ?? 587),
    smtpSecure: getOptionalEnv(env, "SMTP_SECURE") === "true",
    email: getOptionalEnv(env, "EMAIL"),
    appPass: getOptionalEnv(env, "APP_PASS"),
    emailFrom: getOptionalEnv(env, "EMAIL_FROM"),
    cronSecret: getOptionalEnv(env, "CRON_SECRET"),
  };
}

export function getEnvVars(): AppConfig {
  if (cached) return cached;
  loadDotenv();
  cached = buildEnvVars(process.env);
  return cached;
}

export function getConfig(): AppConfig {
  return getEnvVars();
}

export function buildPostgresEnv(env: NodeJS.ProcessEnv = process.env): PostgresEnv {
  return { databaseUrl: getRequiredEnv(env, "NEON_DB_URL") };
}

export function getPostgresEnv(): PostgresEnv {
  if (cachedPostgres) return cachedPostgres;
  loadDotenv();
  cachedPostgres = buildPostgresEnv(process.env);
  return cachedPostgres;
}

export function resetEnvCacheForTests(): void {
  cached = undefined;
  cachedPostgres = undefined;
}
