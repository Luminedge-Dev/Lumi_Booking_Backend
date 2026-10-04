// Independent server lifecycle. Owns its own connect -> collections -> indexes
// -> cron -> app -> listen -> shutdown sequence (matching index.js's bootstrap()
// order exactly); never requires index.js. Importing this module
// triggers none of startServer()'s body (no top-level call) — nothing currently
// calls startServer(), so dev/start/Vercel stay on index.js exactly as today.
//
// Scope note: startServer() in this stage represents the Node/local
// long-lived-process HTTP-server lifecycle only (app.listen(...)) — it is not the
// future Vercel/serverless request handler. config.isServerless exists here only
// to preserve the existing cron-start semantics (don't start cron on a serverless
// container, exactly like index.js's isServerless check). A dedicated
// runtime-cutover stage will later add a separate serverless-handler entrypoint
// (no app.listen()) when this path actually replaces index.js in production.
import http from "node:http";
import { createApp } from "./app";
import { getConfig } from "./app/config/env";
import { connectMongoDB, disconnectMongoDB, getMongoClient } from "./app/database/mongodb";
import { createCollections } from "./app/database/collections";
import { getIndexOps } from "./app/database/indexes";
import { startLegacyReminderCron } from "./app/compat/legacy-jobs";
import type { AppCollections } from "./app/database/database.types";

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

// Resolves once the server actually bound (the 'listening' event), rejects on
// a bind failure (EADDRINUSE/EACCES etc., emitted as an 'error' event) instead
// of letting an unhandled 'error' event throw past the caller. Exported so it's
// independently unit-testable without a live MongoDB connection.
export function listenAsync(server: http.Server, port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const onListening = (): void => {
      server.off("error", onError);
      resolve(server);
    };
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(port);
  });
}

export interface ServerHandle {
  close(): Promise<void>;
}

export async function startServer(): Promise<ServerHandle> {
  const config = getConfig();
  const db = await connectMongoDB(config.mongodbUri);
  let httpServer: http.Server | undefined;

  try {
    const collections = createCollections(db);
    const dependencies = { ...collections, client: getMongoClient(config.mongodbUri) };

    // Non-blocking by design, matching index.js's bootstrap() exactly: its
    // `ensureIndexes(collections).catch(...)` is fired without `await` and
    // startup continues immediately. This is deliberately preserved as-is
    // during parity conversion, not "improved" into a blocking await.
    if (!config.skipIndexEnsureOnBoot) {
      ensureIndexes(collections).catch((err) => console.error("Index creation failed:", err.message));
    }

    // Startup order matches index.js's bootstrap() exactly: Mongo -> collections
    // -> indexes (fired, not awaited) -> cron (if non-serverless) -> createApp()
    // -> listen. Cron is started before the app is created/listening, same as
    // legacy — so a cron-startup failure never leaves an already-listening HTTP
    // server behind, matching what the legacy bootstrap sequence would do.
    if (!config.isServerless) {
      startLegacyReminderCron(collections.usersCollection);
    }

    const app = createApp(dependencies, {
      corsOrigins: config.corsOrigins,
      // Stage 7: threaded the same way corsOrigins already is -- src/app.ts
      // never reads process.env itself (single configuration owner, env.ts).
      authConfig: {
        jwtSecret: config.jwtSecret,
        jwtResetPasswordSecret: config.jwtResetPasswordSecret,
        jwtExpiresIn: config.jwtExpiresIn,
        jwtResetPasswordTokenExpiresIn: config.jwtResetPasswordTokenExpiresIn,
        resetPasswordLink: config.resetPasswordLink,
        isProduction: config.isProduction,
      },
    });
    httpServer = await listenAsync(http.createServer(app), config.port);
    console.log(`[src/server.ts] listening on http://localhost:${config.port}`);

    const boundServer = httpServer;
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        await new Promise<void>((resolve) => boundServer.close(() => resolve()));
        await disconnectMongoDB();
      })();
      return shutdownPromise;
    };

    return { close: shutdown };
  } catch (error) {
    // Mongo connected successfully but something later (collections, cron,
    // app creation, or listen) failed — don't leak the connection or an
    // already-bound HTTP server. Both cleanup steps swallow their own
    // failures so the original `error` is always what gets rethrown below,
    // never a secondary cleanup failure. startServer() never calls
    // process.exit() itself; it's still a testable candidate lifecycle, so it
    // cleans up and rethrows, leaving process termination to whatever future
    // executable entrypoint calls it.
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    }
    await disconnectMongoDB().catch(() => undefined);
    throw error;
  }
}

export function registerProcessHandlers(handle: ServerHandle): void {
  const onSignal = (signal: string): void => {
    console.log(`[src/server.ts] ${signal} received, shutting down`);
    handle.close().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("uncaughtException", (err) => {
    console.error("[src/server.ts] uncaughtException", err);
    handle.close().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[src/server.ts] unhandledRejection", reason);
    handle.close().finally(() => process.exit(1));
  });
}
