import { getConfig } from "../config/env";
import { logger } from "../shared/logger/logger";

interface DbOperationMeta {
  collection: string;
  operation: string;
}

export interface MeasureDatabaseOperationOptions {
  clock?: () => number;
  getSlowDbOperationThresholdMs?: () => number;
}

export async function measureDatabaseOperation<T>(
  meta: DbOperationMeta,
  fn: () => Promise<T>,
  options: MeasureDatabaseOperationOptions = {}
): Promise<T> {
  const clock = options.clock ?? (() => performance.now());
  const getSlowDbOperationThresholdMs =
    options.getSlowDbOperationThresholdMs ?? (() => getConfig().slowDbOperationThresholdMs);

  let start: number | undefined;
  try {
    start = clock();
  } catch {
  }

  try {
    return await fn();
  } finally {
    if (start !== undefined) {
      try {
        const durationMs = clock() - start;
        if (durationMs >= getSlowDbOperationThresholdMs()) {
          logger.warn("database_operation_slow", { ...meta, durationMs });
        }
      } catch {
      }
    }
  }
}
