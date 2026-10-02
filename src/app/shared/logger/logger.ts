import { getRequestId } from "../request-context/request-context";

type LogMetadata = Record<string, unknown>;

// `level`/`event`/`timestamp` are logger-owned and spread LAST so a
// caller-supplied metadata key of the same name (e.g. a mistaken
// `{ event: "..." }`) can never silently corrupt them. `requestId` is
// handled separately: if the caller's metadata explicitly supplies one
// (request-observability.ts does, with a value it captured synchronously),
// that value wins; otherwise it falls back to getRequestId() (reliable for
// a call site like error-handler.ts that runs inside the AsyncLocalStorage
// context established by request-id.ts).
function buildEntry(level: "info" | "warn" | "error", event: string, metadata: LogMetadata): Record<string, unknown> {
  const { requestId: explicitRequestId, ...rest } = metadata;
  return {
    ...rest,
    requestId: explicitRequestId ?? getRequestId(),
    level,
    event,
    timestamp: new Date().toISOString(),
  };
}

// info -> console.log, warn -> console.warn, error -> console.error. This
// mapping is load-bearing: tests assert slow/aborted/db-slow events arrive
// via console.warn specifically, not console.log.
//
// Dispatch is a live if/else on console.* at call time, NOT a module-level
// object caching console.log/warn/error by reference. node:test's
// `mock.method(console, "warn", ...)` replaces the method on the `console`
// object itself; a reference captured once at module-load time would keep
// pointing at the original, pre-mock function, so tests mocking
// console.warn/error would silently fail to intercept anything. Always go
// through `console.log(...)`/`console.warn(...)`/`console.error(...)`
// directly so a test's mock is seen.
//
// Logging is best-effort and must NEVER throw into application/business
// control flow — a broken sink (e.g. a full stdout buffer, a mocked
// console throwing in a test) must not replace a DB operation's return
// value or a request's response. Every emit() call is wrapped so a sink
// failure is swallowed, not propagated.
function emit(level: "info" | "warn" | "error", event: string, metadata: LogMetadata = {}): void {
  try {
    const line = JSON.stringify(buildEntry(level, event, metadata));
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  } catch {
    // Observability must never break the caller. Intentionally silent.
  }
}

// Hand-rolled, dependency-free structured logger. No class hierarchy, no
// injectable sink: tests capture output via node:test's mock.method(console,
// "log"/"warn"/"error") instead.
export const logger = {
  info: (event: string, metadata?: LogMetadata) => emit("info", event, metadata),
  warn: (event: string, metadata?: LogMetadata) => emit("warn", event, metadata),
  error: (event: string, metadata?: LogMetadata) => emit("error", event, metadata),
};
