import { getRequestId } from "../request-context/request-context";

type LogMetadata = Record<string, unknown>;

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
  }
}

export const logger = {
  info: (event: string, metadata?: LogMetadata) => emit("info", event, metadata),
  warn: (event: string, metadata?: LogMetadata) => emit("warn", event, metadata),
  error: (event: string, metadata?: LogMetadata) => emit("error", event, metadata),
};
