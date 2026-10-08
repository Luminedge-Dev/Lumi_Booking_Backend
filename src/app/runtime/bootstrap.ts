import type { Application } from "express";
import { createApp } from "../../app";
import { getConfig, type AppConfig } from "../config/env";
import {
  connectMongoDB,
  disconnectMongoDB,
  ensureHealthy,
  getMongoClient,
} from "../database/mongodb";
import { createCollections } from "../database/collections";
import { getIndexOps } from "../database/indexes";
import type { AppCollections } from "../database/database.types";
import { startLegacyReminderCron } from "../compat/legacy-jobs";
import { createCoreRepositories } from "./core-repositories";

export interface RuntimeInstance {
  app: Application;
  config: AppConfig;
  collections: AppCollections;
  close(): Promise<void>;
  ensureHealthy(): Promise<void>;
}

// Same non-fatal startup warnings as the legacy entrypoint: email is
// best-effort but a broken config must be loud on cold start, and a
// Vercel deploy without production cookies causes cross-site 401 loops.
export function logOperationalWarnings(): void {
  if (!process.env.SMTP_HOST) {
    console.warn("⚠️  SMTP_HOST is not set — outbound email will fail.");
  }
  if (!process.env.EMAIL || !process.env.APP_PASS) {
    console.warn("⚠️  EMAIL and/or APP_PASS is not set — SMTP authentication will fail.");
  }
  if (!process.env.EMAIL_FROM && !process.env.EMAIL) {
    console.warn("⚠️  Neither EMAIL_FROM nor EMAIL is set — email 'from' address is undefined.");
  }

  const smtpPort = Number(process.env.SMTP_PORT || 587);
  const smtpSecure = process.env.SMTP_SECURE === "true";
  if (smtpPort === 465 && !smtpSecure) {
    console.warn(
      "⚠️  SMTP_PORT=465 requires SMTP_SECURE=true (implicit TLS) — email will fail as configured."
    );
  }
  if (smtpPort === 587 && smtpSecure) {
    console.warn(
      "⚠️  SMTP_PORT=587 normally pairs with SMTP_SECURE=false (STARTTLS) — email may fail as configured."
    );
  }

  if (process.env.VERCEL && process.env.NODE_ENV !== "production") {
    console.warn(
      "⚠️  NODE_ENV is not 'production' on a serverless deploy — auth cookies will not be sent cross-site (expect 401 loops)."
    );
  }
}

async function ensureIndexes(collections: AppCollections): Promise<void> {
  const errors: string[] = [];
  for (const op of getIndexOps(collections)) {
    try {
      await op();
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (errors.length) {
    throw new Error(`${errors.length} index operation(s) failed: ${errors.join("; ")}`);
  }
}

// Single initialization owner for both entrypoints (long-lived and
// serverless): config -> Mongo -> collections -> app.
export async function bootstrapRuntime(): Promise<RuntimeInstance> {
  const config = getConfig();
  logOperationalWarnings();
  const db = await connectMongoDB(config.mongodbUri);

  try {
    const collections = createCollections(db);
    const client = getMongoClient(config.mongodbUri);

    // Index creation must not block server startup.
    if (!config.skipIndexEnsureOnBoot) {
      ensureIndexes(collections).catch((err) =>
        console.error("Index creation failed:", err.message)
      );
    }

    // Cron only runs on long-lived processes, never serverless.
    if (!config.isServerless) {
      startLegacyReminderCron(collections.usersCollection);
    }

    const app = createApp(
      { ...collections, client },
      {
        corsOrigins: config.corsOrigins,
        trustProxyHops: config.trustProxyHops,
        // Lazy: no PostgreSQL connection or NEON_DB_URL read until a migrated
        // repository serves its first request.
        repositories: createCoreRepositories(),
        authConfig: {
          jwtSecret: config.jwtSecret,
          jwtResetPasswordSecret: config.jwtResetPasswordSecret,
          jwtExpiresIn: config.jwtExpiresIn,
          jwtResetPasswordTokenExpiresIn: config.jwtResetPasswordTokenExpiresIn,
          resetPasswordLink: config.resetPasswordLink,
          isProduction: config.isProduction,
        },
      }
    );

    return {
      app,
      config,
      collections,
      close: () => disconnectMongoDB(),
      ensureHealthy: () => ensureHealthy(config.mongodbUri),
    };
  } catch (error) {
    await disconnectMongoDB().catch(() => undefined);
    throw error;
  }
}

type RuntimeInitializer = () => Promise<RuntimeInstance>;

// Cache the initialized app across warm serverless invocations. A rejected
// initialization is reset by the caller so the next request retries.
let cachedRuntime: Promise<RuntimeInstance> | undefined;

export function getRuntimeInstance(
  init: RuntimeInitializer = bootstrapRuntime
): Promise<RuntimeInstance> {
  if (!cachedRuntime) cachedRuntime = init();
  return cachedRuntime;
}

export function resetRuntimeInstance(): void {
  cachedRuntime = undefined;
}
