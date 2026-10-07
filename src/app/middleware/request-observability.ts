import type { RequestHandler } from "express";
import { getConfig } from "../config/env";
import { getRequestId } from "../shared/request-context/request-context";
import { logger } from "../shared/logger/logger";

type Clock = () => number;

export interface RequestObservabilityOptions {
  clock?: Clock;
  getSlowRequestThresholdMs?: () => number;
}

function parseByteLength(headerValue: string | number | string[] | undefined): number | undefined {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (raw === undefined) return undefined;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

// Must mount immediately after request-id.ts so measured duration covers the whole pipeline.
export function createRequestObservability(options: RequestObservabilityOptions = {}): RequestHandler {
  const clock = options.clock ?? (() => performance.now());
  const getSlowRequestThresholdMs = options.getSlowRequestThresholdMs ?? (() => getConfig().slowRequestThresholdMs);

  return (req, res, next) => {
    let start: number | undefined;
    let requestId: string | undefined;
    try {
      start = clock();
      requestId = getRequestId();
    } catch {
    }
    let completed = false;

    const finish = (event: "http_request_completed" | "http_request_aborted"): void => {
      if (completed) return;
      completed = true;
      if (start === undefined) return;

      try {
        const durationMs = clock() - start;
        const isSlow = event === "http_request_completed" && durationMs >= getSlowRequestThresholdMs();

        const metadata: Record<string, unknown> = {
          method: req.method,
          path: req.path,
          durationMs,
          requestId,
        };
        if (event === "http_request_completed") {
          metadata.statusCode = res.statusCode;
        }
        const requestBytes = parseByteLength(req.headers["content-length"]);
        if (requestBytes !== undefined) metadata.requestBytes = requestBytes;
        const responseBytes = parseByteLength(res.getHeader("content-length"));
        if (responseBytes !== undefined) metadata.responseBytes = responseBytes;

        if (event === "http_request_aborted") {
          logger.warn("http_request_aborted", metadata);
        } else if (isSlow) {
          logger.warn("http_request_slow", metadata);
        } else {
          logger.info("http_request_completed", metadata);
        }
      } catch {
      }
    };

    res.on("finish", () => finish("http_request_completed"));
    res.on("close", () => finish("http_request_aborted"));

    next();
  };
}

export const requestObservability: RequestHandler = createRequestObservability();
