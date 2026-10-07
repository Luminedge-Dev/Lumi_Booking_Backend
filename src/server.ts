// Long-lived-process lifecycle: HTTP listen plus graceful shutdown on top
// of the shared runtime bootstrap. Importing this module has no side effects.
import http from "node:http";
import { bootstrapRuntime, type RuntimeInstance } from "./app/runtime/bootstrap";

// Resolves on 'listening', rejects on bind failure instead of throwing past
// the caller through an unhandled 'error' event.
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
  let runtime: RuntimeInstance | undefined;
  let httpServer: http.Server | undefined;

  try {
    runtime = await bootstrapRuntime();
    httpServer = await listenAsync(http.createServer(runtime.app), runtime.config.port);
    console.log(`[src/server.ts] listening on http://localhost:${runtime.config.port}`);

    const boundServer = httpServer;
    const boundRuntime = runtime;
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        await new Promise<void>((resolve) => boundServer.close(() => resolve()));
        await boundRuntime.close();
      })();
      return shutdownPromise;
    };

    return { close: shutdown };
  } catch (error) {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    }
    if (runtime) {
      await runtime.close().catch(() => undefined);
    }
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
