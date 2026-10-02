import { getConfig } from "../config/env";
import { logger } from "../shared/logger/logger";

interface DbOperationMeta {
  collection: string;
  operation: string;
}

export interface MeasureDatabaseOperationOptions {
  /** Test-only injection, invisible to any real caller. Defaults to performance.now. */
  clock?: () => number;
  /**
   * Test-only injection. node:test's mock.method() cannot mock getConfig()
   * directly -- this project's TS/ESM-interop compiled exports are
   * getter-backed, not plain data properties, which mock.method requires.
   * This resolver is a small seam for tests to simulate getConfig() failing
   * without needing to touch the real config module. Defaults to reading
   * getConfig().slowDbOperationThresholdMs.
   */
  getSlowDbOperationThresholdMs?: () => number;
}

// Infrastructure only — no call sites this stage (same pattern as
// validate-request.ts). No global MongoDB monkey-patching: callers opt in by
// wrapping one operation. Never swallows or wraps the original error/value —
// logging is a pure side effect, and logger.warn() is itself internally
// non-throwing, so even a broken logging sink cannot replace this function's
// resolved value or rejection.
export async function measureDatabaseOperation<T>(
  meta: DbOperationMeta,
  fn: () => Promise<T>,
  options: MeasureDatabaseOperationOptions = {}
): Promise<T> {
  const clock = options.clock ?? (() => performance.now());
  const getSlowDbOperationThresholdMs =
    options.getSlowDbOperationThresholdMs ?? (() => getConfig().slowDbOperationThresholdMs);

  // The initial clock() read is itself outside any guarantee — if a clock
  // implementation unexpectedly throws, fn() must still execute. `start`
  // stays undefined in that case, and the finally block below treats that
  // as "timing unavailable," skipping logging entirely rather than
  // computing a nonsense duration.
  let start: number | undefined;
  try {
    start = clock();
  } catch {
    // Timing unavailable; the wrapped operation must still execute.
  }

  try {
    return await fn();
  } finally {
    // Wrapped in try/catch with NO return statement inside it: the
    // threshold resolver can throw, and a `return` here would swallow
    // fn()'s real resolution/rejection — this block may only ever have a
    // side effect (logging), never influence what the outer try/finally
    // actually resolves/rejects with.
    if (start !== undefined) {
      try {
        const durationMs = clock() - start;
        if (durationMs >= getSlowDbOperationThresholdMs()) {
          logger.warn("database_operation_slow", { ...meta, durationMs });
        }
      } catch {
        // Observability must never alter the wrapped operation's outcome.
      }
    }
  }
}
